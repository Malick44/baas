/**
 * WebAuthn (passkeys and security keys) without dependencies: a small CBOR reader, COSE key conversion, and the checks
 * for registering a credential and for answering a sign-in challenge.
 *
 * Attestation statements are not verified. A credential is accepted because its holder can sign our challenge, which is
 * what a second factor needs; which brand of authenticator made it is not our business.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type JsonWebKey, type KeyObject } from "node:crypto";

export class WebAuthnError extends Error {}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

// ---- CBOR (just what authenticators send) ----

export function cborDecode(buf: Buffer, depth = 0): { value: unknown; rest: Buffer } {
  if (depth > 8) throw new WebAuthnError("CBOR is nested too deeply");
  if (!buf.length) throw new WebAuthnError("CBOR ended early");
  const major = buf[0]! >> 5;
  const ai = buf[0]! & 31;
  let off = 1;
  let n: number;
  if (ai < 24) n = ai;
  else if (ai === 24 || ai === 25 || ai === 26 || ai === 27) {
    if (major === 7) throw new WebAuthnError("CBOR uses a feature that is not supported"); // floats
    const size = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8;
    if (buf.length < off + size) throw new WebAuthnError("CBOR ended early");
    const v = size === 8 ? buf.readBigUInt64BE(off) : BigInt(buf.readUIntBE(off, size));
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError("CBOR number is too large");
    n = Number(v);
    off += size;
  } else if (major === 7 && ai >= 20 && ai <= 22) n = ai;
  else throw new WebAuthnError("CBOR uses a feature that is not supported");
  const at = buf.subarray(off);
  switch (major) {
    case 0: return { value: n, rest: at };
    case 1: return { value: -1 - n, rest: at };
    case 2: case 3: {
      if (at.length < n) throw new WebAuthnError("CBOR ended early");
      const body = at.subarray(0, n);
      return { value: major === 2 ? Buffer.from(body) : body.toString("utf8"), rest: at.subarray(n) };
    }
    case 4: {
      if (n > 1024) throw new WebAuthnError("CBOR array is too long");
      const out: unknown[] = [];
      let rest = at;
      for (let i = 0; i < n; i++) { const r = cborDecode(rest, depth + 1); out.push(r.value); rest = r.rest; }
      return { value: out, rest };
    }
    case 5: {
      if (n > 1024) throw new WebAuthnError("CBOR map is too long");
      const out = new Map<unknown, unknown>();
      let rest = at;
      for (let i = 0; i < n; i++) {
        const k = cborDecode(rest, depth + 1);
        const v = cborDecode(k.rest, depth + 1);
        out.set(k.value, v.value);
        rest = v.rest;
      }
      return { value: out, rest };
    }
    case 7: return { value: n === 20 ? false : n === 21 ? true : null, rest: at };
    default: throw new WebAuthnError("CBOR uses a feature that is not supported");
  }
}

// ---- keys ----

/** The signature types accepted for new credentials, in COSE numbers: ES256, EdDSA, RS256. */
export const ALGS = [-7, -8, -257] as const;

export function keyFromCose(cose: Buffer): { key: KeyObject; alg: number } {
  const m = cborDecode(cose).value;
  if (!(m instanceof Map)) throw new WebAuthnError("the credential's public key is malformed");
  const kty = m.get(1), alg = m.get(3);
  const bytes = (k: number) => { const v = m.get(k); if (!Buffer.isBuffer(v)) throw new WebAuthnError("the credential's public key is malformed"); return v.toString("base64url"); };
  let jwk: JsonWebKey;
  if (kty === 2 && alg === -7 && m.get(-1) === 1) jwk = { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) };
  else if (kty === 3 && alg === -257) jwk = { kty: "RSA", n: bytes(-1), e: bytes(-2) };
  else if (kty === 1 && alg === -8 && m.get(-1) === 6) jwk = { kty: "OKP", crv: "Ed25519", x: bytes(-2) };
  else throw new WebAuthnError("this kind of credential key is not supported (use ES256, EdDSA or RS256)");
  try { return { key: createPublicKey({ key: jwk, format: "jwk" }), alg: alg as number }; } catch { throw new WebAuthnError("the credential's public key is not valid"); }
}

function checkSignature(alg: number, key: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    if (alg === -7) return cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, sig);
    if (alg === -8) return cryptoVerify(null, data, key, sig);
    return cryptoVerify("sha256", data, key, sig);
  } catch { return false; }
}

