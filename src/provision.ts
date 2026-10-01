import { randomBytes } from "node:crypto";
import pg from "pg";
import { newSecret, projectKey } from "./keys.js";

const REF = /^[a-z0-9]{20}$/;
export const CONNECTION_LIMIT = 25;

/** Base schema every project starts with: roles' grants, auth, storage and realtime tables. Idempotent. */
/** One-time email tokens and linked sign-in providers. Also applied lazily to projects created before these existed. */
export const AUTH_EXTRAS_SQL = `
CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  token_type text NOT NULL CHECK (token_type IN ('confirmation', 'recovery', 'magiclink')),
  token_hash text NOT NULL UNIQUE,
  redirect_to text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS one_time_tokens_user ON auth.one_time_tokens (user_id, token_type);
CREATE TABLE IF NOT EXISTS auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  provider text NOT NULL,
  provider_id text NOT NULL,
  identity_data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  UNIQUE (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS identities_user ON auth.identities (user_id);
GRANT ALL ON auth.one_time_tokens, auth.identities TO service_role;
`;

export const PROJECT_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS realtime; CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA public, auth, storage, realtime, extensions TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO service_role;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.role(), auth.uid() TO anon, authenticated, service_role;

-- Secure by default: nothing created in "public" is reachable through the API until you GRANT access to
-- anon/authenticated and enable row-level security (the dashboard's "new table" does both for you).

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  encrypted_password text,
  email_confirmed_at timestamptz DEFAULT now(),
  raw_app_meta_data jsonb NOT NULL DEFAULT '{"provider":"email"}',
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}',
  banned_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  session_id uuid NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_session ON auth.refresh_tokens (session_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user ON auth.refresh_tokens (user_id);
GRANT ALL ON auth.users, auth.refresh_tokens TO service_role;
GRANT USAGE, SELECT ON SEQUENCE auth.refresh_tokens_id_seq TO service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,63}$'),
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES storage.buckets ON DELETE RESTRICT,
  name text NOT NULL,
  owner uuid,
  size bigint NOT NULL DEFAULT 0,
  mimetype text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);
-- Owned by service_role so project admins can write storage policies from the SQL editor.
ALTER TABLE storage.buckets OWNER TO service_role;
ALTER TABLE storage.objects OWNER TO service_role;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.buckets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS realtime.changes (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  schema_name text NOT NULL,
  table_name text NOT NULL,
  op text NOT NULL,
  pk jsonb
);
CREATE INDEX IF NOT EXISTS realtime_changes_at ON realtime.changes (at);
GRANT SELECT, DELETE ON realtime.changes TO service_role;
CREATE OR REPLACE FUNCTION realtime.broadcast_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, realtime AS $$
DECLARE r record; pkcols text[]; pkv jsonb; cid bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT array_agg(a.attname::text) INTO pkcols FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = TG_RELID AND i.indisprimary;
  SELECT jsonb_object_agg(k, to_jsonb(r) -> k) INTO pkv FROM unnest(pkcols) k;
  INSERT INTO realtime.changes (schema_name, table_name, op, pk) VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, pkv)
    RETURNING id INTO cid;
  PERFORM pg_notify('realtime_changes', cid::text);
  RETURN NULL;
END $$;
${AUTH_EXTRAS_SQL}`;

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
  c.on("error", () => {}); // a killed backend must not become an uncaught exception
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
      // Noisy-neighbour guards: bounded connections and server-side timeouts for every session of this project.
      await c.query(`ALTER ROLE "${user}" CONNECTION LIMIT ${CONNECTION_LIMIT}`);
      await c.query(`ALTER ROLE "${user}" SET statement_timeout = '15s'`);
      await c.query(`ALTER ROLE "${user}" SET idle_in_transaction_session_timeout = '15s'`);
      await c.query(`ALTER ROLE "${user}" SET lock_timeout = '5s'`);
      await c.query(`CREATE DATABASE "${dbName}"`);
      await c.query(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
      await c.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${user}"`);
      // Lets project admins create schemas in their own database (per-database privilege; no effect elsewhere).
      await c.query(`GRANT CREATE ON DATABASE "${dbName}" TO service_role`);
    });

    await withClient(urlFor(adminUrl, dbName), async (c) => {
      await c.query(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS storage;
                     CREATE SCHEMA IF NOT EXISTS realtime; CREATE SCHEMA IF NOT EXISTS extensions`);
      await c.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions`);
      await c.query(PROJECT_SCHEMA_SQL);
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
