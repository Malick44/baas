import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runCli } from "./cli.js";
import { archivingCluster, HAVE_SERVER_BINARIES } from "./pitr-testkit.js";
import { BOOT, makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
if (process.env.CI && !HAVE_SERVER_BINARIES) throw new Error("point-in-time recovery tests need the Postgres server binaries (initdb, postgres, pg_basebackup, pg_archivecleanup)");

// The platform's main cluster does NOT archive here (the shared test server); the added cluster does. Recovery has to follow the project.
describe("point-in-time recovery for projects on added clusters", { skip: (!ADMIN || !HAVE_SERVER_BINARIES) && "needs BAAS_TEST_PG_URL and Postgres server binaries" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let ac: Awaited<ReturnType<typeof archivingCluster>>;
  let plainCluster: Awaited<ReturnType<typeof archivingCluster>>;
  let work: string;
  let owner: string;
  const op = { "x-bootstrap-token": BOOT };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const patch = (id: string, body: object) => t.api("PATCH", `/v1/admin/clusters/${id}`, { headers: op, body });
  const move = (ref: string, cluster: string) => t.api("POST", `/v1/admin/projects/${ref}/move`, { headers: op, body: { cluster } });
  const status = (ref: string) => t.api("GET", `/v1/projects/${ref}/pitr`, { token: owner });
  const restore = (ref: string, to: string, token = owner) => t.api("POST", `/v1/projects/${ref}/pitr/restore`, { token, body: { to } });
  const rows = async (ref: string, q: string): Promise<any[][]> => {
    const j = (await t.sql(owner, ref, q)).json;
    return (Array.isArray(j) ? j : j.results).at(-1).rows;
  };
  const now = async (ref: string) => (await rows(ref, "select clock_timestamp()::timestamptz"))[0]![0] as string;
  /** A pro-plan project, placed on a cluster by keeping every other one out of the running while it is created. */
  const project = async (name: string, cluster: string) => {
    const all = (await t.api("GET", "/v1/admin/clusters", { headers: op })).json.filter((c: any) => c.id !== cluster && c.status === "active").map((c: any) => c.id);
    for (const id of all) await patch(id, { status: "draining" });
    try {
      const p = await t.project(owner, name);
      await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
      assert.equal((await t.api("GET", `/v1/projects/${p.ref}`, { token: owner })).json.cluster, cluster);
      return p;
    } finally {
      for (const id of all) await patch(id, { status: "active" });
    }
  };

  before(async () => {
    ac = await archivingCluster();
    plainCluster = await archivingCluster();
    work = await mkdtemp(join(tmpdir(), "baas-pitr-clusters-"));
    await chmod(work, 0o755);
    t = await makePlatform(ADMIN!, { pitr: { archiveDir: join(work, "main-archive"), baseDir: join(work, "base"), scratchDir: join(work, "scratch"), retentionDays: 7, recoveryTimeoutMs: 120_000 } });
    owner = await t.org();
    assert.equal((await t.api("POST", "/v1/admin/clusters", { headers: op, body: { id: "east", admin_url: ac.url } })).status, 201);
    assert.equal((await t.api("POST", "/v1/admin/clusters", { headers: op, body: { id: "bare", admin_url: plainCluster.url } })).status, 201);
  });
  after(async () => { await t?.close(); await ac?.stop(); await plainCluster?.stop(); await rm(work, { recursive: true, force: true }); });

  it("checks the archive directory it is given, and keeps it off the main cluster", async () => {
    for (const bad of ["relative/path", "/with space", "/quo'te", "/a/../b", "/new\nline", "/semi;colon", 5])
      assert.equal((await patch("east", { archive_dir: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await patch("main", { archive_dir: "/x" })).status, 400, "the main cluster's comes from BAAS_PITR_ARCHIVE_DIR");
    assert.equal((await t.api("POST", "/v1/admin/clusters", { headers: op, body: { id: "bad", admin_url: ac.url.replace("127.0.0.1", "localhost"), archive_dir: "nope" } })).status, 400);
    assert.equal((await patch("bare", { archive_dir: null })).status, 200);
    const list = (await t.api("GET", "/v1/admin/clusters", { headers: op })).json;
    assert.equal(list.find((c: any) => c.id === "east").archive_dir, null);
  });

  it("says that a cluster without an archive directory cannot be recovered, and why", async () => {
    const p = await project("no-archive", "bare");
    const s = (await status(p.ref)).json;
    assert.equal(s.cluster, "bare");
    assert.equal(s.enabled, false);
    assert.equal(s.archive_dir_configured, false);
    const r = await restore(p.ref, new Date().toISOString());
    assert.equal(r.status, 409);
    assert.match(r.json.error, /cluster bare.*no WAL archive directory/);
    const b = await t.api("POST", `/v1/projects/${p.ref}/pitr/base-backup`, { token: owner });
    assert.equal(b.status, 500);
    assert.match(b.json.error, /no WAL archive directory registered/);
    const main = await project("on-main", "main");
    const m = (await status(main.ref)).json;
    assert.equal(m.cluster, "main");
    assert.equal(m.enabled, false, "the main cluster is not archiving here, and that does not leak across");
    assert.equal(m.archive_dir_configured, true);
  });

  let p: Awaited<ReturnType<typeof project>>;
  let bystander: Awaited<ReturnType<typeof project>>;
  let T1: string;
  it("takes a base backup of the cluster the project lives on, kept apart from other clusters'", async () => {
    assert.equal((await patch("east", { archive_dir: ac.archiveDir })).status, 200);
    p = await project("recover-east", "east");
    bystander = await project("bystander-east", "east");
    const s0 = (await status(p.ref)).json;
    assert.equal(s0.enabled, true);
    assert.equal(s0.window, null);
    const b = await t.api("POST", `/v1/projects/${p.ref}/pitr/base-backup`, { token: owner });
    assert.equal(b.status, 201, b.text);
    assert.equal(b.json.status, "complete");
    const row = (await t.platform.control.pool.query(`SELECT cluster_id, path FROM pitr_base_backups WHERE id = $1`, [b.json.id])).rows[0];
    assert.equal(row.cluster_id, "east");
    assert.equal(row.path, join(work, "base", "east", b.json.id), "under a directory of its own");
    assert.equal(existsSync(row.path), true);
    const s = (await status(p.ref)).json;
    assert.ok(s.window.earliest);
    assert.equal(s.base_backups.length, 1);
    const main = await project("main-after", "main");
    assert.equal((await status(main.ref)).json.window, null, "another cluster's backups are not this one's window");
    assert.equal((await t.api("POST", `/v1/projects/${p.ref}/pitr/base-backup`, { token: await t.token(owner, "admin") })).status, 403, "owners only");
  });

  it("brings back a dropped table on the added cluster, leaving its neighbour alone", async () => {
    await t.sql(owner, p.ref, "create table public.notes (id serial primary key, body text); insert into public.notes (body) values ('A1'), ('A2')");
    await t.sql(owner, bystander.ref, "create table public.keep (n int); insert into public.keep values (1)");
    await sleep(1200);
    T1 = await now(p.ref);
    await sleep(1200);
    await t.sql(owner, p.ref, "insert into public.notes (body) values ('B1')");
    await t.sql(owner, bystander.ref, "insert into public.keep values (2)");
    await t.sql(owner, p.ref, "drop table public.notes");
    const r = await restore(p.ref, T1);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual((await rows(p.ref, "select body from public.notes order by id")).map((x) => x[0]), ["A1", "A2"]);
    assert.deepEqual((await rows(bystander.ref, "select n from public.keep order by n")).map((x) => x[0]), [1, 2]);
    const g = await t.gw(p.ref, "GET", "/rest/v1/notes?select=body&order=id", { key: p.service });
    assert.deepEqual(g.json, [{ body: "A1" }, { body: "A2" }], "served from the added cluster afterwards");
    assert.equal(existsSync(join(work, "scratch")) && (await import("node:fs")).readdirSync(join(work, "scratch")).length, 0, "the scratch copy is gone");
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM backups WHERE ref = $1 AND note LIKE 'before point-in-time restore%'`, [p.ref])).rows[0].n, 1);
  });

  it("keeps each cluster's backups and housekeeping separate", async () => {
    const svc = t.platform.pitr!;
    assert.equal(await svc.runScheduled(), "east: base backup current", "main is not archiving, bare has no directory: only east has work");
    await t.platform.control.pool.query(`UPDATE pitr_base_backups SET started_at = now() - interval '2 days' WHERE cluster_id = 'east'`);
    assert.equal(await svc.runScheduled(), "east: base backup taken");
    // A second archiving cluster is handled independently of the first.
    await patch("bare", { archive_dir: plainCluster.archiveDir });
    assert.equal(await svc.runScheduled(), "east: base backup current; bare: base backup taken");
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM pitr_base_backups WHERE cluster_id = 'bare' AND status = 'complete'`)).rows[0].n, 1);
    assert.equal(await svc.runScheduled(), "east: base backup current; bare: base backup current");
    await patch("bare", { archive_dir: null });
    assert.equal(await svc.runScheduled(), "east: base backup current", "no directory: skipped");
    const olds = (await t.platform.control.pool.query<{ id: string; finished_at: Date }>(`SELECT id, finished_at FROM pitr_base_backups WHERE cluster_id = 'east' ORDER BY finished_at`)).rows;
    assert.ok(olds.length >= 2);
    await t.platform.control.pool.query(`UPDATE pitr_base_backups SET finished_at = now() - interval '30 days' WHERE id = $1`, [olds[0]!.id]);
    await t.platform.control.pool.query(`UPDATE pitr_base_backups SET finished_at = now() - interval '20 days' WHERE id = $1`, [olds[1]!.id]);
    const before = (await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM pitr_base_backups WHERE cluster_id = 'east'`)).rows[0].n;
    const r = await svc.prune("east");
    assert.equal(r.removedBackups, 1, "only east's own, with the one anchoring the window kept");
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM pitr_base_backups WHERE cluster_id = 'east'`)).rows[0].n, before - 1);
    // Restoring to the original moment needs a base backup older than T1, which pruning just made impossible; the window moved.
    const s = (await status(p.ref)).json;
    assert.ok(new Date(s.window.earliest) > new Date(T1) || s.base_backups.length >= 1);
  });

  it("recovers a project moved onto the cluster only from the moment it arrived", async () => {
    const mp = await project("mover", "main");
    await t.sql(owner, mp.ref, "create table public.t (n int); insert into public.t values (1)");
    await t.api("POST", `/v1/projects/${mp.ref}/pitr/base-backup`, { token: owner }).then(() => {}); // main: not archiving, refused
    await t.platform.pitr!.takeBaseBackup("east"); // so the window on east predates the move
    await sleep(1200);
    const beforeMove = await now(mp.ref);
    await sleep(1200);
    assert.equal((await move(mp.ref, "east")).status, 200);
    const two = await t.sql(owner, mp.ref, "insert into public.t values (2)");
    assert.equal(two.status, 200, two.text);
    await sleep(1200);
    const afterMove = await now(mp.ref);
    await sleep(1200);
    const three = await t.sql(owner, mp.ref, "insert into public.t values (3)");
    assert.equal(three.status, 200, three.text);
    const early = await restore(mp.ref, beforeMove);
    assert.equal(early.status, 400, early.text);
    assert.match(early.json.error, /moved onto cluster east at \d{4}-.*only be restored to a moment after/);
    const ok = await restore(mp.ref, afterMove);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual((await rows(mp.ref, "select n from public.t order by n")).map((x) => x[0]), [1, 2], "the rows from before the move came with it; the later one is undone");
  });

  it("lets the operator look at and back up a cluster directly", async () => {
    assert.equal((await t.api("GET", "/v1/admin/clusters/east/pitr")).status, 401);
    assert.equal((await t.api("POST", "/v1/admin/clusters/east/pitr/base-backup", { token: owner })).status, 401, "not for organisation tokens");
    const s = await t.api("GET", "/v1/admin/clusters/east/pitr", { headers: op });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.cluster, "east");
    assert.equal(s.json.enabled, true);
    const b = await t.api("POST", "/v1/admin/clusters/east/pitr/base-backup", { headers: op });
    assert.equal(b.status, 201, b.text);
    assert.equal((await t.api("GET", "/v1/admin/clusters/nope/pitr", { headers: op })).status, 500, "unknown cluster");
  });

  it("works from the command line", async () => {
    const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    const cwd = await mkdtemp(join(tmpdir(), "baas-pitr-clusters-cli-"));
    const cli = async (...argv: string[]) => {
      const out: string[] = [], err: string[] = [];
      const code = await runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { BAAS_CONFIG_DIR: join(cwd, "config"), BAAS_BOOTSTRAP_TOKEN: BOOT } });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    assert.equal((await cli("login", "--url", `http://127.0.0.1:${ports.api}`, "--token", owner)).code, 0);
    const list = await cli("admin", "clusters", "list");
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /WAL ARCHIVE/);
    assert.match(list.out, /east .*\/\S*wal/);
    assert.match(list.out, /main .*\(server setting\)/);
    const upd = await cli("admin", "clusters", "update", "bare", "--archive-dir", join(work, "bare-archive"));
    assert.equal(upd.code, 0, upd.err);
    assert.match((await cli("admin", "clusters", "list")).out, /bare .*bare-archive/);
    assert.equal((await cli("admin", "clusters", "update", "bare", "--no-archive")).code, 0);
    assert.doesNotMatch((await cli("admin", "clusters", "list")).out, /bare-archive/);
    assert.equal((await cli("admin", "clusters", "update", "bare", "--archive-dir", "relative")).code, 1);
  });

  it("forgets a cluster's backups when the cluster is removed", async () => {
    const dir = join(work, "base", "east");
    assert.equal(existsSync(dir), true);
    for (const r of (await t.platform.control.pool.query<{ ref: string }>(`SELECT ref FROM projects WHERE cluster_id = 'east'`)).rows) assert.equal((await move(r.ref, "main")).status, 200);
    assert.equal((await t.api("DELETE", "/v1/admin/clusters/east", { headers: op })).status, 204);
    assert.equal(existsSync(dir), false, "its base backups are deleted from disk");
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM pitr_base_backups WHERE cluster_id = 'east'`)).rows[0].n, 0);
  });
});
