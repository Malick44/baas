import pg from "pg";
import { ControlPlane, HttpError, type Principal } from "./control.js";
import type { PoolManager } from "./pools.js";
import { urlFor } from "./provision.js";

/**
 * Install and remove Postgres extensions for a project. The platform connects as the server's superuser to do it, so only
 * extensions Postgres itself marks as safe for database owners ("trusted") or that need no superuser are allowed.
 */
const PROTECTED = new Set(["plpgsql", "pgcrypto"]); // the platform's own schema depends on these

export class ExtensionService {
  constructor(private control: ControlPlane, private pm: PoolManager) {}

  private async withAdmin<T>(ref: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const project = await this.pm.active(ref);
    const c = new pg.Client({ connectionString: urlFor(project.adminUrl, project.dbName) });
    c.on("error", () => {});
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }

  private async catalog(c: pg.Client) {
    const r = await c.query(
      `SELECT a.name, a.default_version AS version, a.installed_version, a.comment, n.nspname AS schema,
              (coalesce(v.trusted, false) OR NOT coalesce(v.superuser, true)) AS installable, coalesce(v.requires, '{}')::text[] AS requires
       FROM pg_available_extensions a
       LEFT JOIN pg_available_extension_versions v ON v.name = a.name AND v.version = a.default_version
       LEFT JOIN pg_extension e ON e.extname = a.name LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
       ORDER BY a.name`,
    );
    return r.rows as { name: string; version: string; installed_version: string | null; comment: string | null; schema: string | null; installable: boolean; requires: string[] }[];
  }

  async list(p: Principal, ref: string) {
    ControlPlane.require(p, "admin");
    await this.control.getProject(p, ref);
    const rows = await this.withAdmin(ref, (c) => this.catalog(c));
    return rows.map((r) => ({ ...r, installed: r.installed_version !== null, protected: PROTECTED.has(r.name) }));
  }

  async set(p: Principal, ref: string, name: unknown, install: unknown) {
    ControlPlane.require(p, "admin");
    await this.control.getProject(p, ref);
    if (typeof name !== "string" || typeof install !== "boolean") throw new HttpError(400, "name and install (true or false) are required");
    await this.withAdmin(ref, async (c) => {
      const rows = await this.catalog(c);
      const ext = rows.find((r) => r.name === name);
      if (!ext) throw new HttpError(404, `extension ${JSON.stringify(name)} is not available on this server`);
      if (install) {
        if (ext.installed_version) return;
        if (!ext.installable) throw new HttpError(403, `${name} needs the server operator to install it`);
        for (const dep of ext.requires) {
          const d = rows.find((r) => r.name === dep);
          if (!d || (!d.installed_version && !d.installable)) throw new HttpError(403, `${name} needs ${dep}, which only the server operator can install`);
        }
        try {
          // The name comes from the server's own catalog above, never from the caller, so quoting it is enough.
          await c.query(`CREATE EXTENSION IF NOT EXISTS "${ext.name}" WITH SCHEMA extensions CASCADE`);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      } else {
        if (PROTECTED.has(name)) throw new HttpError(403, `${name} is used by the platform and cannot be removed`);
        if (!ext.installed_version) return;
        try {
          await c.query(`DROP EXTENSION "${name}"`);
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
      }
    });
    await this.control.audit(p.tokenId, p.orgId, install ? "extension.install" : "extension.remove", ref, { name });
    return (await this.list(p, ref)).find((r) => r.name === name);
  }
}
