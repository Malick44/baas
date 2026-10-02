import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createPlatform, type Platform } from "./platform.js";
import { archivingCluster, HAVE_SERVER_BINARIES } from "./pitr-testkit.js";
import { BOOT, makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
if (process.env.CI && !HAVE_SERVER_BINARIES) throw new Error("point-in-time recovery tests need the Postgres server binaries");
const SCRIPT = join(import.meta.dirname, "..", "deploy", "pitr-archive.sh");

// The archive lives in the shared store and the database uploads WAL over HTTP: no directory is shared between the database, node A and node B.
describe("point-in-time recovery with the archive in the shared store", { skip: (!ADMIN || !HAVE_SERVER_BINARIES) && "needs BAAS_TEST_PG_URL and Postgres server binaries" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let A: Platform;
  let B: Platform;
  let db: Awaited<ReturnType<typeof archivingCluster>>;
  let work: string;
  let owner: string;
  let port: number;
  const op = { "x-bootstrap-token": BOOT };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rows = async (ref: string, q: string): Promise<any[][]> => {
    const j = (await t.sql(owner, ref, q)).json;
    return (Array.isArray(j) ? j : j.results).at(-1).rows;
  };
  const wal = (file: string, token: string, body: Buffer | string, cluster = "arch") =>
    A.api.inject({ method: "PUT", url: `/v1/pitr/wal/${cluster}/${file}`, headers: { "content-type": "application/octet-stream", ...(token ? { "x-archive-token": token } : {}) }, payload: body });

  before(async () => {
    db = await archivingCluster();
    work = await mkdtemp(join(tmpdir(), "baas-pitr-shared-"));
    await chmod(work, 0o755);
    const cfg = (name: string) => ({ shared: true, scratchDir: join(work, name), retentionDays: 7, recoveryTimeoutMs: 120_000 });
    t = await makePlatform(ADMIN!, { storageBackend: "postgres", pitr: cfg("scratch-a") });
    A = t.platform;
    B = await createPlatform({ ...A.cfg, storageDir: join(work, "storage-b"), backupDir: join(work, "backups-b"), pitr: cfg("scratch-b") });
    owner = await t.org();
    port = (await A.listen({ api: 0, gateway: 0, host: "127.0.0.1" })).api;
    assert.equal((await t.api("POST", "/v1/admin/clusters", { headers: op, body: { id: "arch", admin_url: db.url } })).status, 201);
    // Point the database's archive_command at baas, the way an operator would.
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    await c.query(`ALTER SYSTEM SET archive_command = $1`.replace("$1", `'${SCRIPT} http://127.0.0.1:${port} arch ${A.pitr!.archiveToken("arch")} %p %f'`));
    await c.query(`SELECT pg_reload_conf()`);
    await c.end();
  });
  after(async () => { await B?.stop().catch(() => {}); await t?.close(); await db?.stop(); await rm(work, { recursive: true, force: true }); });

  it("hands out the archive command, and takes WAL only with the right token, name and content", async () => {
    const cmd = await t.api("GET", "/v1/admin/clusters/arch/pitr/archive-command?url=http://baas:8080", { headers: op });
    assert.equal(cmd.status, 200, cmd.text);
    assert.equal(cmd.json.command, `/etc/baas/pitr-archive.sh http://baas:8080 arch ${cmd.json.token} %p %f`);
    assert.equal((await t.api("GET", "/v1/admin/clusters/arch/pitr/archive-command")).status, 401, "operators only");
    const token = A.pitr!.archiveToken("arch");
    assert.notEqual(token, A.pitr!.archiveToken("other"), "a token is for one cluster");
    const name = "0000000100000000000000AA";
    assert.equal((await wal(name, "", "x")).statusCode, 401);
    assert.equal((await wal(name, "wrong", "x")).statusCode, 401);
    assert.equal((await wal(name, A.pitr!.archiveToken("main"), "x")).statusCode, 401, "another cluster's token");
    assert.ok([400, 404].includes((await wal("..%2F..%2Fetc%2Fpasswd", token, "x")).statusCode), "no path tricks");
    assert.equal((await wal("not-a-wal-file", token, "x")).statusCode, 400);
    assert.equal((await wal(name, A.pitr!.archiveToken("nope"), "x", "nope")).statusCode, 404, "unknown cluster");
    assert.equal((await wal(name, token, "first")).statusCode, 200);
    assert.equal((await wal(name, token, "first")).statusCode, 200, "the same file again is fine, so a retried archive_command succeeds");
    assert.equal((await wal(name, token, "other-contents")).statusCode, 409, "a different file under the same name is refused");
    await t.platform.control.pool.query(`DELETE FROM blob_objects WHERE key LIKE 'pitr/arch/wal/0000000100000000000000AA'`);
  });

  it("uploads with the bundled script, with and without curl", async () => {
    const dir = join(work, "bin");
    await mkdir(dir);
    for (const n of ["stat", "cat"]) await symlink(execFileSync("which", [n]).toString().trim(), join(dir, n));
    const file = join(work, "seg");
    await writeFile(file, Buffer.alloc(300_000, 7));
    const token = A.pitr!.archiveToken("arch");
    // Asynchronous: the server runs in this very process and has to answer while the script waits.
    const run = async (name: string, env: Record<string, string>, tok = token) => {
      try { await promisify(execFile)("/bin/bash", [SCRIPT, `http://127.0.0.1:${port}`, "arch", tok, file, name], { env }); return 0; } catch (e) { return (e as { code: number }).code; }
    };
    assert.equal(await run("0000000100000000000000AB", { PATH: process.env.PATH! }), 0, "curl");
    assert.equal(await run("0000000100000000000000AC", { PATH: dir }), 0, "plain bash, as in the stock postgres image");
    assert.notEqual(await run("0000000100000000000000AD", { PATH: dir }, "bad"), 0, "a refused upload fails, so Postgres keeps the segment");
    const keys = (await t.platform.control.pool.query(`SELECT key FROM blob_objects WHERE key LIKE 'pitr/arch/wal/%'`)).rows.map((r) => r.key);
    assert.ok(keys.includes("pitr/arch/wal/0000000100000000000000AB") && keys.includes("pitr/arch/wal/0000000100000000000000AC") && !keys.includes("pitr/arch/wal/0000000100000000000000AD"));
    await t.platform.control.pool.query(`DELETE FROM blob_objects WHERE key ~ '/0000000100000000000000A[A-D]$'`);
  });

  let p: Awaited<ReturnType<typeof t.project>>;
  let T1: string;
  it("takes a base backup into the store and archives WAL by itself", async () => {
    // Keep every other cluster out of the running so the project lands on the archiving one.
    await t.api("PATCH", "/v1/admin/clusters/main", { headers: op, body: { status: "draining" } });
    p = await t.project(owner, "shared-recover");
    await t.api("PATCH", "/v1/admin/clusters/main", { headers: op, body: { status: "active" } });
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
    assert.equal((await t.api("GET", `/v1/projects/${p.ref}`, { token: owner })).json.cluster, "arch");
    const b = await t.api("POST", `/v1/projects/${p.ref}/pitr/base-backup`, { token: owner });
    assert.equal(b.status, 201, b.text);
    assert.equal(b.json.status, "complete");
    const row = (await t.platform.control.pool.query(`SELECT path FROM pitr_base_backups WHERE id = $1`, [b.json.id])).rows[0];
    assert.equal(row.path, `arch/base/${b.json.id}.tar.gz`);
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM blob_objects WHERE key = $1`, [`pitr/${row.path}`])).rows[0].n, 1, "in the shared store");
    assert.deepEqual(await readdir(join(work, "scratch-a")).catch(() => []), [], "nothing is left in scratch space");
    assert.ok(Number((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM blob_objects WHERE key LIKE 'pitr/arch/wal/%'`)).rows[0].n) >= 1, "the database has been uploading WAL");
  });

  it("restores on node B, which took no part in the backup and shares no directory", async () => {
    await t.sql(owner, p.ref, "create table public.notes (id serial primary key, body text); insert into public.notes (body) values ('A1'), ('A2')");
    await sleep(1200);
    T1 = (await rows(p.ref, "select clock_timestamp()::timestamptz"))[0]![0] as string;
    await sleep(1200);
    await t.sql(owner, p.ref, "insert into public.notes (body) values ('B1')");
    await t.sql(owner, p.ref, "drop table public.notes");
    const r = await B.api.inject({ method: "POST", url: `/v1/projects/${p.ref}/pitr/restore`, headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, payload: JSON.stringify({ to: T1 }) });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual((await rows(p.ref, "select body from public.notes order by id")).map((x) => x[0]), ["A1", "A2"]);
    assert.deepEqual(await readdir(join(work, "scratch-b")), [], "B's scratch space is clean again");
  });

  it("prunes old base backups and the WAL only they needed, from the store", async () => {
    const svc = A.pitr!;
    await svc.takeBaseBackup("arch");
    await svc.takeBaseBackup("arch");
    const all = (await A.control.pool.query<{ id: string; path: string; start_wal: string }>(`SELECT id, path, start_wal FROM pitr_base_backups WHERE cluster_id = 'arch' AND status = 'complete' ORDER BY finished_at`)).rows;
    assert.ok(all.length >= 3);
    // Make the first two look old, and plant a WAL file older than every backup.
    await A.control.pool.query(`UPDATE pitr_base_backups SET finished_at = now() - interval '20 days' WHERE id = $1`, [all[0]!.id]);
    await A.control.pool.query(`UPDATE pitr_base_backups SET finished_at = now() - interval '10 days' WHERE id = $1`, [all[1]!.id]);
    await wal("000000010000000000000001", svc.archiveToken("arch"), "ancient");
    const r = await svc.prune("arch");
    assert.equal(r.removedBackups, 1);
    const has = async (k: string) => (await A.control.pool.query(`SELECT 1 FROM blob_objects WHERE key = $1`, [`pitr/${k}`])).rowCount === 1;
    assert.equal(await has(all[0]!.path), false, "the oldest backup's tarball is gone");
    assert.equal(await has(all[1]!.path), true, "the one anchoring the window stays");
    assert.equal(await has("arch/wal/000000010000000000000001"), false, "WAL older than the oldest kept backup is removed");
    assert.equal(await has(`arch/wal/${all[1]!.start_wal}`), true, "and what the kept backups need is not");
  });

  it("deletes a removed cluster's archive", async () => {
    for (const r of (await t.platform.control.pool.query<{ ref: string }>(`SELECT ref FROM projects WHERE cluster_id = 'arch'`)).rows) assert.equal((await t.api("POST", `/v1/admin/projects/${r.ref}/move`, { headers: op, body: { cluster: "main" } })).status, 200);
    assert.equal((await t.api("DELETE", "/v1/admin/clusters/arch", { headers: op })).status, 204);
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM blob_objects WHERE key LIKE 'pitr/arch/%'`)).rows[0].n, 0);
  });
});
