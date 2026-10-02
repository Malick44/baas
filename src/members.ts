import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "./authsvc.js";
import { NoMailer, type Mailer } from "./mailer.js";
import { matchStep, newSecret, otpauthUri } from "./totp.js";
import type { Vault } from "./vault.js";
import { ControlPlane, HttpError, RANKS, type Principal, type Role } from "./control.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
export const SESSION_MS = 7 * 86_400_000;
const INVITE_MS = 7 * 86_400_000;
const MIN_PASSWORD = 8;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

export type MembersOptions = { vault?: Vault; mailer?: Mailer; /** Where the dashboard is reached, for links in emails. Without it, emailed resets are off. */ dashboardUrl?: string; issuer?: string };
export type MfaChallenge = { mfa_required: true; mfa_token: string };
const RESET_MS = 3600_000;
const TICKET_MS = 5 * 60_000;
const TICKET_TRIES = 5;
const RESET_COOLDOWN_MS = 60_000;

export type Session = { token: string; expires_at: string; member: MemberView };
export type MemberView = { id: string; email: string; name: string | null; role: Role; mfa?: boolean };

const view = (r: { id: string; email: string; name: string | null; role: Role }): MemberView => ({ id: r.id, email: r.email, name: r.name, role: r.role });

function checkPassword(pw: unknown): string {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD || pw.length > 200) throw new HttpError(400, `password must be ${MIN_PASSWORD}-200 characters`);
  return pw;
}
function checkEmail(e: unknown): string {
  if (typeof e !== "string" || !EMAIL.test(e.trim())) throw new HttpError(400, "a valid email address is required");
  return e.trim();
}

/** Dashboard accounts: password sign-in, invitations and roles, on top of the control plane's token model. */
export class Members {
  /** Recent failed sign-ins per address, so a password cannot be guessed by trying forever. */
  private fails = new Map<string, number[]>();

  private mailer: Mailer;
  private resetSent = new Map<string, number>();

  constructor(private readonly control: ControlPlane, private readonly opts: MembersOptions = {}) {
    this.mailer = opts.mailer ?? new NoMailer();
  }

  get emailResetAvailable() {
    return this.mailer.configured && !!this.opts.dashboardUrl;
  }

  private get pool() {
    return this.control.pool;
  }

  private throttled(key: string): boolean {
    const now = Date.now();
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    this.fails.set(key, recent);
    return recent.length >= MAX_FAILS;
  }

  private async session(m: MemberView & { org_id: string }): Promise<Session> {
    const token = `baas_${randomBytes(32).toString("base64url")}`;
    const expires = new Date(Date.now() + SESSION_MS);
    await this.pool.query(`DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < now() - interval '1 day'`);
    await this.pool.query(
      `INSERT INTO api_tokens (org_id, name, role, token_hash, member_id, expires_at) VALUES ($1, 'session', $2, $3, $4, $5)`,
      [m.org_id, m.role, hash(token), m.id, expires],
    );
    return { token, expires_at: expires.toISOString(), member: view(m) };
  }

