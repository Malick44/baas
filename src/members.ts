import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "./authsvc.js";
import { ControlPlane, HttpError, RANKS, type Principal, type Role } from "./control.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
export const SESSION_MS = 7 * 86_400_000;
const INVITE_MS = 7 * 86_400_000;
const MIN_PASSWORD = 8;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

export type Session = { token: string; expires_at: string; member: MemberView };
export type MemberView = { id: string; email: string; name: string | null; role: Role };

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

  constructor(private readonly control: ControlPlane) {}

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

  async login(email: unknown, password: unknown): Promise<Session> {
    if (typeof email !== "string" || typeof password !== "string") throw new HttpError(400, "email and password are required");
    const key = email.trim().toLowerCase();
    if (this.throttled(key)) throw new HttpError(429, "too many failed sign-ins; try again in a few minutes", { "retry-after": "900" });
    const m = (await this.pool.query(`SELECT id, org_id, email, name, role, password_hash FROM members WHERE lower(email) = $1`, [key])).rows[0];
    const ok = await verifyPassword(password, m?.password_hash ?? null);
    if (!m || !ok) {
      this.fails.set(key, [...(this.fails.get(key) ?? []), Date.now()]);
      throw new HttpError(401, "invalid email or password");
    }
    this.fails.delete(key);
    await this.control.audit(`member:${m.id}`, m.org_id, "member.login", m.id);
    return this.session(m);
  }

  async logout(p: Principal): Promise<void> {
    if (p.memberId) await this.pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1`, [p.tokenId]);
  }

  async me(p: Principal): Promise<MemberView | null> {
    if (!p.memberId) return null;
    const r = await this.pool.query(`SELECT id, email, name, role FROM members WHERE id = $1`, [p.memberId]);
    return r.rows[0] ? view(r.rows[0]) : null;
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
    const members = (await this.pool.query(`SELECT id, email, name, role, created_at FROM members WHERE org_id = $1 ORDER BY created_at`, [p.orgId])).rows;
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
  async resetPassword(p: Principal, id: string, next: unknown) {
    ControlPlane.require(p, "owner");
    const pw = checkPassword(next);
    await this.target(p, id);
    await this.pool.query(`UPDATE members SET password_hash = $1 WHERE id = $2`, [await hashPassword(pw), id]);
    await this.pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [id]);
    await this.control.audit(p.memberId ? `member:${p.memberId}` : p.tokenId, p.orgId, "member.password_reset", id);
  }
}
