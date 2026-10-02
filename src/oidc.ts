/**
 * Generic OpenID Connect sign-in: endpoints come from the issuer's discovery document, and the person is identified by a
 * verified ID token (signature against the issuer's keys, issuer, audience, expiry and nonce), not by trusting a profile call.
 *
 * The issuer is an address an administrator typed in, so every request goes through a guard that refuses private and local
 * networks and connects to the exact address it checked, so a hostname cannot change its answer between check and use.
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { isPrivateAddress } from "./pipelines.js";
import type { Profile } from "./oauth.js";

export class OidcError extends Error {}

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
};

const MAX_BODY = 1_000_000;
const TIMEOUT_MS = 10_000;

/** The address-pinned request every OIDC call is made through. */
export async function guardedJson(rawUrl: string, init: { method?: string; headers?: Record<string, string>; body?: string }, allowPrivate: boolean): Promise<{ status: number; json: any }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new OidcError("the provider gave an address that is not a valid URL"); }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) throw new OidcError("the provider's addresses must use https");
  if (url.username || url.password) throw new OidcError("the provider's addresses must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string; family: number }[];
  try { addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.lookup(host, { all: true }); } catch { throw new OidcError(`could not resolve ${host}`); }
  if (!addrs.length) throw new OidcError(`could not resolve ${host}`);
  if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new OidcError("the provider is on a private or local network address, which sign-in providers may not use");
  const pin = addrs[0]!;
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const body = init.body;
    const req = lib.request({
      hostname: host, port: url.port || undefined, path: `${url.pathname}${url.search}`, method: init.method ?? "GET", timeout: TIMEOUT_MS,
      headers: { accept: "application/json", "user-agent": "baas-auth", ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...init.headers },
      servername: isIP(host) ? undefined : host,
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family))) as never,
    }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (d: Buffer) => { n += d.length; if (n > MAX_BODY) return req.destroy(new Error("the answer was too large")); chunks.push(d); });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) return reject(new OidcError("the provider tried to redirect, which is not followed"));
        let json: any;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = undefined; }
        resolve({ status, json });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(new OidcError(`could not reach the provider: ${e.message}`)));
    req.end(body);
  });
}

const CACHE_MS = 10 * 60_000;

/** Caches per issuer, shared by every project that names the same one. */
export class OidcClient {
  private disco = new Map<string, { at: number; doc: Discovery }>();
  private keys = new Map<string, { at: number; keys: JsonWebKey[] }>();

  constructor(private readonly allowPrivate = false, private readonly now: () => number = Date.now) {}

  async discover(issuer: string): Promise<Discovery> {
    const hit = this.disco.get(issuer);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.doc;
    const r = await guardedJson(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {}, this.allowPrivate);
    const d = r.json;
    if (r.status !== 200 || !d || typeof d !== "object") throw new OidcError(`the issuer's discovery document could not be read (${r.status})`);
    // The document must describe the issuer it was fetched for, or one provider could impersonate another.
    if (d.issuer !== issuer) throw new OidcError("the discovery document names a different issuer than the one configured");
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) if (typeof d[k] !== "string") throw new OidcError(`the discovery document has no ${k}`);
    const doc: Discovery = { issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri,
      userinfo_endpoint: typeof d.userinfo_endpoint === "string" ? d.userinfo_endpoint : undefined,
      token_endpoint_auth_methods_supported: Array.isArray(d.token_endpoint_auth_methods_supported) ? d.token_endpoint_auth_methods_supported.filter((x: unknown) => typeof x === "string") : undefined };
    this.disco.set(issuer, { at: this.now(), doc });
    return doc;
  }

  private async jwks(uri: string, fresh: boolean): Promise<JsonWebKey[]> {
    const hit = this.keys.get(uri);
    if (hit && !fresh && this.now() - hit.at < CACHE_MS) return hit.keys;
    const r = await guardedJson(uri, {}, this.allowPrivate);
    if (r.status !== 200 || !Array.isArray(r.json?.keys)) throw new OidcError("the issuer's signing keys could not be read");
    this.keys.set(uri, { at: this.now(), keys: r.json.keys });
    return r.json.keys;
  }

  /** Check an ID token and return its claims. Throws OidcError with a reason that is safe to show. */
  async verifyIdToken(token: string, o: { disco: Discovery; clientId: string; nonce: string }): Promise<Record<string, any>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new OidcError("the ID token is malformed");
    let header: any, claims: any;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    } catch { throw new OidcError("the ID token is malformed"); }
    const ALGS: Record<string, { hash: string; ec?: boolean }> = {
      RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" }, ES256: { hash: "sha256", ec: true }, ES384: { hash: "sha384", ec: true },
    };
    const alg = ALGS[String(header?.alg)];
    if (!alg) throw new OidcError("the ID token uses a signature type that is not accepted");

    const pick = (ks: JsonWebKey[]) => ks.filter((k: any) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig") && (alg.ec ? k.kty === "EC" : k.kty === "RSA"));
    let candidates = pick(await this.jwks(o.disco.jwks_uri, false));
    if (!candidates.length) candidates = pick(await this.jwks(o.disco.jwks_uri, true)); // keys rotate: look once more
    if (!candidates.length) throw new OidcError("the ID token was signed with a key the issuer does not publish");
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2]!, "base64url");
    const good = candidates.some((jwk) => {
      try {
        return cryptoVerify(alg.hash, data, alg.ec ? { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" } : createPublicKey({ key: jwk, format: "jwk" }), sig);
      } catch { return false; }
    });
    if (!good) throw new OidcError("the ID token's signature is not valid");

    const nowSec = Math.floor(this.now() / 1000);
    if (claims.iss !== o.disco.issuer) throw new OidcError("the ID token was issued by someone else");
    const aud: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(o.clientId)) throw new OidcError("the ID token was issued for a different application");
    if (aud.length > 1 && claims.azp !== o.clientId) throw new OidcError("the ID token was issued for a different application");
    if (typeof claims.exp !== "number" || claims.exp + 60 < nowSec) throw new OidcError("the ID token has expired");
    if (typeof claims.nbf === "number" && claims.nbf - 60 > nowSec) throw new OidcError("the ID token is not valid yet");
    if (claims.nonce !== o.nonce) throw new OidcError("the ID token does not belong to this sign-in");
    if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("the ID token does not say who you are");
    return claims;
  }

  async userinfo(disco: Discovery, accessToken: string): Promise<Record<string, any> | null> {
    if (!disco.userinfo_endpoint) return null;
    const r = await guardedJson(disco.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } }, this.allowPrivate).catch(() => null);
    return r && r.status === 200 && r.json && typeof r.json === "object" ? r.json : null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Map ID-token claims (merged with userinfo when the token lacks an email) to a profile. */
export function profileFromClaims(c: Record<string, any>, info?: Record<string, any> | null): Profile {
  // Userinfo may only add details for the same person.
  const extra = info && info.sub === c.sub ? info : {};
  const email = str(c.email) ?? str(extra.email) ?? null;
  const verified = str(c.email) ? c.email_verified : extra.email_verified;
  return {
    id: c.sub, email, emailVerified: verified === true || verified === "true",
    name: str(c.name) ?? str(extra.name) ?? str(c.preferred_username), avatar: str(c.picture) ?? str(extra.picture), raw: { ...extra, ...c },
  };
}
