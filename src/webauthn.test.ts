import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createClient } from "./client.js";
import { makePlatform } from "./platform-testkit.js";
import { cborDecode, parseAuthData, verifyAssertion, verifyRegistration, WebAuthnError } from "./webauthn.js";
import { cborEncode, SoftAuthenticator } from "./webauthn-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const ORIGIN = "https://app.example.com";
const b64 = (b: Buffer) => b.toString("base64url");

describe("WebAuthn primitives", () => {
  it("reads CBOR, and refuses what it should", () => {
    const v = new Map<unknown, unknown>([["fmt", "none"], [1, -7], [-3, Buffer.from([1, 2, 3])], ["a", [true, false, 300, 70000]]]);
    const back = cborDecode(cborEncode(v)).value as Map<unknown, unknown>;
    assert.equal(back.get("fmt"), "none");
    assert.equal(back.get(1), -7);
    assert.deepEqual(back.get(-3), Buffer.from([1, 2, 3]));
    assert.deepEqual(back.get("a"), [true, false, 300, 70000]);
    for (const bad of [Buffer.alloc(0), Buffer.from([0x18]), Buffer.from([0x5f]), Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0x82, 0x01]), Buffer.from([0x19, 0x27]), Buffer.from([0x43, 1, 2])])
      assert.throws(() => cborDecode(bad), WebAuthnError);
    let deep = Buffer.from([0x01]);
    for (let i = 0; i < 12; i++) deep = Buffer.concat([Buffer.from([0x81]), deep]);
    assert.throws(() => cborDecode(deep), /too deeply/);
    assert.throws(() => cborDecode(Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff])), /too long|too large/);
  });

  it("parses authenticator data and rejects short or lying input", () => {
    assert.throws(() => parseAuthData(Buffer.alloc(10)), /too short/);
    const bad = Buffer.alloc(60);
    bad[32] = 0x41;
    bad.writeUInt16BE(0, 53);
    assert.throws(() => parseAuthData(bad), /credential id/);
    bad.writeUInt16BE(500, 53);
    assert.throws(() => parseAuthData(bad), /credential id/);
  });

  const expect = { challenge: "chal-123", rpId: "app.example.com", origins: [ORIGIN] };
  const reg = (a: SoftAuthenticator, o = {}, origin = ORIGIN) => {
    const r = a.create({ challenge: "chal-123", rp: { id: "app.example.com" } }, origin, o).response;
    return { attestationObject: Buffer.from(r.attestationObject, "base64url"), clientDataJSON: Buffer.from(r.clientDataJSON, "base64url") };
  };

  for (const alg of ["ES256", "RS256", "EdDSA"] as const) {
    it(`registers and then verifies an ${alg} credential`, () => {
      const a = new SoftAuthenticator(alg);
      const r = verifyRegistration(reg(a), expect);
      assert.equal(r.credentialId, b64(a.credentialId));
      assert.equal(r.signCount, 0);
      const get = (o = {}) => { const x = a.get({ challenge: "chal-123", rpId: "app.example.com" }, ORIGIN, o).response; return { authenticatorData: Buffer.from(x.authenticatorData, "base64url"), clientDataJSON: Buffer.from(x.clientDataJSON, "base64url"), signature: Buffer.from(x.signature, "base64url") }; };
      assert.equal(verifyAssertion(get(), expect, { publicKey: r.publicKey, signCount: 0 }), 1);
      assert.equal(verifyAssertion(get(), expect, { publicKey: r.publicKey, signCount: 1 }), 2);
      assert.throws(() => verifyAssertion(get({ tamper: true }), expect, { publicKey: r.publicKey, signCount: 2 }), /signature/);
      assert.throws(() => verifyAssertion(get({ count: 2 }), expect, { publicKey: r.publicKey, signCount: 5 }), /cloned/);
      assert.equal(verifyAssertion(get({ count: 0 }), expect, { publicKey: r.publicKey, signCount: 0 }), 0, "authenticators without a counter always say 0");
      const other = new SoftAuthenticator(alg);
      const o = other.get({ challenge: "chal-123", rpId: "app.example.com" }, ORIGIN).response;
      assert.throws(() => verifyAssertion({ authenticatorData: Buffer.from(o.authenticatorData, "base64url"), clientDataJSON: Buffer.from(o.clientDataJSON, "base64url"), signature: Buffer.from(o.signature, "base64url") }, expect, { publicKey: r.publicKey, signCount: 0 }), /signature/, "another key's signature");
    });
  }

  it("refuses responses for the wrong site, challenge, step, or a missing presence flag", () => {
    const a = new SoftAuthenticator();
    assert.throws(() => verifyRegistration(reg(a, {}, "https://evil.example.net"), expect), /not allowed to use passkeys/);
    assert.throws(() => verifyRegistration(reg(a, { challenge: "other" }), expect), /challenge/);
    assert.throws(() => verifyRegistration(reg(a, { type: "webauthn.get" }), expect), /different step/);
    assert.throws(() => verifyRegistration(reg(a, { rpId: "evil.example.net" }), expect), /relying party/);
    assert.throws(() => verifyRegistration(reg(a, { up: false }), expect), /present/);
    a.verifies = false;
    assert.throws(() => verifyRegistration(reg(a), { ...expect, requireUserVerification: true }), /verify the person/);
    assert.ok(verifyRegistration(reg(a), expect), "not required by default");
    assert.throws(() => verifyRegistration({ attestationObject: cborEncode(new Map([["fmt", "none"]])), clientDataJSON: reg(a).clientDataJSON }, expect), /malformed/);
    assert.throws(() => verifyRegistration({ attestationObject: reg(a).attestationObject, clientDataJSON: Buffer.from("not json") }, expect), /JSON/);
  });
});

