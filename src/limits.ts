/**
 * Counters with a time window, for the limits that must hold across every baas process: failed sign-ins, how often
 * an email or text may be sent. In memory for one process; in the control database when several share it.
 */
import type pg from "pg";

export type Hit = { count: number; resetsAt: number };

export interface Limits {
  /** Count one event in the key's window (a new window starts when the last one has ended). */
  hit(key: string, windowMs: number): Promise<Hit>;
  /** Events in the current window, 0 when there is none. */
  count(key: string): Promise<number>;
  clear(key: string): Promise<void>;
}

export class MemoryLimits implements Limits {
  private m = new Map<string, { n: number; until: number }>();

  async hit(key: string, windowMs: number): Promise<Hit> {
    const now = Date.now();
    const e = this.m.get(key);
    if (!e || e.until <= now) {
      this.m.set(key, { n: 1, until: now + windowMs });
      if (this.m.size > 50_000) this.m.delete(this.m.keys().next().value!);
      return { count: 1, resetsAt: now + windowMs };
    }
    e.n++;
    return { count: e.n, resetsAt: e.until };
  }

  async count(key: string): Promise<number> {
    const e = this.m.get(key);
    return e && e.until > Date.now() ? e.n : 0;
  }

  async clear(key: string): Promise<void> {
    this.m.delete(key);
  }
}

/** One row per key in the control database, so every node sees the same count. The window is the database's clock, not each node's. */
export class PgLimits implements Limits {
  constructor(private pool: pg.Pool) {}

  async hit(key: string, windowMs: number): Promise<Hit> {
    const r = await this.pool.query<{ count: number; ends: Date }>(
      `INSERT INTO rate_limits (key, count, window_end) VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_end <= now() THEN 1 ELSE rate_limits.count + 1 END,
         window_end = CASE WHEN rate_limits.window_end <= now() THEN now() + ($2 * interval '1 millisecond') ELSE rate_limits.window_end END
       RETURNING count, window_end AS ends`,
      [key, windowMs],
    );
    return { count: r.rows[0]!.count, resetsAt: r.rows[0]!.ends.getTime() };
  }

  async count(key: string): Promise<number> {
    const r = await this.pool.query<{ count: number }>(`SELECT count FROM rate_limits WHERE key = $1 AND window_end > now()`, [key]);
    return r.rows[0]?.count ?? 0;
  }

  async clear(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM rate_limits WHERE key = $1`, [key]);
  }

  /** Forget windows that ended. Housekeeping. */
  async prune(): Promise<number> {
    await this.pool.query(`DELETE FROM shared_buckets WHERE at < now() - interval '1 day'`);
    return (await this.pool.query(`DELETE FROM rate_limits WHERE window_end < now() - interval '1 minute'`)).rowCount ?? 0;
  }
}
