import { createHmac, randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import pg from "pg";
import { ControlPlane, HttpError, type Principal } from "./control.js";
import type { PoolManager } from "./pools.js";
import { urlFor } from "./provision.js";
import { ident } from "./rest.js";
import type { Vault } from "./vault.js";

/**
 * Pipelines send a project's row changes to a webhook.
 *
 * - Changes come from realtime.changes (the same log Realtime uses), so a pipeline adds a trigger to each table it watches.
 * - Delivery is at-least-once and in order, one batch at a time per pipeline. A pipeline starts from "now": it does not replay old rows.
 * - A batch is signed: X-Baas-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>"> with the pipeline's secret.
 * - Rows are read with the platform's own credentials at delivery time, so row-level security does not apply and the row is the
 *   *current* row, not a snapshot of the change. Only admins can create pipelines for that reason.
 * - Destinations that resolve to private, loopback or link-local addresses are refused unless the operator allows them.
 */

export type PipelineOptions = {
  /** Allow destinations on private networks (for local development and tests). Default false. */
  allowPrivateTargets?: boolean;
  batchSize?: number;
  timeoutMs?: number;
  /** Consecutive failures before a pipeline pauses itself. */
  maxFailures?: number;
  backoffBaseMs?: number;
  maxPerProject?: number;
};

export type PipelineRow = {
  id: string; ref: string; name: string; tables: string[]; events: string[]; url: string; secret_enc: string; include_rows: boolean; enabled: boolean;
  disabled_reason: string | null; consecutive_failures: number; next_attempt_at: Date | null; last_attempt_at: Date | null; last_success_at: Date | null;
  last_status: number | null; last_error: string | null; delivered: string; failed: string; created_at: Date; filters: Filters;
};

const EVENTS = ["INSERT", "UPDATE", "DELETE"] as const;
const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "null", "notnull"] as const;
type Op = (typeof OPS)[number];
export type Condition = { column: string; op: Op; value?: unknown };
export type Filters = Record<string, Condition[]>;
const MAX_CONDITIONS = 10;
const MAX_IN = 100;
const SQL_OP: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * A table's conditions as SQL over `t`, with every value passed as a parameter. Values are typed by Postgres from the
 * column itself (through jsonb_populate_record), so nothing the caller wrote is ever spliced into the statement.
 */
export function conditionSql(table: string, conds: Condition[], firstParam: number): { sql: string; params: string[] } {
  const tbl = `"public".${ident(table)}`;
  const parts: string[] = [];
  const params: string[] = [];
  for (const c of conds) {
    const col = ident(c.column, "column name");
    if (c.op === "null") parts.push(`t.${col} IS NULL`);
    else if (c.op === "notnull") parts.push(`t.${col} IS NOT NULL`);
    else if (c.op === "in") {
      params.push(JSON.stringify((c.value as unknown[]).map((v) => ({ [c.column]: v }))));
      parts.push(`t.${col} IN (SELECT r.${col} FROM jsonb_populate_recordset(NULL::${tbl}, $${firstParam + params.length - 1}::jsonb) r)`);
    } else {
      params.push(JSON.stringify({ [c.column]: c.value }));
      parts.push(`t.${col} ${SQL_OP[c.op]} (jsonb_populate_record(NULL::${tbl}, $${firstParam + params.length - 1}::jsonb)).${col}`);
    }
  }
  return { sql: parts.join(" AND ") || "true", params };
}
const MAX_TABLES = 50;
const PAYLOAD_LIMIT = 4 * 1024 * 1024;
const MAX_BIGINT = "9223372036854775807";

