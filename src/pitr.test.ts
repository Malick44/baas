import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runCli } from "./cli.js";
import { archivingCluster, HAVE_SERVER_BINARIES } from "./pitr-testkit.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
// On CI the binaries must be there: a skipped recovery test is not a passing one.
if (process.env.CI && !HAVE_SERVER_BINARIES) throw new Error("point-in-time recovery tests need the Postgres server binaries (initdb, postgres, pg_basebackup, pg_archivecleanup)");

describe("point-in-time recovery", { skip: !HAVE_SERVER_BINARIES && "needs Postgres server binaries (BAAS_TEST_PG_BIN)" }, () => {
  let cluster: Awaited<ReturnType<typeof archivingCluster>>;
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let work: string;
  let owner: string;
  let p: Awaited<ReturnType<typeof t.project>>;
  let other: Awaited<ReturnType<typeof t.project>>;

  const rows = async (ref: string, q: string): Promise<any[][]> => {
    const j = (await t.sql(owner, ref, q)).json;
    return (Array.isArray(j) ? j : j.results).at(-1).rows;
  };
  const now = async () => ((await rows(p.ref, "select clock_timestamp()::timestamptz")))[0]![0] as string;
  const pitr = (ref: string, path = "") => t.api("GET", `/v1/projects/${ref}/pitr${path}`, { token: owner });
  const restore = (ref: string, to: string, token = owner) => t.api("POST", `/v1/projects/${ref}/pitr/restore`, { token, body: { to } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    cluster = await archivingCluster();
    work = await mkdtemp(join(tmpdir(), "baas-pitr-work-"));
    await chmod(work, 0o755); // when the tests run as root the recovery server runs as another user, which must be able to get in
    t = await makePlatform(cluster.url, { pitr: { archiveDir: cluster.archiveDir, baseDir: join(work, "base"), scratchDir: join(work, "scratch"), retentionDays: 7, recoveryTimeoutMs: 120_000 } });
    owner = await t.org();
    p = await t.project(owner, "recover-me");
    other = await t.project(owner, "bystander");
    for (const ref of [p.ref, other.ref]) await t.api("PATCH", `/v1/projects/${ref}`, { token: owner, body: { plan: "pro" } });
  });
  after(async () => { await t?.close(); await cluster?.stop(); await rm(work, { recursive: true, force: true }); });

  it("reports that archiving is on, and that there is nothing to restore from yet", async () => {
    const s = (await pitr(p.ref)).json;
    assert.equal(s.enabled, true);
    assert.equal(s.archive_mode, "on");
    assert.equal(s.window, null);
    assert.equal(s.plan_allows, true);
    const early = await restore(p.ref, new Date().toISOString());
    assert.equal(early.status, 400);
    assert.match(early.json.error, /no base backup/);
  });

  it("takes a base backup, which opens the window", async () => {
    const b = await t.api("POST", `/v1/projects/${p.ref}/pitr/base-backup`, { token: owner });
    assert.equal(b.status, 201, b.text);
    assert.equal(b.json.status, "complete");
    assert.ok(Number(b.json.size_bytes) > 1_000_000);
    const s = (await pitr(p.ref)).json;
    assert.ok(s.window.earliest);
    assert.equal(s.base_backups.length, 1);
    assert.equal((await t.api("POST", `/v1/projects/${p.ref}/pitr/base-backup`, { token: await t.token(owner, "admin") })).status, 403, "owners only");
  });

  let T1: string;
  it("brings back a dropped table, exactly as it was at the chosen moment, and leaves other projects alone", async () => {
    await t.sql(owner, p.ref, "create table public.notes (id serial primary key, body text); insert into public.notes (body) values ('A1'), ('A2')");
    await t.sql(owner, other.ref, "create table public.keep (n int); insert into public.keep values (1)");
    await sleep(1200);
    T1 = await now();
    await sleep(1200);
    await t.sql(owner, p.ref, "insert into public.notes (body) values ('B1')");
    await t.sql(owner, other.ref, "insert into public.keep values (2)");
    await t.sql(owner, p.ref, "drop table public.notes"); // the mistake
    assert.equal((await rows(p.ref, "select to_regclass('public.notes')::text"))[0]![0], null);

    const r = await restore(p.ref, T1);
    assert.equal(r.status, 200, r.text);
    assert.equal(new Date(r.json.restored_to).toISOString(), new Date(T1).toISOString());
    assert.deepEqual((await rows(p.ref, "select body from public.notes order by id")).map((x) => x[0]), ["A1", "A2"], "B1 happened after the chosen moment");
    assert.deepEqual((await rows(other.ref, "select n from public.keep order by n")).map((x) => x[0]), [1, 2], "another project is untouched");
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM backups WHERE ref = $1 AND note LIKE 'before point-in-time restore%'`, [p.ref])).rows[0].n, 1, "the state it replaced was saved first");
    const g = await t.gw(p.ref, "GET", "/rest/v1/notes?select=body&order=id", { key: p.service });
    assert.equal(g.status, 200, g.text);
    assert.deepEqual(g.json, [{ body: "A1" }, { body: "A2" }], "the project serves requests after the swap");
    assert.equal(existsSync(join(work, "scratch")) && (await import("node:fs")).readdirSync(join(work, "scratch")).length, 0, "the scratch copy is gone");
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'pitr.restore'`)).rows[0].n, 1);
  });

  it("treats a restore as part of history: later moments include it, earlier ones are still reachable", async () => {
    await t.sql(owner, p.ref, "insert into public.notes (body) values ('C1')");
    await sleep(1200);
    const T2 = await now();
    await sleep(1200);
    await t.sql(owner, p.ref, "insert into public.notes (body) values ('C2')");
    const mid = await restore(p.ref, T2);
    assert.equal(mid.status, 200, mid.text);
    assert.deepEqual((await rows(p.ref, "select body from public.notes order by id")).map((x) => x[0]), ["A1", "A2", "C1"], "after the first restore, then C1, but not C2");
    const back = await restore(p.ref, T1);
    assert.equal(back.status, 200, back.text);
    assert.deepEqual((await rows(p.ref, "select body from public.notes order by id")).map((x) => x[0]), ["A1", "A2"], "a moment before the first restore is still reachable");
    assert.equal((await t.platform.control.pool.query(`SELECT count(*)::int AS n FROM backups WHERE ref = $1 AND note LIKE 'before point-in-time restore%'`, [p.ref])).rows[0].n, 3, "each restore saved what it replaced");
  });

  it("refuses what it cannot do, with a reason", async () => {
    const future = await restore(p.ref, new Date(Date.now() + 3_600_000).toISOString());
    assert.equal(future.status, 400);
    assert.match(future.json.error, /future/);
    assert.equal((await restore(p.ref, "yesterday")).status, 400);
    assert.equal((await t.api("POST", `/v1/projects/${p.ref}/pitr/restore`, { token: owner, body: {} })).status, 400);
    const ancient = await restore(p.ref, "2020-01-01T00:00:00Z");
    assert.equal(ancient.status, 400);
    assert.match(ancient.json.error, /earliest moment that can be restored is \d{4}-/);
    assert.equal((await restore(p.ref, T1, await t.token(owner, "admin"))).status, 403, "owners only");
    assert.equal((await t.api("POST", `/v1/projects/${p.ref}/pitr/restore`, { body: { to: T1 } })).status, 401);

    // A project that did not exist yet at that moment.
    const late = await t.project(owner, "latecomer");
    await t.api("PATCH", `/v1/projects/${late.ref}`, { token: owner, body: { plan: "pro" } });
    const gone = await restore(late.ref, T1);
    assert.equal(gone.status, 400, gone.text);
    assert.match(gone.json.error, /did not exist at that moment/);

    const free = await t.project(owner, "free-tier");
    const no = await restore(free.ref, T1);
    assert.equal(no.status, 403);
    assert.match(no.json.error, /not part of the free plan/);
    await t.api("POST", `/v1/projects/${p.ref}/pause`, { token: owner });
    assert.equal((await restore(p.ref, T1)).status, 409, "a paused project");
    await t.api("POST", `/v1/projects/${p.ref}/resume`, { token: owner });
  });

  it("keeps the base backup that anchors the oldest moment in the window, and removes the ones before it", async () => {
    const svc = t.platform.pitr!;
    const b2 = await svc.takeBaseBackup();
    const b3 = await svc.takeBaseBackup();
    const all = (await t.platform.control.pool.query<{ id: string; path: string }>(`SELECT id, path FROM pitr_base_backups WHERE status = 'complete' ORDER BY finished_at`)).rows;
    assert.equal(all.length, 3);
    const [oldest, middle] = all;
    await t.platform.control.pool.query(`UPDATE pitr_base_backups SET finished_at = now() - interval '20 days' WHERE id = $1`, [oldest!.id]);
    await t.platform.control.pool.query(`UPDATE pitr_base_backups SET finished_at = now() - interval '10 days' WHERE id = $1`, [middle!.id]);
    const r = await svc.prune();
    assert.equal(r.removedBackups, 1);
    assert.equal(existsSync(oldest!.path), false);
    assert.equal(existsSync(middle!.path), true, "still needed to restore to 8 days ago");
    assert.equal(existsSync((await t.platform.control.pool.query(`SELECT path FROM pitr_base_backups WHERE id = $1`, [b2.id])).rows[0].path), true);
    assert.equal((await svc.prune()).removedBackups, 0, "nothing more to do");
  });

  it("takes a fresh base backup only when one is due", async () => {
    const svc = t.platform.pitr!;
    assert.match(await svc.runScheduled(), /base backup current/);
    await t.platform.control.pool.query(`UPDATE pitr_base_backups SET started_at = now() - interval '2 days'`);
    assert.match(await svc.runScheduled(), /base backup taken/);
    const report = await t.platform.housekeep();
    assert.ok(typeof report.pitr === "string" && !String(report.pitr).startsWith("failed"), String(report.pitr));
  });

  it("works from the command line, and will not restore without --yes", async () => {
    const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    const cwd = await mkdtemp(join(tmpdir(), "baas-pitr-cli-"));
    const cfg = join(cwd, "config");
    const cli = async (...argv: string[]) => {
      const out: string[] = [], err: string[] = [];
      const code = await runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { BAAS_CONFIG_DIR: cfg } });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    assert.equal((await cli("login", "--url", `http://127.0.0.1:${ports.api}`, "--token", owner)).code, 0);
    assert.equal((await cli("link", p.ref)).code, 0);
    const st = await cli("pitr", "status");
    assert.match(st.out, /restore to any moment between \S+ and now \(kept 7 days\)/);
    assert.equal((await cli("pitr", "base-backup")).code, 0);
    const T = await now();
    await sleep(1200);
    await t.sql(owner, p.ref, "insert into public.notes (body) values ('after')");
    const refused = await cli("pitr", "restore", "--to", T);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Run again with --yes/);
    assert.equal((await cli("pitr", "restore", "--to", "soon", "--yes")).code, 1);
    const done = await cli("pitr", "restore", "--to", T, "--yes");
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, /Restored \S+ to \S+\. The previous state is saved as backup [0-9a-f-]{36}/);
    assert.equal((await rows(p.ref, "select count(*)::int from public.notes where body = 'after'"))[0]![0], 0);
    assert.equal((await cli("pitr", "nope")).code, 1);
  });

  it("says so, instead of pretending, when the server is not archiving", async () => {
    const plain = await makePlatform(ADMIN ?? cluster.url.replace(/\/postgres$/, "/postgres"), { pitr: { archiveDir: join(work, "nowhere"), baseDir: join(work, "b2"), scratchDir: join(work, "s2") } });
    try {
      const o = await plain.org();
      const pp = await plain.project(o, "plain");
      await plain.api("PATCH", `/v1/projects/${pp.ref}`, { token: o, body: { plan: "pro" } });
      // The shared test server has archive_mode off, unless the operator turned it on.
      const s = (await plain.api("GET", `/v1/projects/${pp.ref}/pitr`, { token: o })).json;
      if (s.enabled) return; // an archiving server: nothing to assert here
      assert.equal(s.window, null);
      assert.equal((await plain.api("POST", `/v1/projects/${pp.ref}/pitr/restore`, { token: o, body: { to: new Date().toISOString() } })).status, 409);
      const b = await plain.api("POST", `/v1/projects/${pp.ref}/pitr/base-backup`, { token: o });
      assert.equal(b.status, 500);
      assert.match(b.json.error, /not switched on/);
      assert.equal((await plain.platform.housekeep()).pitr, "off");
    } finally { await plain.close(); }
  });
});

