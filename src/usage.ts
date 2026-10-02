import type { FastifyRequest } from "fastify";
import pg from "pg";
import { HttpError, type ControlPlane, type Resolved } from "./control.js";
import type { GatewayHooks } from "./gateway.js";
import { planOf } from "./plans.js";
import type { StorageService } from "./storage.js";

export type RequestLog = { at: string; method: string; path: string; status: number; ms: number };

type Counter = { requests: number; errors: number; egress: number };
export const SERVICES = ["rest", "auth", "storage", "functions", "realtime"] as const;
export type Service = (typeof SERVICES)[number] | "other";
type Bucket = { requests: number; clientErrors: number; serverErrors: number };

/** Which part of the API a request path belongs to. */
export function serviceOf(url: string): Service {
  const m = /^\/(rest|auth|storage|functions|realtime)\//.exec(url);
  return m ? (m[1] as Service) : "other";
}

/**
 * Per-project metering, quotas and rate limiting for the data plane.
 * Counters live in memory and are flushed to the control database every few seconds, so a crash loses at most
 * one flush interval of counts. Storage and database sizes are measured periodically by housekeeping.
 */
export class UsageService {
  private pending = new Map<string, Counter>();
  /** Keyed "ref|hourStartMs|service"; flushed with the daily counters. */
  private hourly = new Map<string, Bucket>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private today = new Map<string, { at: number; requests: number }>();
  private overDb = new Set<string>();
  /** Requests not yet written to request_logs, so any node can show the logs of requests every node served. */
  private pendingLogs: Array<RequestLog & { ref: string }> = [];
  private admin: pg.Pool;
  private timer?: NodeJS.Timeout;
  private logTimer?: NodeJS.Timeout;

  constructor(private control: ControlPlane, adminUrl: string, private storage?: StorageService, private now: () => number = Date.now,
    /** How many nodes share the load; each enforces its share of the rate limit. */ private nodes: () => number = () => 1) {
    this.admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    this.admin.on("error", () => {});
  }

  start(flushMs = 10_000) {
    this.timer = setInterval(() => void this.flush().catch(() => {}), flushMs);
    this.timer.unref();
    // Request logs go out sooner than counters, so what another node served shows up within a couple of seconds.
    this.logTimer = setInterval(() => void this.flushLogs().catch(() => {}), Math.min(flushMs, 2_000));
    this.logTimer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.logTimer) clearInterval(this.logTimer);
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

  /**
   * With several nodes the limits are shared exactly through the control database: a project's tokens live in one bucket and a node
   * takes a short lease from it (about a tenth of a second of traffic) and spends it locally, so a lopsided balancer is not throttled
   * harder than an even one and the plan's limit holds in total. Daily quota is claimed in blocks that shrink as the cap nears.
   * If the database cannot be reached the node falls back to its share of the limit, so requests still get answered.
   */
  private leases = new Map<string, { tokens: number; until: number }>();
  private blocks = new Map<string, { left: number; day: number }>();

  private async takeShared(ref: string, plan: ReturnType<typeof planOf>): Promise<void> {
    const t = this.now();
    const lease = this.leases.get(ref);
    if (lease && lease.until > t && lease.tokens >= 1) lease.tokens--;
    else {
      const want = Math.max(1, Math.min(plan.burst, Math.ceil(plan.rps / 10)));
      const n = (await this.control.pool.query<{ n: number }>(`SELECT baas_take_tokens($1, $2, $3, $4) AS n`, [`rps:${ref}`, plan.burst, plan.rps, want])).rows[0]!.n;
      if (n < 1) { this.leases.delete(ref); throw new HttpError(429, "rate limit exceeded", { "retry-after": "1" }); }
      this.leases.set(ref, { tokens: n - 1, until: t + 500 });
      if (this.leases.size > 10_000) this.leases.delete(this.leases.keys().next().value!);
    }
    const day = Math.floor(t / 86_400_000);
    const block = this.blocks.get(ref);
    if (block && block.day === day && block.left > 0) { block.left--; return; }
    const n = (await this.control.pool.query<{ n: number }>(`SELECT baas_claim_day($1, 1000, $2, $3) AS n`, [ref, plan.requestsPerDay, Math.max(1, this.nodes())])).rows[0]!.n;
    if (n < 1) { this.blocks.delete(ref); throw new HttpError(429, "daily request quota exceeded", { "retry-after": "3600" }); }
    this.blocks.set(ref, { left: n - 1, day });
    if (this.blocks.size > 10_000) this.blocks.delete(this.blocks.keys().next().value!);
  }

