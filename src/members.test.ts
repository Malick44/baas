import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BOOT, makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("dashboard accounts", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: { token: string; id: string };
  let orgToken: string;
  const PW = "correct-horse-battery";

  const login = (email: string, password: string) => t.api("POST", "/v1/auth/login", { body: { email, password } });
  async function join(admin: string, email: string, role: string) {
    const inv = await t.api("POST", "/v1/members/invites", { token: admin, body: { email, role } });
    assert.equal(inv.status, 201, inv.text);
    const acc = await t.api("POST", "/v1/auth/accept-invite", { body: { token: inv.json.token, password: PW, name: email.split("@")[0] } });
    assert.equal(acc.status, 201, acc.text);
    return { token: acc.json.token as string, id: acc.json.member.id as string };
  }

  before(async () => {
    t = await makePlatform(ADMIN!);
    const r = await t.api("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "Acme", slug: `acme-${Date.now() % 100000}`, owner_email: "root@example.com", owner_password: PW, owner_name: "Root" } });
    assert.equal(r.status, 201, r.text);
    orgToken = r.json.owner_token;
    assert.equal(r.json.owner.role, "owner");
    const s = await login("ROOT@example.com", PW);
    assert.equal(s.status, 200, "email is case-insensitive");
    owner = { token: s.json.token, id: s.json.member.id };
  });
  after(() => t?.close());

  it("signs in with email and password and the session works everywhere a token does", async () => {
    const me = await t.api("GET", "/v1/me", { token: owner.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.member.email, "root@example.com");
    assert.equal(me.json.role, "owner");
    assert.equal((await t.api("GET", "/v1/projects", { token: owner.token })).status, 200);
    assert.equal((await t.api("GET", "/v1/me", { token: orgToken })).json.member, null, "an API token has no member");
    const s = await login("root@example.com", PW);
    assert.ok(new Date(s.json.expires_at).getTime() > Date.now() + 6 * 86_400_000);
    assert.equal(JSON.stringify(s.json).includes("password"), false, "no hash in the response");
  });

  it("rejects wrong credentials identically for unknown and known addresses, and throttles guessing", async () => {
    const a = await login("root@example.com", "wrong-password-1");
    const b = await login("nobody@example.com", "wrong-password-1");
    assert.equal(a.status, 401);
    assert.deepEqual(a.json, b.json);
    assert.equal((await login("root@example.com", "short")).status, 401);
    assert.equal((await t.api("POST", "/v1/auth/login", { body: { email: "x" } })).status, 400);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login("guess@example.com", `wrong-guess-${i}`)).status;
    assert.equal(last, 429);
    assert.equal((await login("root@example.com", PW)).status, 200, "another address is unaffected");
  });

  it("logging out ends only that session; sessions expire", async () => {
    const one = (await login("root@example.com", PW)).json.token;
    const two = (await login("root@example.com", PW)).json.token;
    assert.equal((await t.api("POST", "/v1/auth/logout", { token: one })).status, 204);
    assert.equal((await t.api("GET", "/v1/me", { token: one })).status, 401);
    assert.equal((await t.api("GET", "/v1/me", { token: two })).status, 200);
    await t.platform.control.pool.query(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE member_id = $1`, [owner.id]);
    assert.equal((await t.api("GET", "/v1/me", { token: two })).status, 401, "expired");
    assert.equal((await t.api("GET", "/v1/me", { token: owner.token })).status, 401);
    owner.token = (await login("root@example.com", PW)).json.token;
  });

  it("invites: roles are capped at the inviter's, tokens are single-use, and the list shows pending ones", async () => {
    const dev = await join(owner.token, "dev@example.com", "developer");
    const adm = await join(owner.token, "adm@example.com", "admin");
    assert.equal((await t.api("POST", "/v1/members/invites", { token: dev.token, body: { email: "x@example.com", role: "developer" } })).status, 403, "developers cannot invite");
    assert.equal((await t.api("POST", "/v1/members/invites", { token: adm.token, body: { email: "boss@example.com", role: "owner" } })).status, 403, "an admin cannot mint an owner");
    assert.equal((await t.api("POST", "/v1/members/invites", { token: adm.token, body: { email: "ok@example.com", role: "admin" } })).status, 201);
    assert.equal((await t.api("POST", "/v1/members/invites", { token: owner.token, body: { email: "DEV@example.com", role: "admin" } })).status, 409, "already a member");
    assert.equal((await t.api("POST", "/v1/members/invites", { token: owner.token, body: { email: "nope", role: "admin" } })).status, 400);
    assert.equal((await t.api("POST", "/v1/members/invites", { token: owner.token, body: { email: "a@example.com", role: "king" } })).status, 400);

    const inv = await t.api("POST", "/v1/members/invites", { token: owner.token, body: { email: "once@example.com", role: "developer" } });
    const first = await t.api("POST", "/v1/auth/accept-invite", { body: { token: inv.json.token, password: PW } });
    assert.equal(first.status, 201);
    const again = await t.api("POST", "/v1/auth/accept-invite", { body: { token: inv.json.token, password: PW } });
    assert.equal(again.status, 400, "single use");
    assert.equal((await t.api("POST", "/v1/auth/accept-invite", { body: { token: "baasinv_nonsense", password: PW } })).status, 400);

    const pending = await t.api("POST", "/v1/members/invites", { token: owner.token, body: { email: "later@example.com", role: "developer" } });
    assert.equal((await t.api("POST", "/v1/auth/accept-invite", { body: { token: pending.json.token, password: "short" } })).status, 400, "weak password does not spend the invite");
    assert.equal((await t.api("POST", "/v1/auth/accept-invite", { body: { token: pending.json.token, password: PW } })).status, 201, "and it still works afterwards");
    const l = (await t.api("GET", "/v1/members", { token: owner.token })).json;
    assert.deepEqual(l.members.map((m: any) => m.email).sort(), ["adm@example.com", "dev@example.com", "later@example.com", "once@example.com", "root@example.com"]);
    assert.deepEqual(l.invites.map((i: any) => i.email), ["ok@example.com"]);
    assert.equal(JSON.stringify(l).includes("hash"), false);
    assert.equal((await t.api("GET", "/v1/members", { token: dev.token })).status, 403);
  });

  it("an invite expires, can be revoked, and a re-invite replaces the old link", async () => {
    const a = await t.api("POST", "/v1/members/invites", { token: owner.token, body: { email: "exp@example.com", role: "developer" } });
    await t.platform.control.pool.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.json.invite.id]);
    assert.equal((await t.api("POST", "/v1/auth/accept-invite", { body: { token: a.json.token, password: PW } })).status, 400, "expired");
    const b = await t.api("POST", "/v1/members/invites", { token: owner.token, body: { email: "exp@example.com", role: "developer" } });
    assert.equal((await t.api("POST", "/v1/auth/accept-invite", { body: { token: a.json.token, password: PW } })).status, 400, "the old link is gone");
    assert.equal((await t.api("DELETE", `/v1/members/invites/${b.json.invite.id}`, { token: owner.token })).status, 204);
    assert.equal((await t.api("POST", "/v1/auth/accept-invite", { body: { token: b.json.token, password: PW } })).status, 400, "revoked");
    assert.equal((await t.api("DELETE", `/v1/members/invites/${b.json.invite.id}`, { token: owner.token })).status, 404);
  });

  it("role changes apply to live sessions at once, within the actor's rank", async () => {
    const dev = await join(owner.token, "promote@example.com", "developer");
    assert.equal((await t.api("POST", "/v1/projects", { token: dev.token, body: { name: "x" } })).status, 403);
    assert.equal((await t.api("PATCH", `/v1/members/${dev.id}`, { token: owner.token, body: { role: "admin" } })).status, 204);
    const p = await t.api("POST", "/v1/projects", { token: dev.token, body: { name: "by-promoted" } });
    assert.equal(p.status, 201, "same session, new role");
    t.refs.push(p.json.ref);
    const adm = await join(owner.token, "peer@example.com", "admin");
    assert.equal((await t.api("PATCH", `/v1/members/${owner.id}`, { token: adm.token, body: { role: "developer" } })).status, 403, "cannot touch a higher role");
    assert.equal((await t.api("PATCH", `/v1/members/${dev.id}`, { token: adm.token, body: { role: "owner" } })).status, 403, "cannot grant above own");
    assert.equal((await t.api("PATCH", `/v1/members/${dev.id}`, { token: owner.token, body: { role: "wizard" } })).status, 400);
    assert.equal((await t.api("PATCH", `/v1/members/${crypto.randomUUID()}`, { token: owner.token, body: { role: "admin" } })).status, 404);
  });

  it("removing a member ends their sessions; the last owner cannot be removed or demoted", async () => {
    const gone = await join(owner.token, "gone@example.com", "admin");
    assert.equal((await t.api("DELETE", `/v1/members/${gone.id}`, { token: owner.token })).status, 204);
    assert.equal((await t.api("GET", "/v1/me", { token: gone.token })).status, 401);
    assert.equal((await login("gone@example.com", PW)).status, 401);
    assert.equal((await t.api("DELETE", `/v1/members/${owner.id}`, { token: owner.token })).status, 409, "last owner");
    assert.equal((await t.api("PATCH", `/v1/members/${owner.id}`, { token: owner.token, body: { role: "admin" } })).status, 409);
    const second = await join(owner.token, "owner2@example.com", "owner");
    assert.equal((await t.api("PATCH", `/v1/members/${owner.id}`, { token: second.token, body: { role: "admin" } })).status, 204, "fine once there is another");
    assert.equal((await t.api("PATCH", `/v1/members/${owner.id}`, { token: second.token, body: { role: "owner" } })).status, 204);
    const dev = await join(owner.token, "leaver@example.com", "developer");
    assert.equal((await t.api("DELETE", `/v1/members/${dev.id}`, { token: dev.token })).status, 204, "anyone may leave");
    const other = await join(owner.token, "other@example.com", "developer");
    assert.equal((await t.api("DELETE", `/v1/members/${other.id}`, { token: (await join(owner.token, "d2@example.com", "developer")).token })).status, 403, "but not remove others");
  });

  it("changes password (needs the current one, signs out other sessions) and owners can reset one", async () => {
    const m = await join(owner.token, "pw@example.com", "developer");
    const other = (await login("pw@example.com", PW)).json.token;
    assert.equal((await t.api("POST", "/v1/me/password", { token: m.token, body: { current_password: "wrong-password", new_password: "brand-new-pass-1" } })).status, 400, "a wrong current password is not a 401: that would read as an ended session");
    assert.equal((await t.api("POST", "/v1/me/password", { token: m.token, body: { current_password: PW, new_password: "short" } })).status, 400);
    assert.equal((await t.api("POST", "/v1/me/password", { token: m.token, body: { current_password: PW, new_password: "brand-new-pass-1" } })).status, 204);
    assert.equal((await t.api("GET", "/v1/me", { token: m.token })).status, 200, "this session stays");
    assert.equal((await t.api("GET", "/v1/me", { token: other })).status, 401, "others are signed out");
    assert.equal((await login("pw@example.com", PW)).status, 401);
    assert.equal((await login("pw@example.com", "brand-new-pass-1")).status, 200);
    assert.equal((await t.api("POST", "/v1/me/password", { token: orgToken, body: { current_password: PW, new_password: "brand-new-pass-2" } })).status, 400, "API tokens have no password");

    const adm = await join(owner.token, "notowner@example.com", "admin");
    assert.equal((await t.api("POST", `/v1/members/${m.id}/password`, { token: adm.token, body: { password: "reset-by-admin-1" } })).status, 403, "owners only");
    assert.equal((await t.api("POST", `/v1/members/${m.id}/password`, { token: owner.token, body: { password: "reset-by-owner-1" } })).status, 204);
    assert.equal((await t.api("GET", "/v1/me", { token: m.token })).status, 401, "signed out everywhere");
    assert.equal((await login("pw@example.com", "reset-by-owner-1")).status, 200);
  });

  it("keeps organisations apart, leaves API tokens working, and audits what happened", async () => {
    const o2 = await t.api("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "Two", slug: `two-${Date.now() % 100000}` } });
    const two = o2.json.owner_token as string;
    const mine = (await t.api("GET", "/v1/members", { token: owner.token })).json.members[0].id;
    assert.equal((await t.api("DELETE", `/v1/members/${mine}`, { token: two })).status, 404, "another org's member");
    assert.deepEqual((await t.api("GET", "/v1/members", { token: two })).json, { members: [], invites: [] });
    assert.equal((await t.api("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "Dup", slug: `dup-${Date.now() % 100000}`, owner_email: "root@example.com", owner_password: PW } })).status, 409, "one account per address");
    assert.equal((await t.api("GET", "/v1/projects", { token: orgToken })).status, 200, "the organisation token still works");
    const log = await t.platform.control.pool.query(`SELECT action FROM audit_log WHERE action LIKE 'member.%'`);
    for (const a of ["member.login", "member.invite", "member.join", "member.role", "member.remove", "member.password", "member.password_reset"])
      assert.ok(log.rows.some((r) => r.action === a), a);
  });
});