const blocked = new BlockList();
for (const [n, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(n, p, "ipv4");
for (const [n, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) blocked.addSubnet(n, p, "ipv6");

/** True for addresses a webhook must not reach by default. */
export function isPrivateAddress(addr: string): boolean {
  let a = addr;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (dotted) a = dotted[1]!;
  else if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const family = isIP(a);
  if (!family) return true;
  return blocked.check(a, family === 6 ? "ipv6" : "ipv4");
}

type Target = { url: URL; address: string; family: 4 | 6 };

/** Validate a destination and resolve it once; the connection is then pinned to the address that was checked. */
export async function resolveTarget(raw: string, allowPrivate: boolean): Promise<Target> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, "url is not a valid URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "url must start with https:// or http://");
  if (url.username || url.password) throw new HttpError(400, "url must not contain a username or password");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string; family: number }[];
  try { addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.lookup(host, { all: true }); } catch { throw new HttpError(400, `could not resolve ${host}`); }
  if (!addrs.length) throw new HttpError(400, `could not resolve ${host}`);
  if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "url points to a private or local network address, which pipelines may not use");
  const first = addrs[0]!;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

function post(t: Target, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const lib = t.url.protocol === "https:" ? https : http;
    const host = t.url.hostname.replace(/^\[|\]$/g, "");
    const req = lib.request({
      hostname: host, port: t.url.port || undefined, path: `${t.url.pathname}${t.url.search}`, method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, timeout: timeoutMs,
      servername: isIP(host) ? undefined : host,
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: t.address, family: t.family }]) : cb(null, t.address, t.family))) as never,
    }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (d: Buffer) => { n += d.length; if (n <= 2048) chunks.push(d); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

export const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

const view = (r: PipelineRow) => ({
  id: r.id, name: r.name, tables: r.tables, events: r.events, filters: r.filters ?? {}, url: r.url, include_rows: r.include_rows, enabled: r.enabled, disabled_reason: r.disabled_reason,
  status: !r.enabled ? "paused" : r.consecutive_failures > 0 ? "failing" : "healthy",
  consecutive_failures: r.consecutive_failures, next_attempt_at: r.next_attempt_at, last_attempt_at: r.last_attempt_at, last_success_at: r.last_success_at,
  last_status: r.last_status, last_error: r.last_error, delivered: Number(r.delivered), failed: Number(r.failed), created_at: r.created_at,
});

export class PipelineService {
  private running = new Set<string>();
  private opts: Required<PipelineOptions>;

  constructor(private pool: pg.Pool, private control: ControlPlane, private pm: PoolManager, private vault: Vault, opts: PipelineOptions = {}) {
    this.opts = { allowPrivateTargets: false, batchSize: 100, timeoutMs: 10_000, maxFailures: 30, backoffBaseMs: 5_000, maxPerProject: 10, ...opts };
  }

  private async withAdmin<T>(ref: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const project = await this.pm.active(ref);
    const c = new pg.Client({ connectionString: urlFor(project.adminUrl, project.dbName) });
    c.on("error", () => {});
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }

  private async load(ref: string, id: string): Promise<PipelineRow> {
    const r = await this.pool.query<PipelineRow>(`SELECT * FROM pipelines WHERE id::text = $1 AND ref = $2`, [id, ref]);
    if (!r.rows[0]) throw new HttpError(404, "pipeline not found");
    return r.rows[0];
  }

  private async access(p: Principal, ref: string) {
    ControlPlane.require(p, "admin");
    await this.control.getProject(p, ref);
  }

  // ---- management ----

  async list(p: Principal, ref: string) {
    await this.access(p, ref);
    return (await this.pool.query<PipelineRow>(`SELECT * FROM pipelines WHERE ref = $1 ORDER BY created_at, name`, [ref])).rows.map(view);
  }

  private parse(b: Record<string, unknown>, partial: boolean) {
    const out: { name?: string; tables?: string[]; events?: string[]; url?: string; include_rows?: boolean; enabled?: boolean; filters?: Filters } = {};
    if (b.filters !== undefined) {
      const f = b.filters;
      if (f === null || typeof f !== "object" || Array.isArray(f)) throw new HttpError(400, "filters must be an object of table name to a list of conditions");
      out.filters = {};
      for (const [table, list] of Object.entries(f)) {
        ident(table, "table name");
        if (!Array.isArray(list) || list.length > MAX_CONDITIONS) throw new HttpError(400, `filters for ${table} must be a list of up to ${MAX_CONDITIONS} conditions`);
        out.filters[table] = list.map((c, i) => {
          const x = c as Record<string, unknown>;
          if (x === null || typeof x !== "object" || typeof x.column !== "string") throw new HttpError(400, `filter ${i + 1} on ${table} needs a column`);
          ident(x.column, "column name");
          if (!OPS.includes(x.op as Op)) throw new HttpError(400, `filter ${i + 1} on ${table}: op must be one of ${OPS.join(", ")}`);
          const scalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
          if (x.op === "null" || x.op === "notnull") return { column: x.column, op: x.op as Op };
          if (x.op === "in") {
            if (!Array.isArray(x.value) || !x.value.length || x.value.length > MAX_IN || !x.value.every(scalar)) throw new HttpError(400, `filter ${i + 1} on ${table}: in needs a list of 1-${MAX_IN} values`);
            return { column: x.column, op: "in" as Op, value: x.value };
          }
          if (!scalar(x.value) || x.value === null) throw new HttpError(400, `filter ${i + 1} on ${table}: ${x.op} needs a value`);
          return { column: x.column, op: x.op as Op, value: x.value };
        });
      }
    }
    if (!partial || b.name !== undefined) {
      if (typeof b.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/.test(b.name.trim())) throw new HttpError(400, "name must be 1-60 letters, digits, spaces, dots, dashes or underscores");
      out.name = b.name.trim();
    }
    if (!partial || b.tables !== undefined) {
      if (!Array.isArray(b.tables) || !b.tables.length || b.tables.length > MAX_TABLES || b.tables.some((t) => typeof t !== "string")) throw new HttpError(400, `tables must list 1-${MAX_TABLES} table names`);
      out.tables = [...new Set(b.tables as string[])];
      for (const t of out.tables) ident(t, "table name");
    }
    if (!partial || b.events !== undefined) {
      const ev = b.events ?? [...EVENTS];
      if (!Array.isArray(ev) || !ev.length || ev.some((e) => !EVENTS.includes(e as never))) throw new HttpError(400, `events must be a non-empty list of ${EVENTS.join(", ")}`);
      out.events = [...new Set(ev as string[])];
    }
    if (!partial || b.url !== undefined) {
      if (typeof b.url !== "string" || b.url.length > 2000) throw new HttpError(400, "url is required");
      out.url = b.url.trim();
    }
    if (b.include_rows !== undefined) {
      if (typeof b.include_rows !== "boolean") throw new HttpError(400, "include_rows must be true or false");
      out.include_rows = b.include_rows;
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
      out.enabled = b.enabled;
    }
    return out;
  }

  /** Check each filter against the real columns and types, by running it once with no rows wanted. */
  private async checkFilters(ref: string, tables: string[], filters: Filters) {
    for (const t of Object.keys(filters)) if (!tables.includes(t)) throw new HttpError(400, `a filter is set for ${t}, which this pipeline does not watch`);
    if (!Object.keys(filters).length) return;
    await this.withAdmin(ref, async (c) => {
      for (const [table, conds] of Object.entries(filters)) {
        const cols = new Set((await c.query(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid = format('%I.%I', 'public', $1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [table])).rows.map((r) => r.attname as string));
        for (const x of conds) if (!cols.has(x.column)) throw new HttpError(400, `${table} has no column named ${x.column}`);
        const { sql, params } = conditionSql(table, conds, 1);
        try {
          await c.query(`SELECT 1 FROM "public".${ident(table)} t WHERE ${sql} LIMIT 0`, params);
        } catch (err) {
          throw new HttpError(400, `filter on ${table} is not valid: ${(err as Error).message}`);
        }
      }
    });
  }

  private async prepareProject(ref: string, tables: string[], id?: string, cursorFromNow = false) {
    return this.withAdmin(ref, async (c) => {
      const have = new Set((await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`)).rows.map((r) => r.relname as string));
      const missing = tables.filter((t) => !have.has(t));
      if (missing.length) throw new HttpError(400, `no such table in the public schema: ${missing.join(", ")}`);
      await c.query(`CREATE TABLE IF NOT EXISTS realtime.pipeline_cursors (pipeline_id uuid PRIMARY KEY, cursor bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      await c.query(`GRANT SELECT ON realtime.pipeline_cursors TO service_role`);
      for (const t of tables) await this.installTrigger(c, t);
      if (id && cursorFromNow) await c.query(`INSERT INTO realtime.pipeline_cursors (pipeline_id, cursor) VALUES ($1, coalesce((SELECT max(id) FROM realtime.changes), 0)) ON CONFLICT DO NOTHING`, [id]);
    });
  }

  private async installTrigger(c: pg.Client, table: string) {
    const has = await c.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'baas_realtime' AND tgrelid = format('%I.%I', 'public', $1::text)::regclass`, [table]);
    if (has.rowCount) return;
    await c.query(`CREATE TRIGGER baas_realtime AFTER INSERT OR UPDATE OR DELETE ON "public".${ident(table)} FOR EACH ROW EXECUTE FUNCTION realtime.broadcast_change()`).catch((e) => {
      if ((e as { code?: string }).code !== "42710") throw e;
    });
  }

  async create(p: Principal, ref: string, b: Record<string, unknown>) {
    await this.access(p, ref);
    const v = this.parse(b, false);
    await resolveTarget(v.url!, this.opts.allowPrivateTargets);
    const count = Number((await this.pool.query(`SELECT count(*) FROM pipelines WHERE ref = $1`, [ref])).rows[0].count);
    if (count >= this.opts.maxPerProject) throw new HttpError(409, `a project can have at most ${this.opts.maxPerProject} pipelines`);
    const id = randomUUID();
    await this.prepareProject(ref, v.tables!, id, true);
    await this.checkFilters(ref, v.tables!, v.filters ?? {}).catch(async (e) => {
      await this.withAdmin(ref, (c) => c.query(`DELETE FROM realtime.pipeline_cursors WHERE pipeline_id = $1`, [id])).catch(() => {});
      throw e;
    });
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    try {
      const r = await this.pool.query<PipelineRow>(
        `INSERT INTO pipelines (id, ref, name, tables, events, url, secret_enc, include_rows, created_by, filters) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
        [id, ref, v.name, v.tables, v.events, v.url, this.vault.seal(secret, `pipeline:${id}`), v.include_rows ?? true, p.tokenId, JSON.stringify(v.filters ?? {})],
      );
      await this.control.audit(p.tokenId, p.orgId, "pipeline.create", ref, { name: v.name, tables: v.tables });
      return { ...view(r.rows[0]!), secret };
    } catch (err) {
      await this.withAdmin(ref, (c) => c.query(`DELETE FROM realtime.pipeline_cursors WHERE pipeline_id = $1`, [id])).catch(() => {});
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "a pipeline with that name already exists");
      throw err;
    }
  }

  async update(p: Principal, ref: string, id: string, b: Record<string, unknown>) {
    await this.access(p, ref);
    const cur = await this.load(ref, id);
    const v = this.parse(b, true);
    if (v.url !== undefined) await resolveTarget(v.url, this.opts.allowPrivateTargets);
    if (v.tables) await this.prepareProject(ref, v.tables);
    if (v.filters !== undefined || v.tables) {
      // Filters for a table that is no longer watched are dropped rather than left behind.
      const tables = v.tables ?? cur.tables;
      const filters = v.filters ?? Object.fromEntries(Object.entries(cur.filters ?? {}).filter(([t]) => tables.includes(t)));
      await this.checkFilters(ref, tables, filters);
      v.filters = filters;
    }
    const enabling = v.enabled === true && !cur.enabled;
    const r = await this.pool.query<PipelineRow>(
      `UPDATE pipelines SET name = coalesce($3, name), tables = coalesce($4, tables), events = coalesce($5, events), url = coalesce($6, url), include_rows = coalesce($7, include_rows), filters = coalesce($10::jsonb, filters),
         enabled = coalesce($8, enabled),
         disabled_reason = CASE WHEN $8 IS NOT NULL THEN NULL ELSE disabled_reason END,
         consecutive_failures = CASE WHEN $9 THEN 0 ELSE consecutive_failures END, next_attempt_at = CASE WHEN $9 THEN NULL ELSE next_attempt_at END
       WHERE id::text = $1 AND ref = $2 RETURNING *`,
      [id, ref, v.name ?? null, v.tables ?? null, v.events ?? null, v.url ?? null, v.include_rows ?? null, v.enabled ?? null, enabling, v.filters === undefined ? null : JSON.stringify(v.filters)],
    ).catch((err) => {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "a pipeline with that name already exists");
      throw err;
    });
    await this.control.audit(p.tokenId, p.orgId, "pipeline.update", ref, { id, fields: Object.keys(v) });
    return view(r.rows[0]!);
  }

  async remove(p: Principal, ref: string, id: string) {
    await this.access(p, ref);
    await this.load(ref, id);
    await this.pool.query(`DELETE FROM pipelines WHERE id::text = $1 AND ref = $2`, [id, ref]);
    await this.withAdmin(ref, (c) => c.query(`DELETE FROM realtime.pipeline_cursors WHERE pipeline_id::text = $1`, [id])).catch(() => {});
    await this.control.audit(p.tokenId, p.orgId, "pipeline.delete", ref, { id });
  }

  async rotateSecret(p: Principal, ref: string, id: string) {
    await this.access(p, ref);
    const cur = await this.load(ref, id);
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await this.pool.query(`UPDATE pipelines SET secret_enc = $2 WHERE id = $1`, [cur.id, this.vault.seal(secret, `pipeline:${cur.id}`)]);
    await this.control.audit(p.tokenId, p.orgId, "pipeline.rotate_secret", ref, { id });
    return { secret };
  }

  async deliveries(p: Principal, ref: string, id: string) {
    await this.access(p, ref);
    await this.load(ref, id);
    return (await this.pool.query(`SELECT id, at, kind, ok, status, ms, events, first_change, last_change, error FROM pipeline_deliveries WHERE pipeline_id::text = $1 ORDER BY id DESC LIMIT 50`, [id])).rows;
  }

  /** Send a sample event now to check the destination and signature. It does not move the pipeline's cursor. */
  async test(p: Principal, ref: string, id: string) {
    await this.access(p, ref);
    const row = await this.load(ref, id);
    const body = JSON.stringify({ id: randomUUID(), type: "test", project: ref, pipeline: { id: row.id, name: row.name }, sent_at: new Date().toISOString(), events: [] });
    const res = await this.send(row, body, "test", 0, null, null);
    await this.control.audit(p.tokenId, p.orgId, "pipeline.test", ref, { id, ok: res.ok });
    return res;
  }

  /** Deliver whatever is pending right now, ignoring any back-off. */
  async run(p: Principal, ref: string, id: string) {
    await this.access(p, ref);
    const row = await this.load(ref, id);
    if (!row.enabled) throw new HttpError(409, "the pipeline is paused; resume it first");
    await this.deliver(row);
    return view(await this.load(ref, id));
  }

  // ---- delivery ----

  /** One background pass: every enabled pipeline that is due, on an active project. */
  async tick(): Promise<number> {
    const due = await this.pool.query<PipelineRow>(
      `SELECT p.* FROM pipelines p JOIN projects j ON j.ref = p.ref WHERE p.enabled AND j.status = 'active' AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= now()) ORDER BY p.last_attempt_at NULLS FIRST LIMIT 200`,
    );
    for (let i = 0; i < due.rows.length; i += 5) await Promise.allSettled(due.rows.slice(i, i + 5).map((r) => this.deliver(r)));
    return due.rows.length;
  }

  private async send(row: PipelineRow, body: string, kind: "delivery" | "test", events: number, first: string | null, last: string | null) {
    const started = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      const target = await resolveTarget(row.url, this.opts.allowPrivateTargets);
      const secret = this.vault.open(row.secret_enc, `pipeline:${row.id}`);
      const t = Math.floor(Date.now() / 1000);
      const res = await post(target, body, {
        "content-type": "application/json", "user-agent": "baas-pipelines/1", "x-baas-signature": sign(secret, t, body), "x-baas-delivery": randomUUID(), "x-baas-event": kind === "test" ? "test" : "changes",
      }, this.opts.timeoutMs);
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `destination answered ${res.status}${res.text ? `: ${res.text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`;
    } catch (err) {
      error = (err as Error).message || "delivery failed";
    }
    const ms = Date.now() - started;
    await this.pool.query(
      `INSERT INTO pipeline_deliveries (pipeline_id, kind, ok, status, ms, events, first_change, last_change, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.id, kind, error === null, status, ms, events, first, last, error],
    );
    await this.pool.query(
      `DELETE FROM pipeline_deliveries WHERE pipeline_id = $1 AND id < (SELECT id FROM pipeline_deliveries WHERE pipeline_id = $1 ORDER BY id DESC OFFSET 99 LIMIT 1)`,
      [row.id],
    );
    return { ok: error === null, status, error, ms };
  }

  private async deliver(row: PipelineRow): Promise<void> {
    if (this.running.has(row.id)) return;
    this.running.add(row.id);
    try {
      const batch = await this.collect(row);
      if (!batch) return;
      const { events, lastSeen, first, last } = batch;
      if (!events.length) {
        await this.advance(row, lastSeen);
        return;
      }
      const body = JSON.stringify({ id: randomUUID(), type: "changes", project: row.ref, pipeline: { id: row.id, name: row.name }, sent_at: new Date().toISOString(), events });
      if (Buffer.byteLength(body) > PAYLOAD_LIMIT) throw new Error("batch is larger than 4 MB; turn off include_rows or watch narrower tables");
      const res = await this.send(row, body, "delivery", events.length, first, last);
      if (res.ok) {
        await this.advance(row, lastSeen);
        await this.pool.query(
          `UPDATE pipelines SET delivered = delivered + $2, consecutive_failures = 0, next_attempt_at = NULL, last_attempt_at = now(), last_success_at = now(), last_status = $3, last_error = NULL WHERE id = $1`,
          [row.id, events.length, res.status],
        );
      } else {
        await this.fail(row, res.status, res.error!);
      }
    } catch (err) {
      await this.fail(row, null, (err as Error).message || "delivery failed").catch(() => {});
    } finally {
      this.running.delete(row.id);
    }
  }

  private async fail(row: PipelineRow, status: number | null, error: string) {
    const n = row.consecutive_failures + 1;
    const delay = Math.min(this.opts.backoffBaseMs * 2 ** (n - 1), 15 * 60_000);
    const stop = n >= this.opts.maxFailures;
    await this.pool.query(
      `UPDATE pipelines SET failed = failed + 1, consecutive_failures = $2, last_attempt_at = now(), last_status = $3, last_error = $4,
         next_attempt_at = now() + ($5::int * interval '1 millisecond'), enabled = enabled AND NOT $6,
         disabled_reason = CASE WHEN $6 THEN $7 ELSE disabled_reason END WHERE id = $1`,
      [row.id, n, status, error.slice(0, 500), delay, stop, `Paused after ${n} failed deliveries in a row. Last error: ${error.slice(0, 200)}`],
    );
  }

  /** Read the next matching changes and their rows. Returns null when there is nothing to do or the project is not reachable. */
  private async collect(row: PipelineRow) {
    return this.withAdmin(row.ref, async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS realtime.pipeline_cursors (pipeline_id uuid PRIMARY KEY, cursor bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      const cur = await c.query(`INSERT INTO realtime.pipeline_cursors (pipeline_id, cursor) VALUES ($1, coalesce((SELECT max(id) FROM realtime.changes), 0)) ON CONFLICT (pipeline_id) DO UPDATE SET pipeline_id = excluded.pipeline_id RETURNING cursor::text`, [row.id]);
      const cursor = cur.rows[0].cursor as string;
      const rows = (await c.query(`SELECT id::text, at, table_name, op, pk FROM realtime.changes WHERE id > $1::bigint ORDER BY id LIMIT 1000`, [cursor])).rows as { id: string; at: Date; table_name: string; op: string; pk: Record<string, unknown> | null }[];
      if (!rows.length) return null;
      const want = rows.filter((r) => row.tables.includes(r.table_name) && row.events.includes(r.op));
      const chosen = want.slice(0, this.opts.batchSize);
      const lastSeen = chosen.length && chosen.length === this.opts.batchSize && want.length > chosen.length ? chosen[chosen.length - 1]!.id : rows[rows.length - 1]!.id;
      const events = [];
      for (const ch of chosen) {
        let record: unknown = null;
        const conds = row.filters?.[ch.table_name];
        const hasKey = ch.pk && Object.keys(ch.pk).length > 0;
        if (ch.op !== "DELETE" && hasKey && (row.include_rows || conds?.length)) {
          const keys = Object.keys(ch.pk!);
          const tbl = `"public".${ident(ch.table_name)}`;
          const f = conds?.length ? conditionSql(ch.table_name, conds, 2) : { sql: "true", params: [] as string[] };
          const r = await c.query(
            `SELECT to_jsonb(t) AS rec FROM ${tbl} t WHERE ROW(${keys.map((k) => `t.${ident(k)}`).join(", ")}) = (SELECT ${keys.map((k) => `r.${ident(k)}`).join(", ")} FROM jsonb_populate_record(NULL::${tbl}, $1::jsonb) r) AND ${f.sql} LIMIT 1`,
            [JSON.stringify(ch.pk), ...f.params],
          ).catch((e) => {
            if (conds?.length) throw e; // a filter that stopped working must show up as a failing pipeline, not as silently dropped rows
            return null;
          });
          // A filtered table only sends rows that match right now. A row that is gone or no longer matches is skipped.
          if (conds?.length && !r?.rows[0]) continue;
          record = row.include_rows ? (r?.rows[0]?.rec ?? null) : null;
        } else if (ch.op !== "DELETE" && conds?.length) {
          continue; // cannot be checked without a key
        }
        events.push({ id: ch.id, at: ch.at, schema: "public", table: ch.table_name, type: ch.op, pk: ch.pk, record });
      }
      const first = events[0]?.id ?? null, last = events[events.length - 1]?.id ?? null;
      return { events, lastSeen, first, last };
    });
  }

  private async advance(row: PipelineRow, to: string) {
    await this.withAdmin(row.ref, async (c) => {
      await c.query(`UPDATE realtime.pipeline_cursors SET cursor = greatest(cursor, $2::bigint), updated_at = now() WHERE pipeline_id = $1`, [row.id, to]);
      // Nothing else prunes the log when no one is subscribed over Realtime, so do it here: keep what any pipeline still needs, for at most a day.
      await c.query(`DELETE FROM realtime.changes WHERE (at < now() - interval '2 minutes' AND id <= coalesce((SELECT min(cursor) FROM realtime.pipeline_cursors), ${MAX_BIGINT})) OR at < now() - interval '24 hours'`);
    });
  }
}
