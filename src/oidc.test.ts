import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { OidcClient, profileFromClaims } from "./oidc.js";
import { makePlatform } from "./platform-testkit.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const b64 = (x: Buffer | string) => Buffer.from(x).toString("base64url");

type Key = { kid: string; alg: "RS256" | "ES256"; priv: KeyObject; jwk: Record<string, unknown> };
function makeKey(kid: string, alg: "RS256" | "ES256"): Key {
  const { privateKey, publicKey } = alg === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, alg, priv: privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg } };
}
function jwt(key: Key, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64(JSON.stringify({ alg: key.alg, kid: key.kid, typ: "JWT", ...header }));
  const data = `${h}.${b64(JSON.stringify(claims))}`;
  const sig = key.alg === "RS256" ? createSign("sha256").update(data).sign(key.priv) : cryptoSign("sha256", Buffer.from(data), { key: key.priv, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64(sig)}`;
}

describe("OpenID Connect claims", () => {
  it("builds a profile, only trusting userinfo for the same subject", () => {
    assert.deepEqual(profileFromClaims({ sub: "1", email: "a@x.io", email_verified: true, name: "A" }).emailVerified, true);
    assert.equal(profileFromClaims({ sub: "1", email: "a@x.io", email_verified: "true" }).emailVerified, true);
    assert.equal(profileFromClaims({ sub: "1", email: "a@x.io" }).emailVerified, false);
    assert.equal(profileFromClaims({ sub: "1" }, { sub: "2", email: "evil@x.io", email_verified: true }).email, null, "another subject's userinfo is ignored");
    assert.equal(profileFromClaims({ sub: "1" }, { sub: "1", email: "b@x.io", email_verified: true }).email, "b@x.io");
  });
});

describe("custom OpenID Connect providers", { skip: !ADMIN && "set BAAS_TEST_PG_URL" }, () => {
  let idp: http.Server;
  let issuer: string;
  let rsa = makeKey("rsa-1", "RS256");
  const ec = makeKey("ec-1", "ES256");
  let published: Key[] = [];
  let discoverIssuer: string | null = null;
  let basicOnly = false;
  const codes = new Map<string, { token: (nonce: string) => string; access?: boolean }>();
  const tokenReqs: { form: URLSearchParams; auth?: string }[] = [];
  let userinfo: Record<string, unknown> = {};
  let hits = { discovery: 0, jwks: 0 };
  let t: Awaited<ReturnType<typeof makePlatform>>;
  let strict: Awaited<ReturnType<typeof makePlatform>>;
  let owner: string;
  let p: Awaited<ReturnType<typeof t.project>>;
  const gw = (m: string, u: string, o: { headers?: Record<string, string> } = {}) => t.gw(p.ref, m, u, { key: p.anon, ...o });
  const settings = (patch: object) => t.api("PATCH", `/v1/projects/${p.ref}/settings`, { token: owner, body: patch }).then((r) => { t.platform.dir.forget(p.ref); return r; });

  const rows = async (q: string): Promise<any[][]> => {
    const j = (await t.sql(owner, p.ref, q)).json;
    return (Array.isArray(j) ? j : j.results).at(-1).rows;
  };
  const claims = (o: Record<string, unknown> = {}) => ({ iss: issuer, aud: "oidc-client", sub: "sub-1", exp: Math.floor(Date.now() / 1000) + 300, email: "ann@corp.example", email_verified: true, name: "Ann", ...o });

  before(async () => {
    idp = http.createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
        if (u.pathname === "/.well-known/openid-configuration") {
          hits.discovery++;
          return send(200, { issuer: discoverIssuer ?? issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo`,
            ...(basicOnly ? { token_endpoint_auth_methods_supported: ["client_secret_basic"] } : {}) });
        }
        if (u.pathname === "/jwks") { hits.jwks++; return send(200, { keys: published.map((k) => k.jwk) }); }
        if (u.pathname === "/token") {
          const form = new URLSearchParams(Buffer.concat(chunks).toString());
          tokenReqs.push({ form, auth: req.headers.authorization });
          const c = codes.get(form.get("code")!);
          if (!c) return send(400, { error: "invalid_grant" });
          const nonce = (globalThis as any).__nonce as string;
          return send(200, { id_token: c.token(nonce), ...(c.access ? { access_token: "at-1" } : {}) });
        }
        if (u.pathname === "/userinfo") return req.headers.authorization === "Bearer at-1" ? send(200, userinfo) : send(401, {});
        send(404, {});
      });
    });
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    published = [rsa, ec];
    t = await makePlatform(ADMIN!, { auth: { oidcAllowPrivate: true } });
    strict = await makePlatform(ADMIN!);
    owner = await t.org();
    p = await t.project(owner, "oidc");
    await t.api("PATCH", `/v1/projects/${p.ref}`, { token: owner, body: { plan: "pro" } });
    await settings({ email_confirm: false, site_url: "https://app.example.com" });
  });
  after(async () => { idp?.close(); await t?.close(); await strict?.close(); });

  const configure = (extra: Record<string, unknown> = {}) => settings({ oidc_providers: { acme: { enabled: true, label: "Acme SSO", issuer, client_id: "oidc-client", secret: "oidc-secret", ...extra } } });

  /** Start a sign-in, then finish it with an ID token built from the flow's own nonce. */
  async function signIn(make: (nonce: string) => string, o: { access?: boolean; code?: string; cookie?: boolean } = {}) {
    const r = await gw("GET", `/auth/v1/authorize?provider=acme&redirect_to=${encodeURIComponent("https://app.example.com/cb")}`);
    assert.equal(r.status, 302, r.text);
    const url = new URL(r.headers.location as string);
    const cookie = /baas_oauth=([\w-]+)/.exec(String(r.headers["set-cookie"]))![1];
    const code = o.code ?? `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { token: make, access: o.access });
    (globalThis as any).__nonce = url.searchParams.get("nonce");
    const done = await gw("GET", `/auth/v1/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get("state")!)}`, { headers: { cookie: `baas_oauth=${cookie}` } });
    return { url, done };
  }
  const ok = (r: Awaited<ReturnType<typeof signIn>>) => /access_token=/.test(String(r.done.headers.location));
  const errorOf = (r: Awaited<ReturnType<typeof signIn>>) => new URL(String(r.done.headers.location)).searchParams.get("error_description") ?? "";

  it("validates and protects the configuration", async () => {
    for (const bad of [
      { Acme: { issuer } }, { github: { issuer } }, { "a": { issuer } }, { acme: { issuer: "ftp://x" } }, { acme: { issuer: "https://u:p@x.io" } }, { acme: { issuer: "https://x.io/?a=1" } },
      { acme: { scopes: "email profile" } }, { acme: { scopes: "openid\nx" } }, { acme: { client_id: 5 } }, { acme: { nope: 1 } },
    ]) assert.equal((await settings({ oidc_providers: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await settings({ oidc_providers: { acme: { enabled: true, issuer } } })).status, 400, "needs credentials to be switched on");
    assert.equal((await settings({ oidc_providers: Object.fromEntries(["aa", "bb", "cc", "dd", "ee", "ff"].map((k) => [k, { issuer }])) })).status, 400, "at most five");
    const r = await configure();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.oidc_providers.acme, { enabled: true, label: "Acme SSO", issuer, client_id: "oidc-client", secret_set: true });
    for (const x of [r, await t.api("GET", `/v1/projects/${p.ref}/settings`, { token: owner }), await t.api("GET", `/v1/projects/${p.ref}/auth-config`, { token: owner })]) assert.equal(x.text.includes("oidc-secret"), false);
    assert.equal(JSON.stringify((await t.api("GET", `/v1/projects/${p.ref}/auth-config`, { token: owner })).json.custom_providers), JSON.stringify([{ id: "acme", label: "Acme SSO", enabled: true, issuer, client_id: "oidc-client", scopes: "openid email profile", secret_set: true }]));
    assert.equal((await gw("GET", "/auth/v1/settings")).json.external.acme, true, "the client library sees it");
    const raw = await t.platform.control.pool.query(`SELECT settings->'oidc_providers'->'acme' AS a FROM project_settings WHERE ref = $1`, [p.ref]);
    assert.match(raw.rows[0].a.secret_enc, /^v1\./, "sealed at rest");
  });

  it("starts a sign-in with discovery's endpoints, PKCE, and a nonce", async () => {
    const r = await gw("GET", `/auth/v1/authorize?provider=acme&redirect_to=${encodeURIComponent("https://app.example.com/cb")}`);
    assert.equal(r.status, 302);
    const u = new URL(r.headers.location as string);
    assert.equal(u.origin + u.pathname, `${issuer}/authorize`);
    assert.equal(u.searchParams.get("client_id"), "oidc-client");
    assert.equal(u.searchParams.get("scope"), "openid email profile");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.ok(u.searchParams.get("code_challenge") && u.searchParams.get("nonce") && u.searchParams.get("state"));
    assert.equal(u.searchParams.get("redirect_uri"), `http://${p.ref}.localhost:8081/auth/v1/callback`);
  });

  it("signs in with an RS256 ID token, creating the user and an identity named after the provider", async () => {
    const r = await signIn((n) => jwt(rsa, claims({ nonce: n })));
    assert.ok(ok(r), `${r.done.status} ${r.done.headers.location}`);
    const f = tokenReqs.at(-1)!.form;
    assert.equal(f.get("client_id"), "oidc-client");
    assert.equal(f.get("client_secret"), "oidc-secret");
    assert.ok(f.get("code_verifier"), "PKCE verifier sent");
    const token = new URLSearchParams(new URL(String(r.done.headers.location)).hash.slice(1)).get("access_token")!;
    const me = (await gw("GET", "/auth/v1/user", { headers: { authorization: `Bearer ${token}` } })).json;
    assert.equal(me.email, "ann@corp.example");
    assert.equal(me.user_metadata.name, "Ann");
    assert.equal(me.app_metadata.provider, "acme");
    assert.deepEqual((await rows("select provider, provider_id from auth.identities")).at(-1), ["acme", "sub-1"]);
    assert.ok(ok(await signIn((n) => jwt(rsa, claims({ nonce: n })))), "the same person again");
    assert.equal((await rows("select count(*)::int from auth.users where email = 'ann@corp.example'"))[0]![0], 1);
  });

  it("accepts ES256 and an audience list that includes the client", async () => {
    assert.ok(ok(await signIn((n) => jwt(ec, claims({ nonce: n, sub: "sub-ec", email: "ec@corp.example" })))));
    assert.ok(ok(await signIn((n) => jwt(rsa, claims({ nonce: n, sub: "sub-aud", email: "aud@corp.example", aud: ["other", "oidc-client"], azp: "oidc-client" })))));
  });

  it("refuses an ID token that is forged, for someone else, stale, or not for this sign-in", async () => {
    const attacker = makeKey("rsa-1", "RS256"); // same kid, different key
    const cases: [string, (n: string) => string, RegExp][] = [
      ["wrong signature", (n) => jwt(attacker, claims({ nonce: n })), /signature is not valid/],
      ["unknown key id", (n) => jwt({ ...rsa, kid: "nope" }, claims({ nonce: n })), /does not publish/],
      ["other issuer", (n) => jwt(rsa, claims({ nonce: n, iss: "https://evil.example" })), /issued by someone else/],
      ["other audience", (n) => jwt(rsa, claims({ nonce: n, aud: "someone-else" })), /different application/],
      ["audience list without azp", (n) => jwt(rsa, claims({ nonce: n, aud: ["oidc-client", "other"] })), /different application/],
      ["expired", (n) => jwt(rsa, claims({ nonce: n, exp: Math.floor(Date.now() / 1000) - 3600 })), /expired/],
      ["not yet valid", (n) => jwt(rsa, claims({ nonce: n, nbf: Math.floor(Date.now() / 1000) + 3600 })), /not valid yet/],
      ["wrong nonce", () => jwt(rsa, claims({ nonce: "replayed" })), /does not belong to this sign-in/],
      ["no nonce", () => jwt(rsa, claims()), /does not belong to this sign-in/],
      ["no subject", (n) => jwt(rsa, claims({ nonce: n, sub: "" })), /who you are/],
      ["alg none", (n) => `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(claims({ nonce: n })))}.`, /signature type/],
      ["HMAC with the public key", (n) => { const d = `${b64(JSON.stringify({ alg: "HS256", kid: "rsa-1" }))}.${b64(JSON.stringify(claims({ nonce: n })))}`; return `${d}.${b64("x")}`; }, /signature type/],
      ["garbage", () => "not-a-jwt", /malformed/],
    ];
    for (const [name, make, why] of cases) {
      const r = await signIn(make);
      assert.equal(ok(r), false, name);
      assert.match(errorOf(r), why, name);
    }
    assert.equal((await rows("select count(*)::int from auth.users where email = 'evil@corp.example'"))[0]![0], 0);
  });

  it("picks up a rotated signing key, and never links an unverified address to an existing account", async () => {
    const rotated = makeKey("rsa-2", "RS256");
    published = [rotated];
    assert.ok(ok(await signIn((n) => jwt(rotated, claims({ nonce: n, sub: "sub-rot", email: "rot@corp.example" })))), "keys are re-fetched once for an unknown kid");
    published = [rsa, ec];
    await t.gw(p.ref, "POST", "/auth/v1/signup", { key: p.anon, body: { email: "victim@corp.example", password: "password-123" } });
    const r = await signIn((n) => jwt(rsa, claims({ nonce: n, sub: "sub-x", email: "victim@corp.example", email_verified: false })));
    assert.equal(ok(r), false, "an address the provider does not vouch for cannot take over an account");
    const v = await signIn((n) => jwt(rsa, claims({ nonce: n, sub: "sub-y", email: "victim@corp.example", email_verified: true })));
    assert.ok(ok(v), "a verified one links to it");
  });

  it("reads the email from userinfo when the token has none, but only for the same subject", async () => {
    userinfo = { sub: "sub-ui", email: "ui@corp.example", email_verified: true, name: "From Userinfo" };
    const r = await signIn((n) => jwt(rsa, { iss: issuer, aud: "oidc-client", sub: "sub-ui", exp: Math.floor(Date.now() / 1000) + 300, nonce: n }), { access: true });
    assert.ok(ok(r));
    assert.equal((await rows("select email from auth.users where email = 'ui@corp.example'")).length, 1);
    userinfo = { sub: "someone-else", email: "stolen@corp.example", email_verified: true };
    await signIn((n) => jwt(rsa, { iss: issuer, aud: "oidc-client", sub: "sub-ui2", exp: Math.floor(Date.now() / 1000) + 300, nonce: n }), { access: true });
    assert.equal((await rows("select 1 from auth.users where email = 'stolen@corp.example'")).length, 0);
  });

  it("uses HTTP basic auth when that is all the provider supports, and rejects a discovery document for a different issuer", async () => {
    basicOnly = true;
    t.platform.auth && (t.platform.auth as any).oidc.disco.clear();
    const r = await signIn((n) => jwt(rsa, claims({ nonce: n, sub: "sub-basic", email: "basic@corp.example" })));
    assert.ok(ok(r));
    const last = tokenReqs.at(-1)!;
    assert.equal(last.auth, `Basic ${Buffer.from("oidc-client:oidc-secret").toString("base64")}`);
    assert.equal(last.form.has("client_secret"), false, "the secret is sent once, not twice");
    basicOnly = false;
    discoverIssuer = "https://impostor.example";
    (t.platform.auth as any).oidc.disco.clear();
    const bad = await gw("GET", `/auth/v1/authorize?provider=acme&redirect_to=${encodeURIComponent("https://app.example.com/cb")}`);
    assert.equal(bad.status, 502);
    assert.match(bad.json.msg ?? bad.json.message ?? bad.text, /different issuer/);
    discoverIssuer = null;
    (t.platform.auth as any).oidc.disco.clear();
  });

  it("caches discovery and keys instead of asking the provider every time", async () => {
    (t.platform.auth as any).oidc.disco.clear();
    const before = { ...hits };
    for (let i = 0; i < 3; i++) await gw("GET", `/auth/v1/authorize?provider=acme&redirect_to=${encodeURIComponent("https://app.example.com/cb")}`);
    assert.equal(hits.discovery - before.discovery, 1);
  });

  it("is off when disabled or removed, and a token exchange failure sends the browser back with the reason", async () => {
    const r = await gw("GET", `/auth/v1/authorize?provider=acme&redirect_to=${encodeURIComponent("https://app.example.com/cb")}`);
    const url = new URL(r.headers.location as string);
    const cookie = /baas_oauth=([\w-]+)/.exec(String(r.headers["set-cookie"]))![1];
    const rejected = await gw("GET", `/auth/v1/callback?code=unknown&state=${encodeURIComponent(url.searchParams.get("state")!)}`, { headers: { cookie: `baas_oauth=${cookie}` } });
    assert.match(String(rejected.headers.location), /^https:\/\/app\.example\.com\/cb\?error=provider_error/);
    assert.equal((await settings({ oidc_providers: { acme: { enabled: false } } })).status, 200);
    assert.equal((await gw("GET", "/auth/v1/authorize?provider=acme&redirect_to=https://app.example.com/cb")).status, 400);
    assert.equal((await gw("GET", "/auth/v1/settings")).json.external.acme, false);
    assert.equal((await settings({ oidc_providers: { acme: null } })).status, 200);
    assert.deepEqual((await t.api("GET", `/v1/projects/${p.ref}/settings`, { token: owner })).json.oidc_providers, {});
  });

  it("will not talk to private addresses unless the operator allowed it", async () => {
    const o = await strict.org();
    const sp = await strict.project(o, "oidc-strict");
    const sset = (patch: object) => strict.api("PATCH", `/v1/projects/${sp.ref}/settings`, { token: o, body: patch }).then((r) => { strict.platform.dir.forget(sp.ref); return r; });
    await sset({ site_url: "https://app.example.com", oidc_providers: { acme: { enabled: true, issuer, client_id: "c", secret: "s" } } });
    const r = await strict.gw(sp.ref, "GET", `/auth/v1/authorize?provider=acme&redirect_to=${encodeURIComponent("https://app.example.com/cb")}`, { key: sp.anon });
    assert.equal(r.status, 502);
    assert.match(r.text, /private or local network|must use https/);
    const c = new OidcClient(false);
    for (const evil of ["http://169.254.169.254", "https://127.0.0.1:9", "https://[::1]", "https://10.0.0.1", "https://localhost"]) await assert.rejects(c.discover(evil), /private|local|https|resolve/, evil);
  });
});
