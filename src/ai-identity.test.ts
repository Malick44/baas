import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { Scripted, propose, query, text } from "./ai-testkit.js";
import { makePlatform, PG_BIN } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const SET_CONFIG = "pg_catalog.set_config(text, text, boolean)";

describe("ai assistant: row-level security and identities", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  const fake = new Scripted();
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string, adm: string, dev: string;
  let R: Awaited<ReturnType<typeof t.project>>;
  let alice: { id: string; email: string }, bob: { id: string; email: string };

  const ask = (token: string, question: string, as?: unknown, ref = R.ref) => t.api("POST", `/v1/projects/${ref}/ai/ask`, { token, body: { question, ...(as !== undefined ? { as } : {}) } });
  const cfg = (token: string, allow: boolean, ref = R.ref) => t.api("PUT", `/v1/projects/${ref}/ai/config`, { token, body: { allowBypassRls: allow } });
  /** Run one query through the assistant and return its step. */
  const runAs = async (as: unknown, sql: string) => {
    fake.script([query(sql)], [text("ok")]);
    const r = await ask(adm, "q", as);
    assert.equal(r.status, 200, r.text);
    return r.json.steps[0];
  };
  const superSql = async (sql: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: R.dbUrl });
    c.on("error", () => {});
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  const canSetConfig = async (role: string) => (await superSql(`SELECT has_function_privilege($1, '${SET_CONFIG}', 'EXECUTE') AS ok`, [role]))[0].ok as boolean;
  const isMember = async () => (await superSql(`SELECT coalesce(to_regrole('baas_ai_reader') IS NOT NULL AND pg_has_role($1, 'baas_ai_reader', 'MEMBER'), false) AS m`, [`authenticator_${R.ref}`]))[0].m as boolean;

  before(async () => {
    t = await makePlatform(ADMIN!, { ai: { llm: fake, queryTimeoutMs: 700, totalTimeoutMs: 5000 } });
    owner = await t.org();
    adm = await t.token(owner, "admin");
    dev = await t.token(owner, "developer");
    R = await t.project(owner, "clinic");
    await t.api("PATCH", `/v1/projects/${R.ref}`, { token: owner, body: { plan: "pro" } });
    const signup = async (email: string) => (await t.gw(R.ref, "POST", "/auth/v1/signup", { key: R.anon, body: { email, password: "secret123" } })).json.user;
    alice = await signup("alice@example.com");
    bob = await signup("bob@example.com");
    const s = await t.sql(owner, R.ref, `
      CREATE TABLE public.patients (id serial PRIMARY KEY, name text NOT NULL, owner uuid, is_public boolean NOT NULL DEFAULT false, ssn text);
      ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.patients TO anon, authenticated;
      CREATE POLICY anon_public ON public.patients FOR SELECT TO anon USING (is_public);
      CREATE POLICY own ON public.patients FOR SELECT TO authenticated USING (owner = auth.uid());
      INSERT INTO public.patients (name, owner, ssn) VALUES ('Ann A', '${alice.id}', '111'), ('Andy A', '${alice.id}', '222'), ('Bea B', '${bob.id}', '333');
      INSERT INTO public.patients (name, is_public, ssn) VALUES ('Public Pat', true, '000');
      CREATE TABLE public.internal_notes (id serial PRIMARY KEY, body text); INSERT INTO public.internal_notes (body) VALUES ('staff only');`);
    assert.equal(s.status, 200, s.text);
    assert.equal((await t.api("POST", `/v1/projects/${R.ref}/ai/enable`, { token: adm })).status, 200);
  });
  after(() => t?.close());

  describe("row-level security applies by default", () => {
    it("starts with 'everyone' mode forbidden and answers as an anonymous visitor", async () => {
      const st = (await t.api("GET", `/v1/projects/${R.ref}/ai`, { token: dev })).json;
      assert.deepEqual([st.allowBypassRls, st.defaultIdentity], [false, "anon"]);
      assert.equal(await isMember(), false, "the bypass reader is unreachable from this project");
      fake.script([query("select name from public.patients order by name")], [text("ok")]);
      const r = await ask(adm, "who are the patients?");
      assert.deepEqual(r.json.answeredAs, { type: "anon", label: "an anonymous visitor" });
      assert.deepEqual(r.json.steps[0].rows, [["Public Pat"]], "only what the policies show to the public");
      const system = fake.requests[0]!.system[1]!;
      assert.match(system, /You are acting as: an anonymous visitor\. Row-level security applies/);
      assert.match(system, /table "patients"/);
      assert.ok(!/internal_notes|about \d+ rows/.test(system), "no ungranted tables, and no row counts that would leak hidden rows");
    });

    it("answers differently for different users, exactly as their API calls would", async () => {
      const count = "select count(*)::int as n, string_agg(name, ', ' order by name) as names from public.patients";
      assert.deepEqual((await runAs({ type: "user", userId: alice.id }, count)).rows, [[2, "Andy A, Ann A"]]);
      assert.deepEqual((await runAs({ type: "user", userId: bob.id }, count)).rows, [[1, "Bea B"]]);
      assert.deepEqual((await runAs({ type: "anon" }, count)).rows, [[1, "Public Pat"]]);
      // The same numbers the REST API gives those users.
      const login = async (email: string) => (await t.gw(R.ref, "POST", "/auth/v1/token?grant_type=password", { key: R.anon, body: { email, password: "secret123" } })).json.access_token;
      assert.equal((await t.gw(R.ref, "GET", "/rest/v1/patients", { key: R.anon, token: await login("alice@example.com") })).json.length, 2);
      assert.equal((await t.gw(R.ref, "GET", "/rest/v1/patients", { key: R.anon, token: await login("bob@example.com") })).json.length, 1);
    });

    it("carries the user's real identity into policies, and says who it is answering as", async () => {
      const step = await runAs({ type: "user", userId: alice.id }, "select auth.uid()::text as uid, auth.jwt() ->> 'email' as email, auth.role() as role, current_user::text as cu");
      assert.deepEqual(step.rows, [[alice.id, "alice@example.com", "authenticated", "authenticated"]]);
      const r = await ask(adm, "hi", { type: "user", userId: bob.id });
      assert.deepEqual(r.json.answeredAs, { type: "user", label: "user bob@example.com" });
      assert.match(fake.requests.at(-1)!.system[1]!, /You are acting as: user bob@example\.com/);
    });

    it("refuses 'everyone' mode unless the owner allowed it, before the model is ever called", async () => {
      fake.script([text("ok")]);
      const r = await ask(adm, "show everything", { type: "service" });
      assert.equal(r.status, 403);
      assert.match(r.json.error, /does not allow the assistant to ignore row-level security/);
      assert.equal(fake.requests.length, 0);
    });

    it("rejects malformed or foreign identities", async () => {
      fake.script([text("ok")]);
      const other = await t.project(owner, "someone-else");
      const stranger = (await t.gw(other.ref, "POST", "/auth/v1/signup", { key: other.anon, body: { email: "eve@example.com", password: "secret123" } })).json.user;
      for (const [as, status] of [
        [{ type: "root" }, 400], [{ type: "user" }, 400], [{ type: "user", userId: "x' or 1=1 --" }, 400], [{ type: "user", userId: 5 }, 400], ["service", 400], [42, 400],
        [{ type: "user", userId: "00000000-0000-0000-0000-000000000000" }, 404], [{ type: "user", userId: stranger.id }, 404],
      ] as Array<[unknown, number]>) assert.equal((await ask(adm, "q", as)).status, status, JSON.stringify(as));
      assert.equal(fake.requests.length, 0);
    });
  });

  describe("the identity cannot be swapped by the SQL the model writes", () => {
    const forged = (id: string) => `'{"sub":"${id}","role":"authenticated"}'`;
    const attempts = () => [
      `select set_config('request.jwt.claims', ${forged(bob.id)}, true)`,
      `select pg_catalog.set_config('request.jwt.claims', ${forged(bob.id)}, true)`,
      `select U&"set\\005fconfig"('request.jwt.claims', ${forged(bob.id)}, true)`,
      `select "set_config"('request.jwt.claims', ${forged(bob.id)}, false)`,
      `select set_config('role', 'service_role', true)`,
      `select set_config('role', 'baas_ai_reader', true)`,
      `select set_config('session_authorization', 'postgres', true)`,
      `select set_config('row_security', 'off', true)`,
      `select set_config('statement_timeout', '0', true)`,
      `select (select set_config('request.jwt.claims', ${forged(bob.id)}, true)) as x, name from public.patients`,
      `with c as (select set_config('request.jwt.claims', ${forged(bob.id)}, true)) select name from public.patients, c`,
    ];

    it("cannot impersonate another user, escalate role, or turn row security off", async () => {
      for (const as of [{ type: "user", userId: alice.id }, { type: "anon" }]) {
        for (const sql of attempts()) {
          const step = await runAs(as, sql);
          assert.equal(step.ok, false, `${JSON.stringify(as)} ran: ${sql}`);
          assert.match(step.error, /permission denied for function set_config/, sql);
        }
      }
      // Still the same person afterwards.
      assert.deepEqual((await runAs({ type: "user", userId: alice.id }, "select auth.uid()::text, count(*)::int from public.patients")).rows, [[alice.id, 2]]);
    });

    it("leaves the platform's own path working: claims are set first, then the role is dropped", async () => {
      const login = (await t.gw(R.ref, "POST", "/auth/v1/token?grant_type=password", { key: R.anon, body: { email: "alice@example.com", password: "secret123" } })).json;
      const rows = await t.gw(R.ref, "GET", "/rest/v1/patients?select=name&order=name", { key: R.anon, token: login.access_token });
      assert.deepEqual(rows.json.map((r: any) => r.name), ["Andy A", "Ann A"]);
      // The login role and service_role keep set_config; anon, authenticated and everyone else do not.
      assert.deepEqual([await canSetConfig("anon"), await canSetConfig("authenticated"), await canSetConfig("service_role"), await canSetConfig(`authenticator_${R.ref}`)], [false, false, true, true]);
      const c = new pg.Client({ connectionString: R.dbUrl.replace("postgres@", `authenticator_${R.ref}:${(await t.platform.control.secretsFor(R.ref))!.dbPassword}@`) });
      c.on("error", () => {});
      await c.connect();
      await c.query("BEGIN");
      await c.query("SELECT set_config('request.jwt.claims', '{}', true)"); // the login role may
      await c.query("SET LOCAL ROLE authenticated");
      await assert.rejects(c.query("SELECT set_config('request.jwt.claims', '{}', true)"), /permission denied for function set_config/);
      await c.end();
    });
  });

  describe("the owner controls 'everyone' mode", () => {
    it("takes the owner role to allow it, and admins can turn it back off", async () => {
      assert.equal((await cfg(adm, true)).status, 403);
      assert.equal((await cfg(dev, true)).status, 403);
      assert.equal((await cfg(await t.org(), true)).status, 404);
      assert.equal((await t.api("PUT", `/v1/projects/${R.ref}/ai/config`, { token: owner, body: { allowBypassRls: "yes" } })).status, 400);
      assert.equal((await t.api("PUT", `/v1/projects/${R.ref}/ai/config`, { body: { allowBypassRls: true } })).status, 401);
      assert.equal(await isMember(), false);

      const on = await cfg(owner, true);
      assert.deepEqual([on.status, on.json.allowBypassRls, on.json.defaultIdentity], [200, true, "service"]);
      assert.equal(await isMember(), true);

      fake.script([query("select count(*)::int as n from public.patients"), query("select body from public.internal_notes")], [text("ok")]);
      const all = await ask(adm, "how many patients?");
      assert.deepEqual(all.json.answeredAs.type, "service");
      assert.deepEqual(all.json.steps.map((s: any) => s.rows), [[[4]], [["staff only"]]], "everything, including ungranted tables");
      assert.match(fake.requests[0]!.system[1]!, /Row-level security is ignored for this identity/);
      assert.match(fake.requests[0]!.system[1]!, /about \d+ rows/);

      // An explicit choice still wins over the default.
      assert.deepEqual((await runAs({ type: "user", userId: bob.id }, "select count(*)::int from public.patients")).rows, [[1]]);

      const off = await cfg(adm, false);
      assert.deepEqual([off.status, off.json.allowBypassRls, off.json.defaultIdentity], [200, false, "anon"]);
      assert.equal(await isMember(), false, "revoked in the database, not just hidden in the UI");
      assert.equal((await ask(adm, "q", { type: "service" })).status, 403);
      const audit = (await t.api("GET", "/v1/audit-log", { token: owner })).json.map((e: any) => e.action);
      assert.ok(audit.includes("ai.bypass_rls_allowed") && audit.includes("ai.bypass_rls_forbidden"));
    });

    it("does not let the model reach the bypass reader when it is not allowed", async () => {
      for (const as of [{ type: "anon" }, { type: "user", userId: alice.id }]) {
        const s = await runAs(as, "select name from public.patients where set_config('role', 'baas_ai_reader', true) is not null");
        assert.equal(s.ok, false);
      }
      const c = new pg.Client({ connectionString: R.dbUrl.replace("postgres@", `authenticator_${R.ref}:${(await t.platform.control.secretsFor(R.ref))!.dbPassword}@`) });
      c.on("error", () => {});
      await c.connect();
      await assert.rejects(c.query("SET ROLE baas_ai_reader"), /permission denied to set role/);
      await c.end();
    });
  });

  describe("fail closed", () => {
    it("repairs a re-granted set_config before answering (as a restore or a careless GRANT would leave it)", async () => {
      await superSql(`GRANT EXECUTE ON FUNCTION ${SET_CONFIG} TO PUBLIC`);
      assert.equal(await canSetConfig("authenticated"), true);
      const s = await runAs({ type: "user", userId: alice.id }, `select set_config('request.jwt.claims', ${"'"}{"sub":"${bob.id}","role":"authenticated"}${"'"}, true)`);
      assert.equal(s.ok, false, "the lock was restored before the query ran");
      assert.equal(await canSetConfig("authenticated"), false);
    });

    it("removes stray access to the bypass reader when it is not allowed", async () => {
      await superSql(`GRANT baas_ai_reader TO "authenticator_${R.ref}"`);
      assert.equal(await isMember(), true);
      await runAs({ type: "anon" }, "select 1");
      assert.equal(await isMember(), false);
    });

    it("survives a backup restore", { skip: !PG_BIN && "pg_dump not found" }, async () => {
      const b = await t.api("POST", `/v1/projects/${R.ref}/backups`, { token: owner, body: {} });
      assert.equal(b.status, 201);
      assert.equal((await t.api("POST", `/v1/projects/${R.ref}/backups/${b.json.id}/restore`, { token: owner })).status, 200);
      const s = await runAs({ type: "user", userId: alice.id }, "select count(*)::int, auth.uid()::text from public.patients");
      assert.deepEqual(s.rows, [[2, alice.id]]);
      assert.equal(await canSetConfig("authenticated"), false);
      assert.equal(await canSetConfig("anon"), false);
      assert.equal((await runAs({ type: "user", userId: alice.id }, `select set_config('request.jwt.claims', '{}', true)`)).ok, false);
    });

    it("switching the assistant off undoes the lock; switching it on restores it", async () => {
      await t.api("POST", `/v1/projects/${R.ref}/ai/disable`, { token: adm });
      assert.deepEqual([await canSetConfig("anon"), await canSetConfig("authenticated"), await isMember()], [true, true, false]);
      assert.equal((await ask(adm, "q")).status, 403);
      await t.api("POST", `/v1/projects/${R.ref}/ai/enable`, { token: adm });
      assert.deepEqual([await canSetConfig("anon"), await canSetConfig("authenticated")], [false, false]);
    });
  });

  describe("choosing a user", () => {
    it("searches users by email, returning only id and email", async () => {
      const found = (await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=ali`, { token: adm })).json;
      assert.deepEqual(found, [{ id: alice.id, email: "alice@example.com" }]);
      assert.deepEqual((await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=EXAMPLE.COM`, { token: adm })).json.map((u: any) => u.email), ["alice@example.com", "bob@example.com"]);
      assert.deepEqual((await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=%25`, { token: adm })).json, [], "wildcards are literal");
      assert.deepEqual((await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=_lice`, { token: adm })).json, []);
      assert.deepEqual((await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=' or 1=1 --`, { token: adm })).json, []);
      assert.equal((await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=a`, { token: dev })).status, 403);
      assert.equal((await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=a`, { token: await t.org() })).status, 404);
      assert.equal((await t.api("GET", `/v1/projects/${R.ref}/ai/users?q=a`, {})).status, 401);
    });

    it("records who was impersonated in the audit log", async () => {
      fake.script([text("ok")]);
      await ask(adm, "hello", { type: "user", userId: bob.id });
      const e = (await t.api("GET", "/v1/audit-log", { token: owner })).json.find((x: any) => x.action === "ai.ask");
      assert.equal(e.meta.as, `user:${bob.id}`);
    });

    it("still proposes changes the same way whichever identity asks", async () => {
      fake.script([propose("UPDATE public.patients SET ssn = NULL WHERE owner IS NOT NULL", "Clears SSNs.")], [text("Review it.")]);
      const r = await ask(adm, "clear ssns", { type: "user", userId: alice.id });
      assert.equal(r.json.proposals.length, 1);
      assert.deepEqual(r.json.proposals[0].validation, { status: "ok" });
      assert.deepEqual((await superSql("SELECT count(ssn)::int AS n FROM public.patients"))[0].n, 4, "nothing was run");
    });
  });
});
