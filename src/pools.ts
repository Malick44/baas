import pg from "pg";
import { HttpError, type ControlPlane, type Resolved } from "./control.js";
import { urlFor } from "./provision.js";

export type ApiRole = "anon" | "authenticated" | "service_role";
export const API_ROLES: ReadonlySet<string> = new Set<ApiRole>(["anon", "authenticated", "service_role"]);

/** Short-lived cache in front of ControlPlane.resolve so pause/delete/settings changes take effect within seconds. */
export class Directory {
  private cache = new Map<string, { at: number; val: Resolved | null }>();
  constructor(private control: ControlPlane, private ttlMs = 2000) {}

  async get(ref: string): Promise<Resolved | null> {
    const hit = this.cache.get(ref);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.val;
    const val = await this.control.resolve(ref);
    this.cache.set(ref, { at: Date.now(), val });
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
    return val;
  }

  forget(ref: string) {
    this.cache.delete(ref);
  }
}

export type RoleContext = {
  role: ApiRole;
  claims: Record<string, unknown>;
  readOnly?: boolean;
  timeoutMs?: number;
};

/**
 * One small connection pool per project, connecting as that project's own login role.
 * A query runs inside a transaction that switches to the caller's API role and publishes their JWT
 * claims, so row-level security sees exactly who is asking.
 */
export class PoolManager {
  private pools = new Map<string, { pool: pg.Pool; url: string; password: string }>();

  constructor(
    readonly dir: Directory,
    private adminUrl: string,
    private opts: { maxPools: number; perPool: number; queryTimeoutMs?: number } = { maxPools: 100, perPool: 5 },
  ) {}

  async active(ref: string): Promise<Resolved & { secrets: NonNullable<Resolved["secrets"]> }> {
    const r = await this.dir.get(ref);
    if (!r) throw new HttpError(404, "project not found");
    if (r.status === "paused") throw new HttpError(503, "project is paused");
    if (r.status !== "active" || !r.secrets) throw new HttpError(404, "project not found");
    return r as Resolved & { secrets: NonNullable<Resolved["secrets"]> };
  }

  async pool(ref: string): Promise<{ pool: pg.Pool; url: string; project: Resolved }> {
    const project = await this.active(ref);
    const password = project.secrets!.dbPassword;
    let e = this.pools.get(ref);
    if (e && e.password !== password) {
      void e.pool.end().catch(() => {});
      this.pools.delete(ref);
      e = undefined;
    }
    if (!e) {
      const url = urlFor(this.adminUrl, project.dbName, { user: `authenticator_${ref}`, password });
      const pool = new pg.Pool({ connectionString: url, max: this.opts.perPool, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
      pool.on("error", () => {});
      e = { pool, url, password };
      this.pools.set(ref, e);
      if (this.pools.size > this.opts.maxPools) {
        const oldest = this.pools.keys().next().value!;
        void this.pools.get(oldest)!.pool.end().catch(() => {});
        this.pools.delete(oldest);
      }
    } else {
      this.pools.delete(ref); // refresh LRU position
      this.pools.set(ref, e);
    }
    return { pool: e.pool, url: e.url, project };
  }

  private async cancel(url: string, pid: number) {
    const c = new pg.Client({ connectionString: url });
    c.on("error", () => {});
    try {
      await c.connect();
      await c.query("SELECT pg_cancel_backend($1)", [pid]);
    } catch {
      /* best effort */
    } finally {
      await c.end().catch(() => {});
    }
  }

  async withRole<T>(ref: string, ctx: RoleContext, fn: (c: pg.PoolClient, project: Resolved) => Promise<T>): Promise<T> {
    if (!API_ROLES.has(ctx.role)) throw new HttpError(403, "invalid role");
    const { pool, url, project } = await this.pool(ref);
    let c: pg.PoolClient;
    try {
      c = await pool.connect();
    } catch (err) {
      if ((err as { code?: string }).code === "53300") throw new HttpError(503, "too many connections for this project");
      throw new HttpError(503, "database unavailable");
    }
    let timer: NodeJS.Timeout | undefined;
    let broken = false;
    try {
      await c.query(ctx.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await c.query(`SET LOCAL ROLE ${ctx.role}`); // ctx.role is whitelisted above
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(ctx.claims)]);
      // A server-side watchdog: users may SET statement_timeout themselves, so the platform also cancels.
      timer = setTimeout(() => void this.cancel(url, (c as unknown as { processID: number }).processID), ctx.timeoutMs ?? this.opts.queryTimeoutMs ?? 20_000);
      const out = await fn(c, project);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      c.release(broken);
    }
  }

  async end() {
    await Promise.all([...this.pools.values()].map((e) => e.pool.end().catch(() => {})));
    this.pools.clear();
  }
}
