import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export type Claims = { role: string; exp: number; iat?: number; sub?: string; [k: string]: unknown };

export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

/** HS256 JWT signed with a project's secret. */
export function signJwt(claims: Claims, secret: string): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64(sig)}`;
}

/** Returns the claims if the signature matches `secret` and the token is unexpired, else null. */
export function verifyJwt(token: string, secret: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    // Only HS256 is ever issued; refuse "none" and every other algorithm outright.
    if ((JSON.parse(Buffer.from(head, "base64url").toString()) as { alg?: string }).alg !== "HS256") return null;
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
  } catch {
    return null;
  }
  if (typeof claims.role !== "string" || typeof claims.exp !== "number") return null;
  return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
}

export function projectKey(role: "anon" | "service_role", ref: string, secret: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ role, ref, iss: "baas", iat, exp: iat + 10 * 365 * 24 * 3600 }, secret);
}