  async login(email: unknown, password: unknown): Promise<Session | MfaChallenge> {
    if (typeof email !== "string" || typeof password !== "string") throw new HttpError(400, "email and password are required");
    const key = email.trim().toLowerCase();
    if (this.throttled(key)) throw new HttpError(429, "too many failed sign-ins; try again in a few minutes", { "retry-after": "900" });
    const m = (await this.pool.query(`SELECT id, org_id, email, name, role, password_hash FROM members WHERE lower(email) = $1`, [key])).rows[0];
    const ok = await verifyPassword(password, m?.password_hash ?? null);
    if (!m || !ok) {
      this.fails.set(key, [...(this.fails.get(key) ?? []), Date.now()]);
      throw new HttpError(401, "invalid email or password");
    }
    if ((await this.pool.query(`SELECT 1 FROM member_factors WHERE member_id = $1 AND status = 'verified'`, [m.id])).rowCount) {
      // A correct password is only half of signing in. Failures at the second step still count against this address.
      const ticket = `baasmfa_${randomBytes(24).toString("base64url")}`;
      await this.pool.query(`DELETE FROM member_mfa_tickets WHERE member_id = $1 OR expires_at < now()`, [m.id]);
      await this.pool.query(`INSERT INTO member_mfa_tickets (member_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [m.id, hash(ticket), new Date(Date.now() + TICKET_MS)]);
      return { mfa_required: true, mfa_token: ticket };
    }
    this.fails.delete(key);
    await this.control.audit(`member:${m.id}`, m.org_id, "member.login", m.id);
    return this.session(m);
  }

  /** Second step of signing in: an authenticator code, or one of the recovery codes. */
  async loginMfa(ticket: unknown, code: unknown): Promise<Session> {
    if (typeof ticket !== "string" || typeof code !== "string" || !code.trim()) throw new HttpError(400, "mfa_token and code are required");
    const t = (await this.pool.query(
      `UPDATE member_mfa_tickets SET attempts = attempts + 1 WHERE token_hash = $1 AND expires_at > now() AND attempts < $2 RETURNING id, member_id`, [hash(ticket), TICKET_TRIES])).rows[0];
    if (!t) throw new HttpError(401, "this sign-in has expired; start again");
    const m = (await this.pool.query(`SELECT id, org_id, email, name, role FROM members WHERE id = $1`, [t.member_id])).rows[0];
    const key = m.email.toLowerCase();
    if (this.throttled(key)) throw new HttpError(429, "too many failed sign-ins; try again in a few minutes", { "retry-after": "900" });
    if (!(await this.checkSecondFactor(t.member_id, code))) {
      this.fails.set(key, [...(this.fails.get(key) ?? []), Date.now()]);
      throw new HttpError(401, "that code is not right");
    }
    await this.pool.query(`DELETE FROM member_mfa_tickets WHERE member_id = $1`, [t.member_id]);
    this.fails.delete(key);
    await this.control.audit(`member:${m.id}`, m.org_id, "member.login", m.id, { mfa: true });
    return this.session(m);
  }

  /** True if the code is a current authenticator code that was not used before, or an unused recovery code (which it spends). */
  private async checkSecondFactor(memberId: string, raw: string): Promise<boolean> {
    const code = raw.trim().replace(/\s/g, "");
    const f = (await this.pool.query(`SELECT secret_enc, last_used_step FROM member_factors WHERE member_id = $1 AND status = 'verified'`, [memberId])).rows[0];
    if (!f || !this.opts.vault) return false;
    if (/^\d{6}$/.test(code)) {
      const step = matchStep(this.opts.vault.open(f.secret_enc, `member:${memberId}`), code, Date.now(), Number(f.last_used_step));
      if (step === null) return false;
      // Only one of two racing requests with the same code can move the step forward.
      return !!(await this.pool.query(`UPDATE member_factors SET last_used_step = $2 WHERE member_id = $1 AND last_used_step < $2`, [memberId, step])).rowCount;
    }
    return !!(await this.pool.query(`UPDATE member_recovery_codes SET used_at = now() WHERE member_id = $1 AND code_hash = $2 AND used_at IS NULL`, [memberId, hash(code.toLowerCase())])).rowCount;
  }

  async logout(p: Principal): Promise<void> {
    if (p.memberId) await this.pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1`, [p.tokenId]);
  }

  async me(p: Principal): Promise<MemberView | null> {
    if (!p.memberId) return null;
    const r = await this.pool.query(
      `SELECT m.id, m.email, m.name, m.role, EXISTS (SELECT 1 FROM member_factors f WHERE f.member_id = m.id AND f.status = 'verified') AS mfa FROM members m WHERE m.id = $1`, [p.memberId]);
    return r.rows[0] ? { ...view(r.rows[0]), mfa: r.rows[0].mfa } : null;
  }

  /** Create the first owner of a new organisation from the bootstrap call. */
  async bootstrapOwner(orgId: string, email: unknown, password: unknown, name?: unknown): Promise<MemberView> {
    const e = checkEmail(email);
    const hashed = await hashPassword(checkPassword(password));
    try {
      const r = await this.pool.query(
        `INSERT INTO members (org_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id, email, name, role`,
        [orgId, e, typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null, hashed],
      );
      return view(r.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "that email already has an account");
      throw err;
    }
  }

  async list(p: Principal) {
    ControlPlane.require(p, "admin");
    const members = (await this.pool.query(
      `SELECT m.id, m.email, m.name, m.role, m.created_at, EXISTS (SELECT 1 FROM member_factors f WHERE f.member_id = m.id AND f.status = 'verified') AS mfa
         FROM members m WHERE m.org_id = $1 ORDER BY m.created_at`, [p.orgId])).rows;
    const invites = (await this.pool.query(
      `SELECT id, email, role, created_at, expires_at FROM invites WHERE org_id = $1 AND accepted_at IS NULL ORDER BY created_at`, [p.orgId])).rows;
    return { members, invites: invites.map((i) => ({ ...i, expired: new Date(i.expires_at) < new Date() })) };
  }

  /** People may grant up to their own rank, and may only touch people at or below it. */
  private canGrant(p: Principal, role: Role) {
    if (RANKS[role] > RANKS[p.role]) throw new HttpError(403, `you cannot grant the ${role} role`);
  }

  async invite(p: Principal, email: unknown, role: unknown) {
    ControlPlane.require(p, "admin");
    const e = checkEmail(email);
    if (role !== "developer" && role !== "admin" && role !== "owner") throw new HttpError(400, "role must be developer, admin or owner");
    this.canGrant(p, role);
    if ((await this.pool.query(`SELECT 1 FROM members WHERE lower(email) = lower($1)`, [e])).rowCount) throw new HttpError(409, "that email already has an account");
    const token = `baasinv_${randomBytes(24).toString("base64url")}`;
    await this.pool.query(`DELETE FROM invites WHERE org_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL`, [p.orgId, e]);
    const r = await this.pool.query(
      `INSERT INTO invites (org_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, created_at, expires_at`,
      [p.orgId, e, role, hash(token), p.memberId ?? p.tokenId, new Date(Date.now() + INVITE_MS)],
    );
    await this.control.audit(p.memberId ? `member:${p.memberId}` : p.tokenId, p.orgId, "member.invite", r.rows[0].id, { email: e, role });
    return { invite: r.rows[0], token };
  }

  async revokeInvite(p: Principal, id: string) {
    ControlPlane.require(p, "admin");
    const r = await this.pool.query(`DELETE FROM invites WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL`, [id, p.orgId]);
    if (!r.rowCount) throw new HttpError(404, "invite not found");
    await this.control.audit(p.memberId ? `member:${p.memberId}` : p.tokenId, p.orgId, "member.invite_revoke", id);
  }

  async acceptInvite(token: unknown, password: unknown, name?: unknown): Promise<Session> {
    if (typeof token !== "string" || !token) throw new HttpError(400, "invite token is required");
    const pw = checkPassword(password);
    const hashed = await hashPassword(pw);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Claim it first so two people racing on one invite cannot both get in.
      const inv = (await c.query(
        `UPDATE invites SET accepted_at = now() WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() RETURNING org_id, email, role`, [hash(token)])).rows[0];
      if (!inv) throw new HttpError(400, "this invitation is invalid, expired or already used");
      let m;
      try {
        m = (await c.query(
          `INSERT INTO members (org_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, org_id, email, name, role`,
          [inv.org_id, inv.email, typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null, hashed, inv.role])).rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "that email already has an account");
        throw err;
      }
      await c.query("COMMIT");
      await this.control.audit(`member:${m.id}`, m.org_id, "member.join", m.id, { role: m.role });
      return this.session(m);
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  private async target(p: Principal, id: string) {
    const m = (await this.pool.query(`SELECT id, email, role FROM members WHERE id = $1 AND org_id = $2`, [id, p.orgId])).rows[0];
    if (!m) throw new HttpError(404, "member not found");
    if (RANKS[m.role as Role] > RANKS[p.role]) throw new HttpError(403, "you cannot change someone with a higher role");
    return m as { id: string; email: string; role: Role };
  }

  private async keepAnOwner(p: Principal, leaving: { id: string; role: Role }) {
    if (leaving.role !== "owner") return;
    const n = (await this.pool.query(`SELECT count(*)::int AS n FROM members WHERE org_id = $1 AND role = 'owner' AND id <> $2`, [p.orgId, leaving.id])).rows[0].n;
    if (n === 0) throw new HttpError(409, "the organisation needs at least one owner member");
  }

  async setRole(p: Principal, id: string, role: unknown) {
    ControlPlane.require(p, "admin");
    if (role !== "developer" && role !== "admin" && role !== "owner") throw new HttpError(400, "role must be developer, admin or owner");
    this.canGrant(p, role);
    const m = await this.target(p, id);
    if (role !== "owner") await this.keepAnOwner(p, m);
    await this.pool.query(`UPDATE members SET role = $1 WHERE id = $2`, [role, id]);
    await this.control.audit(p.memberId ? `member:${p.memberId}` : p.tokenId, p.orgId, "member.role", id, { from: m.role, to: role });
  }

  async remove(p: Principal, id: string) {
    if (id !== p.memberId) ControlPlane.require(p, "admin");
    const m = await this.target(p, id);
    await this.keepAnOwner(p, m);
    await this.pool.query(`DELETE FROM members WHERE id = $1`, [id]); // sessions go with it
    await this.control.audit(p.memberId ? `member:${p.memberId}` : p.tokenId, p.orgId, "member.remove", id, { email: m.email });
  }

  async changePassword(p: Principal, current: unknown, next: unknown) {
    if (!p.memberId) throw new HttpError(400, "only signed-in members have a password");
    const pw = checkPassword(next);
    const row = (await this.pool.query(`SELECT password_hash FROM members WHERE id = $1`, [p.memberId])).rows[0];
    if (typeof current !== "string" || !(await verifyPassword(current, row?.password_hash ?? null))) throw new HttpError(400, "current password is incorrect");
    await this.pool.query(`UPDATE members SET password_hash = $1 WHERE id = $2`, [await hashPassword(pw), p.memberId]);
    await this.pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE member_id = $1 AND id <> $2 AND revoked_at IS NULL`, [p.memberId, p.tokenId]);
    await this.control.audit(`member:${p.memberId}`, p.orgId, "member.password", p.memberId);
  }

  /** An owner sets a new password for someone who has lost theirs, signing them out everywhere. */
  async setPasswordFor(p: Principal, id: string, next: unknown) {
    ControlPlane.require(p, "owner");
    const pw = checkPassword(next);
    await this.target(p, id);
    await this.pool.query(`UPDATE members SET password_hash = $1 WHERE id = $2`, [await hashPassword(pw), id]);
    await this.pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [id]);
    await this.control.audit(p.memberId ? `member:${p.memberId}` : p.tokenId, p.orgId, "member.password_reset", id);
  }

  // ---- password reset by email ----

  /** Always answers the same, whether or not the address has an account. */
  async forgotPassword(email: unknown): Promise<void> {
    if (!this.emailResetAvailable) throw new HttpError(501, "Email is not set up on this server, so passwords cannot be reset by email. Ask an owner to set a new password for you.");
    const e = checkEmail(email).toLowerCase();
    const last = this.resetSent.get(e) ?? 0;
    if (Date.now() - last < RESET_COOLDOWN_MS) return;
    this.resetSent.set(e, Date.now());
    const m = (await this.pool.query(`SELECT id, org_id, email FROM members WHERE lower(email) = $1`, [e])).rows[0];
    if (!m) return;
    const token = `baasrst_${randomBytes(24).toString("base64url")}`;
    await this.pool.query(`DELETE FROM member_resets WHERE member_id = $1 AND used_at IS NULL`, [m.id]);
    await this.pool.query(`INSERT INTO member_resets (member_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [m.id, hash(token), new Date(Date.now() + RESET_MS)]);
    const link = `${this.opts.dashboardUrl!.replace(/\/+$/, "")}/#/reset/${token}`;
    // Not awaited: whether a mail was sent must not show in how long the answer takes.
    void this.mailer.send({
      to: m.email, subject: "Reset your password",
      text: `Someone asked to reset the password for this account.\n\nChoose a new password here (the link works once and expires in an hour):\n${link}\n\nIf this was not you, ignore this email: nothing changes.`,
    }).catch(() => {});
    await this.control.audit(`member:${m.id}`, m.org_id, "member.reset_requested", m.id);
  }

  async resetWithToken(token: unknown, password: unknown): Promise<void> {
    if (typeof token !== "string" || !token) throw new HttpError(400, "token is required");
    const pw = checkPassword(password);
    const hashed = await hashPassword(pw);
    const r = (await this.pool.query(
      `UPDATE member_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING member_id`, [hash(token)])).rows[0];
    if (!r) throw new HttpError(400, "this link is invalid, expired or already used");
    const m = (await this.pool.query(`UPDATE members SET password_hash = $1 WHERE id = $2 RETURNING org_id`, [hashed, r.member_id])).rows[0];
    // A reset signs the account out everywhere; a second factor, if there is one, still applies at the next sign-in.
    await this.pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [r.member_id]);
    await this.pool.query(`DELETE FROM member_resets WHERE member_id = $1`, [r.member_id]);
    await this.control.audit(`member:${r.member_id}`, m.org_id, "member.password_reset_by_email", r.member_id);
  }

