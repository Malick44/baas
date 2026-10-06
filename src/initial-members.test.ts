import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { initialMembersFromEnv, initializeMembers, type InitialMembers } from "./initial-members.js";
import { BOOT, makePlatform } from "./platform-testkit.js";
import { MemoryMailer } from "./mailer.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const cfg: InitialMembers = {
  organization: { name: "Initial team", slug: "initial-team" },
  owner: { email: "owner@example.com", password: "temporary-owner-password-123", name: "Owner" },
  admin: { email: "admin@example.com", password: "temporary-admin-password-456", name: "Admin" },
};

it("initial accounts are disabled unless explicitly enabled, with no fallback credentials", () => {
  assert.equal(initialMembersFromEnv({}), undefined);
  assert.equal(initialMembersFromEnv({ BAAS_INITIAL_USERS_ENABLED: "false" }), undefined);
  assert.throws(() => initialMembersFromEnv({ BAAS_INITIAL_USERS_ENABLED: "yes" }), /true or false/);
  assert.throws(() => initialMembersFromEnv({ BAAS_INITIAL_USERS_ENABLED: "true" }), /BAAS_INITIAL_ORGANIZATION_NAME is required/);
});

describe("one-time initial dashboard users", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  afterEach(async () => { await t?.close(); });
  const login = (role: "owner" | "admin", password = cfg[role].password) => t.api("POST", "/v1/auth/login", { body: { email: cfg[role].email, password } });
  const counts = async () => (await t.platform.pool.query(`SELECT (SELECT count(*)::int FROM organizations) AS orgs, (SELECT count(*)::int FROM members) AS members, (SELECT count(*)::int FROM api_tokens) AS tokens`)).rows[0];

  it("creates both roles in one organization on startup, without a bypass API token", async () => {
    t = await makePlatform(ADMIN!, { initialMembers: cfg });
    assert.equal(t.platform.initialMembers, "created");
    assert.deepEqual(await counts(), { orgs: 1, members: 2, tokens: 0 });
    const members = (await t.platform.pool.query("SELECT email, role, must_change_password, password_hash FROM members ORDER BY role")).rows;
    assert.deepEqual(members.map(({ email, role, must_change_password }) => ({ email, role, must_change_password })), [
      { email: cfg.admin.email, role: "admin", must_change_password: true },
      { email: cfg.owner.email, role: "owner", must_change_password: true },
    ]);
    assert.ok(members.every((m) => m.password_hash.startsWith("scrypt$") && !Object.values(cfg).some((v) => "password" in v && v.password === m.password_hash)));
  });

  it("requires both accounts to replace their password before normal API access, including direct routes", async () => {
    t = await makePlatform(ADMIN!, { initialMembers: cfg });
    for (const role of ["owner", "admin"] as const) {
      const session = await login(role);
      assert.equal(session.status, 200);
      assert.equal(session.json.member.must_change_password, true);
      const token = session.json.token;
      assert.equal((await t.api("GET", "/v1/me", { token })).json.member.must_change_password, true);
      for (const [method, path, body] of [
        ["GET", "/v1/projects"], ["GET", "/v1/members"],
        ["GET", `/v1/projects/${"0".repeat(20)}/api-keys`],
        ["POST", "/v1/projects", { name: "blocked" }],
        ["POST", "/v1/tokens", { name: "bypass", role: "owner" }],
        ["POST", "/v1/me/mfa/enroll"],
      ] as const) {
        const r = await t.api(method, path, { token, body });
        assert.equal(r.status, 403, path);
        assert.equal(r.json.code, "password_change_required", path);
      }
      assert.equal((await t.api("POST", "/v1/auth/logout", { token })).status, 204);
      assert.equal((await t.api("GET", "/v1/me", { token })).status, 401);
    }
    assert.equal((await t.platform.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n, 0);
  });

  it("validates the current and new passwords, lifts the gate, revokes other sessions and keeps role permissions", async () => {
    t = await makePlatform(ADMIN!, { initialMembers: cfg });
    for (const role of ["owner", "admin"] as const) {
      const token = (await login(role)).json.token;
      const other = (await login(role)).json.token;
      for (const [current, next] of [["wrong-password", "my-new-password-123"], [cfg[role].password, cfg[role].password], [cfg[role].password, "short"]]) {
        assert.equal((await t.api("POST", "/v1/me/password", { token, body: { current_password: current, new_password: next } })).status, 400);
        assert.equal((await t.api("GET", "/v1/projects", { token })).status, 403);
      }
      const next = `my-new-${role}-password-123`;
      assert.equal((await t.api("POST", "/v1/me/password", { token, body: { current_password: cfg[role].password, new_password: next } })).status, 204);
      assert.equal((await t.api("GET", "/v1/me", { token })).json.member.must_change_password, false);
      assert.equal((await t.api("GET", "/v1/projects", { token })).status, 200);
      assert.equal((await t.api("GET", "/v1/me", { token: other })).status, 401);
      assert.equal((await login(role)).status, 401);
      assert.equal((await login(role, next)).json.member.must_change_password, false);
      assert.equal((await t.api("POST", "/v1/tokens", { token, body: { name: "script", role: "owner" } })).status, role === "owner" ? 201 : 403);
    }
    assert.equal(await initializeMembers(t.platform.pool, cfg), "already_initialized");
    assert.equal((await login("owner", "my-new-owner-password-123")).status, 200);
    await t.platform.pool.query("DELETE FROM organizations");
    assert.equal(await initializeMembers(t.platform.pool, cfg), "already_initialized");
    assert.deepEqual(await counts(), { orgs: 0, members: 0, tokens: 0 });
  });

  it("serializes racing initializers and never seeds twice", async () => {
    t = await makePlatform(ADMIN!);
    const results = await Promise.all([initializeMembers(t.platform.pool, cfg), initializeMembers(t.platform.pool, cfg)]);
    assert.deepEqual(results.sort(), ["already_initialized", "created"]);
    assert.deepEqual(await counts(), { orgs: 1, members: 2, tokens: 0 });
  });

  it("rolls back the entire organization and owner if the admin insert fails, then supports recovery", async () => {
    t = await makePlatform(ADMIN!);
    await t.platform.pool.query(`CREATE FUNCTION refuse_admin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role = 'admin' THEN RAISE EXCEPTION 'test admin failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER refuse_admin BEFORE INSERT ON members FOR EACH ROW EXECUTE FUNCTION refuse_admin()`);
    await assert.rejects(initializeMembers(t.platform.pool, cfg), /test admin failure/);
    assert.deepEqual(await counts(), { orgs: 0, members: 0, tokens: 0 });
    assert.equal((await t.platform.pool.query("SELECT count(*)::int AS n FROM initial_members_bootstrap")).rows[0].n, 0);
    await t.platform.pool.query("DROP TRIGGER refuse_admin ON members");
    assert.equal(await initializeMembers(t.platform.pool, cfg), "created");
  });

  it("skips existing installations permanently and leaves existing credentials and API tokens working", async () => {
    t = await makePlatform(ADMIN!);
    const org = await t.api("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "Existing", slug: "existing", owner_email: cfg.owner.email, owner_password: cfg.owner.password } });
    assert.equal(await initializeMembers(t.platform.pool, cfg), "skipped_existing");
    assert.deepEqual(await counts(), { orgs: 1, members: 1, tokens: 1 });
    assert.equal((await login("owner")).json.member.must_change_password, false);
    assert.equal((await t.api("GET", "/v1/projects", { token: org.json.owner_token })).status, 200);
    await t.platform.pool.query("DELETE FROM organizations");
    assert.equal(await initializeMembers(t.platform.pool, cfg), "already_initialized");
    assert.deepEqual(await counts(), { orgs: 0, members: 0, tokens: 0 });
  });

  it("rejects invalid or duplicate initial identities before any write", async () => {
    t = await makePlatform(ADMIN!);
    for (const invalid of [
      { ...cfg, admin: { ...cfg.admin, email: "OWNER@example.com" } },
      { ...cfg, admin: { ...cfg.admin, password: cfg.owner.password } },
      { ...cfg, admin: { ...cfg.admin, password: "short" } },
    ]) await assert.rejects(initializeMembers(t.platform.pool, invalid));
    assert.deepEqual(await counts(), { orgs: 0, members: 0, tokens: 0 });
  });

  it("requires replacement after an owner's temporary reset and accepts a distinct password through email recovery", async () => {
    const mailer = new MemoryMailer();
    t = await makePlatform(ADMIN!, { initialMembers: cfg, mail: { mailer }, dashboardUrl: "https://dashboard.example.com" });
    const owner = (await login("owner")).json.token;
    await t.api("POST", "/v1/me/password", { token: owner, body: { current_password: cfg.owner.password, new_password: "new-owner-password-123" } });
    const adminId = (await t.api("GET", "/v1/members", { token: owner })).json.members.find((m: any) => m.role === "admin").id;
    assert.equal((await t.api("POST", `/v1/members/${adminId}/password`, { token: owner, body: { password: "reset-admin-password-123" } })).status, 204);
    const admin = (await login("admin", "reset-admin-password-123")).json.token;
    assert.equal((await t.api("GET", "/v1/projects", { token: admin })).status, 403);
    await t.api("POST", "/v1/auth/forgot", { body: { email: cfg.admin.email } });
    const reset = /#\/reset\/(baasrst_[A-Za-z0-9_-]+)/.exec(mailer.outbox.at(-1)!.text)![1];
    assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: reset, password: "reset-admin-password-123" } })).status, 400);
    assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: reset, password: "recovered-admin-password-123" } })).status, 204);
    assert.equal((await t.api("GET", "/v1/me", { token: admin })).status, 401);
    assert.equal((await login("admin", "recovered-admin-password-123")).json.member.must_change_password, false);
  });
});
