import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createPlatform, type Platform, type PlatformConfig } from "./platform.js";
import { urlFor } from "./provision.js";

export const PG_BIN = process.env.BAAS_TEST_PG_BIN ?? (existsSync("/usr/lib/postgresql/16/bin/pg_dump") ? "/usr/lib/postgresql/16/bin" : undefined);
export const BOOT = "bootstrap-token-for-tests-1234567890";

export type PRes = { status: number; json: any; text: string; headers: Record<string, any> };

export async function makePlatform(adminUrl: string, over: Partial<PlatformConfig> = {}) {
  const ctlDb = `baas_ctl_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  admin.on("error", () => {});
  await admin.query(`CREATE DATABASE "${ctlDb}"`);
  const root = await mkdtemp(join(tmpdir(), "baas-platform-"));
  const platform: Platform = await createPlatform({
    controlUrl: urlFor(adminUrl, ctlDb),
    pgAdminUrl: adminUrl,
    masterKey: "ab".repeat(32),
    bootstrapToken: BOOT,
    storageDir: join(root, "storage"),
    backupDir: join(root, "backups"),
    pgBinDir: PG_BIN,
    gatewayDomain: "localhost",
    publicScheme: "http",
    publicPort: 8081,
    purgeRetentionMs: 0,
    ...over,
  });
  const refs: string[] = [];

  async function req(app: "api" | "gateway", method: string, url: string, o: { token?: string; key?: string; host?: string; body?: unknown; raw?: string | Buffer; headers?: Record<string, string> } = {}): Promise<PRes> {
    const headers: Record<string, string> = { ...o.headers };
    if (o.host) headers.host = o.host;
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.key) headers.apikey = o.key;
    let payload: string | Buffer | undefined = o.raw;
    if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers["content-type"] = "application/json";
    }
    const r = await platform[app].inject({ method: method as "GET", url, headers, payload });
    let json: any = null;
    try {
      json = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* not json */
    }
    return { status: r.statusCode, json, text: r.body, headers: r.headers };
  }

  const api = (method: string, url: string, o: Parameters<typeof req>[3] = {}) => req("api", method, url, o);
  const gw = (ref: string, method: string, url: string, o: Parameters<typeof req>[3] = {}) => req("gateway", method, url, { host: `${ref}.localhost`, ...o });

  async function org(slug = `o-${randomBytes(3).toString("hex")}`) {
    const r = await api("POST", "/v1/organizations", { headers: { "x-bootstrap-token": BOOT }, body: { name: slug, slug } });
    if (r.status !== 201) throw new Error(`org failed: ${r.text}`);
    return r.json.owner_token as string;
  }
  async function token(owner: string, role: "developer" | "admin") {
    return (await api("POST", "/v1/tokens", { token: owner, body: { name: role, role } })).json.token as string;
  }
  async function project(owner: string, name = `p-${randomBytes(3).toString("hex")}`) {
    const r = await api("POST", "/v1/projects", { token: owner, body: { name } });
    if (r.status !== 201) throw new Error(`project failed: ${r.text}`);
    const ref = r.json.ref as string;
    refs.push(ref);
    const keys = (await api("GET", `/v1/projects/${ref}/api-keys`, { token: owner })).json;
    return { ref, anon: keys.anon as string, service: keys.service_role as string, dbUrl: urlFor(adminUrl, `proj_${ref}`) };
  }
  async function sql(owner: string, ref: string, query: string) {
    return api("POST", `/v1/projects/${ref}/sql`, { token: owner, body: { query } });
  }

  async function close() {
    await platform.stop().catch(() => {});
    const c = new pg.Client({ connectionString: adminUrl });
    c.on("error", () => {});
    await c.connect();
    for (const ref of refs) {
      await c.query(`DROP DATABASE IF EXISTS "proj_${ref}" WITH (FORCE)`);
      await c.query(`DROP DATABASE IF EXISTS "proj_${ref}_restore" WITH (FORCE)`);
      await c.query(`DROP DATABASE IF EXISTS "proj_${ref}_old" WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS "authenticator_${ref}"`);
    }
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS "${ctlDb}" WITH (FORCE)`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }

  return { platform, api, gw, org, token, project, sql, close, root, refs };
}
