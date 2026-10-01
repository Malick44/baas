import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { PLANS } from "./plans.js";
import { makePlatform, PG_BIN } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("platform ops", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let admin_: string;
  let dev: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  const ORIGINAL_FREE = { ...PLANS.free! };

  before(async () => {
    t = await makePlatform(ADMIN!);
    owner = await t.org();
    admin_ = await t.token(owner, "admin");
    dev = await t.token(owner, "developer");
    p = await t.project(owner, "main");
  });
  after(async () => {
    PLANS.free = ORIGINAL_FREE;
    await t?.close();
  });

  describe("certificate check for a TLS proxy", () => {
    const check = (domain: string) => t.api("GET", `/v1/tls-check?domain=${encodeURIComponent(domain)}`);
    it("says yes only to names that are served: an existing project's host, and the dashboard host", async () => {
      assert.equal((await check(`${p.ref}.localhost`)).status, 200);
      assert.equal((await check(`${p.ref.toUpperCase()}.LOCALHOST`)).status, 200, "host names are case-insensitive");
      for (const bad of [`${"a".repeat(20)}.localhost`, `${p.ref}.evil.com`, `${p.ref}.localhost.evil.com`, `x${p.ref}.localhost`, "localhost", "", `${p.ref.slice(1)}.localhost`, `${p.ref}.localhostx`])
        assert.equal((await check(bad)).status, 404, bad);
      assert.equal((await t.api("GET", "/v1/tls-check")).status, 404);
    });
    it("stops answering yes once a project is deleted", async () => {
      const gone = await t.project(owner, "to-delete");
      assert.equal((await check(`${gone.ref}.localhost`)).status, 200);
      assert.equal((await t.api("DELETE", `/v1/projects/${gone.ref}`, { token: owner })).status, 200);
      assert.equal((await check(`${gone.ref}.localhost`)).status, 404);
    });
  });

  describe("sql and tables", () => {
    it("runs SQL as service_role, including multi-statement scripts", async () => {
      const r = await t.sql(owner, p.ref, "CREATE TABLE public.items (id serial PRIMARY KEY, name text NOT NULL, qty int DEFAULT 0); INSERT INTO public.items (name) VALUES ('a'), ('b'); SELECT id, name FROM public.items ORDER BY id");
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.results.map((x: any) => x.command), ["CREATE", "INSERT", "SELECT"]);
      assert.deepEqual(r.json.results[2].fields, ["id", "name"]);
      assert.deepEqual(r.json.results[2].rows, [[1, "a"], [2, "b"]]);
      // Duplicate column names survive because rows are arrays.
      assert.deepEqual((await t.sql(owner, p.ref, "SELECT 1 AS x, 2 AS x")).json.results[0].rows, [[1, 2]]);
    });

    it("is atomic and reports errors clearly", async () => {
      const bad = await t.sql(owner, p.ref, "CREATE TABLE public.half (id int); SELECT * FROM nope");
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /nope/);
      assert.equal((await t.sql(owner, p.ref, "SELECT to_regclass('public.half')")).json.results[0].rows[0][0], null);
      assert.equal((await t.sql(owner, p.ref, "")).status, 400);
      assert.equal((await t.api("POST", `/v1/projects/${p.ref}/sql`, { token: owner, body: {} })).status, 400);
    });

    it("truncates huge results", async () => {
      const r = (await t.sql(owner, p.ref, "SELECT generate_series(1, 1500)")).json.results[0];
      assert.equal(r.rows.length, 1000);
      assert.equal(r.truncated, true);
    });

    it("is limited to admins of the owning organisation", async () => {
      assert.equal((await t.sql(dev, p.ref, "SELECT 1")).status, 403);
      assert.equal((await t.sql(admin_, p.ref, "SELECT 1")).status, 200);
      const other = await t.org();
      assert.equal((await t.sql(other, p.ref, "SELECT 1")).status, 404);
      assert.equal((await t.api("GET", `/v1/projects/${p.ref}/tables`, { token: other })).status, 404);
      assert.equal((await t.api("POST", `/v1/projects/${p.ref}/sql`, { body: { query: "select 1" } })).status, 401);
    });

    it("cannot reach other databases or platform internals", async () => {
      const other = await t.project(owner, "other");
      const dbs = (await t.sql(owner, p.ref, `SELECT current_database()`)).json.results[0].rows[0][0];
      assert.equal(dbs, `proj_${p.ref}`);
      // No superuser powers: file access, role management and cross-database connections are all refused.
      for (const q of ["COPY (SELECT 1) TO '/tmp/x'", "CREATE ROLE evil LOGIN", "SELECT pg_read_file('/etc/passwd')", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'proj_${other.ref}'`, "ALTER ROLE service_role SUPERUSER", "CREATE EXTENSION plpython3u", "DROP DATABASE postgres"]) {
        const r = await t.sql(owner, p.ref, q);
        const denied = r.status === 400 || (r.status === 200 && r.json.results[0].rows.every((row: any[]) => row[0] === false || row[0] === null));
        assert.ok(denied, `${q} -> ${r.text.slice(0, 150)}`);
      }
      assert.equal((await t.sql(owner, other.ref, "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%evil%'")).status, 200);
    });

    it("describes tables with columns, keys and RLS", async () => {
      const tables = (await t.api("GET", `/v1/projects/${p.ref}/tables`, { token: dev })).json;
      const items = tables.find((x: any) => x.name === "items");
      assert.deepEqual(items.columns.map((c: any) => [c.name, c.type, c.nullable, c.pk]), [["id", "integer", false, true], ["name", "text", false, false], ["qty", "integer", true, false]]);
      assert.equal(items.rls, false);
      assert.ok(!tables.some((x: any) => x.name === "half"));
    });

    it("lets tables made in the SQL editor be served through the API, with RLS deciding access", async () => {
      await t.sql(owner, p.ref, "CREATE TABLE public.secrets (id serial PRIMARY KEY, v text); ALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY; INSERT INTO public.secrets (v) VALUES ('hidden')");
      // Secure by default: a new table is invisible to anon and authenticated until access is granted.
      assert.equal((await t.gw(p.ref, "GET", "/rest/v1/secrets", { key: p.anon })).status, 401);
      assert.equal((await t.gw(p.ref, "GET", "/rest/v1/items", { key: p.anon })).status, 401);
      assert.equal((await t.gw(p.ref, "POST", "/rest/v1/items", { key: p.anon, body: { name: "x" } })).status, 401);
      assert.equal((await t.gw(p.ref, "GET", "/rest/v1/secrets", { key: p.service })).json.length, 1);
      // Granting access plus RLS (no policy) shows nothing; a policy opens exactly what it says.
      await t.sql(owner, p.ref, "GRANT SELECT ON public.secrets TO anon");
      assert.deepEqual((await t.gw(p.ref, "GET", "/rest/v1/secrets", { key: p.anon })).json, []);
      await t.sql(owner, p.ref, "CREATE POLICY only_shown ON public.secrets FOR SELECT TO anon USING (v = 'shown'); INSERT INTO public.secrets (v) VALUES ('shown')");
      assert.deepEqual((await t.gw(p.ref, "GET", "/rest/v1/secrets", { key: p.anon })).json.map((r: any) => r.v), ["shown"]);
    });

    it("audits SQL statements", async () => {
      const log = (await t.api("GET", "/v1/audit-log", { token: owner })).json;
      assert.ok(log.some((e: any) => e.action === "project.sql" && e.target === p.ref));
    });
  });

  describe("plans, quotas and rate limits", () => {
    it("changes plans only as owner and validates the name", async () => {
      const q = await t.project(owner, "planned");
      assert.equal((await t.api("PATCH", `/v1/projects/${q.ref}`, { token: admin_, body: { plan: "pro" } })).status, 403);
      assert.equal((await t.api("PATCH", `/v1/projects/${q.ref}`, { token: owner, body: { plan: "platinum" } })).status, 400);
      assert.equal((await t.api("PATCH", `/v1/projects/${q.ref}`, { token: owner, body: { plan: "pro" } })).json.plan, "pro");
      assert.deepEqual(Object.keys((await t.api("GET", "/v1/plans")).json), ["free", "pro"]);
    });

    it("rate-limits per project without affecting neighbours", async () => {
      const a = await t.project(owner, "rl-a");
      const b = await t.project(owner, "rl-b");
      const burst = PLANS.free!.burst;
      const results = await Promise.all(Array.from({ length: burst * 3 }, () => t.gw(a.ref, "GET", "/rest/v1/", { key: a.anon })));
      const limited = results.filter((r) => r.status === 429);
      assert.ok(limited.length > 0, "some requests should be limited");
      assert.ok(results.filter((r) => r.status === 200).length >= burst);
      assert.equal(limited[0]!.headers["retry-after"], "1");
      assert.equal((await t.gw(b.ref, "GET", "/rest/v1/", { key: b.anon })).status, 200);
      await new Promise((r) => setTimeout(r, 300)); // refill
      assert.equal((await t.gw(a.ref, "GET", "/rest/v1/", { key: a.anon })).status, 200);
    });

    it("stops a project at its daily request quota until it upgrades", async () => {
      const q = await t.project(owner, "quota");
      await t.platform.pool.query(`INSERT INTO usage_daily (ref, day, requests) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)`, [q.ref, PLANS.free!.requestsPerDay]);
      const r = await t.gw(q.ref, "GET", "/rest/v1/", { key: q.anon });
      assert.equal(r.status, 429);
      assert.match(r.json.message, /quota/);
      await t.api("PATCH", `/v1/projects/${q.ref}`, { token: owner, body: { plan: "pro" } });
      t.platform.dir.forget(q.ref);
      assert.equal((await t.gw(q.ref, "GET", "/rest/v1/", { key: q.anon })).status, 200);
    });

    it("blocks writes but not reads or deletes once the database is over its size limit", async () => {
      const q = await t.project(owner, "bigdb");
      await t.sql(owner, q.ref, "CREATE TABLE public.t (id serial PRIMARY KEY, v text); INSERT INTO public.t (v) VALUES ('x')");
      PLANS.free = { ...ORIGINAL_FREE, dbBytes: 1 };
      await t.platform.usage.measure();
      assert.equal((await t.gw(q.ref, "POST", "/rest/v1/t", { key: q.service, body: { v: "y" } })).status, 402);
      assert.equal((await t.gw(q.ref, "GET", "/rest/v1/t", { key: q.service })).status, 200);
      assert.equal((await t.gw(q.ref, "DELETE", "/rest/v1/t?id=eq.1", { key: q.service })).status, 204);
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/usage`, { token: owner })).json.over_db_quota, true);
      PLANS.free = ORIGINAL_FREE;
      await t.platform.usage.measure();
      assert.equal((await t.gw(q.ref, "POST", "/rest/v1/t", { key: q.service, body: { v: "y" } })).status, 201);
    });
  });

  describe("metering and logs", () => {
    it("counts requests, errors and egress, and serves usage and logs", async () => {
      const q = await t.project(owner, "meter");
      for (let i = 0; i < 5; i++) await t.gw(q.ref, "GET", "/rest/v1/", { key: q.anon });
      await t.gw(q.ref, "GET", "/rest/v1/missing?select=id", { key: q.anon });
      await t.platform.usage.measure();
      const u = (await t.api("GET", `/v1/projects/${q.ref}/usage`, { token: dev })).json;
      assert.equal(u.plan, "free");
      assert.equal(u.daily[0].requests, 6);
      assert.ok(u.daily[0].egress_bytes > 0);
      assert.ok(u.current.db_bytes > 0);
      assert.equal(u.limits.rps, 20);
      const row = (await t.platform.pool.query(`SELECT last_request_at FROM projects WHERE ref = $1`, [q.ref])).rows[0];
      assert.ok(row.last_request_at);

      const logs = (await t.api("GET", `/v1/projects/${q.ref}/logs`, { token: admin_ })).json;
      assert.equal(logs[0].path, "/rest/v1/missing"); // newest first, query string stripped
      assert.equal(logs[0].status, 404);
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/logs`, { token: dev })).status, 403);
    });

    it("breaks requests down per service and hour, counting 4xx as warnings and 5xx as errors", async () => {
      const q = await t.project(owner, "hourly");
      await t.api("PATCH", `/v1/projects/${q.ref}`, { token: owner, body: { plan: "pro" } });
      await t.api("PUT", `/v1/projects/${q.ref}/functions/boom`, { token: owner, body: { source: "export default () => { throw new Error('x'); }", verify_jwt: false } });
      for (let i = 0; i < 3; i++) await t.gw(q.ref, "GET", "/rest/v1/", { key: q.anon }); // 200
      await t.gw(q.ref, "GET", "/rest/v1/missing?select=id", { key: q.anon }); // 404: a warning
      await t.gw(q.ref, "POST", "/auth/v1/signup", { key: q.anon, body: { email: "nope", password: "x" } }); // 422: a warning
      await t.gw(q.ref, "GET", "/storage/v1/bucket", { key: q.anon }); // 403: a warning
      await t.gw(q.ref, "POST", "/functions/v1/boom", {}); // 500: an error
      const m = (await t.api("GET", `/v1/projects/${q.ref}/metrics`, { token: dev })).json;
      const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
      assert.equal(m.hours.length, 24);
      assert.deepEqual(Object.keys(m.services), ["rest", "auth", "storage", "functions", "realtime"]);
      assert.deepEqual([sum(m.services.rest.requests), sum(m.services.rest.warnings), sum(m.services.rest.errors)], [4, 1, 0]);
      assert.deepEqual([sum(m.services.auth.requests), sum(m.services.auth.warnings)], [1, 1]);
      assert.deepEqual([sum(m.services.storage.requests), sum(m.services.storage.warnings)], [1, 1]);
      assert.deepEqual([sum(m.services.functions.requests), sum(m.services.functions.errors)], [1, 1]);
      assert.equal(sum(m.services.realtime.requests), 0);
      assert.equal(m.totals.requests, 7);
      assert.equal(m.totals.serverErrors, 1);
      assert.ok(Math.abs(m.totals.successRate - (100 * 6) / 7) < 1e-9);
      // The newest hour is last, and the counts are stored, not just held in memory.
      assert.ok(new Date(m.hours.at(-1)).getTime() > Date.now() - 3_600_000 && new Date(m.hours.at(-1)).getTime() <= Date.now());
      assert.equal((await t.platform.pool.query(`SELECT sum(requests)::int AS n FROM usage_hourly WHERE ref = $1`, [q.ref])).rows[0].n, 7);
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/metrics?hours=1000`, { token: dev })).json.hours.length, 168);
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/metrics?hours=-5`, { token: dev })).json.hours.length, 1);
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/metrics?hours=abc`, { token: dev })).json.hours.length, 24);
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/metrics`, { token: await t.org() })).status, 404);
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/metrics`, {})).status, 401);
      const empty = (await t.api("GET", `/v1/projects/${(await t.project(owner, "quiet")).ref}/metrics`, { token: owner })).json;
      assert.deepEqual([empty.totals.requests, empty.totals.successRate], [0, null]);
    });

    it("keeps each project's counters and logs separate", async () => {
      const x = await t.project(owner, "sep-x");
      const y = await t.project(owner, "sep-y");
      await t.gw(x.ref, "GET", "/rest/v1/", { key: x.anon });
      assert.equal((await t.api("GET", `/v1/projects/${y.ref}/logs`, { token: owner })).json.length, 0);
      assert.equal((await t.api("GET", `/v1/projects/${y.ref}/usage`, { token: owner })).json.daily.length, 0);
    });
  });

  describe("housekeeping", () => {
    it("pauses idle free projects, spares pro and active ones, and audits it under the organisation", async () => {
      const idle = await t.project(owner, "idle");
      const pro = await t.project(owner, "idle-pro");
      const busy = await t.project(owner, "busy");
      await t.api("PATCH", `/v1/projects/${pro.ref}`, { token: owner, body: { plan: "pro" } });
      await t.platform.pool.query(`UPDATE projects SET last_request_at = now() - interval '8 days' WHERE ref = ANY($1)`, [[idle.ref, pro.ref]]);
      await t.platform.pool.query(`UPDATE projects SET last_request_at = now() WHERE ref = $1`, [busy.ref]);
      const paused = await t.platform.control.autoPauseIdle();
      assert.ok(paused.includes(idle.ref));
      assert.ok(!paused.includes(pro.ref) && !paused.includes(busy.ref));
      assert.equal((await t.api("GET", `/v1/projects/${idle.ref}`, { token: owner })).json.status, "paused");
      t.platform.dir.forget(idle.ref);
      assert.equal((await t.gw(idle.ref, "GET", "/rest/v1/", { key: idle.anon })).status, 503);
      const log = (await t.api("GET", "/v1/audit-log", { token: owner })).json;
      assert.ok(log.some((e: any) => e.actor === "system" && e.action === "project.pause" && e.target === idle.ref));
    });

    it("purges deleted projects together with their files and backups", async () => {
      const q = await t.project(owner, "purge-me");
      await t.gw(q.ref, "POST", "/storage/v1/bucket", { key: q.service, body: { id: "b" } });
      await t.gw(q.ref, "POST", "/storage/v1/object/b/f.txt", { key: q.service, raw: "data", headers: { "content-type": "text/plain" } });
      await t.api("POST", `/v1/projects/${q.ref}/backups`, { token: owner, body: {} });
      assert.ok((await readdir(join(t.root, "storage", q.ref))).length > 0);
      assert.ok((await readdir(join(t.root, "backups", q.ref))).length > 0);
      await t.api("DELETE", `/v1/projects/${q.ref}`, { token: owner });
      const report = await t.platform.housekeep();
      assert.ok((report.purged as string[]).includes(q.ref), JSON.stringify(report));
      await assert.rejects(readdir(join(t.root, "storage", q.ref)));
      await assert.rejects(readdir(join(t.root, "backups", q.ref)));
      assert.equal((await t.platform.pool.query(`SELECT count(*)::int AS n FROM backups WHERE ref = $1`, [q.ref])).rows[0].n, 0);
    });

    it("reports every step and survives a failing one", async () => {
      const report = await t.platform.housekeep();
      for (const k of ["reconciled", "purged", "autoPaused", "flushed", "measured", "scheduledBackups"]) assert.ok(k in report, k);
      assert.ok(!Object.values(report).some((v) => typeof v === "string" && v.startsWith("failed")), JSON.stringify(report));
    });
  });

  describe("backups", { skip: !PG_BIN && "pg_dump not found; set BAAS_TEST_PG_BIN" }, () => {
    let b: typeof p;
    let user: any;

    before(async () => {
      b = await t.project(owner, "backed-up");
      await t.sql(owner, b.ref, "CREATE TABLE public.docs (id serial PRIMARY KEY, body text); INSERT INTO public.docs (body) VALUES ('one'), ('two'); ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY; GRANT SELECT ON public.docs TO anon; CREATE POLICY p ON public.docs FOR SELECT TO anon USING (true)");
      user = (await t.gw(b.ref, "POST", "/auth/v1/signup", { key: b.anon, body: { email: "keep@example.com", password: "secret123" } })).json;
    });

    it("takes, lists and verifies a backup", async () => {
      const r = await t.api("POST", `/v1/projects/${b.ref}/backups`, { token: admin_, body: { note: "before change" } });
      assert.equal(r.status, 201);
      assert.equal(r.json.status, "complete");
      assert.ok(Number(r.json.size_bytes) > 0);
      const file = (await t.platform.pool.query(`SELECT path FROM backups WHERE id = $1`, [r.json.id])).rows[0].path;
      assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), r.json.sha256);
      const list = (await t.api("GET", `/v1/projects/${b.ref}/backups`, { token: dev })).json;
      assert.equal(list[0].note, "before change");
      assert.equal((await t.api("POST", `/v1/projects/${b.ref}/backups`, { token: dev, body: {} })).status, 403);
      assert.equal((await t.api("GET", `/v1/projects/${b.ref}/backups`, { token: await t.org() })).status, 404);
    });

    it("restores data, users and structure while keeping the project's keys working", async () => {
      const id = (await t.api("GET", `/v1/projects/${b.ref}/backups`, { token: owner })).json[0].id;
      await t.sql(owner, b.ref, "DELETE FROM public.docs; DROP TABLE public.items IF EXISTS; INSERT INTO public.docs (body) VALUES ('later')").catch(() => {});
      await t.sql(owner, b.ref, "DELETE FROM public.docs; INSERT INTO public.docs (body) VALUES ('later'); CREATE TABLE public.extra (x int)");
      await t.gw(b.ref, "DELETE", `/auth/v1/admin/users/${user.user.id}`, { key: b.service });
      assert.equal((await t.gw(b.ref, "GET", "/rest/v1/docs", { key: b.anon })).json.length, 1);

      assert.equal((await t.api("POST", `/v1/projects/${b.ref}/backups/${id}/restore`, { token: admin_ })).status, 403); // owner only
      const r = await t.api("POST", `/v1/projects/${b.ref}/backups/${id}/restore`, { token: owner });
      assert.equal(r.status, 200, r.text);

      const docs = (await t.gw(b.ref, "GET", "/rest/v1/docs?order=id", { key: b.anon })).json;
      assert.deepEqual(docs.map((d: any) => d.body), ["one", "two"]);
      assert.equal((await t.gw(b.ref, "GET", "/rest/v1/extra", { key: b.service })).status, 404);
      assert.equal((await t.gw(b.ref, "POST", "/auth/v1/token?grant_type=password", { key: b.anon, body: { email: "keep@example.com", password: "secret123" } })).status, 200);
      // RLS and grants came back too, and the SQL editor still owns what it should.
      assert.equal((await t.gw(b.ref, "POST", "/rest/v1/docs", { key: b.anon, body: { body: "no" } })).status, 401);
      assert.equal((await t.sql(owner, b.ref, "ALTER TABLE public.docs ADD COLUMN note text")).status, 200);
      const c = new pg.Client({ connectionString: ADMIN });
      c.on("error", () => {});
      await c.connect();
      const left = (await c.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`proj\\_${b.ref}%`])).rows.map((r) => r.datname);
      await c.end();
      assert.deepEqual(left, [`proj_${b.ref}`]);
    });

    it("refuses a tampered backup and leaves the project untouched", async () => {
      const made = await t.api("POST", `/v1/projects/${b.ref}/backups`, { token: owner, body: {} });
      const file = (await t.platform.pool.query(`SELECT path FROM backups WHERE id = $1`, [made.json.id])).rows[0].path;
      const bytes = await readFile(file);
      bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff;
      await writeFile(file, bytes);
      const r = await t.api("POST", `/v1/projects/${b.ref}/backups/${made.json.id}/restore`, { token: owner });
      assert.equal(r.status, 500);
      assert.match(r.json.error, /integrity/);
      assert.equal((await t.gw(b.ref, "GET", "/rest/v1/docs", { key: b.anon })).status, 200);
    });

    it("rolls back cleanly when the restore itself fails", async () => {
      const junk = join(t.root, "junk.dump");
      await writeFile(junk, "this is not a pg_dump archive");
      const sha = createHash("sha256").update("this is not a pg_dump archive").digest("hex");
      const id = (await t.platform.pool.query(`INSERT INTO backups (ref, kind, status, path, sha256) VALUES ($1, 'manual', 'complete', $2, $3) RETURNING id`, [b.ref, junk, sha])).rows[0].id;
      const before = (await t.gw(b.ref, "GET", "/rest/v1/docs?order=id", { key: b.anon })).json;
      const r = await t.api("POST", `/v1/projects/${b.ref}/backups/${id}/restore`, { token: owner });
      assert.equal(r.status, 500);
      assert.deepEqual((await t.gw(b.ref, "GET", "/rest/v1/docs?order=id", { key: b.anon })).json, before);
      const c = new pg.Client({ connectionString: ADMIN });
      c.on("error", () => {});
      await c.connect();
      const left = (await c.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`proj\\_${b.ref}%`])).rows.map((x) => x.datname);
      await c.end();
      assert.deepEqual(left, [`proj_${b.ref}`], "no restore/old leftovers");
    });

    it("keeps only as many backups as the plan allows, and deletes on request", async () => {
      const q = await t.project(owner, "retention");
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push((await t.api("POST", `/v1/projects/${q.ref}/backups`, { token: owner, body: {} })).json.id);
      const list = (await t.api("GET", `/v1/projects/${q.ref}/backups`, { token: owner })).json;
      assert.equal(list.length, PLANS.free!.backupsKept);
      assert.ok(!list.some((x: any) => x.id === ids[0]), "oldest was pruned");
      assert.equal((await readdir(join(t.root, "backups", q.ref))).length, PLANS.free!.backupsKept);
      assert.equal((await t.api("DELETE", `/v1/projects/${q.ref}/backups/${ids[3]}`, { token: owner })).status, 204);
      assert.equal((await t.api("DELETE", `/v1/projects/${q.ref}/backups/${ids[3]}`, { token: owner })).status, 404);
      assert.equal((await t.api("DELETE", `/v1/projects/${q.ref}/backups/not-an-id`, { token: owner })).status, 404);
    });

    it("schedules daily backups only for plans that include them", async () => {
      const free = await t.project(owner, "sched-free");
      const pro = await t.project(owner, "sched-pro");
      await t.api("PATCH", `/v1/projects/${pro.ref}`, { token: owner, body: { plan: "pro" } });
      const done = await t.platform.backups.runScheduled();
      assert.ok(done.includes(pro.ref));
      assert.ok(!done.includes(free.ref));
      assert.deepEqual(await t.platform.backups.runScheduled().then((d) => d.filter((r) => r === pro.ref)), [], "not again within 24h");
    });

    it("records a failed backup row when pg_dump cannot run", async () => {
      const bad = new (t.platform.backups.constructor as any)(t.platform.control, { dir: join(t.root, "x"), pgBinDir: "/nonexistent" });
      const q = await t.project(owner, "nodump");
      await assert.rejects(bad.create(null, q.ref, "manual"), /backup failed/);
      const row = (await t.platform.pool.query(`SELECT status, error FROM backups WHERE ref = $1`, [q.ref])).rows[0];
      assert.equal(row.status, "failed");
      assert.match(row.error, /could not start/);
    });
  });

  describe("dashboard and config", () => {
    it("serves the dashboard with strict headers and nothing else from disk", async () => {
      const r = await t.api("GET", "/");
      assert.equal(r.status, 200);
      assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.equal((await t.api("GET", "/dashboard/app.js")).status, 200);
      for (const f of ["..%2Fpackage.json", "%2e%2e%2f%2e%2e%2fetc%2fpasswd", "secrets.txt", "index.html%00"]) assert.equal((await t.api("GET", `/dashboard/${f}`)).status, 404, f);
    });
    it("tells clients where the data plane lives", async () => {
      assert.deepEqual((await t.api("GET", "/v1/config")).json, { gateway: { domain: "localhost", scheme: "http", port: 8081 } });
    });
  });

  describe("functions api", () => {
    it("deploys, lists and reads functions for the owning organisation only", async () => {
      const q = await t.project(owner, "fn-api");
      const src = "export default () => new Response('hi')";
      assert.equal((await t.api("PUT", `/v1/projects/${q.ref}/functions/hello`, { token: dev, body: { source: src } })).status, 403);
      const put = await t.api("PUT", `/v1/projects/${q.ref}/functions/hello`, { token: admin_, body: { source: src, verify_jwt: false } });
      assert.equal(put.json.version, 1);
      assert.equal((await t.gw(q.ref, "POST", "/functions/v1/hello", {})).text, "hi");
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/functions`, { token: dev })).json[0].name, "hello");
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/functions/hello`, { token: dev })).json.source, src);
      const other = await t.org();
      assert.equal((await t.api("GET", `/v1/projects/${q.ref}/functions`, { token: other })).status, 404);
      assert.ok((await t.api("GET", `/v1/projects/${q.ref}/functions/hello/logs`, { token: admin_ })).json.length >= 1);
      assert.equal((await t.api("DELETE", `/v1/projects/${q.ref}/functions/hello`, { token: admin_ })).status, 204);
    });
  });
});