  async admit(ref: string, project: Resolved, req: FastifyRequest): Promise<void> {
    const plan = planOf(project.plan);
    let shared = this.nodes() > 1;
    if (shared) {
      try { await this.takeShared(ref, plan); } catch (e) { if (e instanceof HttpError) throw e; shared = false; }
    }
    if (!shared) {
      // One node (or the database unreachable): a token bucket in memory, `burst` requests at once refilled at `rps` a second,
      // taking this node's share of the limit.
      const share = Math.max(1, this.nodes());
      const burst = Math.max(1, plan.burst / share), rps = plan.rps / share;
      const t = this.now();
      const b = this.buckets.get(ref) ?? { tokens: burst, at: t };
      b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rps);
      b.at = t;
      if (b.tokens < 1) {
        this.buckets.set(ref, b);
        throw new HttpError(429, "rate limit exceeded", { "retry-after": "1" });
      }
      b.tokens -= 1;
      this.buckets.set(ref, b);
      if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value!);
      const used = (await this.persistedToday(ref).catch(() => 0)) + (this.counter(ref).requests);
      if (used >= plan.requestsPerDay) throw new HttpError(429, "daily request quota exceeded", { "retry-after": "3600" });
    }
    if (this.overDb.has(ref) && ["POST", "PUT", "PATCH"].includes(req.method) && /^\/(rest|storage)\//.test(req.url))
      throw new HttpError(402, "database size quota exceeded: delete data or upgrade the plan");
    this.counter(ref).requests++;
  }

  done(ref: string, req: FastifyRequest, status: number, bytes: number, ms: number): void {
    const c = this.counter(ref);
    c.egress += bytes;
    if (status >= 500) c.errors++;
    const hour = Math.floor(this.now() / 3_600_000) * 3_600_000;
    const key = `${ref}|${hour}|${serviceOf(req.url)}`;
    const b = this.hourly.get(key) ?? { requests: 0, clientErrors: 0, serverErrors: 0 };
    b.requests++;
    if (status >= 500) b.serverErrors++;
    else if (status >= 400) b.clientErrors++;
    this.hourly.set(key, b);
    this.pendingLogs.push({ ref, at: new Date(this.now()).toISOString(), method: req.method, path: req.url.split("?")[0]!.slice(0, 200), status, ms });
    if (this.pendingLogs.length > 5000) this.pendingLogs.splice(0, this.pendingLogs.length - 5000);
  }

  /** Write waiting request logs (the newest 50 per project per round, which is plenty for a debugging aid) and keep 200 per project. */
  private async flushLogs(only?: string): Promise<void> {
    const mine = only === undefined ? this.pendingLogs : this.pendingLogs.filter((l) => l.ref === only);
    if (!mine.length) return;
    this.pendingLogs = only === undefined ? [] : this.pendingLogs.filter((l) => l.ref !== only);
    const byRef = new Map<string, Array<RequestLog & { ref: string }>>();
    for (const l of mine) byRef.set(l.ref, [...(byRef.get(l.ref) ?? []), l].slice(-50));
    try {
      for (const [ref, list] of byRef) {
        await this.control.pool.query(
          `INSERT INTO request_logs (ref, at, method, path, status, ms) SELECT $1, * FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::int[], $6::int[])`,
          [ref, list.map((l) => l.at), list.map((l) => l.method), list.map((l) => l.path), list.map((l) => l.status), list.map((l) => Math.min(2_000_000_000, Math.round(l.ms)))],
        );
        await this.control.pool.query(`DELETE FROM request_logs WHERE ref = $1 AND id <= (SELECT id FROM request_logs WHERE ref = $1 ORDER BY id DESC OFFSET 200 LIMIT 1)`, [ref]);
      }
    } catch {
      this.pendingLogs = [...mine, ...this.pendingLogs].slice(-5000); // try again next time
    }
  }

  /** The newest 200 requests the project's data plane served, from every node. */
  async logsFor(ref: string): Promise<RequestLog[]> {
    await this.flushLogs(ref);
    const r = await this.control.pool.query<{ at: Date; method: string; path: string; status: number; ms: number }>(
      `SELECT at, method, path, status, ms FROM request_logs WHERE ref = $1 ORDER BY id DESC LIMIT 200`, [ref]);
    return r.rows.map((x) => ({ at: x.at.toISOString(), method: x.method, path: x.path, status: x.status, ms: x.ms }));
  }

  private async flushHourly(): Promise<void> {
    const batch = [...this.hourly.entries()];
    this.hourly = new Map();
    for (const [key, b] of batch) {
      const [ref, hour, service] = key.split("|") as [string, string, string];
      try {
        await this.control.pool.query(
          `INSERT INTO usage_hourly (ref, hour, service, requests, client_errors, server_errors) VALUES ($1, to_timestamp($2::double precision / 1000), $3, $4, $5, $6)
           ON CONFLICT (ref, hour, service) DO UPDATE SET requests = usage_hourly.requests + EXCLUDED.requests,
             client_errors = usage_hourly.client_errors + EXCLUDED.client_errors, server_errors = usage_hourly.server_errors + EXCLUDED.server_errors`,
          [ref, hour, service, b.requests, b.clientErrors, b.serverErrors],
        );
      } catch {
        const back = this.hourly.get(key) ?? { requests: 0, clientErrors: 0, serverErrors: 0 };
        back.requests += b.requests;
        back.clientErrors += b.clientErrors;
        back.serverErrors += b.serverErrors;
        this.hourly.set(key, back); // try again on the next flush
      }
    }
  }

  /** Per-service request counts for each of the last `hours` hours (oldest first), for the overview charts. */
  async metrics(ref: string, hours = 24) {
    await this.flush();
    const n = Math.min(Math.max(Math.floor(hours) || 24, 1), 168);
    const end = Math.floor(this.now() / 3_600_000) * 3_600_000;
    const start = end - (n - 1) * 3_600_000;
    const rows = (await this.control.pool.query(
      `SELECT (extract(epoch FROM hour) * 1000)::bigint AS h, service, requests, client_errors, server_errors FROM usage_hourly
       WHERE ref = $1 AND hour >= to_timestamp($2::double precision / 1000)`,
      [ref, start],
    )).rows;
    const stamps = Array.from({ length: n }, (_, i) => new Date(start + i * 3_600_000).toISOString());
    const zeros = () => Array.from({ length: n }, () => 0);
    const services = Object.fromEntries(SERVICES.map((s) => [s, { requests: zeros(), warnings: zeros(), errors: zeros() }])) as Record<string, { requests: number[]; warnings: number[]; errors: number[] }>;
    let total = 0;
    let bad = 0;
    for (const r of rows) {
      const i = Math.round((Number(r.h) - start) / 3_600_000);
      const s = services[r.service];
      if (!s || i < 0 || i >= n) continue;
      s.requests[i]! += r.requests;
      s.warnings[i]! += r.client_errors;
      s.errors[i]! += r.server_errors;
      total += r.requests;
      bad += r.server_errors;
    }
    return { hours: stamps, services, totals: { requests: total, serverErrors: bad, successRate: total ? (100 * (total - bad)) / total : null } };
  }

  /** Drop hourly rows older than a week. */
  async pruneHourly(): Promise<void> {
    await this.control.pool.query(`DELETE FROM usage_hourly WHERE hour < now() - interval '8 days'`);
  }

  /** Write buffered counters to the control database. */
  async flush(): Promise<void> {
    await this.flushHourly();
    await this.flushLogs();
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
    // Every cluster is asked, since projects are spread over them; a cluster that cannot be reached keeps its projects' last measurement.
    const dbs = new Map<string, number>();
    const down = new Set<string>();
    for (const cl of await this.control.clusters.all()) {
      const c = cl.id === "main" ? null : new pg.Client({ connectionString: cl.adminUrl, connectionTimeoutMillis: 5000 });
      try {
        let q: pg.QueryResult<{ datname: string; bytes: string }>;
        if (c) { c.on("error", () => {}); await c.connect(); q = await c.query(`SELECT datname, pg_database_size(datname)::text AS bytes FROM pg_database WHERE datname LIKE 'proj\\_%'`); }
        else q = await this.admin.query(`SELECT datname, pg_database_size(datname)::text AS bytes FROM pg_database WHERE datname LIKE 'proj\\_%'`);
        for (const r of q.rows) dbs.set(`${cl.id}/${r.datname}`, Number(r.bytes));
      } catch { down.add(cl.id); /* leave this cluster's projects as they were */ } finally { await c?.end().catch(() => {}); }
    }
    const projects = (await this.control.pool.query<{ ref: string; db_name: string; plan: string; cluster_id: string }>(`SELECT ref, db_name, plan, cluster_id FROM projects WHERE status IN ('active', 'paused')`)).rows;
    for (const p of projects) {
      if (down.has(p.cluster_id)) continue;
      const dbBytes = dbs.get(`${p.cluster_id}/${p.db_name}`) ?? 0;
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
