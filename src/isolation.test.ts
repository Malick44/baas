import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { verifyJwt } from "./keys.js";
import { dropProject, provisionProject, urlFor, type Project } from "./provision.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  url: string,
  sql: string,
  role?: string,
): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  try {
    if (role) await c.query(`SET ROLE ${role}`);
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

describe("multi-project isolation", { skip: !ADMIN && "set BAAS_TEST_PG_URL to a superuser Postgres URL" }, () => {
  let a: Project;
  let b: Project;
  const url = (p: Project, as: "admin" | "auth" = "auth") =>
    as === "admin" ? urlFor(ADMIN!, p.dbName) : urlFor(ADMIN!, p.dbName, p.authenticator);

  before(async () => {
    [a, b] = await Promise.all([provisionProject(ADMIN!), provisionProject(ADMIN!)]);
    for (const p of [a, b]) {
      await query(
        url(p, "admin"),
        `CREATE TABLE public.notes (id serial PRIMARY KEY, owner uuid, body text);
         ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
         CREATE POLICY own ON public.notes FOR SELECT TO authenticated USING (owner = auth.uid());
         GRANT SELECT ON public.notes TO anon;
         INSERT INTO public.notes (owner, body) VALUES ('11111111-1111-1111-1111-111111111111', 'secret of ${p.ref}')`,
      );
    }
  });

  after(async () => {
    await Promise.all([a && dropProject(ADMIN!, a.ref), b && dropProject(ADMIN!, b.ref)]);
  });

  it("gives each project distinct refs, secrets, and keys", () => {
    assert.notEqual(a.ref, b.ref);
    assert.notEqual(a.jwtSecret, b.jwtSecret);
    assert.notEqual(a.anonKey, b.anonKey);
  });

  it("accepts a project's key only under that project's secret", () => {
    assert.equal(verifyJwt(a.anonKey, a.jwtSecret)?.role, "anon");
    assert.equal(verifyJwt(a.serviceKey, a.jwtSecret)?.role, "service_role");
    assert.equal(verifyJwt(a.anonKey, b.jwtSecret), null);
    assert.equal(verifyJwt(b.serviceKey, a.jwtSecret), null);
  });

  it("lets a project's login role connect to its own database", async () => {
    const rows = await query<{ db: string }>(url(a), `SELECT current_database() AS db`);
    assert.equal(rows[0]?.db, a.dbName);
  });

  it("refuses a project's login role on another project's database", async () => {
    await assert.rejects(query(urlFor(ADMIN!, b.dbName, a.authenticator), `SELECT 1`), /permission denied/);
    await assert.rejects(query(urlFor(ADMIN!, a.dbName, b.authenticator), `SELECT 1`), /permission denied/);
  });

  it("enforces RLS for anon and authenticated, and bypasses it for service_role", async () => {
    // authenticated with no matching uid sees nothing; anon has no policy so sees nothing.
    assert.equal((await query(url(a), `SELECT * FROM public.notes`, "authenticated")).length, 0);
    assert.equal((await query(url(a), `SELECT * FROM public.notes`, "anon")).length, 0);
    const rows = await query<{ body: string }>(url(a), `SELECT body FROM public.notes`, "service_role");
    assert.deepEqual(rows.map((r) => r.body), [`secret of ${a.ref}`]);
  });

  it("does not let one project's login role reach the other's roles' data via pg_database or SET ROLE", async () => {
    // Even holding service_role (BYPASSRLS), the role has no CONNECT to project B.
    await assert.rejects(
      query(urlFor(ADMIN!, b.dbName, a.authenticator), `SELECT * FROM public.notes`, "service_role"),
      /permission denied/,
    );
  });

  it("drops a project cleanly", async () => {
    const c = await provisionProject(ADMIN!);
    await dropProject(ADMIN!, c.ref);
    const rows = await query(ADMIN!, `SELECT 1 FROM pg_database WHERE datname = '${c.dbName}'`);
    assert.equal(rows.length, 0);
    const roles = await query(ADMIN!, `SELECT 1 FROM pg_roles WHERE rolname = 'authenticator_${c.ref}'`);
    assert.equal(roles.length, 0);
  });

  it("rolls back a failed provision and leaves no orphans", async () => {
    // Pre-create the database so CREATE DATABASE fails after the role was made.
    const ref = "z".repeat(20);
    await query(ADMIN!, `CREATE DATABASE "proj_${ref}"`);
    await assert.rejects(provisionProject(ADMIN!, ref));
    const roles = await query(ADMIN!, `SELECT 1 FROM pg_roles WHERE rolname = 'authenticator_${ref}'`);
    assert.equal(roles.length, 0);
    await query(ADMIN!, `DROP DATABASE IF EXISTS "proj_${ref}"`);
  });
});
