import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { runCli } from "./cli.js";
import { BOOT, makePlatform } from "./platform-testkit.js";
import { HAVE_SERVER_BINARIES, startCluster } from "./pitr-testkit.js";
import { setProjectAccess } from "./provision.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
if (process.env.CI && !HAVE_SERVER_BINARIES) throw new Error("multi-cluster tests need the Postgres server binaries (initdb, postgres)");

describe("several Postgres clusters", { skip: (!ADMIN || !HAVE_SERVER_BINARIES) && "needs BAAS_TEST_PG_URL and Postgres server binaries" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let c2: Awaited<ReturnType<typeof startCluster>>;
  let c3: Awaited<ReturnType<typeof startCluster>>;
  let owner: string;
  let work: string;
  const op = { "x-bootstrap-token": BOOT };
  const clusters = () => t.api("GET", "/v1/admin/clusters", { headers: op });
  const add = (body: object) => t.api("POST", "/v1/admin/clusters", { headers: op, body });
  const patch = (id: string, body: object) => t.api("PATCH", `/v1/admin/clusters/${id}`, { headers: op, body });
  const move = (ref: string, cluster: string) => t.api("POST", `/v1/admin/projects/${ref}/move`, { headers: op, body: { cluster } });
  const where = async (ref: string) => (await t.api("GET", `/v1/projects/${ref}`, { token: owner })).json.cluster as string;
  const on = async (url: string, q: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: url });
    c.on("error", () => {});
    await c.connect();
    try { return (await c.query(q, params)).rows; } finally { await c.end(); }
  };
  const hasDb = async (url: string, ref: string) => (await on(url, `select 1 from pg_database where datname = $1`, [`proj_${ref}`])).length === 1;
  const hasRole = async (url: string, ref: string) => (await on(url, `select 1 from pg_roles where rolname = $1`, [`authenticator_${ref}`])).length === 1;
  const rows = async (ref: string, q: string): Promise<any[][]> => {
    const j = (await t.sql(owner, ref, q)).json;
    return (Array.isArray(j) ? j : j.results).at(-1).rows;
  };
  /** Create a project (on the pro plan). Pass a cluster to force the placement by keeping the others out of the running. */
  const project = async (name: string, cluster?: string) => {
    const others = cluster ? (await clusters()).json.filter((c: any) => c.id !== cluster && c.status === "active").map((c: any) => c.id) : [];
    for (const id of others) await patch(id, { status: "draining" });
    try {
      const p = await t.project(owner, name);
      await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
      if (cluster) assert.equal(await where(p.ref), cluster, `${name} should be on ${cluster}`);
      return p;
    } finally {
      for (const id of others) await patch(id, { status: "active" });
    }
  };

  before(async () => {
    c2 = await startCluster();
    c3 = await startCluster();
    work = await mkdtemp(join(tmpdir(), "baas-clusters-"));
    await chmod(work, 0o755);
    t = await makePlatform(ADMIN!);
    owner = await t.org();
  });
  after(async () => { await t?.close(); await c2?.stop(); await c3?.stop().catch(() => {}); await rm(work, { recursive: true, force: true }); });

  it("is for the operator only, and starts with just the main cluster", async () => {
    for (const [m, u, b] of [["GET", "/v1/admin/clusters"], ["POST", "/v1/admin/clusters", {}], ["PATCH", "/v1/admin/clusters/main", {}], ["DELETE", "/v1/admin/clusters/main"], ["POST", "/v1/admin/projects/aaaaaaaaaaaaaaaaaaaa/move", {}]] as const) {
      assert.equal((await t.api(m, u, { body: b })).status, 401, `${m} ${u} without the operator secret`);
      assert.equal((await t.api(m, u, { token: owner, body: b })).status, 401, `${m} ${u} with an organisation token`);
    }
    const l = (await clusters()).json;
    assert.deepEqual(l.map((c: any) => [c.id, c.status, c.max_projects]), [["main", "active", null]]);
    assert.match(l[0].host, /:\d+$/);
    assert.equal(JSON.stringify(l).includes("postgres://"), false, "no connection strings in the answer");
  });

  it("checks a cluster before adding it, and keeps its address sealed", async () => {
    for (const bad of [{}, { id: "main", admin_url: c2.url }, { id: "Bad Id", admin_url: c2.url }, { id: "x".repeat(40), admin_url: c2.url }, { id: "c2" }, { id: "c2", admin_url: "http://x" }, { id: "c2", admin_url: "postgres://localhost:1" }, { id: "c2", admin_url: c2.url, max_projects: 0 }, { id: "c2", admin_url: c2.url, max_projects: "many" }])
      assert.equal((await add(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await add({ id: "same", admin_url: ADMIN })).status, 409, "the main cluster is not a second cluster");
    await on(c2.url, `create role limited login password 'x'`);
    const u = new URL(c2.url); u.username = "limited"; u.password = "x";
    const notSuper = await add({ id: "weak", admin_url: u.toString() });
    assert.equal(notSuper.status, 400);
    assert.match(notSuper.json.error, /superuser/);
    const ok = await add({ id: "c2", name: "Second", admin_url: c2.url });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.name, "Second");
    assert.equal(ok.json.projects, 0);
    assert.equal(JSON.stringify(ok.json).includes("postgres://"), false);
    assert.equal((await add({ id: "c2", admin_url: c2.url })).status, 409);
    const stored = (await t.platform.control.pool.query(`SELECT admin_url_enc FROM clusters WHERE id = 'c2'`)).rows[0].admin_url_enc as string;
    assert.match(stored, /^v1\./, "sealed at rest");
    assert.equal(stored.includes("127.0.0.1"), false);
  });

  it("puts new projects on the least full cluster, and honours limits and draining", async () => {
    const placed: string[] = [];
    for (let i = 0; i < 4; i++) placed.push(await where((await project(`spread-${i}`)).ref));
    assert.ok(placed.includes("c2"), `a project went to the empty cluster: ${placed}`);
    const counts = (await clusters()).json.map((c: any) => [c.id, c.projects]);
    const [main, second] = [counts.find((x: any) => x[0] === "main")[1], counts.find((x: any) => x[0] === "c2")[1]];
    assert.ok(Math.abs(main - second) <= 3, `roughly even: ${JSON.stringify(counts)}`);

    assert.equal((await patch("c2", { max_projects: second })).json.max_projects, second);
    for (let i = 0; i < 2; i++) assert.equal(await where((await project(`after-limit-${i}`)).ref), "main", "a full cluster takes no more");
    assert.equal((await patch("c2", { max_projects: null, status: "draining" })).json.status, "draining");
    assert.equal(await where((await project("while-draining")).ref), "main");
    assert.equal((await patch("c2", { status: "sleeping" })).status, 400);
    assert.equal((await patch("c2", { max_projects: -1 })).status, 400);
    assert.equal((await patch("nope", { status: "active" })).status, 404);
    assert.equal((await patch("main", { admin_url: c2.url })).status, 400, "main's address comes from the environment");
    await patch("main", { status: "draining" });
    const none = await t.api("POST", "/v1/projects", { token: owner, body: { name: "nowhere" } });
    assert.equal(none.status, 503);
    assert.match(none.json.error, /no cluster has room/);
    await patch("main", { status: "active" });
    await patch("c2", { status: "active" });
  });

  let onC2: Awaited<ReturnType<typeof project>>;
  it("serves a project on the second cluster like any other: SQL, REST, auth, storage, functions, backups, metrics", async () => {
    onC2 = await project("lives-on-c2", "c2");
    assert.equal(await hasDb(c2.url, onC2.ref), true);
    assert.equal(await hasDb(ADMIN!, onC2.ref), false, "the database is not on the main cluster");

    await t.sql(owner, onC2.ref, "create table public.items (id serial primary key, name text); insert into public.items (name) values ('one'), ('two'); grant select on public.items to anon");
    const g = (m: string, u: string, o: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) => t.gw(onC2.ref, m, u, { key: o.key ?? onC2.anon, body: o.body, headers: o.headers });
    assert.deepEqual((await g("GET", "/rest/v1/items?select=name&order=id")).json, [{ name: "one" }, { name: "two" }]);
    assert.equal((await g("POST", "/rest/v1/items", { key: onC2.service, body: { name: "three" } })).status, 201);
    const su = await g("POST", "/auth/v1/signup", { body: { email: "c2@example.com", password: "password-123" } });
    assert.equal(su.status, 200, su.text);
    assert.equal((await g("POST", "/auth/v1/token?grant_type=password", { body: { email: "c2@example.com", password: "password-123" } })).status, 200);
    assert.equal((await g("POST", "/storage/v1/bucket", { key: onC2.service, body: { id: "b", name: "b", public: true } })).status, 200);
    const up = await t.platform.gateway.inject({ method: "POST", url: "/storage/v1/object/b/hi.txt", headers: { host: `${onC2.ref}.localhost`, apikey: onC2.service, authorization: `Bearer ${onC2.service}`, "content-type": "text/plain" }, payload: "hello" });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal((await g("GET", "/storage/v1/object/public/b/hi.txt")).text, "hello");
    await t.api("PUT", `/v1/projects/${onC2.ref}/functions/hi`, { token: owner, body: { source: "export default async () => Response.json({ ok: true });" } });
    assert.equal((await g("POST", "/functions/v1/hi", { key: onC2.service })).json.ok, true);

    const bk = await t.api("POST", `/v1/projects/${onC2.ref}/backups`, { token: owner, body: {} });
    assert.equal(bk.status, 201, bk.text);
    await t.sql(owner, onC2.ref, "delete from public.items");
    assert.equal((await t.api("POST", `/v1/projects/${onC2.ref}/backups/${bk.json.id}/restore`, { token: owner, body: {} })).status, 200);
    assert.equal((await rows(onC2.ref, "select count(*)::int from public.items"))[0]![0], 3, "restored on the cluster it lives on");
    assert.equal(await where(onC2.ref), "c2");

    await t.platform.usage.measure();
    const size = Number((await t.platform.control.pool.query(`SELECT db_bytes FROM usage_current WHERE ref = $1`, [onC2.ref])).rows[0].db_bytes);
    assert.ok(size > 1_000_000, "the size comes from the cluster it is on");
  });

  it("pauses, resumes and removes a project on the cluster it lives on", async () => {
    const q = await project("short-lived", "c2");
    assert.equal((await t.api("POST", `/v1/projects/${q.ref}/pause`, { token: owner })).status, 200);
    t.platform.dir.forget(q.ref);
    assert.equal((await t.gw(q.ref, "GET", "/rest/v1/", { key: q.anon })).status, 503);
    assert.equal((await t.api("POST", `/v1/projects/${q.ref}/resume`, { token: owner })).status, 200);
    t.platform.dir.forget(q.ref);
    assert.equal((await t.gw(q.ref, "GET", "/rest/v1/", { key: q.anon })).status, 200);
    assert.equal((await t.api("DELETE", `/v1/projects/${q.ref}`, { token: owner })).status, 200);
    const purged = await t.platform.control.purgeDeleted(0);
    assert.ok(purged.includes(q.ref));
    assert.equal(await hasDb(c2.url, q.ref), false, "removed from c2");
    assert.equal(await hasRole(c2.url, q.ref), false);
  });

  it("moves a project between clusters with its data, users, files and keys intact", async () => {
    const p = await project("traveller", "main");
    await t.sql(owner, p.ref, "create table public.notes (id serial primary key, body text); insert into public.notes (body) values ('a'), ('b'), ('c'); grant select, insert on public.notes to anon, authenticated; grant usage on sequence public.notes_id_seq to anon, authenticated");
    const g = (m: string, u: string, o: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) => t.gw(p.ref, m, u, { key: o.key ?? p.anon, body: o.body, headers: o.headers });
    const user = (await g("POST", "/auth/v1/signup", { body: { email: "trav@example.com", password: "password-123" } })).json;
    const before = await g("GET", "/rest/v1/notes?select=body&order=id");
    assert.equal(before.json.length, 3);

    const r = await move(p.ref, "c2");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { from: "main", to: "c2" });
    assert.equal(await where(p.ref), "c2");
    assert.equal(await hasDb(c2.url, p.ref), true);
    assert.equal(await hasDb(ADMIN!, p.ref), false, "the old copy is gone");
    assert.equal(await hasRole(ADMIN!, p.ref), false);
    assert.equal((await t.platform.control.pool.query(`SELECT moving_to FROM projects WHERE ref = $1`, [p.ref])).rows[0].moving_to, null);

    assert.deepEqual((await g("GET", "/rest/v1/notes?select=body&order=id")).json, before.json, "the same data");
    assert.equal((await g("GET", "/auth/v1/user", { key: user.access_token })).json.email, "trav@example.com", "a token from before the move still works: same keys");
    assert.equal((await g("POST", "/auth/v1/token?grant_type=password", { body: { email: "trav@example.com", password: "password-123" } })).status, 200, "and so does the password");
    assert.equal((await g("POST", "/rest/v1/notes", { key: user.access_token, body: { body: "after" } })).status, 201);
    assert.equal((await on(c2.url.replace(/\/postgres$/, `/proj_${p.ref}`), `select count(*)::int as n from public.notes`))[0].n, 4, "new writes land on the new cluster");

    assert.equal((await move(p.ref, "main")).status, 200, "and back again");
    assert.equal(await where(p.ref), "main");
    assert.equal((await g("GET", "/rest/v1/notes?select=body&order=id")).json.length, 4);
    assert.equal(await hasDb(c2.url, p.ref), false);
  });

  it("refuses moves it should, and leaves the project untouched when one fails", async () => {
    const p = await project("stay-put", "main");
    assert.equal((await move(p.ref, "main")).status, 409, "already there");
    assert.equal((await move(p.ref, "nope")).status, 404);
    assert.equal((await move("aaaaaaaaaaaaaaaaaaaa", "c2")).status, 404);
    assert.equal((await t.api("POST", `/v1/admin/projects/${p.ref}/move`, { headers: op, body: {} })).status, 400);
    await patch("c2", { status: "draining" });
    assert.equal((await move(p.ref, "c2")).status, 409, "a draining cluster takes nothing");
    await patch("c2", { status: "active" });
    await t.api("POST", `/v1/projects/${p.ref}/pause`, { token: owner });
    assert.equal((await move(p.ref, "c2")).status, 409, "a paused project must be resumed first");
    await t.api("POST", `/v1/projects/${p.ref}/resume`, { token: owner });
    t.platform.dir.forget(p.ref);

    await t.platform.control.pool.query(`UPDATE projects SET moving_to = 'c2' WHERE ref = $1`, [p.ref]);
    assert.equal((await move(p.ref, "c2")).status, 409, "already being moved");
    await t.platform.control.pool.query(`UPDATE projects SET moving_to = NULL WHERE ref = $1`, [p.ref]);

    // A target that cannot be reached: the move fails and the project carries on exactly as before.
    await t.sql(owner, p.ref, "create table public.keep (n int); insert into public.keep values (7)");
    assert.equal((await add({ id: "c3", admin_url: c3.url })).status, 201);
    await c3.stop();
    const failed = await move(p.ref, "c3");
    assert.equal(failed.status, 500, failed.text);
    assert.match(failed.json.error, /the project is unchanged/);
    assert.equal(await where(p.ref), "main");
    assert.equal((await t.platform.control.pool.query(`SELECT moving_to FROM projects WHERE ref = $1`, [p.ref])).rows[0].moving_to, null);
    assert.deepEqual(await rows(p.ref, "select n from public.keep"), [[7]]);
    assert.equal((await t.gw(p.ref, "GET", "/rest/v1/", { key: p.anon })).status, 200, "serving again: access was given back");
  });

  it("gives back a project whose move was interrupted", async () => {
    const p = await project("interrupted", "main");
    await t.sql(owner, p.ref, "create table public.t (n int); grant select on public.t to anon");
    assert.equal((await t.gw(p.ref, "GET", "/rest/v1/t", { key: p.anon })).status, 200);
    await setProjectAccess(await t.platform.control.adminUrlFor(p.ref), p.ref, false); // what a move does first; it also drops open connections
    t.platform.dir.forget(p.ref);
    await t.platform.control.pool.query(`UPDATE projects SET moving_to = 'c2', updated_at = now() - interval '1 hour' WHERE ref = $1`, [p.ref]);
    assert.equal((await t.gw(p.ref, "GET", "/rest/v1/t", { key: p.anon })).status, 503, "cut off, as a half-done move would leave it");
    assert.deepEqual(await t.platform.mover.reconcile(60_000), [p.ref]);
    t.platform.dir.forget(p.ref);
    assert.equal((await t.gw(p.ref, "GET", "/rest/v1/t", { key: p.anon })).status, 200);
    assert.equal((await t.platform.control.pool.query(`SELECT moving_to FROM projects WHERE ref = $1`, [p.ref])).rows[0].moving_to, null);
    assert.ok(typeof (await t.platform.housekeep()).movesReconciled === "object");
  });

  it("is managed from the command line with the operator secret", async () => {
    const ports = await t.platform.listen({ api: 0, gateway: 0, host: "127.0.0.1" });
    const cwd = await mkdtemp(join(tmpdir(), "baas-clusters-cli-"));
    const run = async (env: Record<string, string>, ...argv: string[]) => {
      const out: string[] = [], err: string[] = [];
      const code = await runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { BAAS_CONFIG_DIR: join(cwd, "c"), ...env } });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    assert.equal((await run({}, "login", "--url", `http://127.0.0.1:${ports.api}`, "--token", owner)).code, 0);
    const noSecret = await run({}, "admin", "clusters", "list");
    assert.equal(noSecret.code, 1);
    assert.match(noSecret.err, /BAAS_BOOTSTRAP_TOKEN/);
    const op = { BAAS_BOOTSTRAP_TOKEN: BOOT };
    assert.equal((await run({ BAAS_BOOTSTRAP_TOKEN: "wrong-secret-wrong-secret-wrong" }, "admin", "clusters", "list")).code, 1);
    const list = await run(op, "admin", "clusters", "list");
    assert.match(list.out, /ID\s+NAME\s+HOST\s+STATUS\s+PROJECTS\s+LIMIT/);
    assert.match(list.out, /main\s+Primary cluster\s+\S+:\d+\s+active/);
    assert.equal((await run(op, "admin", "clusters", "update", "c2", "--drain", "--max-projects", "50")).code, 0);
    assert.match((await run(op, "admin", "clusters", "list")).out, /c2\s+Second\s+\S+\s+draining\s+\d+\s+50/);
    assert.match((await run(op, "admin", "clusters", "update", "c2", "--activate", "--unlimited")).out, /active.*limit none/);
    assert.equal((await run(op, "admin", "clusters", "update", "c2")).code, 1, "nothing to change");
    assert.equal((await run(op, "admin", "clusters", "add", "x")).code, 1, "needs a url");
    assert.equal((await run(op, "admin", "clusters", "remove", "main")).code, 1);
    const p = await project("cli-move", "main");
    const moved = await run(op, "admin", "move", p.ref, "c2");
    assert.equal(moved.code, 0, moved.err);
    assert.match(moved.out, new RegExp(`Moved ${p.ref} from main to c2`));
    assert.equal(await where(p.ref), "c2");
    assert.equal((await run(op, "admin", "move", p.ref)).code, 1);
  });

  it("keeps the last measurement of projects whose cluster cannot be reached", async () => {
    await t.platform.usage.measure();
    const before = Number((await t.platform.control.pool.query(`SELECT db_bytes FROM usage_current WHERE ref = $1`, [onC2.ref])).rows[0].db_bytes);
    assert.ok(before > 0);
    await c2.stop();
    await t.platform.usage.measure();
    const after = Number((await t.platform.control.pool.query(`SELECT db_bytes FROM usage_current WHERE ref = $1`, [onC2.ref])).rows[0].db_bytes);
    assert.equal(after, before, "not reset to zero because a cluster is down");
    const down = await t.gw(onC2.ref, "GET", "/rest/v1/items", { key: onC2.service });
    assert.ok([503, 500].includes(down.status), `requests for its projects fail cleanly (${down.status})`);
    const fine = await project("still-on-main");
    assert.equal(await where(fine.ref), "main", "new projects skip the cluster that is down");
    assert.equal((await t.gw(fine.ref, "GET", "/rest/v1/", { key: fine.anon })).status, 200, "and other projects are unaffected");
  });

  it("removes a cluster only when nothing lives on it", async () => {
    assert.equal((await t.api("DELETE", "/v1/admin/clusters/main", { headers: op })).status, 400);
    assert.equal((await t.api("DELETE", "/v1/admin/clusters/c2", { headers: op })).status, 409, "projects still live there");
    assert.equal((await t.api("DELETE", "/v1/admin/clusters/c3", { headers: op })).status, 204, "c3 was never used");
    assert.equal((await t.api("DELETE", "/v1/admin/clusters/c3", { headers: op })).status, 404);
    assert.deepEqual((await clusters()).json.map((c: any) => c.id), ["main", "c2"]);
  });
});
