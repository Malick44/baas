import type pg from "pg";
import { HttpError } from "./control.js";
import type { PoolManager } from "./pools.js";

export type SqlResult = { command: string; rowCount: number | null; fields: string[]; rows: unknown[][]; truncated: boolean };

const MAX_ROWS = 1000;
const MAX_QUERY = 100 * 1024;

/**
 * Dashboard/CLI access to a project's database as service_role: run SQL, and describe tables.
 * The caller must already have been authorised (admin role on the owning organisation).
 */
export class ProjectAdmin {
  constructor(private pm: PoolManager) {}

  async run(ref: string, query: string): Promise<SqlResult[]> {
    if (typeof query !== "string" || !query.trim()) throw new HttpError(400, "query is required");
    if (query.length > MAX_QUERY) throw new HttpError(400, "query is too long");
    try {
      const results = await this.pm.withRole(ref, { role: "service_role", claims: { role: "service_role" }, timeoutMs: 60_000 }, async (c) => {
        // Rows come back as arrays so duplicate column names survive.
        const r = (await c.query({ text: query, rowMode: "array" })) as unknown as pg.QueryArrayResult | pg.QueryArrayResult[];
        return Array.isArray(r) ? r : [r];
      });
      return results.map((r) => ({
        command: r.command,
        rowCount: r.rowCount,
        fields: r.fields.map((f) => f.name),
        rows: r.rows.slice(0, MAX_ROWS) as unknown[][],
        truncated: r.rows.length > MAX_ROWS,
      }));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const e = err as { code?: string; message?: string; position?: string };
      if (e.code === "57014") throw new HttpError(408, "query cancelled: it ran too long");
      if (e.code && /^[0-9A-Z]{5}$/.test(e.code)) throw new HttpError(400, `${e.message ?? "SQL error"}${e.position ? ` (at position ${e.position})` : ""}`);
      throw err;
    }
  }

  /**
   * Show what an identity can see in one table, so a row-level security policy can be checked before anyone relies on it.
   * Read-only; the identity's own role and claims are used, exactly as an API request would.
   */
  async testAccess(ref: string, table: unknown, as: unknown) {
    if (typeof table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) throw new HttpError(400, "table must be the name of a table in the public schema");
    const a = (as ?? { type: "anon" }) as { type?: unknown; userId?: unknown };
    if (typeof a !== "object" || (a.type !== "anon" && a.type !== "user")) throw new HttpError(400, 'as must be {"type":"anon"} or {"type":"user","userId":…}');
    const service = { role: "service_role" as const, claims: { role: "service_role" }, readOnly: true, timeoutMs: 10_000 };
    const meta = await this.pm.withRole(ref, service, async (c) => {
      const r = await c.query(
        `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'p')`, [table]);
      if (!r.rows[0]) return null;
      const total = Number((await c.query(`SELECT count(*)::int AS n FROM "public"."${table}"`)).rows[0].n);
      return { rls: r.rows[0].rls as boolean, policies: r.rows[0].policies as number, total };
    });
    if (!meta) throw new HttpError(404, `no table named ${table} in the public schema`);

    let identity: { role: "anon" | "authenticated"; claims: Record<string, unknown>; label: string };
    if (a.type === "anon") identity = { role: "anon", claims: { role: "anon" }, label: "an anonymous visitor" };
    else {
      if (typeof a.userId !== "string" || !/^[0-9a-f-]{36}$/.test(a.userId)) throw new HttpError(400, "userId is required");
      const u = await this.pm.withRole(ref, service, async (c) => (await c.query(`SELECT id, email FROM auth.users WHERE id = $1`, [a.userId])).rows[0]);
      if (!u) throw new HttpError(404, "no such user");
      identity = { role: "authenticated", claims: { role: "authenticated", aud: "authenticated", sub: u.id, email: u.email }, label: `the signed-in user ${u.email ?? u.id}` };
    }
    try {
      const seen = await this.pm.withRole(ref, { role: identity.role, claims: identity.claims, readOnly: true, timeoutMs: 10_000 }, async (c) => {
        const visible = Number((await c.query(`SELECT count(*)::int AS n FROM "public"."${table}"`)).rows[0].n);
        const sample = (await c.query(`SELECT to_jsonb(t) AS row FROM "public"."${table}" t LIMIT 5`)).rows.map((r) => r.row as Record<string, unknown>);
        return { visible, sample };
      });
      return { table, identity: identity.label, role: identity.role, allowed: true, rls: meta.rls, policies: meta.policies, total: meta.total, visible: seen.visible, sample: seen.sample };
    } catch (err) {
      if ((err as { code?: string }).code === "42501")
        return { table, identity: identity.label, role: identity.role, allowed: false, rls: meta.rls, policies: meta.policies, total: meta.total, visible: 0, sample: [], reason: `the ${identity.role} role has no access to this table: grant it SELECT first` };
      throw err;
    }
  }

  async tables(ref: string) {
    const [r] = await this.run(
      ref,
      `SELECT c.relname AS name, c.relrowsecurity AS rls, greatest(c.reltuples, 0)::bigint AS rows_estimate,
         (SELECT count(*)::int FROM pg_policy pol WHERE pol.polrelid = c.oid) AS policies,
         (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull,
                  'default', pg_get_expr(d.adbin, d.adrelid),
                  'pk', a.attnum = ANY (coalesce((SELECT i.indkey::int2[] FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary), '{}'::int2[]))) ORDER BY a.attnum)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
    );
    return r!.rows.map((row) => ({ name: row[0], rls: row[1], rows_estimate: Number(row[2]), policies: row[3], columns: row[4] ?? [] }));
  }
}
