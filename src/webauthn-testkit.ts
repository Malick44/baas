/** A software authenticator: makes the same bytes a browser would hand over, so the server's checks can be exercised without a device. */
import { createHash, createSign, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";

export function cborEncode(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "boolean") return Buffer.from([v ? 0xf5 : 0xf4]);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
  throw new Error("cannot encode");
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
export type Alg = "ES256" | "RS256" | "EdDSA";

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly priv: KeyObject;
  readonly pub: KeyObject;
  signCount = 0;
  /** Set the "user verified" flag on what it produces. */
  verifies = true;

  constructor(readonly alg: Alg = "ES256") {
    const pair = alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : alg === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");
    this.priv = pair.privateKey;
    this.pub = pair.publicKey;
  }

  private cose(): Buffer {
    const j = this.pub.export({ format: "jwk" }) as Record<string, string>;
    const b = (k: string) => Buffer.from(j[k]!, "base64url");
    if (this.alg === "ES256") return cborEncode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, b("x")], [-3, b("y")]]));
    if (this.alg === "RS256") return cborEncode(new Map<number, unknown>([[1, 3], [3, -257], [-1, b("n")], [-2, b("e")]]));
    return cborEncode(new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, b("x")]]));
  }

  private authData(rpId: string, o: { attested: boolean; up?: boolean; rpIdHash?: Buffer; count?: number }) {
    const flags = (o.up === false ? 0 : 0x01) | (this.verifies ? 0x04 : 0) | (o.attested ? 0x40 : 0);
    const head = Buffer.concat([o.rpIdHash ?? sha256(rpId), Buffer.from([flags]), Buffer.alloc(4)]);
    head.writeUInt32BE(o.count ?? this.signCount, 33);
    if (!o.attested) return head;
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16, 7), idLen, this.credentialId, this.cose()]);
  }

  private client(type: string, challenge: string, origin: string, extra: object = {}) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
  }

  /** What navigator.credentials.create() resolves with, base64url-encoded the way the SDK sends it. */
  create(options: { challenge: string; rp: { id: string } }, origin: string, o: { rpId?: string; up?: boolean; type?: string; challenge?: string; fmt?: string } = {}) {
    const clientDataJSON = this.client(o.type ?? "webauthn.create", o.challenge ?? options.challenge, origin);
    const authData = this.authData(o.rpId ?? options.rp.id, { attested: true, up: o.up });
    const attestationObject = cborEncode(new Map<string, unknown>([["fmt", o.fmt ?? "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: this.credentialId.toString("base64url"), rawId: this.credentialId.toString("base64url"), type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url") } };
  }

  /** What navigator.credentials.get() resolves with. */
  get(options: { challenge: string; rpId: string }, origin: string, o: { rpId?: string; up?: boolean; type?: string; challenge?: string; count?: number; tamper?: boolean; id?: string; userHandle?: string } = {}) {
    this.signCount = o.count ?? this.signCount + 1;
    const clientDataJSON = this.client(o.type ?? "webauthn.get", o.challenge ?? options.challenge, origin);
    const authenticatorData = this.authData(o.rpId ?? options.rpId, { attested: false, up: o.up, count: this.signCount });
    const data = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const signature = this.alg === "ES256" ? createSign("sha256").update(data).sign(this.priv) : this.alg === "RS256" ? createSign("sha256").update(data).sign(this.priv) : cryptoSign(null, data, this.priv);
    if (o.tamper) signature.writeUInt8(signature.readUInt8(signature.length - 1) ^ 1, signature.length - 1);
    return { id: o.id ?? this.credentialId.toString("base64url"), rawId: this.credentialId.toString("base64url"), type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: signature.toString("base64url"), ...(o.userHandle ? { userHandle: o.userHandle } : {}) } };
  }
}
