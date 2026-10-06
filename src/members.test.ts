import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MemoryMailer } from "./mailer.js";
import { BOOT, makePlatform } from "./platform-testkit.js";
import { codeFor, stepAt } from "./totp.js";

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
    assert.equal(Object.hasOwn(s.json.member, "password_hash"), false, "no hash in the response");
    assert.equal(Object.hasOwn(s.json.member, "password"), false, "no password in the response");
    assert.equal(s.text.includes(PW), false, "password value is never returned");
    assert.equal(s.json.member.must_change_password, false);
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

describe("member password reset and authenticator", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let bare: Awaited<ReturnType<typeof makePlatform>>;
  const mail = new MemoryMailer();
  const PW = "correct-horse-battery";
  let owner: { token: string; id: string };
  let org: string;

  const login = (email: string, password: string) => t.api("POST", "/v1/auth/login", { body: { email, password } });
  const now = () => stepAt(Date.now());
  async function join(admin: string, email: string, role: string) {
    const inv = await t.api("POST", "/v1/members/invites", { token: admin, body: { email, role } });
    const acc = await t.api("POST", "/v1/auth/accept-invite", { body: { token: inv.json.token, password: PW } });
    assert.equal(acc.status, 201, acc.text);
    return { token: acc.json.token as string, id: acc.json.member.id as string };
  }
  /** Turn on an authenticator for a signed-in member; returns the secret and recovery codes. */
  async function enableMfa(token: string) {
    const e = await t.api("POST", "/v1/me/mfa/enroll", { token });
    assert.equal(e.status, 200, e.text);
    const v = await t.api("POST", "/v1/me/mfa/verify", { token, body: { code: codeFor(e.json.secret, now()) } });
    assert.equal(v.status, 200, v.text);
    return { secret: e.json.secret as string, recovery: v.json.recovery_codes as string[] };
  }

  before(async () => {
    t = await makePlatform(ADMIN!, { mail: { mailer: mail }, dashboardUrl: "http://dash.test" });
    bare = await makePlatform(ADMIN!);
    const r = await t.api("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "Sec", slug: `sec-${Date.now() % 100000}`, owner_email: "boss@example.com", owner_password: PW } });
    assert.equal(r.status, 201, r.text);
    org = r.json.owner_token;
    owner = { token: (await login("boss@example.com", PW)).json.token, id: r.json.owner.id };
  });
  after(async () => { await t?.close(); await bare?.close(); });

  describe("reset by email", () => {
    it("is off, and says so, when the server cannot send email", async () => {
      assert.equal((await bare.api("GET", "/v1/config")).json.member_email_reset, false);
      assert.equal((await bare.api("POST", "/v1/auth/forgot", { body: { email: "x@example.com" } })).status, 501);
      assert.equal((await t.api("GET", "/v1/config")).json.member_email_reset, true);
    });

    it("answers the same for known and unknown addresses, and mails a single-use link only to a member", async () => {
      const m = await join(owner.token, "forgetful@example.com", "developer");
      const before = mail.outbox.length;
      const unknown = await t.api("POST", "/v1/auth/forgot", { body: { email: "nobody-here@example.com" } });
      const known = await t.api("POST", "/v1/auth/forgot", { body: { email: "Forgetful@example.com" } });
      assert.equal(unknown.status, 202);
      assert.deepEqual(unknown.json, known.json);
      assert.equal((await t.api("POST", "/v1/auth/forgot", { body: { email: "not an email" } })).status, 400);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(mail.outbox.length - before, 1, "only the real member gets mail");
      const sent = mail.outbox.at(-1)!;
      assert.equal(sent.to, "forgetful@example.com");
      const link = /http:\/\/dash\.test\/#\/reset\/(baasrst_[\w-]+)/.exec(sent.text);
      assert.ok(link, sent.text);

      await t.api("POST", "/v1/auth/forgot", { body: { email: "forgetful@example.com" } });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(mail.outbox.length - before, 1, "asking again right away does not send another");

      assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: link![1], password: "short" } })).status, 400);
      assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: "baasrst_nonsense", password: "a-new-passphrase-1" } })).status, 400);
      assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: link![1], password: "a-new-passphrase-1" } })).status, 204, "a weak password did not spend the link");
      assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: link![1], password: "another-passphrase-2" } })).status, 400, "single use");
      assert.equal((await t.api("GET", "/v1/me", { token: m.token })).status, 401, "signed out everywhere");
      assert.equal((await login("forgetful@example.com", PW)).status, 401);
      assert.equal((await login("forgetful@example.com", "a-new-passphrase-1")).status, 200);
    });

    it("links expire and are replaced by a newer request", async () => {
      const m = await join(owner.token, "slow@example.com", "developer");
      void m;
      await t.api("POST", "/v1/auth/forgot", { body: { email: "slow@example.com" } });
      await new Promise((r) => setTimeout(r, 50));
      const first = /reset\/(baasrst_[\w-]+)/.exec(mail.outbox.at(-1)!.text)![1]!;
      await t.platform.control.pool.query(`UPDATE member_resets SET expires_at = now() - interval '1 minute'`);
      assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: first, password: "a-new-passphrase-1" } })).status, 400, "expired");
      void org;
    });
  });

  describe("authenticator app", () => {
    it("is set up in two steps and shows on the member", async () => {
      const m = await join(owner.token, "twofa@example.com", "developer");
      assert.equal((await t.api("POST", "/v1/me/mfa/verify", { token: m.token, body: { code: "123456" } })).status, 400, "nothing to verify yet");
      const e = await t.api("POST", "/v1/me/mfa/enroll", { token: m.token });
      assert.match(e.json.uri, /^otpauth:\/\/totp\/baas:twofa%40example\.com\?secret=[A-Z2-7]+/);
      assert.equal((await t.api("GET", "/v1/me", { token: m.token })).json.member.mfa, false, "not on until a code is proven");
      assert.equal((await login("twofa@example.com", PW)).json.token !== undefined, true);
      assert.equal((await t.api("POST", "/v1/me/mfa/verify", { token: m.token, body: { code: "000000" } })).status, 400);
      assert.equal((await t.api("POST", "/v1/me/mfa/verify", { token: m.token, body: { code: "abc" } })).status, 400);
      const v = await t.api("POST", "/v1/me/mfa/verify", { token: m.token, body: { code: codeFor(e.json.secret, now()) } });
      assert.equal(v.status, 200);
      assert.equal(v.json.recovery_codes.length, 8);
      assert.ok(v.json.recovery_codes.every((c: string) => /^[0-9a-f]{5}-[0-9a-f]{5}$/.test(c)));
      assert.equal((await t.api("GET", "/v1/me", { token: m.token })).json.member.mfa, true);
      assert.equal((await t.api("POST", "/v1/me/mfa/enroll", { token: m.token })).status, 409, "remove it before starting over");
      const raw = await t.platform.control.pool.query(`SELECT secret_enc FROM member_factors WHERE member_id = $1`, [m.id]);
      assert.equal(raw.rows[0].secret_enc.includes(e.json.secret), false, "sealed at rest");
      assert.equal((await t.api("POST", "/v1/me/mfa/enroll", { token: org })).status, 400, "API tokens are not members");
      assert.equal((await t.api("GET", "/v1/members", { token: owner.token })).json.members.find((x: any) => x.id === m.id).mfa, true);
    });

    it("needs the code after the password, and a code works once", async () => {
      const m = await join(owner.token, "login2fa@example.com", "admin");
      const { secret } = await enableMfa(m.token);
      const first = await login("login2fa@example.com", PW);
      assert.equal(first.status, 200);
      assert.equal(first.json.mfa_required, true);
      assert.equal(first.json.token, undefined, "no session yet");
      assert.equal((await t.api("GET", "/v1/me", { token: first.json.mfa_token })).status, 401, "the ticket is not a session");
      const mfa = (token: string, code: string) => t.api("POST", "/v1/auth/mfa", { body: { mfa_token: token, code } });
      assert.equal((await mfa(first.json.mfa_token, "000000")).status, 401);
      assert.equal((await mfa("baasmfa_nonsense", codeFor(secret, now() + 1))).status, 401);
      const ok = await mfa(first.json.mfa_token, codeFor(secret, now() + 1));
      assert.equal(ok.status, 200, ok.text);
      assert.equal((await t.api("GET", "/v1/me", { token: ok.json.token })).json.member.email, "login2fa@example.com");
      assert.equal((await mfa(first.json.mfa_token, codeFor(secret, now() + 1))).status, 401, "the ticket is used up");
      const second = await login("login2fa@example.com", PW);
      assert.equal((await mfa(second.json.mfa_token, codeFor(secret, now() + 1))).status, 401, "the same code cannot be replayed");
      assert.equal((await mfa(second.json.mfa_token, codeFor(secret, now() + 1))).status, 401);
      const third = await login("login2fa@example.com", PW);
      assert.equal((await mfa(third.json.mfa_token, codeFor(secret, now() - 1))).status, 401, "nor an older one");
    });

    it("gives a ticket five tries and a few minutes", async () => {
      const m = await join(owner.token, "tries@example.com", "developer");
      const { secret } = await enableMfa(m.token);
      const tk = (await login("tries@example.com", PW)).json.mfa_token;
      for (let i = 0; i < 5; i++) assert.equal((await t.api("POST", "/v1/auth/mfa", { body: { mfa_token: tk, code: "111111" } })).status, 401);
      const late = await t.api("POST", "/v1/auth/mfa", { body: { mfa_token: tk, code: codeFor(secret, now() + 1) } });
      assert.equal(late.status, 401, "even the right code is refused after five misses");
      assert.match(late.json.error, /expired/);
      const tk2 = (await login("tries@example.com", PW)).json.mfa_token;
      await t.platform.control.pool.query(`UPDATE member_mfa_tickets SET expires_at = now() - interval '1 second'`);
      assert.equal((await t.api("POST", "/v1/auth/mfa", { body: { mfa_token: tk2, code: codeFor(secret, now() + 1) } })).status, 401, "expired");
    });

    it("accepts each recovery code once, in place of an authenticator code", async () => {
      const m = await join(owner.token, "recover@example.com", "developer");
      const { recovery } = await enableMfa(m.token);
      const use = async (code: string) => t.api("POST", "/v1/auth/mfa", { body: { mfa_token: (await login("recover@example.com", PW)).json.mfa_token, code } });
      assert.equal((await use(recovery[0]!)).status, 200);
      assert.equal((await use(recovery[0]!)).status, 401, "spent");
      assert.equal((await use(recovery[1]!.toUpperCase())).status, 200, "case does not matter");
      assert.equal((await use("00000-00000")).status, 401);
    });

    it("is removed with the password and a code, or by an owner for someone who lost both", async () => {
      const m = await join(owner.token, "remove2fa@example.com", "developer");
      const { secret } = await enableMfa(m.token);
      const off = (password: string, code: string) => t.api("POST", "/v1/me/mfa/disable", { token: m.token, body: { password, code } });
      assert.equal((await off("wrong-password-1", codeFor(secret, now() + 1))).status, 400);
      assert.equal((await off(PW, "000000")).status, 400);
      assert.equal((await off(PW, codeFor(secret, now() + 1))).status, 204);
      assert.equal((await login("remove2fa@example.com", PW)).json.token !== undefined, true, "back to a password alone");

      const lost = await join(owner.token, "lost@example.com", "developer");
      await enableMfa(lost.token);
      const adm = await join(owner.token, "mere-admin@example.com", "admin");
      assert.equal((await t.api("DELETE", `/v1/members/${lost.id}/mfa`, { token: adm.token })).status, 403, "owners only");
      assert.equal((await t.api("DELETE", `/v1/members/${lost.id}/mfa`, { token: owner.token })).status, 204);
      assert.equal((await login("lost@example.com", PW)).json.token !== undefined, true);
      assert.equal((await t.api("DELETE", `/v1/members/${crypto.randomUUID()}/mfa`, { token: owner.token })).status, 404);
    });

    it("keeps a reset password behind the second factor, and counts second-step misses against the address", async () => {
      const m = await join(owner.token, "reset2fa@example.com", "developer");
      await enableMfa(m.token);
      await t.api("POST", "/v1/auth/forgot", { body: { email: "reset2fa@example.com" } });
      await new Promise((r) => setTimeout(r, 50));
      const tok = /reset\/(baasrst_[\w-]+)/.exec(mail.outbox.at(-1)!.text)![1]!;
      assert.equal((await t.api("POST", "/v1/auth/reset", { body: { token: tok, password: "fresh-passphrase-9" } })).status, 204);
      const again = await login("reset2fa@example.com", "fresh-passphrase-9");
      assert.equal(again.json.mfa_required, true, "a reset by email does not switch the second factor off");
      let last = 0;
      for (let i = 0; i < 12; i++) {
        const tk = (await login("reset2fa@example.com", "fresh-passphrase-9"));
        if (tk.status === 429) { last = 429; break; }
        last = (await t.api("POST", "/v1/auth/mfa", { body: { mfa_token: tk.json.mfa_token, code: "222222" } })).status;
      }
      assert.equal(last, 429);
    });
  });
});
