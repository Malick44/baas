import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { AuthService } from "./authsvc.js";
import { ControlPlane, type Principal } from "./control.js";
import { buildGateway, type GatewayHooks, type GatewayServices } from "./gateway.js";
import { migrate } from "./migrate.js";
import { Directory, PoolManager } from "./pools.js";
import { dropProject, urlFor } from "./provision.js";
import { Vault } from "./vault.js";

export type TestProject = {
  ref: string;
  host: string;
  anon: string;
  service: string;
  jwtSecret: string;
  /** Superuser URL to the project database, for arranging fixtures. */
  dbUrl: string;
};

export type Res = { status: number; json: any; text: string; headers: Record<string, string | string[] | number | undefined> };

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

export async function makeHarness(
  adminUrl: string,
  extra?: (pm: PoolManager, control: ControlPlane) => { services?: Partial<GatewayServices>; hooks?: GatewayHooks },
) {
  const ctlDb = `baas_ctl_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  admin.on("error", () => {});
  await admin.query(`CREATE DATABASE "${ctlDb}"`);
  const pool = new pg.Pool({ connectionString: urlFor(adminUrl, ctlDb) });
  pool.on("error", () => {});
  await migrate(pool);
  const control = new ControlPlane(pool, adminUrl, new Vault("ab".repeat(32)));
  const dir = new Directory(control, 0);
  const pm = new PoolManager(dir, adminUrl);
  const ex = extra?.(pm, control) ?? {};
  const services: GatewayServices = { auth: new AuthService(pm), ...ex.services };
  const app: FastifyInstance = buildGateway(pm, services, { domain: "localhost", hooks: ex.hooks });
  const created: string[] = [];
  const owner: Principal = await (async () => {
    const { ownerToken } = await control.createOrg("Test", `t-${randomBytes(3).toString("hex")}`);
    return (await control.authenticate(ownerToken))!;
  })();

  async function project(name = `p-${randomBytes(3).toString("hex")}`): Promise<TestProject> {
    const row = await control.createProject(owner, name);
    created.push(row.ref);
    const s = (await control.secretsFor(row.ref))!;
    return { ref: row.ref, host: `${row.ref}.localhost`, anon: s.anonKey, service: s.serviceKey, jwtSecret: s.jwtSecret, dbUrl: urlFor(adminUrl, row.db_name) };
  }

  async function call(p: { host: string }, method: string, path: string, o: { key?: string; token?: string; body?: unknown; raw?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { host: p.host, ...o.headers };
    if (o.key) headers.apikey = o.key;
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let payload: Buffer | string | undefined = o.raw;
    if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers["content-type"] ??= "application/json";
    }
    const r = await app.inject({ method: method as "GET", url: path, headers, payload });
    let json: unknown = null;
    try {
      json = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* not json */
    }
    return { status: r.statusCode, json, text: r.body, headers: r.headers };
  }

  async function sql<T = any>(p: TestProject, text: string, params?: unknown[]): Promise<T[]> {
    const c = new pg.Client({ connectionString: p.dbUrl });
    c.on("error", () => {});
    await c.connect();
    try {
      return (await c.query(text, params)).rows as T[];
    } finally {
      await c.end();
    }
  }

  /** Start a real HTTP listener (needed for WebSockets). Returns the port. */
  async function listen(): Promise<number> {
    await app.listen({ port: 0, host: "127.0.0.1" });
    return (app.server.address() as { port: number }).port;
  }

  async function close() {
    await app.close(); // stops realtime feeds before their databases are dropped
    await pm.end();
    for (const ref of created) await dropProject(adminUrl, ref).catch(() => {});
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${ctlDb}" WITH (FORCE)`);
    await admin.end();
  }

  return { app, control, pm, dir, owner, project, call, sql, listen, close, adminUrl, pool };
}
