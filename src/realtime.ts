import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { HttpError } from "./control.js";
import { type Helpers, type Mountable, type ProjectCtx } from "./gateway.js";
import { verifyJwt } from "./keys.js";
import { API_ROLES, type ApiRole, type PoolManager } from "./pools.js";
import { urlFor } from "./provision.js";
import { condition, ident } from "./rest.js";

/**
 * Change feed over WebSocket, one shared LISTEN connection per project.
 *
 * Protocol (JSON text frames):
 *   -> {type:"subscribe", ref, table, event?:"*"|"INSERT"|"UPDATE"|"DELETE", filter?:"col=op.value"}
 *   <- {type:"subscribed", ref} | {type:"error", ref?, message}
 *   <- {type:"change", ref, schema, table, event, new?, old?}
 *   -> {type:"unsubscribe", ref} | {type:"access_token", token} | {type:"heartbeat"}
 *
 * Row-level security is honoured: an INSERT or UPDATE is delivered only if the subscriber's own role can
 * read the row right now. DELETE events carry only the primary key and go to service_role, or to other
 * roles when the table has no RLS. Filtered subscriptions receive no DELETE events.
 */

type Sub = { id: string; table: string; events: Set<string>; filter?: { col: string; spec: string } };
type Conn = {
  ws: WebSocket; ref: string; role: ApiRole; claims: Record<string, unknown>; subs: Map<string, Sub>; alive: boolean;
};
type Change = { id: string; schema_name: string; table_name: string; op: "INSERT" | "UPDATE" | "DELETE"; pk: Record<string, unknown> | null };

export type RealtimeOptions = {
  maxConnsPerProject?: number;
  maxSubsPerConn?: number;
  /** How often to ping sockets and re-check that the project is still active. */
  checkMs?: number;
};

class Feed {
  conns = new Set<Conn>();
  client?: pg.Client;
  queue: Promise<void> = Promise.resolve();
  cleanup?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  stopped = false;
  /** Resolves once LISTEN is active; a subscription is only acknowledged after this. */
  ready?: Promise<void>;
  enabled = new Set<string>();
  constructor(readonly ref: string) {}
}

export class RealtimeHub implements Mountable {
  private feeds = new Map<string, Feed>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private beat?: NodeJS.Timeout;

  constructor(private pm: PoolManager, private opts: RealtimeOptions = {}) {}

