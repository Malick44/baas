import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { signJwt } from "./keys.js";
import { makeHarness, type Harness, type TestProject } from "./testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("data plane: rest + auth", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let h: Harness;
  let a: TestProject;
  let b: TestProject;

  const signup = async (p: TestProject, email: string, password = "secret123") =>
    (await h.call(p, "POST", "/auth/v1/signup", { key: p.anon, body: { email, password } })).json;

  before(async () => {
    h = await makeHarness(ADMIN!);
    [a, b] = await Promise.all([h.project(), h.project()]);
    for (const p of [a, b]) {
      await h.sql(p, `
        CREATE TABLE public.todos (id serial PRIMARY KEY, owner uuid DEFAULT auth.uid(), title text NOT NULL, done boolean DEFAULT false, prio int DEFAULT 0);
        ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
        CREATE POLICY read_own ON public.todos FOR SELECT TO authenticated USING (owner = auth.uid());
        CREATE POLICY write_own ON public.todos FOR ALL TO authenticated USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
        CREATE TABLE public.notes (id int PRIMARY KEY, body text);
        INSERT INTO public.notes VALUES (1,'alpha'),(2,'beta'),(3,'gamma'),(4,'delta');
        GRANT SELECT ON public.notes TO anon;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes, public.todos TO authenticated, service_role;
        GRANT USAGE ON SEQUENCE public.todos_id_seq TO authenticated, service_role;
        CREATE FUNCTION public.add(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a + b';
        CREATE FUNCTION public.notes_like(pat text) RETURNS SETOF public.notes LANGUAGE sql AS 'SELECT * FROM public.notes WHERE body LIKE pat';`);
    }
  });
  after(() => h?.close());

  describe("credentials", () => {
    it("requires an API key and rejects bad ones", async () => {
      assert.equal((await h.call(a, "GET", "/rest/v1/notes")).status, 401);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes", { key: "garbage" })).status, 401);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes", { key: a.anon })).status, 200);
    });

    it("rejects a JWT with alg none or a foreign signature", async () => {
      const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ role: "service_role", exp: 9999999999 })).toString("base64url")}.`;
      assert.equal((await h.call(a, "GET", "/rest/v1/notes", { key: none })).status, 401);
      const forged = signJwt({ role: "service_role", exp: 9999999999 }, "not-the-secret");
      assert.equal((await h.call(a, "GET", "/rest/v1/notes", { key: forged })).status, 401);
      const expired = signJwt({ role: "anon", exp: 1 }, a.jwtSecret);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes", { key: expired })).status, 401);
    });

    it("rejects roles outside anon/authenticated/service_role", async () => {
      const t = signJwt({ role: "postgres", exp: 9999999999 }, a.jwtSecret);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes", { key: t })).status, 401);
    });

    it("refuses another project's keys, and unknown or malformed hosts", async () => {
      assert.equal((await h.call(b, "GET", "/rest/v1/notes", { key: a.anon })).status, 401);
      assert.equal((await h.call(b, "GET", "/rest/v1/notes", { key: b.anon, token: a.service })).status, 401);
      assert.equal((await h.call({ host: "localhost" }, "GET", "/rest/v1/notes", { key: a.anon })).status, 404);
      assert.equal((await h.call({ host: `${"z".repeat(20)}.localhost` }, "GET", "/rest/v1/notes", { key: a.anon })).status, 404);
      assert.equal((await h.call({ host: `${a.ref}.evil.com` }, "GET", "/rest/v1/notes", { key: a.anon })).status, 404);
      assert.equal((await h.call({ host: `x.${a.ref}.localhost` }, "GET", "/rest/v1/notes", { key: a.anon })).status, 404);
    });

    it("answers CORS preflight without credentials", async () => {
      const r = await h.call(a, "OPTIONS", "/rest/v1/notes");
      assert.equal(r.status, 204);
      assert.equal(r.headers["access-control-allow-origin"], "*");
    });
  });

  describe("rest", () => {
    it("filters, orders, paginates and selects columns", async () => {
      const get = (q: string, o = {}) => h.call(a, "GET", `/rest/v1/notes?${q}`, { key: a.anon, ...o });
      assert.deepEqual((await get("id=eq.2")).json, [{ id: 2, body: "beta" }]);
      assert.deepEqual((await get("select=body&order=id.desc&limit=2")).json, [{ body: "delta" }, { body: "gamma" }]);
      assert.deepEqual((await get("select=id,label:body&id=in.(1,3)&order=id")).json, [{ id: 1, label: "alpha" }, { id: 3, label: "gamma" }]);
      assert.deepEqual((await get("id=gte.2&id=lt.4&order=id")).json.map((r: any) => r.id), [2, 3]);
      assert.deepEqual((await get("body=like.*ta&order=id")).json.map((r: any) => r.id), [2, 4]);
      assert.deepEqual((await get("body=ilike.ALPH*")).json.map((r: any) => r.id), [1]);
      assert.deepEqual((await get("id=not.in.(1,2)&order=id")).json.map((r: any) => r.id), [3, 4]);
      assert.deepEqual((await get("or=(id.eq.1,id.eq.4)&order=id")).json.map((r: any) => r.id), [1, 4]);
      assert.deepEqual((await get("body=is.null")).json, []);
      assert.deepEqual((await get("limit=1&offset=2&order=id")).json.map((r: any) => r.id), [3]);
      assert.deepEqual((await get("order=id", { headers: { range: "1-2" } })).json.map((r: any) => r.id), [2, 3]);
    });

    it("counts, and returns a single object on request", async () => {
      const c = await h.call(a, "GET", "/rest/v1/notes?limit=2&order=id", { key: a.anon, headers: { prefer: "count=exact" } });
      assert.equal(c.status, 206);
      assert.equal(c.headers["content-range"], "0-1/4");
      const one = await h.call(a, "GET", "/rest/v1/notes?id=eq.3", { key: a.anon, headers: { accept: "application/vnd.pgrst.object+json" } });
      assert.deepEqual(one.json, { id: 3, body: "gamma" });
      const many = await h.call(a, "GET", "/rest/v1/notes", { key: a.anon, headers: { accept: "application/vnd.pgrst.object+json" } });
      assert.equal(many.status, 406);
    });

    it("maps database errors to sensible statuses", async () => {
      assert.equal((await h.call(a, "GET", "/rest/v1/nope", { key: a.anon })).status, 404);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes?nocol=eq.1", { key: a.anon })).status, 400);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes?id=eq.abc", { key: a.anon })).status, 400);
      assert.equal((await h.call(a, "GET", "/rest/v1/todos", { key: a.anon })).status, 401); // anon has no grant
      assert.equal((await h.call(a, "POST", "/rest/v1/notes", { key: a.anon, body: { id: 9, body: "x" } })).status, 401);
      assert.equal((await h.call(a, "POST", "/rest/v1/notes", { key: a.service, body: { id: 1, body: "dup" } })).status, 409);
    });

    it("keeps user input out of SQL", async () => {
      const evil = ["notes;drop table notes", 'notes"', "notes--", "notes/**/", "pg_catalog.pg_authid", "no tes"];
      for (const t of evil) assert.ok([400, 404].includes((await h.call(a, "GET", `/rest/v1/${encodeURIComponent(t)}`, { key: a.service })).status), t);
      for (const col of ['id"', "id;select 1", "1=1--", "id)or(1=1"])
        assert.equal((await h.call(a, "GET", `/rest/v1/notes?${encodeURIComponent(col)}=eq.1`, { key: a.anon })).status, 400, col);
      for (const ord of ["id;drop table notes", 'id"', "id.sideways"])
        assert.equal((await h.call(a, "GET", `/rest/v1/notes?order=${encodeURIComponent(ord)}`, { key: a.anon })).status, 400, ord);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes?select=id,pg_sleep(9)", { key: a.anon })).status, 400);
      const val = await h.call(a, "GET", `/rest/v1/notes?body=eq.${encodeURIComponent("x' OR '1'='1")}`, { key: a.anon });
      assert.deepEqual(val.json, []);
      assert.equal((await h.sql(a, "SELECT count(*)::int AS n FROM public.notes"))[0].n, 4);
    });

    it("enforces row-level security per user", async () => {
      const u1 = await signup(a, "one@example.com");
      const u2 = await signup(a, "two@example.com");
      const ins = await h.call(a, "POST", "/rest/v1/todos", { key: a.anon, token: u1.access_token, body: { title: "mine" }, headers: { prefer: "return=representation" } });
      assert.equal(ins.status, 201);
      assert.equal(ins.json[0].owner, u1.user.id);
      assert.equal((await h.call(a, "GET", "/rest/v1/todos", { key: a.anon, token: u1.access_token })).json.length, 1);
      assert.deepEqual((await h.call(a, "GET", "/rest/v1/todos", { key: a.anon, token: u2.access_token })).json, []);
      // Another user cannot change or delete the row, and cannot insert one as somebody else.
      const id = ins.json[0].id;
      assert.equal((await h.call(a, "PATCH", `/rest/v1/todos?id=eq.${id}`, { key: a.anon, token: u2.access_token, body: { title: "hacked" }, headers: { prefer: "return=representation" } })).json.length, 0);
      assert.equal((await h.call(a, "POST", "/rest/v1/todos", { key: a.anon, token: u2.access_token, body: { title: "x", owner: u1.user.id } })).status, 403);
      assert.equal((await h.sql(a, "SELECT title FROM public.todos WHERE id = $1", [id]))[0].title, "mine");
      // service_role sees everything.
      assert.equal((await h.call(a, "GET", "/rest/v1/todos", { key: a.service })).json.length, 1);
    });

    it("supports insert arrays, patch, delete, upsert and requires filters", async () => {
      const s = a.service;
      const ins = await h.call(a, "POST", "/rest/v1/notes", { key: s, body: [{ id: 10, body: "x" }, { id: 11, body: "y" }], headers: { prefer: "return=representation" } });
      assert.equal(ins.status, 201);
      assert.equal(ins.json.length, 2);
      assert.equal((await h.call(a, "PATCH", "/rest/v1/notes", { key: s, body: { body: "z" } })).status, 400); // unfiltered
      assert.equal((await h.call(a, "DELETE", "/rest/v1/notes", { key: s })).status, 400);
      const patched = await h.call(a, "PATCH", "/rest/v1/notes?id=eq.10", { key: s, body: { body: "patched" }, headers: { prefer: "return=representation" } });
      assert.equal(patched.json[0].body, "patched");
      const up = await h.call(a, "POST", "/rest/v1/notes", { key: s, body: [{ id: 10, body: "upserted" }, { id: 12, body: "new" }], headers: { prefer: "resolution=merge-duplicates,return=representation" } });
      assert.deepEqual(up.json.map((r: any) => r.body).sort(), ["new", "upserted"]);
      const ign = await h.call(a, "POST", "/rest/v1/notes?on_conflict=id", { key: s, body: [{ id: 10, body: "ignored" }], headers: { prefer: "resolution=ignore-duplicates,return=representation" } });
      assert.deepEqual(ign.json, []);
      const del = await h.call(a, "DELETE", "/rest/v1/notes?id=gte.10", { key: s, headers: { prefer: "return=representation" } });
      assert.equal(del.json.length, 3);
      assert.equal((await h.call(a, "DELETE", "/rest/v1/notes?id=eq.99", { key: s })).status, 204);
    });

    it("rejects malformed bodies", async () => {
      assert.equal((await h.call(a, "POST", "/rest/v1/notes", { key: a.service, raw: "{not json", headers: { "content-type": "application/json" } })).status, 400);
      assert.equal((await h.call(a, "POST", "/rest/v1/notes", { key: a.service, body: [] })).status, 400);
      assert.equal((await h.call(a, "POST", "/rest/v1/notes", { key: a.service, body: { "bad col": 1 } })).status, 400);
      assert.equal((await h.call(a, "GET", "/rest/v1/notes", { key: a.anon, headers: { "accept-profile": "auth" } })).status, 406);
      assert.equal((await h.call(a, "GET", "/rest/v1/users?select=*", { key: a.anon })).status, 404);
    });

    it("does not expose the auth, storage or realtime schemas", async () => {
      for (const t of ["users", "refresh_tokens", "objects", "buckets", "changes"]) assert.equal((await h.call(a, "GET", `/rest/v1/${t}`, { key: a.service })).status, 404, t);
    });

    it("calls functions through rpc", async () => {
      assert.equal((await h.call(a, "POST", "/rest/v1/rpc/add", { key: a.anon, body: { a: 2, b: 3 } })).json, 5);
      assert.deepEqual((await h.call(a, "POST", "/rest/v1/rpc/notes_like", { key: a.anon, body: { pat: "%lph%" } })).json, [{ id: 1, body: "alpha" }]);
      assert.equal((await h.call(a, "GET", "/rest/v1/rpc/add?a=4&b=5", { key: a.anon })).json, 9);
      assert.equal((await h.call(a, "POST", "/rest/v1/rpc/nothere", { key: a.anon, body: {} })).status, 404);
    });
  });

  describe("auth", () => {
    it("signs up, logs in, and reads the user", async () => {
      const s = await signup(a, "flow@example.com");
      assert.ok(s.access_token && s.refresh_token);
      assert.equal(s.user.email, "flow@example.com");
      assert.equal((await h.call(a, "POST", "/auth/v1/signup", { key: a.anon, body: { email: "FLOW@example.com", password: "secret123" } })).status, 422);
      const l = await h.call(a, "POST", "/auth/v1/token?grant_type=password", { key: a.anon, body: { email: "Flow@Example.com", password: "secret123" } });
      assert.equal(l.status, 200);
      const me = await h.call(a, "GET", "/auth/v1/user", { key: a.anon, token: l.json.access_token });
      assert.equal(me.json.email, "flow@example.com");
      assert.equal((await h.call(a, "GET", "/auth/v1/user", { key: a.anon })).status, 401); // anon key is not a user
    });

    it("rejects weak input and wrong credentials without revealing which", async () => {
      assert.equal((await h.call(a, "POST", "/auth/v1/signup", { key: a.anon, body: { email: "nope", password: "secret123" } })).status, 422);
      assert.equal((await h.call(a, "POST", "/auth/v1/signup", { key: a.anon, body: { email: "w@example.com", password: "123" } })).status, 422);
      const wrongPw = await h.call(a, "POST", "/auth/v1/token?grant_type=password", { key: a.anon, body: { email: "flow@example.com", password: "bad-password" } });
      const noUser = await h.call(a, "POST", "/auth/v1/token?grant_type=password", { key: a.anon, body: { email: "ghost@example.com", password: "bad-password" } });
      assert.equal(wrongPw.status, 400);
      assert.deepEqual(wrongPw.json, noUser.json);
      assert.equal((await h.call(a, "POST", "/auth/v1/token?grant_type=magic", { key: a.anon, body: {} })).status, 400);
    });

    it("stores passwords hashed", async () => {
      const [row] = await h.sql(a, "SELECT encrypted_password FROM auth.users WHERE email = 'flow@example.com'");
      assert.match(row.encrypted_password, /^scrypt\$/);
      assert.ok(!row.encrypted_password.includes("secret123"));
    });

    it("rotates refresh tokens and ends the session when one is replayed", async () => {
      const s = await signup(a, "rot@example.com");
      const r1 = await h.call(a, "POST", "/auth/v1/token?grant_type=refresh_token", { key: a.anon, body: { refresh_token: s.refresh_token } });
      assert.equal(r1.status, 200);
      assert.notEqual(r1.json.refresh_token, s.refresh_token);
      const replay = await h.call(a, "POST", "/auth/v1/token?grant_type=refresh_token", { key: a.anon, body: { refresh_token: s.refresh_token } });
      assert.equal(replay.status, 400);
      // The replay burned the whole session, including the legitimately rotated token.
      assert.equal((await h.call(a, "POST", "/auth/v1/token?grant_type=refresh_token", { key: a.anon, body: { refresh_token: r1.json.refresh_token } })).status, 400);
    });

    it("logs out by revoking the session", async () => {
      const s = await signup(a, "out@example.com");
      assert.equal((await h.call(a, "POST", "/auth/v1/logout", { key: a.anon, token: s.access_token })).status, 204);
      assert.equal((await h.call(a, "POST", "/auth/v1/token?grant_type=refresh_token", { key: a.anon, body: { refresh_token: s.refresh_token } })).status, 400);
    });

    it("updates the user and requires service_role for admin routes", async () => {
      const s = await signup(a, "upd@example.com");
      const u = await h.call(a, "PUT", "/auth/v1/user", { key: a.anon, token: s.access_token, body: { data: { name: "Ann" }, password: "newsecret1" } });
      assert.equal(u.json.user_metadata.name, "Ann");
      assert.equal((await h.call(a, "POST", "/auth/v1/token?grant_type=password", { key: a.anon, body: { email: "upd@example.com", password: "newsecret1" } })).status, 200);
      assert.equal((await h.call(a, "GET", "/auth/v1/admin/users", { key: a.anon, token: s.access_token })).status, 403);
      const list = await h.call(a, "GET", "/auth/v1/admin/users?per_page=100", { key: a.service });
      assert.ok(list.json.total >= 1 && list.json.users.every((x: any) => !("encrypted_password" in x)));
      const mk = await h.call(a, "POST", "/auth/v1/admin/users", { key: a.service, body: { email: "made@example.com", password: "secret123", user_metadata: { x: 1 } } });
      assert.equal(mk.status, 201);
      assert.equal((await h.call(a, "DELETE", `/auth/v1/admin/users/${mk.json.id}`, { key: a.service })).status, 204);
      assert.equal((await h.call(a, "GET", `/auth/v1/admin/users/${mk.json.id}`, { key: a.service })).status, 404);
    });

    it("bans users and refuses their login", async () => {
      const s = await signup(a, "ban@example.com");
      await h.call(a, "PUT", `/auth/v1/admin/users/${s.user.id}`, { key: a.service, body: { ban_duration: "24h" } });
      assert.equal((await h.call(a, "POST", "/auth/v1/token?grant_type=password", { key: a.anon, body: { email: "ban@example.com", password: "secret123" } })).status, 400);
      assert.equal((await h.call(a, "POST", "/auth/v1/token?grant_type=refresh_token", { key: a.anon, body: { refresh_token: s.refresh_token } })).status, 400);
    });

    it("throttles repeated failed logins per project and email", async () => {
      await signup(a, "brute@example.com");
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await h.call(a, "POST", "/auth/v1/token?grant_type=password", { key: a.anon, body: { email: "brute@example.com", password: `wrong-${i}` } })).status;
      assert.equal(last, 429);
      // The same email in another project is unaffected.
      await signup(b, "brute@example.com");
      assert.equal((await h.call(b, "POST", "/auth/v1/token?grant_type=password", { key: b.anon, body: { email: "brute@example.com", password: "secret123" } })).status, 200);
    });

    it("honours disable_signup and jwt_expiry settings", async () => {
      const p = await h.project();
      await h.owner && (await h.control.updateSettings(h.owner, p.ref, { jwt_expiry: 120, disable_signup: true }));
      assert.equal((await h.call(p, "POST", "/auth/v1/signup", { key: p.anon, body: { email: "x@example.com", password: "secret123" } })).status, 422);
      await h.control.updateSettings(h.owner, p.ref, { disable_signup: false });
      assert.equal((await signup(p, "y@example.com")).expires_in, 120);
    });

    it("does not accept a user token from another project", async () => {
      const s = await signup(a, "cross@example.com");
      assert.equal((await h.call(b, "GET", "/auth/v1/user", { key: b.anon, token: s.access_token })).status, 401);
      assert.equal((await h.call(b, "GET", "/rest/v1/todos", { key: b.anon, token: s.access_token })).status, 401);
    });
  });

  describe("project lifecycle at the gateway", () => {
    it("serves 503 while paused, works again on resume, and 404 once deleted", async () => {
      const p = await h.project();
      assert.equal((await h.call(p, "GET", "/rest/v1/", { key: p.anon })).status, 200);
      await h.control.pauseProject(h.owner, p.ref);
      assert.equal((await h.call(p, "GET", "/rest/v1/", { key: p.anon })).status, 503);
      await h.control.resumeProject(h.owner, p.ref);
      assert.equal((await h.call(p, "GET", "/rest/v1/", { key: p.anon })).status, 200);
      await h.control.deleteProject(h.owner, p.ref);
      assert.equal((await h.call(p, "GET", "/rest/v1/", { key: p.anon })).status, 404);
    });
  });
});