// ---- authenticator data ----

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

export type AuthData = { rpIdHash: Buffer; flags: number; signCount: number; credential?: { aaguid: Buffer; id: Buffer; publicKey: Buffer } };

export function parseAuthData(b: Buffer): AuthData {
  if (b.length < 37) throw new WebAuthnError("the authenticator data is too short");
  const out: AuthData = { rpIdHash: b.subarray(0, 32), flags: b[32]!, signCount: b.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (b.length < 55) throw new WebAuthnError("the authenticator data is too short");
    const len = b.readUInt16BE(53);
    if (len < 1 || len > 1023 || b.length < 55 + len) throw new WebAuthnError("the credential id is malformed");
    const rest = b.subarray(55 + len);
    const key = cborDecode(rest);
    out.credential = { aaguid: b.subarray(37, 53), id: Buffer.from(b.subarray(55, 55 + len)), publicKey: Buffer.from(rest.subarray(0, rest.length - key.rest.length)) };
  }
  return out;
}

export type Expect = { challenge: string; rpId: string; origins: string[]; /** Refuse authenticators that did not verify the person (PIN, fingerprint). */ requireUserVerification?: boolean };

function checkClient(clientDataJSON: Buffer, type: "webauthn.create" | "webauthn.get", e: Expect) {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { c = JSON.parse(clientDataJSON.toString("utf8")); } catch { throw new WebAuthnError("the client data is not valid JSON"); }
  if (c.type !== type) throw new WebAuthnError("this response is for a different step");
  const given = Buffer.from(String(c.challenge ?? ""));
  const want = Buffer.from(e.challenge);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new WebAuthnError("the challenge does not match");
  if (typeof c.origin !== "string" || !e.origins.includes(c.origin)) throw new WebAuthnError(`this site (${String(c.origin)}) is not allowed to use passkeys for this project`);
  if (c.crossOrigin === true) throw new WebAuthnError("cross-origin requests are not accepted");
}

function checkAuthData(a: AuthData, e: Expect) {
  if (!timingSafeEqual(a.rpIdHash, sha256(e.rpId))) throw new WebAuthnError("the response was made for a different relying party id");
  if (!(a.flags & FLAG_UP)) throw new WebAuthnError("the authenticator did not confirm that someone was present");
  if (e.requireUserVerification && !(a.flags & FLAG_UV)) throw new WebAuthnError("the authenticator did not verify the person");
}

export type Registered = { credentialId: string; publicKey: string; signCount: number; aaguid: string };

export function verifyRegistration(r: { attestationObject: Buffer; clientDataJSON: Buffer }, e: Expect): Registered {
  checkClient(r.clientDataJSON, "webauthn.create", e);
  const att = cborDecode(r.attestationObject).value;
  const authData = att instanceof Map ? att.get("authData") : null;
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError("the attestation is malformed");
  const a = parseAuthData(authData);
  checkAuthData(a, e);
  if (!a.credential) throw new WebAuthnError("the response carries no credential");
  keyFromCose(a.credential.publicKey); // refuses algorithms we cannot check later
  return { credentialId: a.credential.id.toString("base64url"), publicKey: a.credential.publicKey.toString("base64url"), signCount: a.signCount, aaguid: a.credential.aaguid.toString("hex") };
}

/** Returns the new signature counter. A counter that does not go up means the credential may have been copied. */
export function verifyAssertion(r: { authenticatorData: Buffer; clientDataJSON: Buffer; signature: Buffer }, e: Expect, stored: { publicKey: string; signCount: number }): number {
  checkClient(r.clientDataJSON, "webauthn.get", e);
  const a = parseAuthData(r.authenticatorData);
  checkAuthData(a, e);
  const { key, alg } = keyFromCose(Buffer.from(stored.publicKey, "base64url"));
  if (!checkSignature(alg, key, Buffer.concat([r.authenticatorData, sha256(r.clientDataJSON)]), r.signature)) throw new WebAuthnError("the signature is not valid");
  if ((a.signCount !== 0 || stored.signCount !== 0) && a.signCount <= stored.signCount) throw new WebAuthnError("this credential's counter went backwards, so it may have been cloned");
  return a.signCount;
}

export const newChallenge = () => randomBytes(32).toString("base64url");
