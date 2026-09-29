import { randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type pg from "pg";
import { HttpError, type Resolved } from "./control.js";
import { signJwt } from "./keys.js";
import type { PoolManager } from "./pools.js";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AuthError extends HttpError {
  constructor(status: number, readonly errorCode: string, message: string) {
    super(status, message);
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scryptAsync(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${h.toString("base64url")}`;
}

const DUMMY = hashPassword("dummy-password-for-timing");

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  const [alg, salt, hash] = (stored ?? (await DUMMY)).split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const h = await scryptAsync(pw, Buffer.from(salt, "base64url"), 32, SCRYPT);
  const want = Buffer.from(hash, "base64url");
  return stored !== null && h.length === want.length && timingSafeEqual(h, want);
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

type UserRow = {
  id: string; email: string | null; encrypted_password: string | null; email_confirmed_at: Date | null;
  raw_app_meta_data: Record<string, unknown>; raw_user_meta_data: Record<string, unknown>;
  banned_until: Date | null; created_at: Date; updated_at: Date; last_sign_in_at: Date | null;
};

export const publicUser = (u: UserRow) => ({
  id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
  email_confirmed_at: u.email_confirmed_at, confirmed_at: u.email_confirmed_at, phone: "",
  last_sign_in_at: u.last_sign_in_at, app_metadata: u.raw_app_meta_data, user_metadata: u.raw_user_meta_data,
  created_at: u.created_at, updated_at: u.updated_at, banned_until: u.banned_until,
});

/** Failed-login limiter per project+email so one project's guessing cannot lock out another's users. */
class Attempts {
  private m = new Map<string, { n: number; until: number }>();
  check(key: string) {
    const e = this.m.get(key);
    if (e && e.until > Date.now() && e.n >= 10) throw new AuthError(429, "over_request_rate_limit", "Too many attempts, try again later");
  }
  fail(key: string) {
    const e = this.m.get(key);
    if (!e || e.until <= Date.now()) this.m.set(key, { n: 1, until: Date.now() + 15 * 60_000 });
    else e.n++;
    if (this.m.size > 20000) this.m.delete(this.m.keys().next().value!);
  }
  clear(key: string) {
    this.m.delete(key);
  }
}

/**
 * scrypt runs on the shared libuv threadpool, so one project's login storm could delay everyone's file and DNS work.
 * Bound how many password hashes may run at once per project and overall; excess callers are told to retry.
 */
class HashSlots {
  private per = new Map<string, number>();
  private total = 0;
  constructor(private maxPerProject = 3, private maxTotal = 8) {}
  async run<T>(ref: string, fn: () => Promise<T>): Promise<T> {
    if ((this.per.get(ref) ?? 0) >= this.maxPerProject || this.total >= this.maxTotal)
      throw new AuthError(429, "over_request_rate_limit", "Too many sign-in requests at once, retry shortly");
    this.per.set(ref, (this.per.get(ref) ?? 0) + 1);
    this.total++;
    try {
      return await fn();
    } finally {
      this.total--;
      const n = (this.per.get(ref) ?? 1) - 1;
      if (n <= 0) this.per.delete(ref);
      else this.per.set(ref, n);
    }
  }
}

export class AuthService {
  private slots = new HashSlots();
  private attempts = new Attempts();
  constructor(private pm: PoolManager) {}

  private db<T>(ref: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.pm.withRole(ref, { role: "service_role", claims: { role: "service_role" } }, (c) => fn(c));
  }

  private async session(ref: string, project: Resolved, user: UserRow, sessionId: string = randomUUID()) {
    const secret = project.secrets!.jwtSecret;
    const ttl = Number(project.settings.jwt_expiry ?? 3600);
    const now = Math.floor(Date.now() / 1000);
    const access = signJwt(
      {
        iss: "baas", aud: "authenticated", sub: user.id, role: "authenticated", email: user.email, session_id: sessionId,
        app_metadata: user.raw_app_meta_data, user_metadata: user.raw_user_meta_data, iat: now, exp: now + ttl,
      },
      secret,
    );
    const refresh = randomBytes(32).toString("base64url");
    await this.db(ref, (c) =>
      c.query(`INSERT INTO auth.refresh_tokens (token_hash, user_id, session_id) VALUES ($1, $2, $3)`, [hashToken(refresh), user.id, sessionId]),
    );
    return { access_token: access, token_type: "bearer", expires_in: ttl, expires_at: now + ttl, refresh_token: refresh, user: publicUser(user) };
  }

  private validate(email: unknown, password: unknown) {
    if (typeof email !== "string" || !EMAIL.test(email)) throw new AuthError(422, "validation_failed", "Unable to validate email address: invalid format");
    if (typeof password !== "string" || password.length < 6) throw new AuthError(422, "weak_password", "Password should be at least 6 characters");
    if (password.length > 256) throw new AuthError(422, "weak_password", "Password is too long");
    return { email: email.toLowerCase(), password };
  }

  async signup(ref: string, project: Resolved, body: Record<string, unknown>) {
    if (project.settings.disable_signup === true) throw new AuthError(422, "signup_disabled", "Signups not allowed for this instance");
    const { email, password } = this.validate(body.email, body.password);
    const meta = body.data !== null && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
    const user = await this.insertUser(ref, email, password, meta as object, {});
    return this.session(ref, project, user);
  }

  private async insertUser(ref: string, email: string, password: string, meta: object, appMeta: object): Promise<UserRow> {
    const hash = await this.slots.run(ref, () => hashPassword(password));
    try {
      return await this.db(ref, async (c) =>
        (await c.query<UserRow>(
          `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data)
           VALUES ($1, $2, $3, '{"provider":"email"}'::jsonb || $4::jsonb) RETURNING *`,
          [email, hash, JSON.stringify(meta), JSON.stringify(appMeta)],
        )).rows[0]!,
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new AuthError(422, "user_already_exists", "User already registered");
      throw err;
    }
  }

  async passwordLogin(ref: string, project: Resolved, body: Record<string, unknown>) {
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const key = `${ref}:${email}`;
    this.attempts.check(key);
    const user = await this.db(ref, async (c) => (await c.query<UserRow>(`SELECT * FROM auth.users WHERE email = $1`, [email])).rows[0]);
    const ok = await this.slots.run(ref, () => verifyPassword(password, user?.encrypted_password ?? null)); // constant work for unknown emails
    if (!user || !ok) {
      this.attempts.fail(key);
      throw new AuthError(400, "invalid_credentials", "Invalid login credentials");
    }
    if (user.banned_until && user.banned_until > new Date()) throw new AuthError(400, "user_banned", "User is banned");
    this.attempts.clear(key);
    await this.db(ref, (c) => c.query(`UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1`, [user.id]));
    return this.session(ref, project, user);
  }

  async refresh(ref: string, project: Resolved, body: Record<string, unknown>) {
    const token = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const h = hashToken(token);
    const row = await this.db(ref, async (c) =>
      (await c.query<{ user_id: string; session_id: string }>(
        `UPDATE auth.refresh_tokens SET revoked = true WHERE token_hash = $1 AND revoked = false RETURNING user_id, session_id`,
        [h],
      )).rows[0],
    );
    if (!row) {
      // A token that existed but was already used means it leaked or was replayed: end the whole session.
      await this.db(ref, (c) =>
        c.query(`UPDATE auth.refresh_tokens SET revoked = true WHERE session_id = (SELECT session_id FROM auth.refresh_tokens WHERE token_hash = $1)`, [h]),
      );
      throw new AuthError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
    }
    const user = await this.getUser(ref, row.user_id);
    if (!user || (user.banned_until && user.banned_until > new Date())) throw new AuthError(400, "user_not_found", "User not found");
    return this.session(ref, project, user, row.session_id);
  }

  private async getUser(ref: string, id: string): Promise<UserRow | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    return this.db(ref, async (c) => (await c.query<UserRow>(`SELECT * FROM auth.users WHERE id = $1`, [id])).rows[0]);
  }

  async me(ref: string, claims: Record<string, unknown>) {
    if (claims.role !== "authenticated" || typeof claims.sub !== "string") throw new AuthError(401, "bad_jwt", "This endpoint requires a user session");
    const u = await this.getUser(ref, claims.sub);
    if (!u) throw new AuthError(401, "user_not_found", "User from sub claim in JWT does not exist");
    return publicUser(u);
  }

  async updateMe(ref: string, claims: Record<string, unknown>, body: Record<string, unknown>) {
    await this.me(ref, claims);
    return this.updateUser(ref, claims.sub as string, body);
  }

  private async updateUser(ref: string, id: string, body: Record<string, unknown>) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (body.email !== undefined) {
      if (typeof body.email !== "string" || !EMAIL.test(body.email)) throw new AuthError(422, "validation_failed", "Unable to validate email address: invalid format");
      params.push(body.email.toLowerCase());
      sets.push(`email = $${params.length}`);
    }
    if (body.password !== undefined) {
      const { password } = this.validate("a@b.co", body.password);
      params.push(await this.slots.run(ref, () => hashPassword(password)));
      sets.push(`encrypted_password = $${params.length}`);
    }
    for (const [field, col] of [["data", "raw_user_meta_data"], ["user_metadata", "raw_user_meta_data"], ["app_metadata", "raw_app_meta_data"]] as const) {
      const v = body[field];
      if (v === undefined) continue;
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new AuthError(422, "validation_failed", `${field} must be an object`);
      params.push(JSON.stringify(v));
      sets.push(`${col} = ${col} || $${params.length}::jsonb`);
    }
    if (typeof body.ban_duration === "string" || body.ban_duration === "none") {
      if (body.ban_duration === "none") sets.push(`banned_until = NULL`);
      else {
        const m = /^(\d{1,6})h$/.exec(body.ban_duration);
        if (!m) throw new AuthError(422, "validation_failed", "ban_duration must be like 24h or none");
        sets.push(`banned_until = now() + interval '${Number(m[1])} hours'`);
      }
    }
    if (!sets.length) throw new AuthError(422, "validation_failed", "nothing to update");
    try {
      const u = await this.db(ref, async (c) =>
        (await c.query<UserRow>(`UPDATE auth.users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, params)).rows[0],
      );
      if (!u) throw new AuthError(404, "user_not_found", "User not found");
      return publicUser(u);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new AuthError(422, "email_exists", "A user with this email address has already been registered");
      throw err;
    }
  }

  async logout(ref: string, claims: Record<string, unknown>) {
    if (typeof claims.session_id === "string" && /^[0-9a-f-]{36}$/.test(claims.session_id))
      await this.db(ref, (c) => c.query(`UPDATE auth.refresh_tokens SET revoked = true WHERE session_id = $1`, [claims.session_id]));
  }

  // ---- admin (service_role) ----

  async adminList(ref: string, page: number, perPage: number) {
    const rows = await this.db(ref, async (c) =>
      (await c.query<UserRow>(`SELECT * FROM auth.users ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [perPage, (page - 1) * perPage])).rows,
    );
    const total = await this.db(ref, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM auth.users`)).rows[0].n));
    return { users: rows.map(publicUser), total };
  }

  async adminCreate(ref: string, body: Record<string, unknown>) {
    const { email, password } = this.validate(body.email, body.password);
    const meta = (body.user_metadata ?? {}) as object;
    const app = (body.app_metadata ?? {}) as object;
    return publicUser(await this.insertUser(ref, email, password, meta, app));
  }

  async adminGet(ref: string, id: string) {
    const u = await this.getUser(ref, id);
    if (!u) throw new AuthError(404, "user_not_found", "User not found");
    return publicUser(u);
  }

  adminUpdate(ref: string, id: string, body: Record<string, unknown>) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AuthError(404, "user_not_found", "User not found");
    return this.updateUser(ref, id, body);
  }

  async adminDelete(ref: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AuthError(404, "user_not_found", "User not found");
    const n = await this.db(ref, async (c) => (await c.query(`DELETE FROM auth.users WHERE id = $1`, [id])).rowCount);
    if (!n) throw new AuthError(404, "user_not_found", "User not found");
  }
}
