/**
 * What several baas processes need to agree on: who is running, and which one runs the jobs that must run once
 * (housekeeping, webhook delivery). Leadership is a Postgres advisory lock held on a dedicated connection to the control
 * database: when the leader's process or connection dies, Postgres releases the lock and another node takes over.
 *
 * A single process that never calls start() is its own leader and the only node, so nothing changes for one-node installs.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";

const LOCK_KEY = 727002;
const NODE_TTL_MS = 20_000;

export type NodeRow = { id: string; host: string; started_at: Date; seen_at: Date; leader: boolean; self: boolean };

export class Coordinator {
  readonly id = randomUUID();
  private leading = false;
  private nodes = 1;
  private timer?: NodeJS.Timeout;
  private lockClient?: pg.Client;
  private started = false;
  private busy = false;

  constructor(private pool: pg.Pool, private controlUrl: string, private opts: { everyMs?: number; log?: (m: string) => void } = {}) {}

  /** True when this node should run the singleton jobs. */
  isLeader(): boolean {
    return this.started ? this.leading : true;
  }

  /** How many nodes were alive at the last heartbeat. */
  nodeCount(): number {
    return this.started ? this.nodes : 1;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.beat();
    this.timer = setInterval(() => void this.beat().catch(() => {}), this.opts.everyMs ?? 5_000);
    this.timer.unref();
  }

  /** One round: be counted, count the others, and try to lead if nobody does. Exposed so tests need not wait for the timer. */
  async beat(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.pool.query(
        `INSERT INTO nodes (id, host) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET seen_at = now(), host = EXCLUDED.host`,
        [this.id, `${hostname()}:${process.pid}`],
      );
      await this.pool.query(`DELETE FROM nodes WHERE seen_at < now() - ($1 * interval '1 millisecond') * 5`, [NODE_TTL_MS]);
      this.nodes = Number((await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM nodes WHERE seen_at > now() - ($1 * interval '1 millisecond')`, [NODE_TTL_MS])).rows[0]!.n) || 1;
      await this.lead();
    } finally {
      this.busy = false;
    }
  }

  private async lead(): Promise<void> {
    if (this.lockClient) {
      try { await this.lockClient.query("SELECT 1"); return; } catch { this.drop(); }
    }
    const c = new pg.Client({ connectionString: this.controlUrl });
    c.on("error", () => { if (this.lockClient === c) this.drop(); });
    try {
      await c.connect();
      const got = (await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY])).rows[0]!.ok;
      if (got) {
        this.lockClient = c;
        if (!this.leading) {
          this.opts.log?.(`node ${this.id.slice(0, 8)} is now the leader`);
          await this.pool.query(`UPDATE nodes SET leader = (id = $1)`, [this.id]).catch(() => {});
        }
        this.leading = true;
        return;
      }
    } catch { /* the control database is unreachable: not leading */ }
    await c.end().catch(() => {});
    this.leading = false;
  }

  private drop() {
    const c = this.lockClient;
    this.lockClient = undefined;
    if (this.leading) void this.pool.query(`UPDATE nodes SET leader = false WHERE id = $1`, [this.id]).catch(() => {});
    this.leading = false;
    void c?.end().catch(() => {});
  }

  async list(): Promise<NodeRow[]> {
    const rows = (await this.pool.query<Omit<NodeRow, "self">>(
      `SELECT id, host, started_at, seen_at, leader FROM nodes WHERE seen_at > now() - ($1 * interval '1 millisecond') ORDER BY started_at`, [NODE_TTL_MS])).rows;
    return rows.map((r) => ({ ...r, self: r.id === this.id }));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.started = false;
    this.drop();
    await this.pool.query(`DELETE FROM nodes WHERE id = $1`, [this.id]).catch(() => {});
  }
}
