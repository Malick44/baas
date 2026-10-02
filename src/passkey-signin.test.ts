import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createClient } from "./client.js";
import { makePlatform } from "./platform-testkit.js";
import { SoftAuthenticator } from "./webauthn-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const ORIGIN = "https://app.example.com";
const handleOf = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");

describe("signing in and up with a passkey alone", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  const gw = (method: string, url: string, o: { key?: string; body?: unknown } = {}) => t.gw(p.ref, method, url, { key: o.key ?? p.anon, body: o.body });
  const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  const settings = (patch: object) => t.api("PATCH", `/v1/projects/${p.ref}/settings`, { token: owner, body: patch }).then((r) => { t.platform.dir.forget(p.ref); return r; });
  const options = (body: object = {}) => gw("POST", "/auth/v1/passkey/options", { body });
  const verify = (challenge_id: string, credential_response: unknown) => gw("POST", "/auth/v1/passkey/verify", { body: { challenge_id, credential_response } });

  /** Create a passkey-only account. */
  async function signUp(a: SoftAuthenticator, body: object = {}) {
    const o = await options({ purpose: "signup", ...body });
    assert.equal(o.status, 200, o.text);
    const v = await verify(o.json.id, a.create({ challenge: o.json.publicKey.challenge, rp: o.json.publicKey.rp }, ORIGIN));
    return { o, v };
  }
  async function signIn(a: SoftAuthenticator, userId?: string, extra: Parameters<SoftAuthenticator["get"]>[2] = {}) {
    const o = await options();
    assert.equal(o.status, 200, o.text);
    const v = await verify(o.json.id, a.get({ challenge: o.json.publicKey.challenge, rpId: o.json.publicKey.rpId }, ORIGIN, { userHandle: userId ? handleOf(userId) : undefined, ...extra }));
    return { o, v };
  }

  before(async () => {
    t = await makePlatform(ADMIN!);
    owner = await t.org();
    p = await t.project(owner, "passwordless");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
    await settings({ site_url: ORIGIN });
  });
  after(() => t?.close());

  it("is off until the project turns it on, and says so", async () => {
    assert.equal((await gw("GET", "/auth/v1/settings")).json.external.passkey, false);
    const o = await options();
    assert.equal(o.status, 422);
    assert.equal(o.json.error_code, "passkey_signin_disabled");
    assert.equal((await verify("00000000-0000-0000-0000-000000000000", {})).json.error_code, "passkey_signin_disabled");
    for (const bad of [{ passwordless: "yes" }, { passwordless: 1 }]) assert.equal((await settings({ webauthn: bad })).status, 400);
    assert.equal((await settings({ webauthn: { passwordless: true } })).status, 200);
    assert.equal((await gw("GET", "/auth/v1/settings")).json.external.passkey, true);
  });

  it("makes an account from nothing but a passkey, and signs back in with it", async () => {
    const a = new SoftAuthenticator();
    const { o, v } = await signUp(a, { friendly_name: "Ada's laptop", data: { nickname: "ada" } });
    assert.equal(o.json.publicKey.authenticatorSelection.residentKey, "required", "it must be discoverable, or there is nothing to pick at sign-in");
    assert.equal(o.json.publicKey.authenticatorSelection.userVerification, "required");
    assert.equal(v.status, 200, v.text);
    const id = v.json.user.id as string;
    assert.equal(o.json.publicKey.user.id, handleOf(id), "the browser is told the id the account will really have");
    assert.equal(v.json.user.email, null);
    assert.deepEqual(v.json.user.user_metadata, { nickname: "ada" });
    assert.equal(claims(v.json.access_token).aal, "aal2");
    const me = await gw("GET", "/auth/v1/user", { key: v.json.access_token });
    assert.deepEqual(me.json.factors.map((f: any) => [f.friendly_name, f.status, f.factor_type]), [["Ada's laptop", "verified", "webauthn"]]);
    assert.equal((await gw("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: v.json.refresh_token } })).status, 200, "the session refreshes");

    const back = await signIn(a, id);
    assert.equal(back.v.status, 200, back.v.text);
    assert.equal(back.v.json.user.id, id);
    assert.equal(claims(back.v.json.access_token).aal, "aal2");
    assert.notEqual(claims(back.v.json.access_token).session_id, claims(v.json.access_token).session_id, "a new session");
    assert.equal((await signIn(a, id, { count: 50 })).v.status, 200);
    assert.equal((await signIn(a, undefined)).v.status, 200, "a missing user handle is tolerated: the credential id says who");
  });

  it("lets someone who added a passkey as a second factor sign in with it", async () => {
    const email = "has-pw@example.com";
    const s = (await gw("POST", "/auth/v1/signup", { body: { email, password: "password-123" } })).json;
    const a = new SoftAuthenticator();
    const e = await gw("POST", "/auth/v1/factors", { key: s.access_token, body: { factor_type: "webauthn", friendly_name: "key" } });
    const ch = await gw("POST", `/auth/v1/factors/${e.json.id}/challenge`, { key: s.access_token });
    assert.equal(ch.json.webauthn.credential_options.publicKey.authenticatorSelection.residentKey, "required", "new second-factor passkeys are discoverable too once this is on");
    const v = await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: s.access_token, body: { challenge_id: ch.json.id, webauthn: { type: "create", credential_response: a.create(ch.json.webauthn.credential_options.publicKey, ORIGIN) } } });
    assert.equal(v.status, 200, v.text);
    const r = await signIn(a, s.user.id);
    assert.equal(r.v.status, 200, r.v.text);
    assert.equal(r.v.json.user.email, email);
  });

  it("refuses what it should", async () => {
    const a = new SoftAuthenticator();
    const { v } = await signUp(a);
    const id = v.json.user.id as string;
    // unknown passkey, bad signature, another site, another challenge, an authenticator that did not verify the person
    assert.equal((await signIn(new SoftAuthenticator(), id)).v.status, 400, "an unknown passkey");
    assert.equal((await signIn(a, id, { tamper: true })).v.status, 400, "a bad signature");
    const stranger = await signIn(a, "11111111-1111-1111-1111-111111111111");
    assert.equal(stranger.v.status, 400);
    assert.match(stranger.v.json.msg ?? stranger.v.json.message, /different account/);
    const o = await options();
    const evil = await verify(o.json.id, a.get(o.json.publicKey, "https://evil.example.net"));
    assert.match(evil.json.msg ?? evil.json.message, /not allowed to use passkeys/);
    const o2 = await options();
    assert.equal((await verify(o2.json.id, a.get(o2.json.publicKey, ORIGIN, { challenge: o.json.publicKey.challenge }))).status, 400, "an answer to another challenge");
    const lax = new SoftAuthenticator();
    lax.verifies = false;
    const noUv = await options({ purpose: "signup" });
    const rej = await verify(noUv.json.id, lax.create(noUv.json.publicKey, ORIGIN));
    assert.equal(rej.status, 400);
    assert.match(rej.json.msg ?? rej.json.message, /verify the person/);
    // one try per challenge, replays and unknown challenges
    const o3 = await options();
    const resp = a.get(o3.json.publicKey, ORIGIN);
    assert.equal((await verify(o3.json.id, resp)).status, 200);
    assert.equal((await verify(o3.json.id, resp)).status, 400, "the same bytes again");
    const o4 = await options();
    assert.equal((await verify(o4.json.id, resp)).status, 400, "the same bytes against a new challenge");
    assert.equal((await verify("00000000-0000-0000-0000-000000000000", resp)).status, 400);
    assert.equal((await verify("nope", resp)).status, 400);
    assert.equal((await verify(o4.json.id, {})).status, 400);
    assert.equal((await options({ purpose: "teleport" })).status, 422);
    assert.equal((await options({ purpose: "signup", friendly_name: "" })).status, 422);
    assert.equal((await options({ purpose: "signup", data: [] })).status, 422);
    // a sign-up challenge cannot be used to sign in, nor the other way round
    const su = await options({ purpose: "signup" });
    assert.equal((await verify(su.json.id, a.get({ challenge: su.json.publicKey.challenge, rpId: "app.example.com" }, ORIGIN))).status, 400);
    const si = await options();
    assert.equal((await verify(si.json.id, new SoftAuthenticator().create({ challenge: si.json.publicKey.challenge, rp: { id: "app.example.com" } }, ORIGIN))).status, 400);
    // the same authenticator cannot make a second account
    const again = await options({ purpose: "signup" });
    const dup = await verify(again.json.id, a.create(again.json.publicKey, ORIGIN));
    assert.equal(dup.status, 400);
    assert.match(dup.json.msg ?? dup.json.message, /already registered/);
  });

  it("does not let a banned user in, nor a removed passkey", async () => {
    const a = new SoftAuthenticator();
    const { v } = await signUp(a);
    const id = v.json.user.id as string;
    assert.equal((await gw("PUT", `/auth/v1/admin/users/${id}`, { key: p.service, body: { ban_duration: "1h" } })).status, 200);
    const banned = await signIn(a, id);
    assert.equal(banned.v.status, 400);
    assert.equal(banned.v.json.error_code, "user_banned");
    assert.equal((await gw("PUT", `/auth/v1/admin/users/${id}`, { key: p.service, body: { ban_duration: "none" } })).status, 200);
    assert.equal((await signIn(a, id)).v.status, 200);
    assert.equal((await gw("DELETE", `/auth/v1/admin/users/${id}/factors`, { key: p.service })).status, 204);
    assert.equal((await signIn(a, id)).v.status, 400, "a removed passkey no longer signs in");
  });

  it("follows the sign-up switch, and the setting being turned off again", async () => {
    await settings({ disable_signup: true });
    const o = await options({ purpose: "signup" });
    assert.equal(o.status, 422);
    assert.equal(o.json.error_code, "signup_disabled");
    // an offered challenge stops working if sign-ups close before it is answered
    await settings({ disable_signup: false });
    const a = new SoftAuthenticator();
    const open = await options({ purpose: "signup" });
    await settings({ disable_signup: true });
    assert.equal((await verify(open.json.id, a.create(open.json.publicKey, ORIGIN))).json.error_code, "signup_disabled");
    await settings({ disable_signup: false });
    // existing passkey holders can still sign in while sign-up is closed
    const b = new SoftAuthenticator();
    const { v } = await signUp(b);
    await settings({ disable_signup: true });
    assert.equal((await signIn(b, v.json.user.id)).v.status, 200);
    await settings({ disable_signup: false });
    await settings({ webauthn: { passwordless: false } });
    assert.equal((await options()).status, 422);
    await settings({ webauthn: { passwordless: true } });
  });

  it("keeps the table of open requests from growing without limit", async () => {
    const c = new (await import("pg")).default.Client({ connectionString: p.dbUrl });
    await c.connect();
    await c.query(`INSERT INTO auth.passkey_challenges (challenge, purpose) SELECT 'x' || g, 'signin' FROM generate_series(1, 5000) g`);
    const full = await options();
    assert.equal(full.status, 429);
    await c.query(`UPDATE auth.passkey_challenges SET created_at = now() - interval '2 hours'`);
    assert.equal((await options()).status, 200, "old ones are swept");
    await c.end();
  });

  it("works through the client library", async () => {
    const base = `http://${p.ref}.localhost:8081`;
    const fetchVia = ((u: string, i: RequestInit) => t.platform.gateway.inject({ method: (i.method ?? "GET") as "GET", url: String(u).replace(base, ""), headers: { ...(i.headers as Record<string, string>), host: `${p.ref}.localhost` }, payload: i.body as string })
      .then((r) => new Response(r.body, { status: r.statusCode, headers: r.headers as Record<string, string> }))) as typeof fetch;
    const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const device = new SoftAuthenticator();
    let userId = "";
    let cancel = false;
    const credentials = {
      async create(o: any) {
        if (cancel) throw new Error("The operation was cancelled");
        assert.ok(o.publicKey.challenge instanceof ArrayBuffer && o.publicKey.user.id instanceof ArrayBuffer);
        const r = device.create({ challenge: Buffer.from(o.publicKey.challenge).toString("base64url"), rp: o.publicKey.rp }, ORIGIN);
        return { id: r.id, type: r.type, rawId: ab(Buffer.from(r.rawId, "base64url")), response: { clientDataJSON: ab(Buffer.from(r.response.clientDataJSON, "base64url")), attestationObject: ab(Buffer.from(r.response.attestationObject, "base64url")) } };
      },
      async get(o: any) {
        if (cancel) throw new Error("The operation was cancelled");
        assert.deepEqual(o.publicKey.allowCredentials, [], "discoverable: the browser picks");
        const r = device.get({ challenge: Buffer.from(o.publicKey.challenge).toString("base64url"), rpId: o.publicKey.rpId }, ORIGIN, { userHandle: handleOf(userId) });
        return { id: r.id, type: r.type, rawId: ab(Buffer.from(r.rawId, "base64url")), response: { clientDataJSON: ab(Buffer.from(r.response.clientDataJSON, "base64url")), authenticatorData: ab(Buffer.from(r.response.authenticatorData, "base64url")), signature: ab(Buffer.from(r.response.signature, "base64url")), userHandle: ab(Buffer.from(r.response.userHandle!, "base64url")) } };
      },
    };
    const c = createClient(base, p.anon, { fetch: fetchVia, credentials });
    cancel = true;
    assert.match((await c.auth.signUpWithPasskey()).error!.message, /cancelled/);
    cancel = false;
    const up = await c.auth.signUpWithPasskey({ displayName: "sdk device", data: { plan: "free" } });
    assert.equal(up.error, null, JSON.stringify(up.error));
    userId = up.data!.user.id;
    assert.equal((await c.auth.mfa.getAuthenticatorAssuranceLevel()).data!.currentLevel, "aal2");
    await c.auth.signOut();
    assert.ok((await c.auth.getUser()).error, "signed out");
    cancel = true;
    assert.match((await c.auth.signInWithPasskey()).error!.message, /cancelled/);
    cancel = false;
    const inn = await c.auth.signInWithPasskey();
    assert.equal(inn.error, null, JSON.stringify(inn.error));
    assert.equal(inn.data!.user.id, userId);
    assert.equal((await c.auth.getUser()).data!.user.id, userId, "the client holds the session");
    const bare = createClient(base, p.anon, { fetch: fetchVia });
    assert.match((await bare.auth.signInWithPasskey()).error!.message, /cannot use passkeys/);
  });

  it("upgrades projects created before passkey sign-in existed", async () => {
    const o = await t.project(owner, "legacy-passwordless");
    const c = new (await import("pg")).default.Client({ connectionString: o.dbUrl });
    await c.connect();
    await c.query(`DROP TABLE auth.passkey_challenges`);
    await c.end();
    await t.api("PATCH", `/v1/projects/${o.ref}/settings`, { token: owner, body: { site_url: ORIGIN, webauthn: { passwordless: true } } });
    t.platform.dir.forget(o.ref);
    const r = await t.gw(o.ref, "POST", "/auth/v1/passkey/options", { key: o.anon, body: {} });
    assert.equal(r.status, 200, r.text);
  });
});
