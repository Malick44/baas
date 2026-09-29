import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { dbNameOf, dropProject, newRef, provisionProject, setProjectAccess, type Project } from "./provision.js";
import type { Vault } from "./vault.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Role = "developer" | "admin" | "owner";
const RANK: Record<Role, number> = { developer: 1, admin: 2, owner: 3 };

export type Principal = { tokenId: string; orgId: string; role: Role };

export type ProjectRow = {
  ref: string;
  org_id: string;
  name: string;
  status: "provisioning" | "active" | "paused" | "failed" | "deleted" | "purged";
  db_name: string;
  plan: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type ProjectSecrets = { jwtSecret: string; serviceKey: string; anonKey: string; dbPassword: string };

const SETTINGS_KEYS = {
  site_url: (v: unknown) => typeof v === "string" && /^https?:\/\//.test(v),
  redirect_urls: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  cors_origins: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  jwt_expiry: (v: unknown) => Number.isInteger(v) && (v as number) >= 60 && (v as number) <= 604800,
  disable_signup: (v: unknown) => typeof v === "boolean",
  function_env: (v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, x]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && typeof x === "string" && x.length <= 4096),
} as const;

export type Resolved = {
  ref: string;
  status: ProjectRow["status"];
  plan: string;
  orgId: string;
  dbName: string;
  settings: Record<string, unknown>;
  /** Present only while the project is active. */
  secrets?: ProjectSecrets;
};

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export class ControlPlane {
  constructor(
    readonly pool: pg.Pool,
    readonly adminUrl: string,
    private readonly vault: Vault,
    /** Injectable so tests can simulate a failing provision. */
    private readonly provision: (adminUrl: string, ref: string) => Promise<Project> = provisionProject,
  ) {}

  static require(p: Principal, min: Role): void {
    if (RANK[p.role] < RANK[min]) throw new HttpError(403, `requires ${min} role`);
  }

  private async audit(actor: string, orgId: string | null, action: string, target: string | null, meta: object = {}) {
    await this.pool.query(`INSERT INTO audit_log (org_id, actor, action, target, meta) VALUES ($1, $2, $3, $4, $5)`, [
      orgId, actor, action, target, meta,
    ]);
  }

  // ---- organizations and tokens ----

  async createOrg(name: string, slug: string): Promise<{ org: { id: string; name: string; slug: string }; ownerToken: string }> {
    let org;
    try {
      org = (await this.pool.query(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug`, [name, slug])).rows[0];
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") throw new HttpError(409, "organization slug already taken");
      if (code === "23514") throw new HttpError(400, "slug must be 2-40 chars of a-z, 0-9, -");
      throw err;
    }
    const ownerToken = await this.mintToken(org.id, "initial owner", "owner");
    await this.audit("bootstrap", org.id, "org.create", org.id, { slug });
    return { org, ownerToken };
  }

  private async mintToken(orgId: string, name: string, role: Role): Promise<string> {
    const token = `baas_${randomBytes(32).toString("base64url")}`;
    await this.pool.query(`INSERT INTO api_tokens (org_id, name, role, token_hash) VALUES ($1, $2, $3, $4)`, [orgId, name, role, hashToken(token)]);
    return token;
  }

  async createToken(p: Principal, name: string, role: Role): Promise<string> {
    ControlPlane.require(p, "owner");
    const token = await this.mintToken(p.orgId, name, role);
    await this.audit(p.tokenId, p.orgId, "token.create", null, { name, role });
    return token;
  }

  async revokeToken(p: Principal, tokenId: string): Promise<void> {
    ControlPlane.require(p, "owner");
    const r = await this.pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`, [tokenId, p.orgId]);
    if (!r.rowCount) throw new HttpError(404, "token not found");
    await this.audit(p.tokenId, p.orgId, "token.revoke", tokenId);
  }

  async authenticate(token: string): Promise<Principal | null> {
    const r = await this.pool.query<{ id: string; org_id: string; role: Role }>(
      `SELECT id, org_id, role FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    return row ? { tokenId: row.id, orgId: row.org_id, role: row.role } : null;
  }

  // ---- projects ----

  async createProject(p: Principal, name: string): Promise<ProjectRow> {
    ControlPlane.require(p, "admin");
    const ref = newRef();
    try {
      await this.pool.query(`INSERT INTO projects (ref, org_id, name, status, db_name) VALUES ($1, $2, $3, 'provisioning', $4)`, [ref, p.orgId, name, dbNameOf(ref)]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "a project with that name already exists");
      throw err;
    }
    let project: Project;
    try {
      project = await this.provision(this.adminUrl, ref);
    } catch (err) {
      await this.setStatus(ref, ["provisioning"], "failed");
      await this.audit(p.tokenId, p.orgId, "project.create_failed", ref, { error: (err as Error).message });
      throw new HttpError(500, "provisioning failed");
    }
    try {
      await this.pool.query(
        `INSERT INTO project_secrets (ref, jwt_secret_enc, service_key_enc, db_password_enc, anon_key) VALUES ($1, $2, $3, $4, $5)`,
        [ref, this.vault.seal(project.jwtSecret, ref), this.vault.seal(project.serviceKey, ref), this.vault.seal(project.authenticator.password, ref), project.anonKey],
      );
      await this.pool.query(`INSERT INTO project_settings (ref) VALUES ($1)`, [ref]);
    } catch (err) {
      // Never leave a database whose secrets we did not keep.
      await dropProject(this.adminUrl, ref).catch(() => {});
      await this.setStatus(ref, ["provisioning"], "failed");
      throw err;
    }
    const row = await this.setStatus(ref, ["provisioning"], "active");
    await this.audit(p.tokenId, p.orgId, "project.create", ref, { name });
    return row!;
  }

  private async setStatus(ref: string, from: ProjectRow["status"][], to: ProjectRow["status"]): Promise<ProjectRow | null> {
    const r = await this.pool.query<ProjectRow>(
      `UPDATE projects SET status = $3, updated_at = now(), deleted_at = CASE WHEN $3 = 'deleted' THEN now() ELSE deleted_at END
       WHERE ref = $1 AND status = ANY($2) RETURNING *`,
      [ref, from, to],
    );
    return r.rows[0] ?? null;
  }

  /** Scoped to the caller's organisation; another org's project is indistinguishable from a missing one. */
  async getProject(p: Principal, ref: string): Promise<ProjectRow> {
    const r = await this.pool.query<ProjectRow>(`SELECT * FROM projects WHERE ref = $1 AND org_id = $2 AND status <> 'purged'`, [ref, p.orgId]);
    if (!r.rows[0]) throw new HttpError(404, "project not found");
    return r.rows[0];
  }

  async listProjects(p: Principal): Promise<ProjectRow[]> {
    return (await this.pool.query<ProjectRow>(`SELECT * FROM projects WHERE org_id = $1 AND status NOT IN ('deleted', 'purged') ORDER BY created_at`, [p.orgId])).rows;
  }

  private async transition(p: Principal, ref: string, min: Role, from: ProjectRow["status"][], to: ProjectRow["status"], access: boolean, action: string) {
    ControlPlane.require(p, min);
    const current = await this.getProject(p, ref);
    const row = await this.setStatus(ref, from, to);
    if (!row) throw new HttpError(409, `cannot ${action} a project that is ${current.status}`);
    try {
      await setProjectAccess(this.adminUrl, ref, access);
    } catch (err) {
      // Keep the recorded state truthful about what the database allows.
      await this.pool.query(`UPDATE projects SET status = $2, updated_at = now(), deleted_at = NULL WHERE ref = $1`, [ref, current.status]);
      throw err;
    }
    await this.audit(p.tokenId, p.orgId, `project.${action}`, ref);
    return row;
  }

  pauseProject = (p: Principal, ref: string) => this.transition(p, ref, "admin", ["active"], "paused", false, "pause");
  resumeProject = (p: Principal, ref: string) => this.transition(p, ref, "admin", ["paused"], "active", true, "resume");
  /** Soft delete: the database stays, unreachable, until purged. */
  deleteProject = (p: Principal, ref: string) => this.transition(p, ref, "owner", ["active", "paused", "failed"], "deleted", false, "delete");

  async apiKeys(p: Principal, ref: string): Promise<{ anon: string; service_role?: string }> {
    await this.getProject(p, ref);
    const s = (await this.pool.query(`SELECT * FROM project_secrets WHERE ref = $1`, [ref])).rows[0];
    if (!s) throw new HttpError(409, "project has no keys yet");
    const keys: { anon: string; service_role?: string } = { anon: s.anon_key };
    if (p.role !== "developer") keys.service_role = this.vault.open(s.service_key_enc, ref);
    return keys;
  }

  async getSettings(p: Principal, ref: string): Promise<Record<string, unknown>> {
    await this.getProject(p, ref);
    return (await this.pool.query(`SELECT settings FROM project_settings WHERE ref = $1`, [ref])).rows[0]?.settings ?? {};
  }

  async updateSettings(p: Principal, ref: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    ControlPlane.require(p, "admin");
    await this.getProject(p, ref);
    for (const [k, v] of Object.entries(patch)) {
      const ok = (SETTINGS_KEYS as Record<string, (v: unknown) => boolean>)[k];
      if (!ok) throw new HttpError(400, `unknown setting: ${k}`);
      if (!ok(v)) throw new HttpError(400, `invalid value for ${k}`);
    }
    const r = await this.pool.query(`UPDATE project_settings SET settings = settings || $2::jsonb WHERE ref = $1 RETURNING settings`, [ref, JSON.stringify(patch)]);
    await this.audit(p.tokenId, p.orgId, "project.settings", ref, { keys: Object.keys(patch) });
    return r.rows[0].settings;
  }

  async auditLog(p: Principal, limit = 50) {
    ControlPlane.require(p, "admin");
    return (await this.pool.query(`SELECT id, actor, action, target, meta, at FROM audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT $2`, [p.orgId, Math.min(limit, 200)])).rows;
  }

  // ---- internal (gateway and background jobs; never exposed through the API) ----

  /** One lookup for the data plane: status, plan, settings and (if active) decrypted secrets. Null if unknown. */
  async resolve(ref: string): Promise<Resolved | null> {
    if (!/^[a-z0-9]{20}$/.test(ref)) return null;
    const r = await this.pool.query(
      `SELECT p.status, p.plan, p.db_name, p.org_id, s.jwt_secret_enc, s.service_key_enc, s.db_password_enc, s.anon_key,
              coalesce(ps.settings, '{}'::jsonb) AS settings
       FROM projects p LEFT JOIN project_secrets s ON s.ref = p.ref LEFT JOIN project_settings ps ON ps.ref = p.ref
       WHERE p.ref = $1`,
      [ref],
    );
    const row = r.rows[0];
    if (!row) return null;
    const out: Resolved = { ref, status: row.status, plan: row.plan, orgId: row.org_id, dbName: row.db_name, settings: row.settings };
    if (row.status === "active" && row.jwt_secret_enc) {
      out.secrets = {
        jwtSecret: this.vault.open(row.jwt_secret_enc, ref),
        serviceKey: this.vault.open(row.service_key_enc, ref),
        dbPassword: this.vault.open(row.db_password_enc, ref),
        anonKey: row.anon_key,
      };
    }
    return out;
  }

  /** Decrypted secrets for a live project. The gateway (Phase 2) uses this to verify keys and reach the database. */
  async secretsFor(ref: string): Promise<ProjectSecrets | null> {
    const r = await this.pool.query(
      `SELECT s.* FROM project_secrets s JOIN projects p USING (ref) WHERE ref = $1 AND p.status = 'active'`,
      [ref],
    );
    const s = r.rows[0];
    if (!s) return null;
    return {
      jwtSecret: this.vault.open(s.jwt_secret_enc, ref),
      serviceKey: this.vault.open(s.service_key_enc, ref),
      dbPassword: this.vault.open(s.db_password_enc, ref),
      anonKey: s.anon_key,
    };
  }

  /** Permanently drop the databases of projects deleted longer than `retentionMs` ago. Returns the refs purged. */
  async purgeDeleted(retentionMs: number): Promise<string[]> {
    const due = (await this.pool.query<{ ref: string }>(
      `SELECT ref FROM projects WHERE status = 'deleted' AND deleted_at <= now() - ($1 || ' milliseconds')::interval`,
      [retentionMs],
    )).rows;
    const purged: string[] = [];
    for (const { ref } of due) {
      await dropProject(this.adminUrl, ref);
      await this.pool.query(`DELETE FROM project_secrets WHERE ref = $1`, [ref]);
      if (await this.setStatus(ref, ["deleted"], "purged")) {
        await this.audit("system", null, "project.purge", ref);
        purged.push(ref);
      }
    }
    return purged;
  }

  /** Clean up after a crash mid-provision: stuck rows become failed and any leftover database or role is dropped. */
  async reconcile(stuckForMs = 10 * 60_000): Promise<string[]> {
    const stuck = (await this.pool.query<{ ref: string }>(
      `SELECT ref FROM projects WHERE status = 'provisioning' AND updated_at <= now() - ($1 || ' milliseconds')::interval`,
      [stuckForMs],
    )).rows;
    for (const { ref } of stuck) {
      await dropProject(this.adminUrl, ref);
      await this.setStatus(ref, ["provisioning"], "failed");
      await this.audit("system", null, "project.reconcile", ref);
    }
    return stuck.map((r) => r.ref);
  }
}
