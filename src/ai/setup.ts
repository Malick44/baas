import pg from "pg";
import { dbNameOf, urlFor } from "../provision.js";

/**
 * The AI assistant reads through a dedicated role that can SELECT from the public schema and nothing else:
 * no auth.users (password hashes), no refresh tokens, no storage or realtime internals. It bypasses row-level
 * security like the SQL editor does, because it serves the project's own administrators.
 * The role is a cluster-wide name but its privileges are granted per project database, and only projects that opt in
 * are made members of it.
 */
const withAdmin = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
};

export async function enableAiReader(adminUrl: string, ref: string): Promise<void> {
  await withAdmin(urlFor(adminUrl, dbNameOf(ref)), async (c) => {
    await c.query(`DO $$ BEGIN CREATE ROLE baas_ai_reader NOLOGIN NOINHERIT BYPASSRLS;
                   EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
    await c.query(`GRANT USAGE ON SCHEMA public TO baas_ai_reader`);
    await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO baas_ai_reader`);
    // Tables created later from the SQL editor or dashboard (owned by service_role) are readable too.
    await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE service_role IN SCHEMA public GRANT SELECT ON TABLES TO baas_ai_reader`);
    await c.query(`GRANT baas_ai_reader TO "authenticator_${ref}"`);
  });
}

export async function disableAiReader(adminUrl: string, ref: string): Promise<void> {
  await withAdmin(urlFor(adminUrl, dbNameOf(ref)), async (c) => {
    await c.query(`REVOKE baas_ai_reader FROM "authenticator_${ref}"`).catch(() => {});
  });
}