describe("passkeys as a second factor", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<Awaited<ReturnType<typeof makePlatform>>["project"]>>;
  let n = 0;
  const gw = (method: string, url: string, o: { key?: string; body?: unknown } = {}) => t.gw(p.ref, method, url, { key: o.key ?? p.anon, body: o.body });
  const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  const settings = (patch: object) => t.api("PATCH", `/v1/projects/${p.ref}/settings`, { token: owner, body: patch }).then((r) => { t.platform.dir.forget(p.ref); return r; });
  const fresh = async () => {
    const email = `pk${++n}@example.com`;
    const s = (await gw("POST", "/auth/v1/signup", { body: { email, password: "password-123" } })).json;
    return { email, token: s.access_token as string, id: s.user.id as string };
  };
  const enroll = (token: string, body: Record<string, unknown> = {}) => gw("POST", "/auth/v1/factors", { key: token, body: { factor_type: "webauthn", ...body } });
  const challenge = (token: string, fid: string) => gw("POST", `/auth/v1/factors/${fid}/challenge`, { key: token });
  const verify = (token: string, fid: string, challengeId: string, type: "create" | "request", response: unknown) =>
    gw("POST", `/auth/v1/factors/${fid}/verify`, { key: token, body: { challenge_id: challengeId, webauthn: { type, credential_response: response } } });
  /** Register an authenticator as a new factor; returns the upgraded session. */
  async function register(u: { token: string }, a: SoftAuthenticator, name = "key") {
    const e = await enroll(u.token, { friendly_name: name });
    assert.equal(e.status, 200, e.text);
    const ch = await challenge(u.token, e.json.id);
    assert.equal(ch.status, 200, ch.text);
    const v = await verify(u.token, e.json.id, ch.json.id, "create", a.create(ch.json.webauthn.credential_options.publicKey, ORIGIN));
    return { factor: e.json.id as string, v };
  }
  async function signIn(u: { token: string }, factor: string, a: SoftAuthenticator, o: Parameters<SoftAuthenticator["get"]>[2] = {}) {
    const ch = await challenge(u.token, factor);
    assert.equal(ch.json.webauthn.type, "request");
    return { ch, v: await verify(u.token, factor, ch.json.id, "request", a.get(ch.json.webauthn.credential_options.publicKey, ORIGIN, o)) };
  }

  before(async () => {
    t = await makePlatform(ADMIN!);
    owner = await t.org();
    p = await t.project(owner, "passkeys");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
  });
  after(() => t?.close());

  it("needs to know which site passkeys belong to, and checks that setting", async () => {
    const u = await fresh();
    const none = await enroll(u.token);
    assert.equal(none.status, 422);
    assert.equal(none.json.error_code, "webauthn_not_configured");
    for (const bad of [{ rp_id: "10.0.0.1" }, { rp_id: "Has Space" }, { origins: ["https://app.example.com/path"] }, { origins: ["http://app.example.com"] }, { origins: "https://a.example" }, { rp_name: "" }, { nope: 1 }, { require_user_verification: "yes" }])
      assert.equal((await settings({ webauthn: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await settings({ webauthn: { rp_id: "app.example.com", origins: ["https://other.net"] } })).status, 200);
    assert.equal((await enroll(u.token)).json.error_code, "webauthn_misconfigured", "an origin off the id would never work in a browser");
    assert.equal((await settings({ webauthn: {}, site_url: ORIGIN })).status, 200, "the site URL is enough");
    assert.equal((await enroll(u.token, { friendly_name: "ok" })).status, 200);
    assert.equal((await enroll(u.token, { factor_type: "sms" })).status, 422);
  });

  it("registers a passkey, upgrades the session to aal2, and lists the factor", async () => {
    const u = await fresh();
    const a = new SoftAuthenticator();
    const e = await enroll(u.token, { friendly_name: "YubiKey" });
    assert.deepEqual(e.json, { id: e.json.id, type: "webauthn", friendly_name: "YubiKey" });
    const ch = await challenge(u.token, e.json.id);
    const opts = ch.json.webauthn.credential_options.publicKey;
    assert.equal(ch.json.webauthn.type, "create");
    assert.deepEqual(opts.rp, { id: "app.example.com", name: "app.example.com" });
    assert.equal(opts.attestation, "none");
    assert.deepEqual(opts.pubKeyCredParams.map((x: any) => x.alg), [-7, -8, -257]);
    assert.equal(Buffer.from(opts.user.id, "base64url").toString("hex"), u.id.replace(/-/g, ""));
    assert.equal(opts.user.name, u.email);
    assert.equal(Buffer.from(opts.challenge, "base64url").length, 32);
    assert.deepEqual(opts.excludeCredentials, []);
    const v = await verify(u.token, e.json.id, ch.json.id, "create", a.create(opts, ORIGIN));
    assert.equal(v.status, 200, v.text);
    assert.equal(claims(v.json.access_token).aal, "aal2");
    const me = await gw("GET", "/auth/v1/user", { key: v.json.access_token });
    assert.deepEqual(me.json.factors.map((f: any) => [f.friendly_name, f.status, f.factor_type]), [["YubiKey", "verified", "webauthn"]]);
    assert.equal(JSON.stringify(me.json).includes("public_key"), false);
    const again = await verify(u.token, e.json.id, ch.json.id, "create", a.create(opts, ORIGIN));
    assert.equal(again.status, 400, "a challenge answers once");
  });

  it("asks for the passkey at the next sign-in, and a good answer gives aal2", async () => {
    const u = await fresh();
    const a = new SoftAuthenticator();
    const { factor } = await register(u, a);
    const login = (await gw("POST", "/auth/v1/token?grant_type=password", { body: { email: u.email, password: "password-123" } })).json;
    assert.equal(claims(login.access_token).aal, "aal1");
    const { ch, v } = await signIn({ token: login.access_token }, factor, a);
    assert.equal(ch.json.webauthn.credential_options.publicKey.rpId, "app.example.com");
    assert.deepEqual(ch.json.webauthn.credential_options.publicKey.allowCredentials, [{ type: "public-key", id: b64(a.credentialId) }]);
    assert.equal(v.status, 200, v.text);
    assert.equal(claims(v.json.access_token).aal, "aal2");
    assert.equal(claims(v.json.access_token).session_id, claims(login.access_token).session_id, "same session, upgraded");
  });

  for (const alg of ["RS256", "EdDSA"] as const) {
    it(`works with ${alg} keys`, async () => {
      const u = await fresh();
      const a = new SoftAuthenticator(alg);
      const { factor, v } = await register(u, a);
      assert.equal(v.status, 200, v.text);
      assert.equal((await signIn(u, factor, a)).v.status, 200);
    });
  }

  it("rejects a wrong signature, the wrong passkey, the wrong site, and a response made for another challenge", async () => {
    const u = await fresh();
    const a = new SoftAuthenticator();
    const { factor } = await register(u, a);
    assert.equal((await signIn(u, factor, a, { tamper: true })).v.status, 400);
    assert.equal((await signIn(u, factor, new SoftAuthenticator())).v.status, 400, "a different passkey");
    const stranger = await signIn(u, factor, a, { id: "AAAA" });
    assert.equal(stranger.v.status, 400);
    assert.match(stranger.v.json.msg ?? stranger.v.json.message, /not the passkey/);
    const ch = await challenge(u.token, factor);
    const opts = ch.json.webauthn.credential_options.publicKey;
    const evil = await verify(u.token, factor, ch.json.id, "request", a.get(opts, "https://evil.example.net"));
    assert.equal(evil.status, 400);
    assert.match(evil.json.msg ?? evil.json.message, /not allowed to use passkeys/);
    const ch2 = await challenge(u.token, factor);
    const stale = await verify(u.token, factor, ch2.json.id, "request", a.get(ch2.json.webauthn.credential_options.publicKey, ORIGIN, { challenge: opts.challenge }));
    assert.equal(stale.status, 400, "an answer to an old challenge");
    assert.equal((await signIn(u, factor, a)).v.status, 200, "and the real thing still works afterwards");
    const ch3 = await challenge(u.token, factor);
    assert.equal((await verify(u.token, factor, ch3.json.id, "create", a.get(ch3.json.webauthn.credential_options.publicKey, ORIGIN))).status, 400, "the wrong step for this factor");
    assert.equal((await verify(u.token, factor, ch3.json.id, "request", {})).status, 400);
  });

  it("notices a cloned passkey by its counter, and refuses a response replayed from the wire", async () => {
    const u = await fresh();
    const a = new SoftAuthenticator();
    const { factor } = await register(u, a);
    assert.equal((await signIn(u, factor, a, { count: 10 })).v.status, 200);
    assert.equal((await signIn(u, factor, a, { count: 5 })).v.status, 400, "the counter went backwards");
    assert.equal((await signIn(u, factor, a, { count: 11 })).v.status, 200);
    const ch = await challenge(u.token, factor);
    const resp = a.get(ch.json.webauthn.credential_options.publicKey, ORIGIN, { count: 12 });
    assert.equal((await verify(u.token, factor, ch.json.id, "request", resp)).status, 200);
    assert.equal((await verify(u.token, factor, ch.json.id, "request", resp)).status, 400, "the same bytes again");
    const ch2 = await challenge(u.token, factor);
    assert.equal((await verify(u.token, factor, ch2.json.id, "request", resp)).status, 400, "the same bytes against a new challenge");
  });

  it("will not add a second passkey from a session that has not proven the first", async () => {
    const u = await fresh();
    await register(u, new SoftAuthenticator(), "first");
    const login = (await gw("POST", "/auth/v1/token?grant_type=password", { body: { email: u.email, password: "password-123" } })).json;
    assert.equal((await enroll(login.access_token, { friendly_name: "second" })).status, 401, "adding another needs the second factor first (aal2)");
  });

  it("lets a new device be added from an aal2 session, and refuses the same authenticator twice", async () => {
    const u = await fresh();
    const a = new SoftAuthenticator();
    const first = await register(u, a, "laptop");
    const s2 = first.v.json.access_token as string;
    const b = new SoftAuthenticator();
    const e = await enroll(s2, { friendly_name: "phone" });
    const ch = await challenge(s2, e.json.id);
    assert.deepEqual(ch.json.webauthn.credential_options.publicKey.excludeCredentials, [{ type: "public-key", id: b64(a.credentialId) }]);
    const dup = await verify(s2, e.json.id, ch.json.id, "create", a.create(ch.json.webauthn.credential_options.publicKey, ORIGIN));
    assert.equal(dup.status, 400, "the same authenticator");
    assert.match(dup.json.msg ?? dup.json.message, /already registered/);
    const e2 = await enroll(s2, { friendly_name: "phone2" });
    const ch2 = await challenge(s2, e2.json.id);
    assert.equal((await verify(s2, e2.json.id, ch2.json.id, "create", b.create(ch2.json.webauthn.credential_options.publicKey, ORIGIN))).status, 200);
  });

  it("removes a passkey only from an aal2 session, and the admin can remove them all", async () => {
    const u = await fresh();
    const a = new SoftAuthenticator();
    const { factor, v } = await register(u, a);
    const aal1 = (await gw("POST", "/auth/v1/token?grant_type=password", { body: { email: u.email, password: "password-123" } })).json.access_token;
    assert.equal((await gw("DELETE", `/auth/v1/factors/${factor}`, { key: aal1 })).status, 401);
    assert.equal((await gw("DELETE", `/auth/v1/factors/${factor}`, { key: v.json.access_token })).status, 200);
    const u2 = await fresh();
    await register(u2, new SoftAuthenticator());
    assert.equal((await gw("DELETE", `/auth/v1/admin/users/${u2.id}/factors`, { key: p.service })).status, 204);
    assert.equal((await gw("GET", "/auth/v1/user", { key: u2.token })).json.factors.length, 0);
  });

  it("can require user verification, and passkeys do not mix with authenticator codes", async () => {
    assert.equal((await settings({ webauthn: { require_user_verification: true } })).status, 200);
    const u = await fresh();
    const lax = new SoftAuthenticator();
    lax.verifies = false;
    const e = await enroll(u.token, { friendly_name: "no-pin" });
    const ch = await challenge(u.token, e.json.id);
    assert.equal(ch.json.webauthn.credential_options.publicKey.authenticatorSelection.userVerification, "required");
    const bad = await verify(u.token, e.json.id, ch.json.id, "create", lax.create(ch.json.webauthn.credential_options.publicKey, ORIGIN));
    assert.equal(bad.status, 400);
    assert.match(bad.json.msg ?? bad.json.message, /verify the person/);
    const strict = new SoftAuthenticator();
    const ch2 = await challenge(u.token, e.json.id);
    assert.equal((await verify(u.token, e.json.id, ch2.json.id, "create", strict.create(ch2.json.webauthn.credential_options.publicKey, ORIGIN))).status, 200);
    const codeTry = await gw("POST", `/auth/v1/factors/${e.json.id}/verify`, { key: u.token, body: { challenge_id: ch2.json.id, code: "123456" } });
    assert.equal(codeTry.status, 400, "a code is not a passkey");
    await settings({ webauthn: {} });
  });

  it("upgrades projects whose factor tables predate passkeys", async () => {
    const o = await t.project(owner, "legacy-passkeys");
    const c = new (await import("pg")).default.Client({ connectionString: o.dbUrl });
    await c.connect();
    await c.query(`DROP TABLE auth.webauthn_credentials;
      ALTER TABLE auth.mfa_challenges DROP COLUMN webauthn_challenge;
      ALTER TABLE auth.mfa_factors DROP CONSTRAINT mfa_factors_factor_type_check;
      DELETE FROM auth.mfa_factors;
      ALTER TABLE auth.mfa_factors ADD CONSTRAINT mfa_factors_factor_type_check CHECK (factor_type = 'totp');
      ALTER TABLE auth.mfa_factors ALTER COLUMN secret_enc SET NOT NULL`);
    await c.end();
    await t.api("PATCH", `/v1/projects/${o.ref}/settings`, { token: owner, body: { site_url: ORIGIN } });
    t.platform.dir.forget(o.ref);
    const g = (m: string, u: string, key: string, body?: unknown) => t.gw(o.ref, m, u, { key, body });
    const s = (await g("POST", "/auth/v1/signup", o.anon, { email: "old-pk@example.com", password: "password-123" })).json;
    const e = await g("POST", "/auth/v1/factors", s.access_token, { factor_type: "webauthn", friendly_name: "key" });
    assert.equal(e.status, 200, e.text);
    const ch = await g("POST", `/auth/v1/factors/${e.json.id}/challenge`, s.access_token);
    const a = new SoftAuthenticator();
    const v = await g("POST", `/auth/v1/factors/${e.json.id}/verify`, s.access_token, { challenge_id: ch.json.id, webauthn: { type: "create", credential_response: a.create(ch.json.webauthn.credential_options.publicKey, ORIGIN) } });
    assert.equal(v.status, 200, v.text);
  });

  it("works through the client library, including cleaning up a cancelled prompt", async () => {
    const base = `http://${p.ref}.localhost:8081`;
    const fetchVia = ((u: string, i: RequestInit) => t.platform.gateway.inject({ method: (i.method ?? "GET") as "GET", url: String(u).replace(base, ""), headers: { ...(i.headers as Record<string, string>), host: `${p.ref}.localhost` }, payload: i.body as string })
      .then((r) => new Response(r.body, { status: r.statusCode, headers: r.headers as Record<string, string> }))) as typeof fetch;
    const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const device = new SoftAuthenticator();
    let cancel = false;
    const credentials = {
      async create(o: any) {
        if (cancel) throw new Error("The operation was cancelled");
        assert.ok(o.publicKey.challenge instanceof ArrayBuffer && o.publicKey.user.id instanceof ArrayBuffer, "binary fields reach the browser as buffers");
        const r = device.create({ challenge: Buffer.from(o.publicKey.challenge).toString("base64url"), rp: o.publicKey.rp }, ORIGIN);
        return { id: r.id, type: r.type, rawId: ab(Buffer.from(r.rawId, "base64url")), response: { clientDataJSON: ab(Buffer.from(r.response.clientDataJSON, "base64url")), attestationObject: ab(Buffer.from(r.response.attestationObject, "base64url")) } };
      },
      async get(o: any) {
        assert.ok(o.publicKey.allowCredentials[0].id instanceof ArrayBuffer);
        const r = device.get({ challenge: Buffer.from(o.publicKey.challenge).toString("base64url"), rpId: o.publicKey.rpId }, ORIGIN);
        return { id: r.id, type: r.type, rawId: ab(Buffer.from(r.rawId, "base64url")), response: { clientDataJSON: ab(Buffer.from(r.response.clientDataJSON, "base64url")), authenticatorData: ab(Buffer.from(r.response.authenticatorData, "base64url")), signature: ab(Buffer.from(r.response.signature, "base64url")) } };
      },
    };
    const c = createClient(base, p.anon, { fetch: fetchVia, credentials });
    await c.auth.signUp({ email: "sdk-pk@example.com", password: "password-123" });
    cancel = true;
    const cancelled = await c.auth.mfa.webauthn.register({ friendlyName: "laptop" });
    assert.match(cancelled.error!.message, /cancelled/);
    assert.equal(((await c.auth.getUser()).data!.user.factors as unknown[]).length, 0, "no half-made factor is left behind");
    cancel = false;
    const reg = await c.auth.mfa.webauthn.register({ friendlyName: "laptop" });
    assert.equal(reg.error, null, JSON.stringify(reg.error));
    assert.equal((await c.auth.mfa.getAuthenticatorAssuranceLevel()).data!.currentLevel, "aal2");
    const factor = ((await c.auth.getUser()).data!.user.factors as Array<{ id: string }>)[0]!.id;
    await c.auth.signOut();
    await c.auth.signInWithPassword({ email: "sdk-pk@example.com", password: "password-123" });
    assert.equal((await c.auth.mfa.getAuthenticatorAssuranceLevel()).data!.currentLevel, "aal1");
    const used = await c.auth.mfa.webauthn.authenticate({ factorId: factor });
    assert.equal(used.error, null, JSON.stringify(used.error));
    assert.equal((await c.auth.mfa.getAuthenticatorAssuranceLevel()).data!.currentLevel, "aal2");
    const none = createClient(base, p.anon, { fetch: fetchVia, credentials: undefined });
    assert.match((await none.auth.mfa.webauthn.register({ friendlyName: "x" })).error!.message, /cannot make passkeys|Auth session missing/);
  });
});