describe("point-in-time recovery is optional", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  it("is reported as not configured, and plans say who may use it", async () => {
    const t = await makePlatform(ADMIN!);
    try {
      const o = await t.org();
      const p = await t.project(o, "no-pitr");
      const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
      const cwd = await mkdtemp(join(tmpdir(), "baas-pitr-cli2-"));
      const out: string[] = [];
      const run = (...argv: string[]) => runCli(argv, { out: (s) => out.push(s), err: (s) => out.push(s), cwd, env: { BAAS_CONFIG_DIR: join(cwd, "c") } });
      await run("login", "--url", `http://127.0.0.1:${ports.api}`, "--token", o);
      await run("link", p.ref);
      await run("pitr", "status");
      assert.match(out.at(-1)!, /not set up on this server/);
      const s = (await t.api("GET", `/v1/projects/${p.ref}/pitr`, { token: o })).json;
      assert.equal(s.enabled, false);
      assert.equal(s.configured, false);
      assert.equal((await t.api("POST", `/v1/projects/${p.ref}/pitr/restore`, { token: o, body: { to: new Date().toISOString() } })).status, 404, "no such route without the service");
      const plans = (await t.api("GET", "/v1/plans", { token: o })).json;
      assert.equal(plans.free.pitr, false);
      assert.equal(plans.pro.pitr, true);
    } finally { await t.close(); }
  });
});
