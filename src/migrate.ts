import { readdir, readFile } from "node:fs/promises";
import { guard } from "./pgguard.js";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Apply pending migrations in filename order, each in its own transaction. Returns the names applied. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const c = await pool.connect();
  const unguard = guard(c);
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock(727001)"); // one migrator at a time
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const name of (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      const sql = await readFile(DIR + name, "utf8");
      try {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${(err as Error).message}`);
      }
      applied.push(name);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    unguard();
    c.release();
  }
  return applied;
}
