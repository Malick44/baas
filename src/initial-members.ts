import type pg from "pg";
import { hashPassword } from "./authsvc.js";
import { guard } from "./pgguard.js";

type InitialMember = { email: string; password: string; name?: string };
export type InitialMembers = {
  organization: { name: string; slug: string };
  owner: InitialMember;
  admin: InitialMember;
};

/** Explicitly enabled by the operator. No shared passwords or fallback accounts. */
export function initialMembersFromEnv(env: NodeJS.ProcessEnv): InitialMembers | undefined {
  if (!env.BAAS_INITIAL_USERS_ENABLED || env.BAAS_INITIAL_USERS_ENABLED === "false") return undefined;
  if (env.BAAS_INITIAL_USERS_ENABLED !== "true") throw new Error("BAAS_INITIAL_USERS_ENABLED must be true or false");
  const need = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`${key} is required when initial users are enabled`);
    return value;
  };
  return {
    organization: { name: need("BAAS_INITIAL_ORGANIZATION_NAME"), slug: need("BAAS_INITIAL_ORGANIZATION_SLUG") },
    owner: { email: need("BAAS_INITIAL_OWNER_EMAIL"), password: need("BAAS_INITIAL_OWNER_PASSWORD"), name: env.BAAS_INITIAL_OWNER_NAME },
    admin: { email: need("BAAS_INITIAL_ADMIN_EMAIL"), password: need("BAAS_INITIAL_ADMIN_PASSWORD"), name: env.BAAS_INITIAL_ADMIN_NAME },
  };
}

function validate(cfg: InitialMembers) {
  if (!cfg.organization.name.trim() || cfg.organization.name.length > 80) throw new Error("initial organization name must be 1-80 characters");
  if (!/^[a-z0-9-]{2,40}$/.test(cfg.organization.slug)) throw new Error("initial organization slug must be 2-40 chars of a-z, 0-9, -");
  const emails = [cfg.owner, cfg.admin].map((m) => {
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/.test(m.email.trim())) throw new Error("initial users need valid email addresses");
    if (m.password.length < 16 || m.password.length > 200) throw new Error("initial passwords must be 16-200 characters; use npm run setup:users");
    return m.email.trim().toLowerCase();
  });
  if (emails[0] === emails[1]) throw new Error("initial owner and admin must have distinct email addresses");
  if (cfg.owner.password === cfg.admin.password) throw new Error("initial owner and admin must have distinct passwords");
}

/** Seed one organization and two restricted members atomically, only on an empty installation. */
export async function initializeMembers(pool: pg.Pool, cfg?: InitialMembers): Promise<"disabled" | "created" | "already_initialized" | "skipped_existing"> {
  if (!cfg) return "disabled";
  validate(cfg);
  const hashes = await Promise.all([hashPassword(cfg.owner.password), hashPassword(cfg.admin.password)]);
  const c = await pool.connect();
  const unguard = guard(c);
  try {
    await c.query("BEGIN");
    // Also serializes against ordinary organization creation, rather than just other seeders.
    await c.query("LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE");
    if ((await c.query("SELECT 1 FROM initial_members_bootstrap")).rowCount) {
      await c.query("COMMIT");
      return "already_initialized";
    }
    if ((await c.query("SELECT 1 FROM organizations LIMIT 1")).rowCount) {
      await c.query("INSERT INTO initial_members_bootstrap (outcome) VALUES ('skipped_existing')");
      await c.query("COMMIT");
      return "skipped_existing";
    }
    const org = (await c.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [cfg.organization.name.trim(), cfg.organization.slug])).rows[0];
    for (const [i, role] of (["owner", "admin"] as const).entries()) {
      const m = cfg[role];
      const member = (await c.query(
        `INSERT INTO members (org_id, email, name, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [org.id, m.email.trim().toLowerCase(), m.name?.trim().slice(0, 80) || null, hashes[i], role])).rows[0];
      await c.query("INSERT INTO audit_log (org_id, actor, action, target, meta) VALUES ($1, 'bootstrap', 'member.initialize', $2, $3)", [org.id, member.id, { role }]);
    }
    // No unrestricted owner API token is minted: both accounts must replace their temporary passwords first.
    await c.query("INSERT INTO audit_log (org_id, actor, action, target, meta) VALUES ($1, 'bootstrap', 'org.create', $2, $3)", [org.id, org.id, { slug: cfg.organization.slug, initial_members: true }]);
    await c.query("INSERT INTO initial_members_bootstrap (outcome) VALUES ('created')");
    await c.query("COMMIT");
    return "created";
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    unguard();
    c.release();
  }
}
