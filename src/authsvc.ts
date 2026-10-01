import { createHmac, randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { HttpError, type Resolved } from "./control.js";
import { signJwt } from "./keys.js";
import { DEFAULT_TEMPLATES, htmlFromText, NoMailer, renderTemplate, type Mailer, type TemplateKind } from "./mailer.js";
import { isProvider, PROVIDERS, type OAuthProvider, type Profile } from "./oauth.js";
import type { PoolManager } from "./pools.js";
import { AUTH_EXTRAS_SQL, urlFor } from "./provision.js";
import type { Vault } from "./vault.js";

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

export type AuthOptions = {
  /** Superuser connection for the cluster; lets older projects get the tables the email and provider flows need. */
  adminUrl?: string;
  vault?: Vault;
  mailer?: Mailer;
  /** The project's public URL (<ref>.<domain>), used in email links and as the OAuth callback. */
  publicUrl?: (ref: string) => string;
  /** Point a provider at a different server (a self-hosted GitHub, or a stand-in during tests). */
  providerOverrides?: Record<string, Partial<Pick<OAuthProvider, "authUrl" | "tokenUrl" | "userUrl" | "emailsUrl">>>;
  fetch?: typeof fetch;
  /** Minimum time between emails to the same address, and the most emails one project may send per hour. */
  emailCooldownMs?: number;
  maxEmailsPerHour?: number;
  secureCookies?: boolean;
  log?: (msg: string) => void;
};

/** A failed OAuth sign-in. When the app gave a safe redirect_to, the browser is sent back there with the error. */
export class OAuthFailure extends AuthError {
  constructor(status: number, errorCode: string, message: string, readonly redirectTo: string | null = null) {
    super(status, errorCode, message);
  }
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const TOKEN_TYPES: Record<string, "confirmation" | "recovery" | "magiclink"> = { signup: "confirmation", confirmation: "confirmation", recovery: "recovery", magiclink: "magiclink", email: "magiclink" };
const TOKEN_TTL = { confirmation: 24 * 3600_000, recovery: 3600_000, magiclink: 3600_000 };
const TEMPLATE_OF: Record<"confirmation" | "recovery" | "magiclink", TemplateKind> = { confirmation: "confirmation", recovery: "recovery", magiclink: "magic_link" };

/** Where an email link or OAuth sign-in may send the browser: the site URL's origin, or something the owner listed. */
export function redirectAllowed(settings: Record<string, unknown>, raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password) return false;
  const site = typeof settings.site_url === "string" ? settings.site_url : "";
  try {
    if (site && /^https?:$/.test(u.protocol) && new URL(site).origin === u.origin) return true;
  } catch { /* bad site_url */ }
  const list = Array.isArray(settings.redirect_urls) ? (settings.redirect_urls as unknown[]) : [];
  return list.some((e) => typeof e === "string" && e.length > 0 && (e === raw || (e.endsWith("*") && raw.startsWith(e.slice(0, -1)))));
}

export class AuthService {
  private slots = new HashSlots();
  private attempts = new Attempts();
  private ready = new Set<string>();
  private cooldown = new Map<string, number>();
  private hourly = new Map<string, { n: number; until: number }>();
  private mailer: Mailer;
  constructor(private pm: PoolManager, private opts: AuthOptions = {}) {
    this.mailer = opts.mailer ?? new NoMailer();
  }

  get emailConfigured() {
    return this.mailer.configured;
  }

  /** New projects have the email/provider tables from the start; older ones get them the first time they are needed. */
  private async ensure(ref: string, project: Resolved) {
    if (this.ready.has(ref) || !this.opts.adminUrl) return;
    const c = new pg.Client({ connectionString: urlFor(this.opts.adminUrl, project.dbName) });
    c.on("error", () => {});
    await c.connect();
    try {
      await c.query(AUTH_EXTRAS_SQL);
    } finally {
      await c.end().catch(() => {});
    }
    this.ready.add(ref);
  }

  private confirmRequired(project: Resolved) {
    return project.settings.email_confirm === true && this.mailer.configured;
  }

  /** What the client library reads to decide which sign-in options to show. */
  publicSettings(project: Resolved) {
    const providers = (project.settings.auth_providers ?? {}) as Record<string, { enabled?: boolean; client_id?: string; secret_enc?: string }>;
    const external: Record<string, boolean> = { email: true };
    for (const name of Object.keys(PROVIDERS)) external[name] = providers[name]?.enabled === true && !!providers[name]?.client_id && !!providers[name]?.secret_enc && !!this.opts.vault;
    return { external, disable_signup: project.settings.disable_signup === true, mailer_autoconfirm: !this.confirmRequired(project), email_delivery: this.mailer.configured, password_min_length: this.minPassword(project) };
  }

  private minPassword(project: Resolved) {
    const n = Number(project.settings.password_min_length);
    return Number.isInteger(n) && n >= 6 && n <= 64 ? n : 6;
  }

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

  private validate(email: unknown, password: unknown, min = 6) {
    if (typeof email !== "string" || !EMAIL.test(email)) throw new AuthError(422, "validation_failed", "Unable to validate email address: invalid format");
    if (typeof password !== "string" || password.length < min) throw new AuthError(422, "weak_password", `Password should be at least ${min} characters`);
    if (password.length > 256) throw new AuthError(422, "weak_password", "Password is too long");
    return { email: email.toLowerCase(), password };
  }

  /** Sign up. Returns a session, or just the user when the project requires the email address to be confirmed first. */
  async signup(ref: string, project: Resolved, body: Record<string, unknown>, redirectTo?: unknown) {
    if (project.settings.disable_signup === true) throw new AuthError(422, "signup_disabled", "Signups not allowed for this instance");
    const { email, password } = this.validate(body.email, body.password, this.minPassword(project));
    const meta = body.data !== null && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
    const confirm = this.confirmRequired(project);
    const redirect = this.redirectFor(project, redirectTo ?? body.redirect_to);
    if (confirm) await this.ensure(ref, project);
    const user = await this.insertUser(ref, email, password, meta as object, {}, !confirm);
    if (!confirm) return this.session(ref, project, user);
    await this.sendToken(ref, project, user, "confirmation", redirect).catch((e) => this.opts.log?.(`confirmation email to ${email} failed: ${(e as Error).message}`));
    return publicUser(user);
  }

  private async insertUser(ref: string, email: string, password: string | null, meta: object, appMeta: object, confirmed = true): Promise<UserRow> {
    const hash = password === null ? null : await this.slots.run(ref, () => hashPassword(password));
    try {
      return await this.db(ref, async (c) =>
        (await c.query<UserRow>(
          `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
           VALUES ($1, $2, $3, '{"provider":"email"}'::jsonb || $4::jsonb, CASE WHEN $5::boolean THEN now() END) RETURNING *`,
          [email, hash, JSON.stringify(meta), JSON.stringify(appMeta), confirmed],
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
    if (!user.email_confirmed_at) throw new AuthError(400, "email_not_confirmed", "Email not confirmed");
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

  async updateMe(ref: string, project: Resolved, claims: Record<string, unknown>, body: Record<string, unknown>) {
    await this.me(ref, claims);
    // A signed-in user may not confirm their own address or ban themselves; those are administrator actions.
    const { email_confirm: _c, ban_duration: _b, app_metadata: _a, ...own } = body;
    const before = await this.getUser(ref, claims.sub as string);
    const changing = typeof own.email === "string" && before?.email?.toLowerCase() !== own.email.toLowerCase();
    // With confirmation required, a new address has to be proven before it can be used to sign in.
    const confirm = changing && this.confirmRequired(project);
    const out = await this.updateUser(ref, claims.sub as string, confirm ? { ...own, email_confirm: false } : own, this.minPassword(project));
    if (confirm) {
      await this.ensure(ref, project);
      const u = (await this.getUser(ref, claims.sub as string))!;
      await this.db(ref, (c) => c.query(`UPDATE auth.users SET email_confirmed_at = NULL WHERE id = $1`, [u.id]));
      await this.sendToken(ref, project, { ...u, email_confirmed_at: null }, "confirmation", this.redirectFor(project, undefined)).catch((e) => this.opts.log?.(`confirmation email failed: ${(e as Error).message}`));
      return { ...out, email_confirmed_at: null, confirmed_at: null };
    }
    return out;
  }

  get secureCookies() {
    return this.opts.secureCookies === true;
  }

  private async updateUser(ref: string, id: string, body: Record<string, unknown>, minLen = 6) {
    const sets: string[] = [];
    if (body.email_confirm === true) sets.push(`email_confirmed_at = coalesce(email_confirmed_at, now())`);
    const params: unknown[] = [id];
    if (body.email !== undefined) {
      if (typeof body.email !== "string" || !EMAIL.test(body.email)) throw new AuthError(422, "validation_failed", "Unable to validate email address: invalid format");
      params.push(body.email.toLowerCase());
      sets.push(`email = $${params.length}`);
    }
    if (body.password !== undefined) {
      const { password } = this.validate("a@b.co", body.password, minLen);
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

  // ---- email links: confirmation, password recovery, magic links ----

  /** The redirect an email link will end on: the one the app asked for if it is allowed, else the site URL. */
  private redirectFor(project: Resolved, asked: unknown): string | null {
    if (asked !== undefined && asked !== null && asked !== "") {
      if (!redirectAllowed(project.settings, asked)) throw new AuthError(400, "validation_failed", "redirect_to is not allowed: add it to the redirect URLs or use an address on the site URL");
      return asked as string;
    }
    const site = project.settings.site_url;
    return typeof site === "string" && /^https?:\/\//.test(site) ? site : null;
  }

  private requireMail() {
    if (!this.mailer.configured) throw new AuthError(501, "not_implemented", "Email delivery is not configured for this platform");
  }

  /** One email to an address per minute, and a ceiling per project, so the form cannot be used to flood anyone. */
  private mailGate(ref: string, email: string) {
    const now = Date.now();
    const key = `${ref}:${email}`;
    const gap = this.opts.emailCooldownMs ?? 60_000;
    if ((this.cooldown.get(key) ?? 0) > now) throw new AuthError(429, "over_email_send_rate_limit", `For security purposes, you can only request this once every ${Math.round(gap / 1000)} seconds`);
    const h = this.hourly.get(ref);
    const cap = this.opts.maxEmailsPerHour ?? 100;
    if (h && h.until > now && h.n >= cap) throw new AuthError(429, "over_email_send_rate_limit", "This project has sent too many emails this hour; try again later");
    this.cooldown.set(key, now + gap);
    if (this.cooldown.size > 20_000) this.cooldown.delete(this.cooldown.keys().next().value!);
    if (!h || h.until <= now) this.hourly.set(ref, { n: 1, until: now + 3600_000 });
    else h.n++;
  }

  private async sendToken(ref: string, project: Resolved, user: UserRow, type: "confirmation" | "recovery" | "magiclink", redirectTo: string | null) {
    if (!user.email) return;
    await this.ensure(ref, project);
    const raw = randomBytes(32).toString("base64url");
    await this.db(ref, async (c) => {
      // Only the newest link of each kind works.
      await c.query(`UPDATE auth.one_time_tokens SET used_at = now() WHERE user_id = $1 AND token_type = $2 AND used_at IS NULL`, [user.id, type]);
      await c.query(`INSERT INTO auth.one_time_tokens (user_id, token_type, token_hash, redirect_to, expires_at) VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'))`,
        [user.id, type, hashToken(raw), redirectTo, TOKEN_TTL[type]]);
    });
    const base = this.opts.publicUrl?.(ref) ?? "";
    const url = `${base}/auth/v1/verify?token=${raw}&type=${type === "confirmation" ? "signup" : type}`;
    const kind = TEMPLATE_OF[type];
    const custom = ((project.settings.email_templates ?? {}) as Record<string, { subject?: string; body?: string }>)[kind] ?? {};
    const vars = { ConfirmationURL: url, Email: user.email, SiteURL: typeof project.settings.site_url === "string" ? project.settings.site_url : "" };
    const subject = renderTemplate(custom.subject || DEFAULT_TEMPLATES[kind].subject, vars);
    const text = renderTemplate(custom.body || DEFAULT_TEMPLATES[kind].body, vars);
    const fromName = typeof project.settings.mailer_from_name === "string" && project.settings.mailer_from_name ? project.settings.mailer_from_name : undefined;
    await this.mailer.send({ to: user.email, subject, text, html: htmlFromText(text), fromName });
  }

  private async userByEmail(ref: string, email: string): Promise<UserRow | undefined> {
    return this.db(ref, async (c) => (await c.query<UserRow>(`SELECT * FROM auth.users WHERE email = $1`, [email])).rows[0]);
  }

  private emailOf(v: unknown): string {
    if (typeof v !== "string" || !EMAIL.test(v)) throw new AuthError(422, "validation_failed", "Unable to validate email address: invalid format");
    return v.toLowerCase();
  }

  /** Password reset. Answers the same whether or not the address has an account. */
  async recover(ref: string, project: Resolved, body: Record<string, unknown>, redirectTo?: unknown) {
    this.requireMail();
    const email = this.emailOf(body.email);
    const redirect = this.redirectFor(project, redirectTo ?? body.redirect_to);
    this.mailGate(ref, email);
    await this.ensure(ref, project);
    const user = await this.userByEmail(ref, email);
    if (user) await this.sendToken(ref, project, user, "recovery", redirect).catch((e) => this.opts.log?.(`recovery email to ${email} failed: ${(e as Error).message}`));
    return {};
  }

  /** A sign-in link by email. Creates the account on first use unless sign-ups are off or the app said not to. */
  async magicLink(ref: string, project: Resolved, body: Record<string, unknown>, redirectTo?: unknown) {
    this.requireMail();
    const email = this.emailOf(body.email);
    const redirect = this.redirectFor(project, redirectTo ?? body.redirect_to);
    this.mailGate(ref, email);
    await this.ensure(ref, project);
    let user = await this.userByEmail(ref, email);
    if (!user) {
      if (body.create_user === false || project.settings.disable_signup === true) return {};
      const meta = body.data !== null && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as object) : {};
      user = await this.insertUser(ref, email, null, meta, {}, false).catch(async (e) => {
        if ((e as { errorCode?: string }).errorCode === "user_already_exists") return (await this.userByEmail(ref, email))!;
        throw e;
      });
    }
    await this.sendToken(ref, project, user, "magiclink", redirect).catch((e) => this.opts.log?.(`magic link email to ${email} failed: ${(e as Error).message}`));
    return {};
  }

  /** Send the confirmation email again to someone who has not confirmed yet. */
  async resend(ref: string, project: Resolved, body: Record<string, unknown>, redirectTo?: unknown) {
    this.requireMail();
    if (body.type !== "signup") throw new AuthError(422, "validation_failed", 'type must be "signup"');
    const email = this.emailOf(body.email);
    const redirect = this.redirectFor(project, redirectTo ?? body.redirect_to);
    this.mailGate(ref, email);
    await this.ensure(ref, project);
    const user = await this.userByEmail(ref, email);
    if (user && !user.email_confirmed_at) await this.sendToken(ref, project, user, "confirmation", redirect).catch((e) => this.opts.log?.(`confirmation email to ${email} failed: ${(e as Error).message}`));
    return {};
  }

  /** Trade a one-time link token for a session. The token works once, until it expires. */
  async verify(ref: string, project: Resolved, input: { token?: unknown; type?: unknown }) {
    if (typeof input.token !== "string" || !/^[\w-]{20,100}$/.test(input.token)) throw new AuthError(403, "otp_expired", "Email link is invalid or has expired");
    const want = input.type === undefined || input.type === "" ? undefined : TOKEN_TYPES[String(input.type)];
    if (input.type !== undefined && input.type !== "" && !want) throw new AuthError(422, "validation_failed", "type must be signup, recovery, magiclink or email");
    await this.ensure(ref, project);
    const row = await this.db(ref, async (c) =>
      (await c.query<{ user_id: string; token_type: "confirmation" | "recovery" | "magiclink"; redirect_to: string | null }>(
        `UPDATE auth.one_time_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND ($2::text IS NULL OR token_type = $2) RETURNING user_id, token_type, redirect_to`,
        [hashToken(input.token as string), want ?? null],
      )).rows[0],
    );
    if (!row) throw new AuthError(403, "otp_expired", "Email link is invalid or has expired");
    const u = await this.db(ref, async (c) =>
      (await c.query<UserRow>(`UPDATE auth.users SET email_confirmed_at = coalesce(email_confirmed_at, now()), last_sign_in_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [row.user_id])).rows[0],
    );
    if (!u) throw new AuthError(403, "otp_expired", "Email link is invalid or has expired");
    if (u.banned_until && u.banned_until > new Date()) throw new AuthError(400, "user_banned", "User is banned");
    const session = await this.session(ref, project, u);
    // The redirect was checked when the link was made, but the owner may have tightened the list since.
    const redirectTo = row.redirect_to && redirectAllowed(project.settings, row.redirect_to) ? row.redirect_to : null;
    return { session, redirectTo, type: row.token_type === "confirmation" ? "signup" : row.token_type };
  }

  // ---- sign in with an outside provider ----

  private providerConfig(ref: string, project: Resolved, name: unknown) {
    if (!isProvider(name)) throw new AuthError(400, "validation_failed", "Unsupported provider");
    const cfg = ((project.settings.auth_providers ?? {}) as Record<string, { enabled?: boolean; client_id?: string; secret_enc?: string }>)[name];
    if (!cfg?.enabled || !cfg.client_id || !cfg.secret_enc || !this.opts.vault) throw new AuthError(400, "provider_disabled", `Unsupported provider: ${name} is not enabled for this project`);
    const base = PROVIDERS[name]!;
    const o = this.opts.providerOverrides?.[name] ?? {};
    return { name, provider: { ...base, ...o } as OAuthProvider, clientId: cfg.client_id, secret: this.opts.vault.open(cfg.secret_enc, `${ref}:oauth:${name}`) };
  }

  private stateKey(project: Resolved) {
    return createHmac("sha256", project.secrets!.jwtSecret).update("oauth-state").digest();
  }
  private pkceVerifier(project: Resolved, nonce: string) {
    return createHmac("sha256", project.secrets!.jwtSecret).update(`oauth-pkce:${nonce}`).digest("base64url");
  }
  private callbackUrl(ref: string) {
    return `${this.opts.publicUrl?.(ref) ?? ""}/auth/v1/callback`;
  }

  /** Where to send the browser to start signing in. `nonce` must also be set as a cookie, to bind the flow to this browser. */
  authorize(ref: string, project: Resolved, providerName: unknown, redirectTo: unknown) {
    const cfg = this.providerConfig(ref, project, providerName);
    const redirect = this.redirectFor(project, redirectTo);
    if (!redirect) throw new AuthError(400, "validation_failed", "redirect_to is required: set a site URL or pass an allowed redirect_to");
    const nonce = randomBytes(16).toString("base64url");
    const payload = b64(JSON.stringify({ p: cfg.name, r: redirect, n: nonce, e: Math.floor(Date.now() / 1000) + 600 }));
    const state = `${payload}.${createHmac("sha256", this.stateKey(project)).update(payload).digest("base64url")}`;
    const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: this.callbackUrl(ref), response_type: "code", scope: cfg.provider.scopes, state });
    if (cfg.provider.pkce) {
      q.set("code_challenge", createHash("sha256").update(this.pkceVerifier(project, nonce)).digest("base64url"));
      q.set("code_challenge_method", "S256");
    }
    return { url: `${cfg.provider.authUrl}${cfg.provider.authUrl.includes("?") ? "&" : "?"}${q}`, nonce };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<any> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new Error(`could not reach the provider: ${(e as Error).message}`);
    }
    const text = (await res.text()).slice(0, 1_000_000);
    let data: any;
    try { data = JSON.parse(text); } catch { throw new Error(`the provider answered ${res.status} with something unreadable`); }
    if (!res.ok) throw new Error(`the provider answered ${res.status}${data?.error_description ? `: ${data.error_description}` : data?.error ? `: ${String(data.error)}` : ""}`);
    return data;
  }

  /** Finish a sign-in: the provider sent the browser back with a code. */
  async callback(ref: string, project: Resolved, query: Record<string, string | string[] | undefined>, cookieNonce: string | undefined) {
    const one = (k: string) => (typeof query[k] === "string" ? (query[k] as string) : "");
    const [payload, sig] = one("state").split(".");
    let st: { p: string; r: string; n: string; e: number } | null = null;
    if (payload && sig) {
      const want = createHmac("sha256", this.stateKey(project)).update(payload).digest();
      const got = Buffer.from(sig, "base64url");
      if (got.length === want.length && timingSafeEqual(got, want)) {
        try { st = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { st = null; }
      }
    }
    if (!st || typeof st.p !== "string" || typeof st.n !== "string" || st.e < Math.floor(Date.now() / 1000))
      throw new OAuthFailure(400, "bad_oauth_state", "The sign-in link is invalid or has expired; start again");
    const back = redirectAllowed(project.settings, st.r) ? st.r : null;
    const fail = (status: number, code: string, msg: string) => new OAuthFailure(status, code, msg, back);
    const a = Buffer.from(cookieNonce ?? "");
    const b = Buffer.from(st.n);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw fail(400, "bad_oauth_callback", "This sign-in was not started in this browser; start again");
    if (one("error")) throw fail(400, "access_denied", one("error_description") || one("error"));
    if (!one("code")) throw fail(400, "bad_oauth_callback", "The provider did not send a code");

    const cfg = this.providerConfig(ref, project, st.p);
    let profile: Profile;
    try {
      const body = new URLSearchParams({ grant_type: "authorization_code", code: one("code"), redirect_uri: this.callbackUrl(ref), client_id: cfg.clientId, client_secret: cfg.secret });
      if (cfg.provider.pkce) body.set("code_verifier", this.pkceVerifier(project, st.n));
      const tok = await this.fetchJson(cfg.provider.tokenUrl, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body });
      if (typeof tok?.access_token !== "string") throw new Error("the provider did not return an access token");
      const auth = { authorization: `Bearer ${tok.access_token}`, accept: "application/json", "user-agent": "baas-auth" };
      const user = await this.fetchJson(cfg.provider.userUrl, { headers: auth });
      const emails = cfg.provider.emailsUrl ? await this.fetchJson(cfg.provider.emailsUrl, { headers: auth }).catch(() => []) : undefined;
      profile = cfg.provider.profile(user, Array.isArray(emails) ? emails : undefined);
    } catch (e) {
      throw fail(502, "provider_error", (e as Error).message);
    }
    if (!profile.id || profile.id === "undefined") throw fail(502, "provider_error", "The provider did not say who you are");
    await this.ensure(ref, project);
    const user = await this.oauthUser(ref, project, cfg.name, profile).catch((e) => {
      if (e instanceof AuthError) throw fail(e.status, e.errorCode, e.message);
      throw e;
    });
    return { session: await this.session(ref, project, user), redirectTo: back };
  }

  /** Find or create the user for a provider identity, linking to an existing account only when the provider vouches for the address. */
  private async oauthUser(ref: string, project: Resolved, provider: string, p: Profile): Promise<UserRow> {
    const meta = { full_name: p.name, name: p.name, avatar_url: p.avatar, email: p.email, provider_id: p.id };
    const identityData = JSON.stringify({ ...meta, email_verified: p.emailVerified });
    return this.db(ref, async (c) => {
      const byIdentity = (await c.query<UserRow>(
        `SELECT u.* FROM auth.identities i JOIN auth.users u ON u.id = i.user_id WHERE i.provider = $1 AND i.provider_id = $2`, [provider, p.id])).rows[0];
      let user = byIdentity;
      if (user) {
        await c.query(`UPDATE auth.identities SET identity_data = $3::jsonb, last_sign_in_at = now() WHERE provider = $1 AND provider_id = $2`, [provider, p.id, identityData]);
      } else {
        const email = p.email?.toLowerCase() ?? null;
        const existing = email ? (await c.query<UserRow>(`SELECT * FROM auth.users WHERE email = $1`, [email])).rows[0] : undefined;
        if (existing) {
          if (!p.emailVerified) throw new AuthError(422, "email_exists", `An account with ${email} already exists. Sign in with your password instead.`);
          if (!existing.email_confirmed_at) {
            // Someone registered this address without proving they own it. The provider just proved it, so the password they chose is removed.
            await c.query(`UPDATE auth.users SET encrypted_password = NULL, email_confirmed_at = now() WHERE id = $1`, [existing.id]);
            await c.query(`UPDATE auth.refresh_tokens SET revoked = true WHERE user_id = $1`, [existing.id]);
          }
          user = existing;
        } else {
          if (project.settings.disable_signup === true) throw new AuthError(422, "signup_disabled", "Signups not allowed for this instance");
          user = (await c.query<UserRow>(
            `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
             VALUES ($1, NULL, CASE WHEN $2::boolean THEN now() END, jsonb_build_object('provider', $3::text, 'providers', jsonb_build_array($3::text)), $4::jsonb) RETURNING *`,
            [email, p.emailVerified, provider, JSON.stringify(meta)])).rows[0]!;
        }
        await c.query(`INSERT INTO auth.identities (user_id, provider, provider_id, identity_data, last_sign_in_at) VALUES ($1, $2, $3, $4::jsonb, now())`, [user!.id, provider, p.id, identityData]);
        await c.query(
          `UPDATE auth.users SET raw_app_meta_data = jsonb_set(raw_app_meta_data, '{providers}', (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements(coalesce(raw_app_meta_data -> 'providers', '[]'::jsonb) || to_jsonb($2::text)) x)) WHERE id = $1`,
          [user!.id, provider]);
      }
      if (user!.banned_until && user!.banned_until > new Date()) throw new AuthError(400, "user_banned", "User is banned");
      return (await c.query<UserRow>(`UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1 RETURNING *`, [user!.id])).rows[0]!;
    });
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
    return publicUser(await this.insertUser(ref, email, password, meta, app, body.email_confirm !== false));
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
