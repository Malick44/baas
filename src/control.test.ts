import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { buildApi } from "./api.js";
import { ControlPlane } from "./control.js";
import { verifyJwt } from "./keys.js";
import { migrate } from "./migrate.js";
import { urlFor, type Project } from "./provision.js";
import { Vault } from "./vault.js";

const ADMIN = process.env.BAAS_TEST_PG_URL;
const BOOT = "bootstrap-token-for-tests-1234567890";

describe("control plane", { skip: !ADMIN && "set BAAS_TEST_PG_URL to a superuser Postgres URL" }, () => {
  const ctlDb = `baas_ctl_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let control: ControlPlane;
  let failNext = false;
  let app: ReturnType<typeof buildApi>;
  const created: string[] = [];

  const call = async (method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      payload: opts.body as object | undefined,
    });
    return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as any) : null };
  };

  const newOrg = async (slug: string) => {
    const r = await call("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: slug, slug } });
    assert.equal(r.status, 201);
    return r.json.owner_token as string;
  };
  const tokenFor = async (owner: string, role: string) =>
    (await call("POST", "/v1/tokens", { token: owner, body: { name: role, role } })).json.token as string;
  const newProject = async (token: string, name: string) => {
    const r = await call("POST", "/v1/projects", { token, body: { name } });
    if (r.json?.ref) created.push(r.json.ref);
    return r;
  };
  const dbExists = async (name: string) => (await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rowCount === 1;

  before(async () => {
    admin = new pg.Pool({ connectionString: ADMIN });
    admin.on("error", () => {});
    await admin.query(`CREATE DATABASE "${ctlDb}"`);
    pool = new pg.Pool({ connectionString: urlFor(ADMIN!, ctlDb) });
    pool.on("error", () => {});
    assert.ok((await migrate(pool)).includes("001_init.sql"));
    const { provisionProject } = await import("./provision.js");
    const flaky = async (url: string, ref: string): Promise<Project> => {
      if (failNext) {
        failNext = false;
        throw new Error("boom");
      }
      return provisionProject(url, ref);
    };
    control = new ControlPlane(pool, ADMIN!, new Vault("ab".repeat(32)), flaky);
    app = buildApi(control, BOOT);
  });

  after(async () => {
    const { dropProject } = await import("./provision.js");
    for (const ref of created) await dropProject(ADMIN!, ref).catch(() => {});
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${ctlDb}" WITH (FORCE)`);
    await admin?.end();
  });

  it("is idempotent to migrate twice", async () => {
    assert.deepEqual(await migrate(pool), []);
  });

  it("creates organisations only with the bootstrap token", async () => {
    assert.equal((await call("POST", "/v1/organizations", { body: { name: "x", slug: "xx" } })).status, 401);
    assert.equal((await call("POST", "/v1/organizations", { headers: { "x-bootstrap-token": "wrong" }, body: { name: "x", slug: "xx" } })).status, 401);
    await newOrg("acme");
    const dup = await call("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "x", slug: "acme" } });
    assert.equal(dup.status, 409);
    const bad = await call("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: "x", slug: "Bad Slug!" } });
    assert.equal(bad.status, 400);
  });

  it("rejects missing, malformed and revoked tokens", async () => {
    assert.equal((await call("GET", "/v1/projects")).status, 401);
    assert.equal((await call("GET", "/v1/projects", { token: "nope" })).status, 401);
    const owner = await newOrg("revoke-org");
    const extra = await call("POST", "/v1/tokens", { token: owner, body: { name: "t", role: "admin" } });
    const id = (await pool.query(`SELECT id FROM api_tokens WHERE name = 't'`)).rows[0].id;
    assert.equal((await call("GET", "/v1/projects", { token: extra.json.token })).status, 200);
    assert.equal((await call("DELETE", `/v1/tokens/${id}`, { token: owner })).status, 204);
    assert.equal((await call("GET", "/v1/projects", { token: extra.json.token })).status, 401);
  });

  it("creates a working project and keeps its secrets encrypted at rest", async () => {
    const owner = await newOrg("secrets-org");
    const r = await newProject(owner, "app");
    assert.equal(r.status, 201);
    assert.equal(r.json.status, "active");
    assert.ok(await dbExists(`proj_${r.json.ref}`));

    const secrets = (await control.secretsFor(r.json.ref))!;
    const keys = (await call("GET", `/v1/projects/${r.json.ref}/api-keys`, { token: owner })).json;
    assert.equal(keys.anon, secrets.anonKey);
    assert.equal(keys.service_role, secrets.serviceKey);
    assert.equal(verifyJwt(keys.service_role, secrets.jwtSecret)?.role, "service_role");

    const row = JSON.stringify((await pool.query(`SELECT * FROM project_secrets WHERE ref = $1`, [r.json.ref])).rows[0]);
    for (const plain of [secrets.jwtSecret, secrets.dbPassword, secrets.serviceKey]) assert.ok(!row.includes(plain));

    // The stored database password really is the login role's password.
    const c = new pg.Client({ connectionString: urlFor(ADMIN!, `proj_${r.json.ref}`, { user: `authenticator_${r.json.ref}`, password: secrets.dbPassword }) });
    c.on("error", () => {});
    await c.connect();
    await c.end();

    // A ciphertext copied to another project does not open.
    const other = await newProject(owner, "app2");
    const a = (await pool.query(`SELECT jwt_secret_enc FROM project_secrets WHERE ref = $1`, [r.json.ref])).rows[0].jwt_secret_enc;
    await pool.query(`UPDATE project_secrets SET jwt_secret_enc = $1 WHERE ref = $2`, [a, other.json.ref]);
    await assert.rejects(control.secretsFor(other.json.ref));
  });

  it("never lets one organisation see or touch another's projects", async () => {
    const a = await newOrg("org-a");
    const b = await newOrg("org-b");
    const proj = (await newProject(a, "private")).json.ref;
    assert.equal((await call("GET", `/v1/projects/${proj}`, { token: b })).status, 404);
    assert.equal((await call("GET", `/v1/projects/${proj}/api-keys`, { token: b })).status, 404);
    assert.equal((await call("PATCH", `/v1/projects/${proj}/settings`, { token: b, body: { jwt_expiry: 3600 } })).status, 404);
    assert.equal((await call("POST", `/v1/projects/${proj}/pause`, { token: b })).status, 404);
    assert.equal((await call("DELETE", `/v1/projects/${proj}`, { token: b })).status, 404);
    assert.deepEqual((await call("GET", "/v1/projects", { token: b })).json, []);
    assert.equal((await call("GET", `/v1/projects/${proj}`, { token: a })).json.status, "active");
  });

  it("enforces roles", async () => {
    const owner = await newOrg("roles-org");
    const admin_ = await tokenFor(owner, "admin");
    const dev = await tokenFor(owner, "developer");
    assert.equal((await newProject(dev, "d")).status, 403);
    const ref = (await newProject(admin_, "p")).json.ref;

    assert.equal((await call("GET", `/v1/projects/${ref}`, { token: dev })).status, 200);
    const devKeys = (await call("GET", `/v1/projects/${ref}/api-keys`, { token: dev })).json;
    assert.ok(devKeys.anon && !("service_role" in devKeys));
    assert.ok((await call("GET", `/v1/projects/${ref}/api-keys`, { token: admin_ })).json.service_role);

    assert.equal((await call("POST", `/v1/projects/${ref}/pause`, { token: dev })).status, 403);
    assert.equal((await call("PATCH", `/v1/projects/${ref}/settings`, { token: dev, body: { jwt_expiry: 3600 } })).status, 403);
    assert.equal((await call("DELETE", `/v1/projects/${ref}`, { token: admin_ })).status, 403);
    assert.equal((await call("POST", "/v1/tokens", { token: admin_, body: { name: "x", role: "owner" } })).status, 403);
    assert.equal((await call("GET", "/v1/audit-log", { token: dev })).status, 403);
    assert.equal((await call("DELETE", `/v1/projects/${ref}`, { token: owner })).status, 200);
  });

  it("pause cuts off the database and resume restores it", async () => {
    const owner = await newOrg("pause-org");
    const ref = (await newProject(owner, "p")).json.ref;
    const { dbPassword } = (await control.secretsFor(ref))!;
    const url = urlFor(ADMIN!, `proj_${ref}`, { user: `authenticator_${ref}`, password: dbPassword });

    const live = new pg.Client({ connectionString: url });
    live.on("error", () => {});
    await live.connect();
    assert.equal((await call("POST", `/v1/projects/${ref}/pause`, { token: owner })).json.status, "paused");
    await assert.rejects(live.query("SELECT 1")); // open connection was terminated
    const again = new pg.Client({ connectionString: url });
    again.on("error", () => {});
    await assert.rejects(again.connect());
    assert.equal((await call("POST", `/v1/projects/${ref}/pause`, { token: owner })).status, 409);
    assert.equal(await control.secretsFor(ref), null); // gateway sees a paused project as unavailable

    assert.equal((await call("POST", `/v1/projects/${ref}/resume`, { token: owner })).json.status, "active");
    const back = new pg.Client({ connectionString: url });
    back.on("error", () => {});
    await back.connect();
    await back.end();
    assert.ok(await control.secretsFor(ref));
  });

  it("soft-deletes, blocks access, then purges after retention and frees the name", async () => {
    const owner = await newOrg("delete-org");
    const ref = (await newProject(owner, "gone")).json.ref;
    assert.equal((await call("DELETE", `/v1/projects/${ref}`, { token: owner })).json.status, "deleted");
    assert.ok(await dbExists(`proj_${ref}`), "database is kept until purge");
    assert.equal(await control.secretsFor(ref), null);
    assert.deepEqual((await call("GET", "/v1/projects", { token: owner })).json, []);
    assert.equal((await call("POST", `/v1/projects/${ref}/resume`, { token: owner })).status, 409);

    assert.ok(!(await control.purgeDeleted(60_000)).includes(ref), "not yet past retention");
    assert.ok(await dbExists(`proj_${ref}`));
    assert.ok((await control.purgeDeleted(0)).includes(ref));
    assert.ok(!(await dbExists(`proj_${ref}`)));
    assert.equal((await pool.query(`SELECT 1 FROM project_secrets WHERE ref = $1`, [ref])).rowCount, 0);
    assert.equal((await call("GET", `/v1/projects/${ref}`, { token: owner })).status, 404);
    assert.equal((await newProject(owner, "gone")).status, 201);
  });

  it("rejects duplicate names within an organisation only", async () => {
    const a = await newOrg("dup-a");
    const b = await newOrg("dup-b");
    assert.equal((await newProject(a, "same")).status, 201);
    assert.equal((await newProject(a, "same")).status, 409);
    assert.equal((await newProject(b, "same")).status, 201);
  });

  it("marks a failed provision as failed, leaves nothing behind, and frees the name", async () => {
    const owner = await newOrg("fail-org");
    failNext = true;
    const r = await newProject(owner, "flaky");
    assert.equal(r.status, 500);
    const row = (await pool.query(`SELECT ref, status FROM projects WHERE name = 'flaky'`)).rows[0];
    assert.equal(row.status, "failed");
    assert.ok(!(await dbExists(`proj_${row.ref}`)));
    assert.equal((await newProject(owner, "flaky")).status, 201);
  });

  it("reconciles a project stuck in provisioning after a crash", async () => {
    const owner = await newOrg("stuck-org");
    const p = await control.authenticate(owner);
    const ref = randomBytes(10).toString("hex");
    await pool.query(`INSERT INTO projects (ref, org_id, name, status, db_name, updated_at) VALUES ($1, $2, 'stuck', 'provisioning', $3, now() - interval '1 hour')`, [ref, p!.orgId, `proj_${ref}`]);
    await admin.query(`CREATE DATABASE "proj_${ref}"`); // leftover from the crash
    created.push(ref);
    assert.deepEqual(await control.reconcile(), [ref]);
    assert.ok(!(await dbExists(`proj_${ref}`)));
    assert.equal((await pool.query(`SELECT status FROM projects WHERE ref = $1`, [ref])).rows[0].status, "failed");
    assert.deepEqual(await control.reconcile(), []);
  });

  it("validates and merges settings", async () => {
    const owner = await newOrg("settings-org");
    const ref = (await newProject(owner, "s")).json.ref;
    const url = `/v1/projects/${ref}/settings`;
    assert.equal((await call("PATCH", url, { token: owner, body: { nope: 1 } })).status, 400);
    assert.equal((await call("PATCH", url, { token: owner, body: { jwt_expiry: 5 } })).status, 400);
    assert.equal((await call("PATCH", url, { token: owner, body: { site_url: "javascript:alert(1)" } })).status, 400);
    await call("PATCH", url, { token: owner, body: { site_url: "https://app.example.com" } });
    await call("PATCH", url, { token: owner, body: { jwt_expiry: 3600 } });
    assert.deepEqual((await call("GET", url, { token: owner })).json, { site_url: "https://app.example.com", jwt_expiry: 3600 });
  });

  it("records mutations in a per-organisation audit log", async () => {
    const owner = await newOrg("audit-org");
    const other = await newOrg("audit-other");
    const ref = (await newProject(owner, "a")).json.ref;
    await call("POST", `/v1/projects/${ref}/pause`, { token: owner });
    const actions = (await call("GET", "/v1/audit-log", { token: owner })).json.map((e: any) => e.action);
    assert.deepEqual(actions.slice(0, 2), ["project.pause", "project.create"]);
    assert.ok(!JSON.stringify((await call("GET", "/v1/audit-log", { token: other })).json).includes(ref));
  });

  it("returns 400 for malformed bodies", async () => {
    const owner = await newOrg("body-org");
    assert.equal((await call("POST", "/v1/projects", { token: owner, body: {} })).status, 400);
    assert.equal((await call("POST", "/v1/projects", { token: owner, body: { name: "" } })).status, 400);
    assert.equal((await call("POST", "/v1/tokens", { token: owner, body: { name: "x", role: "god" } })).status, 400);
  });
});