  mount(app: FastifyInstance, { authenticate }: Helpers): void {
    const domainRef = (req: IncomingMessage) => (app as unknown as { refFromHost(h?: string): string | null }).refFromHost?.(req.headers.host) ?? null;
    app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/realtime/v1/websocket") return; // not ours; another upgrade handler may take it
      const reject = (code: number, msg: string) => {
        socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      };
      const ref = domainRef(req);
      if (!ref) return reject(404, "Not Found");
      const fake = { projectRef: ref, headers: req.headers, query: Object.fromEntries(url.searchParams) } as unknown as FastifyRequest;
      authenticate(fake)
        .then((ctx) => {
          const feed = this.feeds.get(ref);
          if ((feed?.conns.size ?? 0) >= (this.opts.maxConnsPerProject ?? 200)) return reject(429, "Too Many Requests");
          this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ctx));
        })
        .catch((err) => reject(err instanceof HttpError ? err.status : 500, err instanceof HttpError ? err.message.replace(/[\r\n]/g, " ") : "error"));
    });
    const every = this.opts.checkMs ?? 30_000;
    this.beat = setInterval(() => void this.sweep(), every);
    this.beat.unref();
    app.addHook("onClose", async () => this.close());
  }

  private async sweep() {
    for (const feed of this.feeds.values()) {
      const ok = await this.pm.active(feed.ref).then(() => true, () => false);
      for (const c of [...feed.conns]) {
        if (!ok) c.ws.close(4002, "project unavailable");
        else if (typeof c.claims.exp === "number" && c.claims.exp < Date.now() / 1000) c.ws.close(4001, "token expired");
        else if (!c.alive) c.ws.terminate();
        else {
          c.alive = false;
          c.ws.ping();
        }
      }
    }
  }

  private send(c: Conn, msg: object) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private onConnection(ws: WebSocket, ctx: ProjectCtx) {
    const conn: Conn = { ws, ref: ctx.ref, role: ctx.who.role, claims: ctx.who.claims, subs: new Map(), alive: true };
    const feed = this.feeds.get(ctx.ref) ?? this.newFeed(ctx.ref);
    feed.conns.add(conn);
    if (feed.idleTimer) clearTimeout(feed.idleTimer);
    ws.on("pong", () => (conn.alive = true));
    // Messages on one socket are handled strictly in order: a subscribe sent right after an access_token
    // must be evaluated with the new identity.
    let chain: Promise<void> = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      conn.alive = true;
      if (isBinary) return this.send(conn, { type: "error", message: "binary frames are not supported" });
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
        if (msg === null || typeof msg !== "object" || Array.isArray(msg)) throw new Error();
      } catch {
        return this.send(conn, { type: "error", message: "invalid JSON" });
      }
      chain = chain.then(() => this.onMessage(conn, feed, msg)).catch(() => this.send(conn, { type: "error", ref: msg.ref, message: "internal error" }));
    });
    ws.on("close", () => {
      feed.conns.delete(conn);
      if (feed.conns.size === 0) feed.idleTimer = setTimeout(() => this.stopFeed(feed), 10_000);
    });
    ws.on("error", () => {});
    this.send(conn, { type: "connected", role: conn.role });
    this.startFeed(feed).catch(() => {});
  }

  private async onMessage(conn: Conn, feed: Feed, msg: Record<string, unknown>) {
    switch (msg.type) {
      case "heartbeat":
        return this.send(conn, { type: "heartbeat" });
      case "unsubscribe":
        conn.subs.delete(String(msg.ref));
        return;
      case "access_token": {
        const project = await this.pm.active(conn.ref).catch(() => null);
        const claims = project && typeof msg.token === "string" ? verifyJwt(msg.token, project.secrets.jwtSecret) : null;
        if (!claims || !API_ROLES.has(claims.role) || (claims.role === "authenticated" && typeof claims.sub !== "string"))
          return this.send(conn, { type: "error", message: "invalid access token" });
        conn.claims = claims;
        conn.role = claims.role as ApiRole;
        return this.send(conn, { type: "access_token_ok", role: conn.role });
      }
      case "subscribe":
        return this.subscribe(conn, feed, msg);
      default:
        return this.send(conn, { type: "error", message: "unknown message type" });
    }
  }

  private async subscribe(conn: Conn, feed: Feed, msg: Record<string, unknown>) {
    const id = typeof msg.ref === "string" && msg.ref.length > 0 && msg.ref.length <= 64 ? msg.ref : null;
    const fail = (message: string) => this.send(conn, { type: "error", ref: id ?? undefined, message });
    if (!id) return fail("ref must be a non-empty string up to 64 chars");
    if (conn.subs.size >= (this.opts.maxSubsPerConn ?? 50) && !conn.subs.has(id)) return fail("too many subscriptions");
    if (msg.schema !== undefined && msg.schema !== "public") return fail("only the public schema is available");
    const table = String(msg.table ?? "");
    const event = String(msg.event ?? "*").toUpperCase();
    if (!["*", "INSERT", "UPDATE", "DELETE"].includes(event)) return fail("event must be *, INSERT, UPDATE or DELETE");
    let filter: Sub["filter"];
    try {
      ident(table, "table");
      if (msg.filter !== undefined) {
        const m = /^([A-Za-z_][A-Za-z0-9_]{0,62})=(.+)$/.exec(String(msg.filter));
        if (!m) return fail("filter must look like column=op.value");
        ident(m[1]!, "column");
        condition('"x"', m[2]!, []); // validates the operator and value shape
        filter = { col: m[1]!, spec: m[2]! };
      }
    } catch (err) {
      return fail((err as Error).message);
    }
    // One answer for "missing", "no privilege" and "no primary key" so a caller cannot probe the schema.
    const generic = "cannot subscribe to this table";
    const info = await this.pm.withRole(conn.ref, { role: conn.role, claims: conn.claims, readOnly: true }, async (c) =>
      (await c.query<{ can: boolean; pk: string[] | null }>(
        `SELECT has_table_privilege(current_user, c.oid, 'SELECT') AS can,
                (SELECT array_agg(a.attname::text) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                 WHERE i.indrelid = c.oid AND i.indisprimary) AS pk
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'p')`,
        [table],
      )).rows[0],
    );
    if (!info || !info.can || !info.pk?.length) return fail(generic);
    await this.enable(feed, table);
    try {
      await this.startFeed(feed);
    } catch {
      return fail("realtime is temporarily unavailable");
    }
    conn.subs.set(id, { id, table, events: new Set(event === "*" ? ["INSERT", "UPDATE", "DELETE"] : [event]), filter });
    this.send(conn, { type: "subscribed", ref: id });
  }

  /** Install the change trigger on a table (idempotent). Done with platform credentials, never the caller's. */
  private async enable(feed: Feed, table: string) {
    if (feed.enabled.has(table)) return;
    const project = await this.pm.active(feed.ref);
    const c = new pg.Client({ connectionString: urlFor(project.adminUrl, project.dbName) });
    c.on("error", () => {});
    await c.connect();
    try {
      const has = await c.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'baas_realtime' AND tgrelid = format('%I.%I', 'public', $1::text)::regclass`, [table]);
      if (!has.rowCount)
        await c.query(`CREATE TRIGGER baas_realtime AFTER INSERT OR UPDATE OR DELETE ON "public".${ident(table)} FOR EACH ROW EXECUTE FUNCTION realtime.broadcast_change()`).catch((e) => {
          if ((e as { code?: string }).code !== "42710") throw e; // already created by a concurrent subscriber
        });
      feed.enabled.add(table);
    } finally {
      await c.end().catch(() => {});
    }
  }

  // ---- feeds ----

  private newFeed(ref: string): Feed {
    const f = new Feed(ref);
    this.feeds.set(ref, f);
    return f;
  }

  private startFeed(feed: Feed): Promise<void> {
    if (!feed.ready) feed.ready = this.listen(feed).finally(() => void 0);
    return feed.ready;
  }

  private async listen(feed: Feed): Promise<void> {
    if (feed.client || feed.stopped) return;
    try {
      const { url } = await this.pm.pool(feed.ref);
      const client = new pg.Client({ connectionString: url });
      feed.client = client;
      client.on("notification", (n) => {
        if (n.channel !== "realtime_changes" || !n.payload) return;
        feed.queue = feed.queue.then(() => this.dispatch(feed, n.payload!)).catch(() => {});
      });
      const reconnect = () => {
        if (feed.client === client) {
          feed.client = undefined;
          feed.ready = undefined;
        }
        if (!feed.stopped && feed.conns.size) setTimeout(() => void this.startFeed(feed).catch(() => {}), 1000).unref();
      };
      client.on("error", reconnect);
      client.on("end", reconnect);
      await client.connect();
      await client.query("LISTEN realtime_changes");
      feed.cleanup ??= setInterval(() => void this.prune(feed), 60_000).unref();
    } catch (err) {
      feed.client = undefined;
      feed.ready = undefined;
      if (!feed.stopped && feed.conns.size) setTimeout(() => void this.startFeed(feed).catch(() => {}), 2000).unref();
      throw err;
    }
  }

  private async prune(feed: Feed) {
    await this.pm
      .withRole(feed.ref, { role: "service_role", claims: { role: "service_role" } }, async (c) => {
        // Pipelines read the same log; keep what any of them still needs, but never more than a day.
        const piped = (await c.query(`SELECT to_regclass('realtime.pipeline_cursors') IS NOT NULL AS yes`)).rows[0].yes;
        if (!piped) return c.query(`DELETE FROM realtime.changes WHERE at < now() - interval '2 minutes'`);
        return c.query(`DELETE FROM realtime.changes WHERE (at < now() - interval '2 minutes' AND id <= coalesce((SELECT min(cursor) FROM realtime.pipeline_cursors), 9223372036854775807)) OR at < now() - interval '24 hours'`);
      })
      .catch(() => {});
  }

  private stopFeed(feed: Feed) {
    if (feed.conns.size) return;
    feed.stopped = true;
    if (feed.cleanup) clearInterval(feed.cleanup);
    void feed.client?.end().catch(() => {});
    this.feeds.delete(feed.ref);
  }

  private async dispatch(feed: Feed, changeId: string) {
    if (!/^\d+$/.test(changeId)) return;
    const change = await this.pm
      .withRole(feed.ref, { role: "service_role", claims: { role: "service_role" } }, async (c) =>
        (await c.query<Change>(`SELECT id::text, schema_name, table_name, op, pk FROM realtime.changes WHERE id = $1`, [changeId])).rows[0],
      )
      .catch(() => undefined);
    if (!change?.pk) return;
    await Promise.all(
      [...feed.conns].flatMap((conn) =>
        [...conn.subs.values()].filter((s) => s.table === change.table_name && s.events.has(change.op)).map((s) => this.deliver(conn, s, change).catch(() => {})),
      ),
    );
  }

  private async deliver(conn: Conn, sub: Sub, ch: Change) {
    const pk = ch.pk!;
    const cols = Object.keys(pk);
    if (ch.op === "DELETE") {
      if (sub.filter) return;
      if (conn.role !== "service_role") {
        const open = await this.pm.withRole(conn.ref, { role: conn.role, claims: conn.claims, readOnly: true }, async (c) =>
          (await c.query<{ ok: boolean }>(
            `SELECT NOT c.relrowsecurity AND has_table_privilege(current_user, c.oid, 'SELECT') AS ok FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`, [sub.table])).rows[0]?.ok === true,
        );
        if (!open) return;
      }
      return this.send(conn, { type: "change", ref: sub.id, schema: "public", table: sub.table, event: "DELETE", old: pk });
    }
    const qt = `"public".${ident(sub.table)}`;
    const params: unknown[] = [];
    const conds = cols.map((k) => {
      params.push(pk[k] !== null && typeof pk[k] === "object" ? JSON.stringify(pk[k]) : String(pk[k]));
      return `${qt}.${ident(k)} = $${params.length}`;
    });
    if (sub.filter) conds.push(condition(`${qt}.${ident(sub.filter.col)}`, sub.filter.spec, params));
    const row = await this.pm.withRole(conn.ref, { role: conn.role, claims: conn.claims, readOnly: true }, async (c) =>
      (await c.query<{ r: unknown }>(`SELECT to_jsonb(_r) AS r FROM (SELECT * FROM ${qt} WHERE ${conds.join(" AND ")}) _r`, params)).rows[0]?.r,
    );
    if (row === undefined) return; // not visible to this subscriber (RLS or filter)
    this.send(conn, { type: "change", ref: sub.id, schema: "public", table: sub.table, event: ch.op, new: row, old: ch.op === "UPDATE" ? pk : undefined });
  }

  async close() {
    if (this.beat) clearInterval(this.beat);
    for (const feed of this.feeds.values()) {
      feed.stopped = true;
      if (feed.cleanup) clearInterval(feed.cleanup);
      if (feed.idleTimer) clearTimeout(feed.idleTimer);
      for (const c of feed.conns) c.ws.terminate();
      await feed.client?.end().catch(() => {});
    }
    this.feeds.clear();
    this.wss.close();
  }
}
