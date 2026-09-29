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
