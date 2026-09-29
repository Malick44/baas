import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export type Claims = { role: string; iss: string; iat: number; exp: number; ref: string };

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
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
  return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
}

export function projectKey(role: "anon" | "service_role", ref: string, secret: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ role, ref, iss: "baas", iat, exp: iat + 10 * 365 * 24 * 3600 }, secret);
}
