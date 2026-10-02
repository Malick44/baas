import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { makePlatform } from "./platform-testkit.js";
import { codeFor, stepAt } from "./totp.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

describe("multi-factor authentication", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  let n = 0;

  const gw = (method: string, url: string, o: { key?: string; body?: unknown } = {}) => t.gw(p.ref, method, url, { key: o.key ?? p.anon, body: o.body });
  const as = (token: string) => ({ key: token });
  const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  const fresh = async () => {
    const email = `mfa${++n}@example.com`;
    const s = (await gw("POST", "/auth/v1/signup", { body: { email, password: "password-123" } })).json;
    return { email, token: s.access_token as string, refresh: s.refresh_token as string, id: s.user.id as string };
  };
  const enroll = (token: string, body: Record<string, unknown> = {}) => gw("POST", "/auth/v1/factors", { ...as(token), body: { factor_type: "totp", ...body } });
  const challenge = (token: string, fid: string) => gw("POST", `/auth/v1/factors/${fid}/challenge`, as(token));
  /** Enrol and verify a factor; returns the upgraded session and the secret. */
  const setup = async (u: Awaited<ReturnType<typeof fresh>>, name?: string) => {
    const e = await enroll(u.token, name ? { friendly_name: name } : {});
    assert.equal(e.status, 200, e.text);
    const ch = await challenge(u.token, e.json.id);
    const v = await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: u.token, body: { challenge_id: ch.json.id, code: codeFor(e.json.totp.secret, stepAt(Date.now())) } });
    assert.equal(v.status, 200, v.text);
    return { factor: e.json.id as string, secret: e.json.totp.secret as string, session: v.json };
  };
  const answer = async (token: string, fid: string, code: string) => {
    const ch = await challenge(token, fid);
    return gw("POST", `/auth/v1/factors/${fid}/verify`, { key: token, body: { challenge_id: ch.json.id, code } });
  };

  before(async () => {
    t = await makePlatform(ADMIN!);
    owner = await t.org();
    p = await t.project(owner, "mfa");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
  });
  after(() => t?.close());

  it("enrols an authenticator, shows it as unverified, and keeps the secret out of every later response", async () => {
    const u = await fresh();
    const e = await enroll(u.token, { friendly_name: "My phone", issuer: "Acme" });
    assert.equal(e.status, 200, e.text);
    assert.match(e.json.totp.secret, /^[A-Z2-7]{32}$/);
    const uri = new URL(e.json.totp.uri);
    assert.equal(uri.searchParams.get("secret"), e.json.totp.secret);
    assert.equal(uri.searchParams.get("issuer"), "Acme");
    assert.equal(decodeURIComponent(uri.pathname), `/Acme:${u.email}`);
    const me = await gw("GET", "/auth/v1/user", as(u.token));
    assert.deepEqual(me.json.factors.map((f: any) => [f.id, f.friendly_name, f.status, f.factor_type]), [[e.json.id, "My phone", "unverified", "totp"]]);
    assert.ok(!me.text.includes(e.json.totp.secret));
    assert.ok(!JSON.stringify((await t.sql(owner, p.ref, "select * from auth.mfa_factors")).json).includes(e.json.totp.secret), "stored sealed, not in the clear");
    assert.equal((await gw("GET", "/auth/v1/user", as(u.token))).json.factors.length, 1);
  });

  it("verifies a code, upgrades the session to aal2 and keeps that level through a refresh", async () => {
    const u = await fresh();
    assert.equal(claims(u.token).aal, "aal1");
    const { session } = await setup(u, "phone");
    assert.equal(claims(session.access_token).aal, "aal2");
    assert.equal(claims(session.access_token).session_id, claims(u.token).session_id, "same session, higher level");
    const r = await gw("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } });
    assert.equal(claims(r.json.access_token).aal, "aal2", "refreshing keeps the level");
    assert.equal((await gw("GET", "/auth/v1/user", as(r.json.access_token))).json.factors[0].status, "verified");
    // The refresh token from before the upgrade is spent; replaying it is treated as a leak and ends the whole session.
    assert.equal((await gw("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: u.refresh } })).status, 400);
    assert.equal((await gw("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: r.json.refresh_token } })).status, 400, "and the upgraded session with it");
  });

  it("starts a password sign-in at aal1 and lets a policy demand aal2", async () => {
    const u = await fresh();
    const { secret } = await setup(u);
    await t.sql(owner, p.ref, `create table public.vault${n} (id serial primary key, owner uuid, note text);
      alter table public.vault${n} enable row level security; grant select on public.vault${n} to authenticated;
      create policy strong on public.vault${n} for select to authenticated using (owner = auth.uid() and (auth.jwt() ->> 'aal') = 'aal2');
      insert into public.vault${n} (owner, note) values ('${u.id}', 'top secret')`);
    const login = (await gw("POST", "/auth/v1/token?grant_type=password", { body: { email: u.email, password: "password-123" } })).json;
    assert.equal(claims(login.access_token).aal, "aal1");
    assert.deepEqual((await gw("GET", `/rest/v1/vault${n}`, as(login.access_token))).json, [], "a password alone is not enough for this table");
    const ch = await challenge(login.access_token, (await gw("GET", "/auth/v1/user", as(login.access_token))).json.factors[0].id);
    const up = await gw("POST", `/auth/v1/factors/${(await gw("GET", "/auth/v1/user", as(login.access_token))).json.factors[0].id}/verify`, { key: login.access_token, body: { challenge_id: ch.json.id, code: codeFor(secret, stepAt(Date.now()) + 1) } });
    assert.equal(up.status, 200, up.text);
    assert.equal((await gw("GET", `/rest/v1/vault${n}`, as(up.json.access_token))).json[0].note, "top secret");
  });

  it("rejects wrong codes, a reused code and an old code, and locks the factor after repeated failures", async () => {
    const u = await fresh();
    const { factor, secret, session } = await setup(u);
    const now = stepAt(Date.now());
    const bad = await answer(session.access_token, factor, "000000" === codeFor(secret, now) ? "111111" : "000000");
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error_code, "mfa_verification_failed");
    assert.equal((await answer(session.access_token, factor, codeFor(secret, now))).status, 400, "the code that was just accepted cannot be used again");
    assert.equal((await answer(session.access_token, factor, codeFor(secret, now - 1))).status, 400, "an older code is refused after a newer one");
    assert.equal((await answer(session.access_token, factor, codeFor(secret, now + 1))).status, 200, "the next one still works");
    for (let i = 0; i < 10; i++) await answer(session.access_token, factor, "999999");
    assert.equal((await answer(session.access_token, factor, codeFor(secret, now + 1))).status, 429, "ten failures lock it for a while, even for the right code");
  });

  it("spends a challenge once, lets it expire, and keeps factors private to their owner", async () => {
    const a = await fresh(), b = await fresh();
    const e = await enroll(a.token);
    const ch = await challenge(a.token, e.json.id);
    const code = codeFor(e.json.totp.secret, stepAt(Date.now()));
    assert.equal((await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: b.token, body: { challenge_id: ch.json.id, code } })).status, 404, "another user cannot answer");
    assert.equal((await challenge(b.token, e.json.id)).status, 404);
    assert.equal((await gw("DELETE", `/auth/v1/factors/${e.json.id}`, as(b.token))).status, 404);
    const ok = await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: a.token, body: { challenge_id: ch.json.id, code } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: ok.json.access_token, body: { challenge_id: ch.json.id, code: codeFor(e.json.totp.secret, stepAt(Date.now()) + 1) } })).status, 400, "a challenge answers once");
    const old = await challenge(ok.json.access_token, e.json.id);
    await t.sql(owner, p.ref, `update auth.mfa_challenges set created_at = now() - interval '6 minutes' where id = '${old.json.id}'`);
    assert.equal((await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: ok.json.access_token, body: { challenge_id: old.json.id, code: codeFor(e.json.totp.secret, stepAt(Date.now()) + 1) } })).status, 400, "an expired challenge");
    for (const bad of [{}, { challenge_id: "nope", code: "123456" }, { challenge_id: ch.json.id }, { challenge_id: ch.json.id, code: 123456 }]) assert.equal((await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: a.token, body: bad })).status, 400);
    assert.equal((await gw("POST", "/auth/v1/factors/not-a-uuid/challenge", as(a.token))).status, 404);
  });

  it("needs aal2 to change a password or email, add or remove a factor once one is verified", async () => {
    const u = await fresh();
    const { factor, session } = await setup(u, "first");
    const login = (await gw("POST", "/auth/v1/token?grant_type=password", { body: { email: u.email, password: "password-123" } })).json;
    for (const body of [{ password: "another-pass-1" }, { email: "moved-mfa@example.com" }]) {
      const r = await gw("PUT", "/auth/v1/user", { key: login.access_token, body });
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.equal(r.json.error_code, "insufficient_aal");
    }
    assert.equal((await gw("PUT", "/auth/v1/user", { key: login.access_token, body: { data: { nick: "fine" } } })).status, 200, "profile data is not protected");
    assert.equal((await enroll(login.access_token)).status, 401, "adding a factor needs aal2");
    assert.equal((await gw("DELETE", `/auth/v1/factors/${factor}`, as(login.access_token))).status, 401, "removing one too");
    assert.equal((await gw("PUT", "/auth/v1/user", { key: session.access_token, body: { password: "another-pass-1" } })).status, 200);
    assert.equal((await enroll(session.access_token, { friendly_name: "second" })).status, 200);
    assert.equal((await enroll(session.access_token, { friendly_name: "second" })).status, 422, "names are unique per user");
    assert.equal((await gw("DELETE", `/auth/v1/factors/${factor}`, as(session.access_token))).status, 200);
    assert.deepEqual((await gw("GET", "/auth/v1/user", as(session.access_token))).json.factors.map((f: any) => f.friendly_name), ["second"]);
  });

  it("does not let an email link alone get around the second factor", async () => {
    const mailer = new (await import("./mailer.js")).MemoryMailer();
    const t2 = await makePlatform(ADMIN!, { mail: { mailer }, auth: { emailCooldownMs: 0 } });
    try {
      const o2 = await t2.org();
      const q = await t2.project(o2, "recover");
      const g = (m: string, url: string, o: { key?: string; body?: unknown } = {}) => t2.gw(q.ref, m, url, { key: o.key ?? q.anon, body: o.body });
      const s = (await g("POST", "/auth/v1/signup", { body: { email: "r@example.com", password: "password-123" } })).json;
      const e = (await g("POST", "/auth/v1/factors", { key: s.access_token, body: {} })).json;
      const ch = (await g("POST", `/auth/v1/factors/${e.id}/challenge`, { key: s.access_token })).json;
      assert.equal((await g("POST", `/auth/v1/factors/${e.id}/verify`, { key: s.access_token, body: { challenge_id: ch.id, code: codeFor(e.totp.secret, stepAt(Date.now())) } })).status, 200);
      await g("POST", "/auth/v1/recover", { body: { email: "r@example.com" } });
      const code = /enter this code in the app: (\d{6})/.exec(mailer.last("r@example.com")!.text)![1];
      const rec = (await g("POST", "/auth/v1/verify", { body: { email: "r@example.com", token: code, type: "recovery" } })).json;
      assert.equal(claims(rec.access_token).aal, "aal1");
      assert.equal((await g("PUT", "/auth/v1/user", { key: rec.access_token, body: { password: "attacker-pass-1" } })).status, 401, "access to the mailbox is not enough");
    } finally { await t2.close(); }
  });

  it("lets an administrator remove a lost authenticator, which also ends its upgraded sessions", async () => {
    const u = await fresh();
    const { session } = await setup(u);
    const admin = (m: string, url: string) => gw(m, url, { key: p.service });
    const listed = (await admin("GET", "/auth/v1/admin/users?per_page=200")).json.users.find((x: any) => x.id === u.id);
    assert.deepEqual(listed.factors.map((f: any) => f.status), ["verified"]);
    assert.equal((await gw("DELETE", `/auth/v1/admin/users/${u.id}/factors`, as(u.token))).status, 403, "not for users");
    assert.equal((await admin("DELETE", `/auth/v1/admin/users/${u.id}/factors/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`)).status, 404);
    assert.equal((await admin("DELETE", `/auth/v1/admin/users/${u.id}/factors`)).status, 204);
    assert.equal((await admin("DELETE", `/auth/v1/admin/users/${u.id}/factors`)).status, 404, "nothing left to remove");
    assert.equal((await gw("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } })).status, 400, "the upgraded session ends");
    const login = (await gw("POST", "/auth/v1/token?grant_type=password", { body: { email: u.email, password: "password-123" } })).json;
    assert.equal((await gw("PUT", "/auth/v1/user", { key: login.access_token, body: { password: "free-again-1" } })).status, 200, "no factor, no second step");
  });

  it("validates enrolment and limits how many factors a user can have", async () => {
    const u = await fresh();
    assert.equal((await enroll(u.token, { factor_type: "phone" })).status, 422);
    assert.equal((await enroll(u.token, { friendly_name: "" })).status, 422);
    assert.equal((await enroll(u.token, { friendly_name: "x".repeat(61) })).status, 422);
    assert.equal((await gw("POST", "/auth/v1/factors", { key: p.anon, body: {} })).status, 401, "needs a user session");
    for (let i = 0; i < 10; i++) assert.equal((await enroll(u.token, { friendly_name: `f${i}` })).status, 200);
    assert.equal((await enroll(u.token, { friendly_name: "one too many" })).status, 422);
  });

  it("works on projects that predate these tables", async () => {
    const old = await t.project(owner, "legacy-mfa");
    const c = new pg.Client({ connectionString: old.dbUrl });
    await c.connect();
    await c.query("DROP TABLE auth.webauthn_credentials, auth.mfa_challenges, auth.mfa_factors");
    await c.query("ALTER TABLE auth.refresh_tokens DROP COLUMN aal");
    await c.end();
    const g = (m: string, url: string, o: { key?: string; body?: unknown } = {}) => t.gw(old.ref, m, url, { key: o.key ?? old.anon, body: o.body });
    const s = (await g("POST", "/auth/v1/signup", { body: { email: "old@example.com", password: "password-123" } }));
    assert.equal(s.status, 200, s.text);
    const e = await g("POST", "/auth/v1/factors", { key: s.json.access_token, body: {} });
    assert.equal(e.status, 200, e.text);
    const ch = (await g("POST", `/auth/v1/factors/${e.json.id}/challenge`, { key: s.json.access_token })).json;
    const v = await g("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: s.json.access_token, body: { challenge_id: ch.id, code: codeFor(e.json.totp.secret, stepAt(Date.now())) } });
    assert.equal(claims(v.json.access_token).aal, "aal2", v.text);
  });
});