  // ---- authenticator app ----

  private requireMember(p: Principal): string {
    if (!p.memberId) throw new HttpError(400, "only signed-in members can use an authenticator");
    return p.memberId;
  }

  async mfaEnroll(p: Principal) {
    const id = this.requireMember(p);
    if (!this.opts.vault) throw new HttpError(501, "the platform key store is needed for authenticators");
    if ((await this.pool.query(`SELECT 1 FROM member_factors WHERE member_id = $1 AND status = 'verified'`, [id])).rowCount) throw new HttpError(409, "an authenticator is already set up; remove it first");
    const m = (await this.pool.query(`SELECT email FROM members WHERE id = $1`, [id])).rows[0];
    const secret = newSecret();
    await this.pool.query(
      `INSERT INTO member_factors (member_id, secret_enc) VALUES ($1, $2)
       ON CONFLICT (member_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, status = 'unverified', last_used_step = -1, created_at = now()`,
      [id, this.opts.vault.seal(secret, `member:${id}`)]);
    return { secret, uri: otpauthUri(secret, m.email, this.opts.issuer ?? "baas") };
  }

  /** Confirms the app shows the right codes, turns the requirement on, and hands out recovery codes (once). */
  async mfaVerify(p: Principal, code: unknown) {
    const id = this.requireMember(p);
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) throw new HttpError(400, "enter the 6-digit code from your app");
    const f = (await this.pool.query(`SELECT secret_enc FROM member_factors WHERE member_id = $1 AND status = 'unverified'`, [id])).rows[0];
    if (!f || !this.opts.vault) throw new HttpError(400, "start setting up an authenticator first");
    const step = matchStep(this.opts.vault.open(f.secret_enc, `member:${id}`), code.trim(), Date.now(), -1);
    if (step === null) throw new HttpError(400, "that code is not right; check the time on your device");
    await this.pool.query(`UPDATE member_factors SET status = 'verified', verified_at = now(), last_used_step = $2 WHERE member_id = $1`, [id, step]);
    const codes = Array.from({ length: 8 }, () => { const x = randomBytes(5).toString("hex"); return `${x.slice(0, 5)}-${x.slice(5)}`; });
    await this.pool.query(`DELETE FROM member_recovery_codes WHERE member_id = $1`, [id]);
    for (const c of codes) await this.pool.query(`INSERT INTO member_recovery_codes (member_id, code_hash) VALUES ($1, $2)`, [id, hash(c)]);
    await this.control.audit(`member:${id}`, p.orgId, "member.mfa_enabled", id);
    return { recovery_codes: codes };
  }

  /** Removing it needs the password and a current code (or a recovery code), so a stolen session cannot switch it off. */
  async mfaDisable(p: Principal, password: unknown, code: unknown) {
    const id = this.requireMember(p);
    const row = (await this.pool.query(`SELECT password_hash FROM members WHERE id = $1`, [id])).rows[0];
    if (typeof password !== "string" || !(await verifyPassword(password, row?.password_hash ?? null))) throw new HttpError(400, "password is incorrect");
    if (typeof code !== "string" || !(await this.checkSecondFactor(id, code))) throw new HttpError(400, "that code is not right");
    await this.pool.query(`DELETE FROM member_factors WHERE member_id = $1`, [id]);
    await this.pool.query(`DELETE FROM member_recovery_codes WHERE member_id = $1`, [id]);
    await this.control.audit(`member:${id}`, p.orgId, "member.mfa_removed", id);
  }

  /** For someone who lost their device and their recovery codes. */
  async removeMfaFor(p: Principal, id: string) {
    ControlPlane.require(p, "owner");
    await this.target(p, id);
    await this.pool.query(`DELETE FROM member_factors WHERE member_id = $1`, [id]);
    await this.pool.query(`DELETE FROM member_recovery_codes WHERE member_id = $1`, [id]);
    await this.pool.query(`DELETE FROM member_mfa_tickets WHERE member_id = $1`, [id]);
    await this.control.audit(p.memberId ? `member:${p.memberId}` : p.tokenId, p.orgId, "member.mfa_reset", id);
  }
}
