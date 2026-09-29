import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing for project secrets. The additional data (the project ref)
 * is authenticated, so a ciphertext copied onto another project's row will not open.
 * Format: v1.<iv>.<tag>.<ciphertext>, all base64url.
 */
export class Vault {
  private readonly key: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error("master key must be 32 bytes as 64 hex chars");
    this.key = Buffer.from(masterKeyHex, "hex");
  }

  seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv, c.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  open(sealed: string, aad: string): string {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("unrecognised sealed value");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }
}
