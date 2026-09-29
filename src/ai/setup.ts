import pg from "pg";
import { dbNameOf, urlFor } from "../provision.js";

/**
 * Database-level access for the AI assistant. Two independent pieces:
 *
 * 1. IDENTITY LOCK (whenever the assistant is on). Row-level security learns who is asking from the setting
 *    request.jwt.claims, and any role may change a setting with set_config(). The assistant runs SQL written by a model, so
 *    without a lock that SQL could say "I am someone else" (or `set_config('role', ...)`) and escape the identity it was
 *    given. The lock removes EXECUTE on set_config from PUBLIC (so anon and authenticated lose it) and keeps it for the
 *    project's login role, which sets the claims before switching role, and for service_role.
 *
 * 2. THE BYPASS READER (only if the project owner allows it). A role that can SELECT from public and ignores row-level
 *    security, for questions about "everyone's" data. It never sees auth, storage or realtime tables. Its membership is
 *    granted to the project's login role only while bypass is allowed, so it is unreachable otherwise.
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

const SET_CONFIG = "pg_catalog.set_config(text, text, boolean)";

export type AiAccessState = { lockedDown: boolean; readerMember: boolean };

/** Bring the database to the state the settings ask for. Idempotent; safe to call before every question. */
export async function syncAiAccess(adminUrl: string, ref: string, opts: { bypass: boolean }): Promise<void> {
  await withAdmin(urlFor(adminUrl, dbNameOf(ref)), async (c) => {
    await c.query(`REVOKE EXECUTE ON FUNCTION ${SET_CONFIG} FROM PUBLIC`);
    await c.query(`GRANT EXECUTE ON FUNCTION ${SET_CONFIG} TO service_role, "authenticator_${ref}"`);
    if (opts.bypass) {
      await c.query(`DO $$ BEGIN CREATE ROLE baas_ai_reader NOLOGIN NOINHERIT BYPASSRLS;
                     EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
      await c.query(`GRANT USAGE ON SCHEMA public TO baas_ai_reader`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO baas_ai_reader`);
      // Tables created later from the SQL editor or dashboard (owned by service_role) are readable too.
      await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE service_role IN SCHEMA public GRANT SELECT ON TABLES TO baas_ai_reader`);
      await c.query(`GRANT baas_ai_reader TO "authenticator_${ref}"`);
    } else {
      await c.query(`DO $$ BEGIN IF to_regrole('baas_ai_reader') IS NOT NULL THEN REVOKE baas_ai_reader FROM "authenticator_${ref}"; END IF; END $$`);
    }
  });
}

/** Undo everything when the assistant is switched off: no reader membership, and set_config as it was. */
export async function removeAiAccess(adminUrl: string, ref: string): Promise<void> {
  await withAdmin(urlFor(adminUrl, dbNameOf(ref)), async (c) => {
    await c.query(`DO $$ BEGIN IF to_regrole('baas_ai_reader') IS NOT NULL THEN REVOKE baas_ai_reader FROM "authenticator_${ref}"; END IF; END $$`);
    await c.query(`GRANT EXECUTE ON FUNCTION ${SET_CONFIG} TO PUBLIC`);
  });
}

/** What the database actually allows right now (not what we believe we set). */
export async function inspectAiAccess(adminUrl: string, ref: string): Promise<AiAccessState> {
  return withAdmin(urlFor(adminUrl, dbNameOf(ref)), async (c) => {
    const r = await c.query<{ locked: boolean; member: boolean }>(
      `SELECT NOT (has_function_privilege('anon', '${SET_CONFIG}', 'EXECUTE') OR has_function_privilege('authenticated', '${SET_CONFIG}', 'EXECUTE')) AS locked,
              coalesce(to_regrole('baas_ai_reader') IS NOT NULL AND pg_has_role($1, 'baas_ai_reader', 'MEMBER'), false) AS member`,
      [`authenticator_${ref}`],
    );
    return { lockedDown: r.rows[0]!.locked, readerMember: r.rows[0]!.member };
  });
}
