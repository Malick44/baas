import { randomBytes } from "node:crypto";
import pg from "pg";
import { newSecret, projectKey } from "./keys.js";

const REF = /^[a-z0-9]{20}$/;

export type Project = {
  ref: string;
  dbName: string;
  jwtSecret: string;
  anonKey: string;
  serviceKey: string;
  /** Login role PostgREST connects as; can CONNECT to this project's database only. */
  authenticator: { user: string; password: string };
};

export const newRef = () => randomBytes(10).toString("hex");
export const dbNameOf = (ref: string) => `proj_${ref}`;
const authenticatorOf = (ref: string) => `authenticator_${ref}`;

function assertRef(ref: string): void {
  if (!REF.test(ref)) throw new Error(`invalid project ref: ${ref}`);
}

/** Connection string for `dbName` using the same server/credentials as `adminUrl`. */
export function urlFor(adminUrl: string, dbName: string, creds?: { user: string; password: string }): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  if (creds) {
    u.username = creds.user;
    u.password = creds.password;
  }
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Create an isolated project on a shared cluster: its own database, its own JWT
 * secret and keys, and its own login role that can only connect to that database.
 * Shared NOLOGIN roles (anon, authenticated, service_role) carry privileges per
 * database, so a grant in one project's database never applies in another.
 * On failure, everything created so far is removed.
 */
export async function provisionProject(adminUrl: string, ref?: string): Promise<Project> {
  ref ??= newRef();
  assertRef(ref);
  const dbName = dbNameOf(ref);
  const user = authenticatorOf(ref);
  const password = randomBytes(24).toString("hex");
  const jwtSecret = newSecret();

  try {
    await withClient(adminUrl, async (c) => {
      for (const [role, extra] of [["anon", ""], ["authenticated", ""], ["service_role", "BYPASSRLS"]] as const) {
        // Idempotent and safe under concurrent provisioning.
        await c.query(
          `DO $$ BEGIN
             CREATE ROLE ${role} NOLOGIN NOINHERIT ${extra};
           EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`,
        );
      }
      await c.query(`CREATE ROLE "${user}" LOGIN NOINHERIT PASSWORD '${password}'`);
      await c.query(`GRANT anon, authenticated, service_role TO "${user}"`);
      await c.query(`CREATE DATABASE "${dbName}"`);
      await c.query(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
      await c.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${user}"`);
    });

    await withClient(urlFor(adminUrl, dbName), async (c) => {
      await c.query(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS storage;
                     CREATE SCHEMA IF NOT EXISTS realtime; CREATE SCHEMA IF NOT EXISTS extensions`);
      await c.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions`);
      await c.query(`GRANT USAGE ON SCHEMA public, auth, storage, realtime, extensions
                     TO anon, authenticated, service_role`);
      await c.query(`GRANT ALL ON SCHEMA public TO service_role`);
      // Row-level-security helpers reading the claims PostgREST sets per request.
      await c.query(`
        CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
          $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') $$;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
          $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
        GRANT EXECUTE ON FUNCTION auth.role(), auth.uid() TO anon, authenticated, service_role`);
      await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
                     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role`);
    });
  } catch (err) {
    await dropProject(adminUrl, ref).catch(() => {});
    throw err;
  }

  return {
    ref,
    dbName,
    jwtSecret,
    anonKey: projectKey("anon", ref, jwtSecret),
    serviceKey: projectKey("service_role", ref, jwtSecret),
    authenticator: { user, password },
  };
}

/** Remove a project's database and login role. Safe to call for a partly created project. */
export async function dropProject(adminUrl: string, ref: string): Promise<void> {
  assertRef(ref);
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${dbNameOf(ref)}" WITH (FORCE)`);
    await c.query(`DROP ROLE IF EXISTS "${authenticatorOf(ref)}"`);
  });
}

/**
 * Cut off or restore a project's access to its database (pause/resume, soft delete).
 * Disabling also terminates the login role's open connections.
 */
export async function setProjectAccess(adminUrl: string, ref: string, enabled: boolean): Promise<void> {
  assertRef(ref);
  const user = authenticatorOf(ref);
  await withClient(adminUrl, async (c) => {
    await c.query(`ALTER ROLE "${user}" ${enabled ? "LOGIN" : "NOLOGIN"}`);
    if (!enabled) await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [user]);
  });
}
