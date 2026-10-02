/**
 * More than one Postgres cluster. Every project's database lives on exactly one; the registry says where, picks a cluster for
 * new projects, and a move copies a project to another cluster while its access is cut.
 *
 * "main" is the cluster named by BAAS_PG_ADMIN_URL. Others are added at run time with an admin (superuser) URL, which is sealed with the
 * platform key and never shown again.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { BackupService } from "./backup.js";
import { HttpError } from "./control.js";
import { createProjectDatabase, dropProject, setProjectAccess } from "./provision.js";
import type { Vault } from "./vault.js";

export const MAIN = "main";
const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const TTL_MS = 30_000;

export type ClusterRow = { id: string; name: string; status: "active" | "draining"; max_projects: number | null; created_at: Date };
export type ClusterView = ClusterRow & { host: string; projects: number; db_bytes: number | null };

const hostOf = (url: string) => { const u = new URL(url); return `${u.hostname}:${u.port || "5432"}`; };

export class ClusterRegistry {
  private urls = new Map<string, { at: number; url: string }>();

  constructor(private pool: pg.Pool, private vault: Vault, private mainUrl: string) {}

  /** The admin URL for a cluster. Cached briefly, so a rotated URL reaches every node within seconds. */
  async adminUrl(id: string): Promise<string> {
    if (id === MAIN) return this.mainUrl;
    const hit = this.urls.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.url;
    const r = (await this.pool.query<{ admin_url_enc: string | null }>(`SELECT admin_url_enc FROM clusters WHERE id = $1`, [id])).rows[0];
    if (!r?.admin_url_enc) throw new HttpError(500, `cluster ${id} is not available`);
    const url = this.vault.open(r.admin_url_enc, `cluster:${id}`);
    this.urls.set(id, { at: Date.now(), url });
    return url;
  }

  /** Every cluster with its URL, for jobs that must visit them all. */
  async all(): Promise<Array<{ id: string; adminUrl: string }>> {
    const ids = (await this.pool.query<{ id: string }>(`SELECT id FROM clusters ORDER BY created_at, id`)).rows;
    return Promise.all(ids.map(async ({ id }) => ({ id, adminUrl: await this.adminUrl(id) })));
  }

  async adminUrlOfProject(ref: string): Promise<string> {
    const r = (await this.pool.query<{ cluster_id: string }>(`SELECT cluster_id FROM projects WHERE ref = $1`, [ref])).rows[0];
    if (!r) throw new HttpError(404, "project not found");
    return this.adminUrl(r.cluster_id);
  }

  async list(): Promise<ClusterView[]> {
    const rows = (await this.pool.query<ClusterRow & { projects: string; db_bytes: string | null }>(
      `SELECT c.id, c.name, c.status, c.max_projects, c.created_at,
              (SELECT count(*) FROM projects p WHERE p.cluster_id = c.id AND p.status NOT IN ('purged')) AS projects,
              (SELECT sum(u.db_bytes) FROM usage_current u JOIN projects p ON p.ref = u.ref WHERE p.cluster_id = c.id) AS db_bytes
       FROM clusters c ORDER BY c.created_at, c.id`)).rows;
    return Promise.all(rows.map(async (r) => ({ ...r, projects: Number(r.projects), db_bytes: r.db_bytes === null ? null : Number(r.db_bytes), host: hostOf(await this.adminUrl(r.id)) })));
  }

  /** Can this cluster be reached right now? A short-lived answer, so a downed cluster is skipped without a probe per request. */
  private health = new Map<string, { at: number; ok: boolean }>();
  private async reachable(id: string, url: string): Promise<boolean> {
    const hit = this.health.get(id);
    if (hit && Date.now() - hit.at < 10_000) return hit.ok;
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2500 });
    c.on("error", () => {});
    let ok = false;
    try { await c.connect(); await c.query("SELECT 1"); ok = true; } catch { /* down */ } finally { await c.end().catch(() => {}); }
    this.health.set(id, { at: Date.now(), ok });
    return ok;
  }

  /** Where a new project goes: the active, reachable cluster with room that is least full (by share of its capacity, else by count). */
  async pick(exclude: ReadonlySet<string> = new Set()): Promise<string> {
    const rows = (await this.list()).filter((c) => !exclude.has(c.id));
    const open = rows.filter((c) => c.status === "active" && (c.max_projects === null || c.projects < c.max_projects));
    open.sort((a, b) => (a.max_projects ? a.projects / a.max_projects : a.projects / 1e6) - (b.max_projects ? b.projects / b.max_projects : b.projects / 1e6) || a.projects - b.projects);
    for (const c of open) if (await this.reachable(c.id, await this.adminUrl(c.id))) return c.id;
    throw new HttpError(503, open.length ? "no cluster with room can be reached right now" : "no cluster has room for another project");
  }

  /** Check an admin URL really is a reachable server where we may create databases and roles. */
  private async check(url: string, exceptId?: string): Promise<void> {
    let u: URL;
    try { u = new URL(url); } catch { throw new HttpError(400, "admin_url is not a valid URL"); }
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new HttpError(400, "admin_url must start with postgres://");
    if (!u.username) throw new HttpError(400, "admin_url needs a user (a superuser)");
    for (const c of await this.all()) if (c.id !== exceptId && hostOf(c.adminUrl) === hostOf(url)) throw new HttpError(409, `${hostOf(url)} is already registered as cluster ${c.id}`);
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
    c.on("error", () => {});
    try {
      await c.connect();
      const r = (await c.query<{ super: boolean }>(`SELECT rolsuper AS super FROM pg_roles WHERE rolname = current_user`)).rows[0];
      if (!r?.super) throw new HttpError(400, "the admin user must be a superuser, so baas can create databases and roles");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `could not connect: ${(e as Error).message.slice(0, 150)}`);
    } finally {
      await c.end().catch(() => {});
    }
  }

  async add(input: { id?: unknown; name?: unknown; admin_url?: unknown; max_projects?: unknown }): Promise<ClusterView> {
    if (typeof input.id !== "string" || !ID.test(input.id) || input.id === MAIN) throw new HttpError(400, "id must be 1-31 characters of a-z, 0-9 and -, and not \"main\"");
    if (typeof input.admin_url !== "string") throw new HttpError(400, "admin_url is required");
    const max = input.max_projects === undefined || input.max_projects === null ? null : Number(input.max_projects);
    if (max !== null && (!Number.isInteger(max) || max < 1)) throw new HttpError(400, "max_projects must be a positive whole number");
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : input.id;
    await this.check(input.admin_url);
    try {
      await this.pool.query(`INSERT INTO clusters (id, name, admin_url_enc, max_projects) VALUES ($1, $2, $3, $4)`, [input.id, name, this.vault.seal(input.admin_url, `cluster:${input.id}`), max]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "a cluster with that id exists");
      throw e;
    }
    return (await this.list()).find((c) => c.id === input.id)!;
  }

  async update(id: string, patch: { name?: unknown; status?: unknown; max_projects?: unknown; admin_url?: unknown }): Promise<ClusterView> {
    const cur = (await this.pool.query<ClusterRow>(`SELECT id, name, status, max_projects, created_at FROM clusters WHERE id = $1`, [id])).rows[0];
    if (!cur) throw new HttpError(404, "cluster not found");
    const sets: string[] = [], vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.name !== undefined) { if (typeof patch.name !== "string" || !patch.name.trim()) throw new HttpError(400, "name must be text"); set("name", patch.name.trim().slice(0, 80)); }
    if (patch.status !== undefined) { if (patch.status !== "active" && patch.status !== "draining") throw new HttpError(400, "status must be active or draining"); set("status", patch.status); }
    if (patch.max_projects !== undefined) {
      const m = patch.max_projects === null ? null : Number(patch.max_projects);
      if (m !== null && (!Number.isInteger(m) || m < 1)) throw new HttpError(400, "max_projects must be a positive whole number or null");
      set("max_projects", m);
    }
    if (patch.admin_url !== undefined) {
      if (id === MAIN) throw new HttpError(400, "the main cluster's address comes from BAAS_PG_ADMIN_URL");
      if (typeof patch.admin_url !== "string") throw new HttpError(400, "admin_url must be text");
      await this.check(patch.admin_url, id);
      set("admin_url_enc", this.vault.seal(patch.admin_url, `cluster:${id}`));
      this.urls.delete(id);
    }
    if (sets.length) await this.pool.query(`UPDATE clusters SET ${sets.join(", ")} WHERE id = $1`, vals);
    return (await this.list()).find((c) => c.id === id)!;
  }

  async remove(id: string): Promise<void> {
    if (id === MAIN) throw new HttpError(400, "the main cluster cannot be removed");
    const n = Number((await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM projects WHERE cluster_id = $1 OR moving_to = $1`, [id])).rows[0]!.n);
    if (n) throw new HttpError(409, `${n} project(s) still use this cluster; move or delete them first`);
    if (!(await this.pool.query(`DELETE FROM clusters WHERE id = $1`, [id])).rowCount) throw new HttpError(404, "cluster not found");
    this.urls.delete(id);
  }
}

/** Copies a project's database to another cluster. */
export class ClusterMover {
  constructor(
    private registry: ClusterRegistry, private pool: pg.Pool, private vault: Vault, private backups: BackupService, private dir: string,
    private audit: (action: string, ref: string, orgId: string, meta: object) => Promise<void>, private forget: (ref: string) => void,
  ) {}

  /**
   * Cut the project off, dump it, build it on the target with the same login password, switch, and drop the old copy.
   * Until the switch, any failure restores the project exactly as it was. The project is unavailable while it is copied,
   * for about as long as a backup and restore of its database take.
   */
  async move(ref: string, targetId: string): Promise<{ from: string; to: string }> {
    const row = (await this.pool.query<{ cluster_id: string; org_id: string; status: string; db_password_enc: string | null }>(
      `SELECT p.cluster_id, p.org_id, p.status, s.db_password_enc FROM projects p LEFT JOIN project_secrets s ON s.ref = p.ref WHERE p.ref = $1`, [ref])).rows[0];
    if (!row || ["purged", "deleted"].includes(row.status)) throw new HttpError(404, "project not found");
    if (row.status !== "active" || !row.db_password_enc) throw new HttpError(409, `cannot move a project that is ${row.status}; resume it first`);
    if (row.cluster_id === targetId) throw new HttpError(409, "the project is already on that cluster");
    const target = (await this.registry.list()).find((c) => c.id === targetId);
    if (!target) throw new HttpError(404, "cluster not found");
    if (target.status !== "active") throw new HttpError(409, "that cluster is draining and takes no new projects");
    if (target.max_projects !== null && target.projects >= target.max_projects) throw new HttpError(409, "that cluster is full");

    const claimed = await this.pool.query(`UPDATE projects SET moving_to = $2, updated_at = now() WHERE ref = $1 AND status = 'active' AND moving_to IS NULL`, [ref, targetId]);
    if (!claimed.rowCount) throw new HttpError(409, "the project is already being moved");

    const srcUrl = await this.registry.adminUrl(row.cluster_id);
    const dstUrl = await this.registry.adminUrl(targetId);
    const password = this.vault.open(row.db_password_enc, ref);
    const file = join(this.dir, "moves", `${ref}.dump`);
    let built = false;
    try {
      await mkdir(join(this.dir, "moves"), { recursive: true, mode: 0o700 });
      await setProjectAccess(srcUrl, ref, false); // no writes from here until the switch
      this.forget(ref);
      await this.backups.runTool("pg_dump", ["-Fc", "-f", file, "-d", `proj_${ref}`], srcUrl);
      await dropProject(dstUrl, ref).catch(() => {}); // a leftover from an earlier failed attempt
      built = true;
      await createProjectDatabase(dstUrl, ref, password);
      await this.backups.runTool("pg_restore", ["--exit-on-error", "--no-owner", "-d", `proj_${ref}`, file], dstUrl);
      await this.checkCopy(srcUrl, dstUrl, ref);
      // The switch: one statement, after which every node reads the project from its new home.
      const sw = await this.pool.query(`UPDATE projects SET cluster_id = $2, moving_to = NULL, updated_at = now() WHERE ref = $1 AND moving_to = $2`, [ref, targetId]);
      if (!sw.rowCount) throw new Error("the project's move was cancelled");
      built = false;
    } catch (err) {
      if (built) await dropProject(dstUrl, ref).catch(() => {});
      await setProjectAccess(srcUrl, ref, true).catch(() => {});
      await this.pool.query(`UPDATE projects SET moving_to = NULL WHERE ref = $1 AND moving_to = $2`, [ref, targetId]);
      this.forget(ref);
      await rm(file, { force: true });
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `the move failed and the project is unchanged: ${(err as Error).message.slice(0, 250)}`);
    }
    this.forget(ref);
    await rm(file, { force: true });
    // The old copy is garbage now; failing to remove it must not fail the move.
    await dropProject(srcUrl, ref).catch(() => {});
    await this.audit("project.move", ref, row.org_id, { from: row.cluster_id, to: targetId });
    return { from: row.cluster_id, to: targetId };
  }

  /** A cheap guard before switching: the same tables with the same row counts on both sides. */
  private async checkCopy(srcUrl: string, dstUrl: string, ref: string): Promise<void> {
    const counts = async (url: string) => {
      const c = new pg.Client({ connectionString: urlForDb(url, `proj_${ref}`) });
      c.on("error", () => {});
      await c.connect();
      try {
        const tables = (await c.query<{ s: string; t: string }>(`SELECT schemaname AS s, relname AS t FROM pg_stat_user_tables ORDER BY 1, 2`)).rows;
        const out: Record<string, number> = {};
        for (const { s, t } of tables) out[`${s}.${t}`] = Number((await c.query(`SELECT count(*)::int AS n FROM "${s.replace(/"/g, '""')}"."${t.replace(/"/g, '""')}"`)).rows[0].n);
        return out;
      } finally { await c.end().catch(() => {}); }
    };
    const [a, b] = await Promise.all([counts(srcUrl), counts(dstUrl)]);
    if (JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(b).sort())) throw new Error("the copy does not match the original (table or row counts differ)");
  }

  /** Housekeeping: a node that died mid-move leaves the project cut off; give it back to the cluster it is still on. */
  async reconcile(olderThanMs = 30 * 60_000): Promise<string[]> {
    const stuck = (await this.pool.query<{ ref: string; cluster_id: string; moving_to: string }>(
      `SELECT ref, cluster_id, moving_to FROM projects WHERE moving_to IS NOT NULL AND updated_at <= now() - ($1 || ' milliseconds')::interval`, [olderThanMs])).rows;
    for (const s of stuck) {
      await dropProject(await this.registry.adminUrl(s.moving_to), s.ref).catch(() => {});
      await setProjectAccess(await this.registry.adminUrl(s.cluster_id), s.ref, true).catch(() => {});
      await this.pool.query(`UPDATE projects SET moving_to = NULL WHERE ref = $1 AND moving_to = $2`, [s.ref, s.moving_to]);
      this.forget(s.ref);
    }
    return stuck.map((s) => s.ref);
  }
}

const urlForDb = (adminUrl: string, db: string) => { const u = new URL(adminUrl); u.pathname = `/${db}`; return u.toString(); };
