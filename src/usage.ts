import type { FastifyRequest } from "fastify";
import pg from "pg";
import { HttpError, type ControlPlane, type Resolved } from "./control.js";
import type { GatewayHooks } from "./gateway.js";
import { planOf } from "./plans.js";
import type { StorageService } from "./storage.js";

export type RequestLog = { at: string; method: string; path: string; status: number; ms: number };

type Counter = { requests: number; errors: number; egress: number };

/**
 * Per-project metering, quotas and rate limiting for the data plane.
 * Counters live in memory and are flushed to the control database every few seconds, so a crash loses at most
 * one flush interval of counts. Storage and database sizes are measured periodically by housekeeping.
 */
export class UsageService {
  private pending = new Map<string, Counter>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private today = new Map<string, { at: number; requests: number }>();
  private overDb = new Set<string>();
  private logs = new Map<string, RequestLog[]>();
  private admin: pg.Pool;
  private timer?: NodeJS.Timeout;

  constructor(private control: ControlPlane, adminUrl: string, private storage?: StorageService, private now: () => number = Date.now) {
    this.admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    this.admin.on("error", () => {});
  }

  start(flushMs = 10_000) {
    this.timer = setInterval(() => void this.flush().catch(() => {}), flushMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => {});
    await this.admin.end().catch(() => {});
  }

  /** Hooks for the gateway. */
  hooks(): GatewayHooks {
    return {
      admit: (ref, project, req) => this.admit(ref, project, req),
      done: (ref, req, status, bytes, ms) => this.done(ref, req, status, bytes, ms),
    };
  }

  private counter(ref: string): Counter {
    let c = this.pending.get(ref);
    if (!c) this.pending.set(ref, (c = { requests: 0, errors: 0, egress: 0 }));
    return c;
  }

  private async persistedToday(ref: string): Promise<number> {
    const hit = this.today.get(ref);
    if (hit && this.now() - hit.at < 30_000) return hit.requests;
    const r = await this.control.pool.query(`SELECT requests FROM usage_daily WHERE ref = $1 AND day = (now() AT TIME ZONE 'utc')::date`, [ref]);
    const requests = Number(r.rows[0]?.requests ?? 0);
    this.today.set(ref, { at: this.now(), requests });
    return requests;
  }

  async admit(ref: string, project: Resolved, req: FastifyRequest): Promise<void> {
    const plan = planOf(project.plan);
    // Token bucket: `burst` requests at once, refilled at `rps` per second.
    const t = this.now();
    const b = this.buckets.get(ref) ?? { tokens: plan.burst, at: t };
    b.tokens = Math.min(plan.burst, b.tokens + ((t - b.at) / 1000) * plan.rps);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(ref, b);
      throw new HttpError(429, "rate limit exceeded", { "retry-after": "1" });
    }
    b.tokens -= 1;
    this.buckets.set(ref, b);
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value!);

    const used = (await this.persistedToday(ref)) + (this.counter(ref).requests);
    if (used >= plan.requestsPerDay) throw new HttpError(429, "daily request quota exceeded", { "retry-after": "3600" });
    if (this.overDb.has(ref) && ["POST", "PUT", "PATCH"].includes(req.method) && /^\/(rest|storage)\//.test(req.url))
      throw new HttpError(402, "database size quota exceeded: delete data or upgrade the plan");
    this.counter(ref).requests++;
  }

  done(ref: string, req: FastifyRequest, status: number, bytes: number, ms: number): void {
    const c = this.counter(ref);
    c.egress += bytes;
    if (status >= 500) c.errors++;
    const list = this.logs.get(ref) ?? [];
    list.push({ at: new Date(this.now()).toISOString(), method: req.method, path: req.url.split("?")[0]!.slice(0, 200), status, ms });
    if (list.length > 200) list.shift();
    this.logs.set(ref, list);
    if (this.logs.size > 2000) this.logs.delete(this.logs.keys().next().value!);
  }

  logsFor(ref: string): RequestLog[] {
    return [...(this.logs.get(ref) ?? [])].reverse();
  }

  /** Write buffered counters to the control database. */
  async flush(): Promise<void> {
    const batch = [...this.pending.entries()].filter(([, c]) => c.requests || c.errors || c.egress);
    this.pending = new Map([...this.pending.entries()].filter(([ref]) => !batch.some(([r]) => r === ref)).map(([k, v]) => [k, v]));
    for (const [ref, c] of batch) {
      try {
        await this.control.pool.query(
          `INSERT INTO usage_daily (ref, day, requests, errors, egress_bytes) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2, $3, $4)
           ON CONFLICT (ref, day) DO UPDATE SET requests = usage_daily.requests + EXCLUDED.requests,
             errors = usage_daily.errors + EXCLUDED.errors, egress_bytes = usage_daily.egress_bytes + EXCLUDED.egress_bytes`,
          [ref, c.requests, c.errors, c.egress],
        );
        await this.control.pool.query(`UPDATE projects SET last_request_at = now() WHERE ref = $1`, [ref]);
        this.today.delete(ref);
      } catch {
        const back = this.counter(ref); // keep the counts for the next attempt
        back.requests += c.requests;
        back.errors += c.errors;
        back.egress += c.egress;
      }
    }
  }

  /** Measure database and storage size for every active project and refresh over-quota flags. */
  async measure(): Promise<void> {
    const dbs = new Map((await this.admin.query<{ datname: string; bytes: string }>(`SELECT datname, pg_database_size(datname)::text AS bytes FROM pg_database WHERE datname LIKE 'proj\\_%'`)).rows.map((r) => [r.datname, Number(r.bytes)]));
    const projects = (await this.control.pool.query<{ ref: string; db_name: string; plan: string }>(`SELECT ref, db_name, plan FROM projects WHERE status IN ('active', 'paused')`)).rows;
    for (const p of projects) {
      const dbBytes = dbs.get(p.db_name) ?? 0;
      let storageBytes = 0;
      if (this.storage) storageBytes = await this.storage.totalBytes(p.ref).catch(() => 0);
      await this.control.pool.query(
        `INSERT INTO usage_current (ref, db_bytes, storage_bytes, measured_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (ref) DO UPDATE SET db_bytes = EXCLUDED.db_bytes, storage_bytes = EXCLUDED.storage_bytes, measured_at = now()`,
        [p.ref, dbBytes, storageBytes],
      );
      if (dbBytes > planOf(p.plan).dbBytes) this.overDb.add(p.ref);
      else this.overDb.delete(p.ref);
    }
  }

  async report(ref: string, days = 30) {
    await this.flush();
    const daily = (await this.control.pool.query(
      `SELECT day::text, requests::int, errors::int, egress_bytes::bigint AS egress_bytes FROM usage_daily
       WHERE ref = $1 AND day > (now() AT TIME ZONE 'utc')::date - $2::int ORDER BY day DESC`,
      [ref, Math.min(Math.max(days, 1), 90)],
    )).rows;
    const current = (await this.control.pool.query(`SELECT db_bytes::bigint, storage_bytes::bigint, measured_at FROM usage_current WHERE ref = $1`, [ref])).rows[0] ?? null;
    return { daily, current, over_db_quota: this.overDb.has(ref) };
  }
}
