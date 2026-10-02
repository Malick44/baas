import type pg from "pg";
import { HttpError } from "./control.js";
import type { ApiRole, PoolManager } from "./pools.js";
import { buildEmbeds, loadRelationships, parseSelectTree } from "./rest-embed.js";

/**
 * PostgREST-compatible subset over one project's `public` schema.
 * Supported: select (columns, aliases), filters (eq neq gt gte lt lte like ilike is in, not.), or/and (flat),
 * order, limit/offset/Range, Prefer count/return/resolution, single-object Accept, POST/PATCH/DELETE, upsert, rpc.
 * Embedded resources (select=*,orders(*)) follow foreign keys: see rest-embed.ts. Not supported: JSON path operators, casts. Unfiltered PATCH/DELETE is rejected.
 * Every value is a bound parameter; identifiers are validated, then quoted.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "or", "and", "apikey"]);
const MAX_ROWS = 1000;
const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" };

export class RestError extends HttpError {
  constructor(status: number, readonly code: string, message: string, readonly details: string | null = null, readonly hint: string | null = null) {
    super(status, message);
  }
}

const bad = (message: string, code = "PGRST100") => new RestError(400, code, message);

export function ident(id: string, what = "identifier"): string {
  if (!IDENT.test(id)) throw bad(`invalid ${what}: ${JSON.stringify(id.slice(0, 64))}`);
  return `"${id}"`;
}

/** Split on commas that are not inside parentheses or double quotes. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    if (ch === "," && depth === 0 && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || out.length) out.push(cur);
  return out;
}

function parseList(v: string): string[] {
  if (!v.startsWith("(") || !v.endsWith(")")) throw bad("in.() expects a parenthesised list");
  const inner = v.slice(1, -1);
  if (inner.trim() === "") return [];
  return splitTop(inner).map((x) => (x.startsWith('"') && x.endsWith('"') && x.length >= 2 ? x.slice(1, -1).replace(/\\(.)/g, "$1") : x));
}

export function condition(qcol: string, spec: string, params: unknown[]): string {
  let neg = false;
  let s = spec;
  if (s.startsWith("not.")) {
    neg = true;
    s = s.slice(4);
  }
  const dot = s.indexOf(".");
  if (dot < 0) throw bad(`malformed filter: ${JSON.stringify(spec.slice(0, 64))}`);
  const op = s.slice(0, dot);
  const val = s.slice(dot + 1);
  let sql: string;
  if (Object.hasOwn(OPS, op)) {
    params.push(op === "like" || op === "ilike" ? val.replace(/\*/g, "%") : val);
    sql = `${qcol} ${OPS[op]} $${params.length}`;
  } else if (op === "is") {
    const v = val.toLowerCase();
    if (!["null", "true", "false", "unknown"].includes(v)) throw bad("is. expects null, true, false or unknown");
    sql = `${qcol} IS ${v.toUpperCase()}`;
  } else if (op === "in") {
    params.push(parseList(val));
    sql = `${qcol} = ANY($${params.length})`;
  } else throw bad(`unsupported operator: ${JSON.stringify(op.slice(0, 32))}`);
  return neg ? `NOT (${sql})` : sql;
}

/** WHERE conditions from a PostgREST query string, qualified with the table name. */
export function buildFilters(table: string, query: Record<string, string | string[] | undefined>, params: unknown[]): string[] {
  const qt = ident(table, "table");
  const conds: string[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined) continue;
    const vals = Array.isArray(raw) ? raw : [raw];
    if (key === "or" || key === "and") {
      for (const v of vals) {
        if (!v.startsWith("(") || !v.endsWith(")")) throw bad(`${key}= expects a parenthesised list`);
        const parts = splitTop(v.slice(1, -1)).map((item) => {
          if (/^(and|or|not\.and|not\.or)\(/.test(item)) throw bad("nested and/or is not supported");
          const i = item.indexOf(".");
          if (i < 0) throw bad("malformed or/and item");
          return condition(`${qt}.${ident(item.slice(0, i), "column")}`, item.slice(i + 1), params);
        });
        if (parts.length) conds.push(`(${parts.join(key === "or" ? " OR " : " AND ")})`);
      }
      continue;
    }
    if (RESERVED.has(key)) continue;
    if (key.includes(".")) continue; // filters on an embedded resource: <name>.<column>=…, applied where the embed is built
    for (const v of vals) conds.push(condition(`${qt}.${ident(key, "column")}`, v, params));
  }
  return conds;
}

function parseOrder(order: string | undefined): string {
  if (!order) return "";
  const items = splitTop(order).map((item) => {
    const [col, ...mods] = item.split(".");
    let dir = "";
    let nulls = "";
    for (const m of mods) {
      if (m === "asc") dir = " ASC";
      else if (m === "desc") dir = " DESC";
      else if (m === "nullsfirst") nulls = " NULLS FIRST";
      else if (m === "nullslast") nulls = " NULLS LAST";
      else throw bad(`unsupported order modifier: ${JSON.stringify(m.slice(0, 32))}`);
    }
    return `${ident(col!, "column")}${dir}${nulls}`;
  });
  return ` ORDER BY ${items.join(", ")}`;
}

function nonNegInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw bad(`${name} must be a non-negative integer`);
  return Number(v);
}

export function mapPgError(err: unknown, role: string): RestError {
  if (err instanceof RestError) return err;
  if (err instanceof HttpError) return new RestError(err.status, "PGRST000", err.message);
  const e = err as { code?: string; message?: string; detail?: string; hint?: string };
  const code = e.code ?? "";
  const details = e.detail ?? null;
  const hint = e.hint ?? null;
  const msg = e.message ?? "error";
  if (code === "42P01" || code === "42883") return new RestError(404, code, msg, details, hint);
  if (code === "42501") return new RestError(role === "anon" ? 401 : 403, code, msg, details, hint);
  if (code === "23505" || code === "23503") return new RestError(409, code, msg, details, hint);
  if (code === "57014") return new RestError(408, code, "canceling statement due to timeout");
  if (code === "53300") return new RestError(503, code, "too many connections for this project");
  if (code === "25006") return new RestError(405, code, msg);
  if (/^(22|23|42|21)/.test(code)) return new RestError(400, code, msg, details, hint);
  if (/^(P0001)$/.test(code)) return new RestError(400, code, msg, details, hint);
  return new RestError(500, "PGRST000", "internal error");
}

export type RestRequest = {
  ref: string;
  role: ApiRole;
  claims: Record<string, unknown>;
  method: string;
  path: string; // after /rest/v1/
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | undefined;
};
export type RestResponse = { status: number; headers: Record<string, string>; body: string };

const q = (query: RestRequest["query"], k: string): string | undefined => {
  const v = query[k];
  return Array.isArray(v) ? v[0] : v;
};

const header = (h: RestRequest["headers"], k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v.join(",") : v;
};

function prefer(h: RestRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header(h, "prefer") ?? "").split(",")) {
    const [k, v] = part.trim().split("=");
    if (k) out[k] = v ?? "true";
  }
  return out;
}

function jsonBody(buf: Buffer | undefined): unknown {
  if (!buf || buf.length === 0) throw bad("request body is required", "PGRST102");
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw bad("invalid JSON body", "PGRST102");
  }
}

const AGG = (inner: string) => `SELECT coalesce(json_agg(_t), '[]'::json)::text AS body, count(*)::int AS n FROM (${inner}) _t`;

async function primaryKey(c: pg.PoolClient, table: string): Promise<string[]> {
  const r = await c.query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = format('%I.%I', 'public', $1::text)::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [table],
  );
  return r.rows.map((x) => x.attname);
}

export async function handleRest(pm: PoolManager, req: RestRequest): Promise<RestResponse> {
  try {
    return await run(pm, req);
  } catch (err) {
    const e = mapPgError(err, req.role);
    return {
      status: e.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: e.code, message: e.message, details: e.details, hint: e.hint }),
    };
  }
}

async function run(pm: PoolManager, req: RestRequest): Promise<RestResponse> {
  const profile = header(req.headers, req.method === "GET" || req.method === "HEAD" ? "accept-profile" : "content-profile");
  if (profile && profile !== "public") throw new RestError(406, "PGRST106", "only the public schema is exposed");
  const segs = req.path.split("/").filter(Boolean);
  const pf = prefer(req.headers);
  const wantsObject = (header(req.headers, "accept") ?? "").includes("application/vnd.pgrst.object+json");
  const json = { "content-type": "application/json" };

  if (segs.length === 0) return { status: 200, headers: json, body: JSON.stringify({ message: "baas REST" }) };

  if (segs[0] === "rpc" && segs.length === 2) return rpc(pm, req, segs[1]!, wantsObject);
  if (segs.length !== 1) throw new RestError(404, "PGRST125", "invalid path");
  const table = segs[0]!;
  const qt = `"public".${ident(table, "table")}`;
  const params: unknown[] = [];
  const readOnly = req.method === "GET" || req.method === "HEAD";

  const ctx = { role: req.role, claims: req.claims, readOnly };

  if (readOnly) {
    const tree = parseSelectTree(q(req.query, "select"));
    let limit = nonNegInt(q(req.query, "limit"), "limit");
    let offset = nonNegInt(q(req.query, "offset"), "offset") ?? 0;
    const range = /^(\d+)-(\d*)$/.exec(header(req.headers, "range") ?? "");
    if (range) {
      offset = Number(range[1]);
      if (range[2]) limit = Number(range[2]) - offset + 1;
    }
    limit = Math.min(limit ?? MAX_ROWS, MAX_ROWS);
    const order = parseOrder(q(req.query, "order"));
    const out = await pm.withRole(req.ref, ctx, async (c) => {
      const conds = buildFilters(table, req.query, params);
      const selects = [...tree.columns];
      const dotted = Object.keys(req.query).filter((k) => k.includes(".") && !["or", "and"].includes(k));
      if (tree.embeds.length) {
        const used = new Set<string>();
        const built = buildEmbeds(await loadRelationships(c), table, qt, tree.embeds, req.query, params, used);
        selects.push(...built.selects);
        conds.push(...built.inner);
        const stray = dotted.find((k) => !used.has(k));
        if (stray) throw bad(`the filter ${JSON.stringify(stray.slice(0, 64))} does not match an embedded resource in select`);
      } else if (dotted.length) throw bad(`the filter ${JSON.stringify(dotted[0]!.slice(0, 64))} refers to an embedded resource, but select embeds none`);
      const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
      const sql = AGG(`SELECT ${selects.join(", ") || "*"} FROM ${qt}${where}${order} LIMIT ${limit} OFFSET ${offset}`);
      const rows = (await c.query<{ body: string; n: number }>(sql, params)).rows[0]!;
      let total: number | undefined;
      if (pf.count === "exact") total = Number((await c.query(`SELECT count(*)::int AS n FROM ${qt}${where}`, params)).rows[0].n);
      return { ...rows, total };
    });
    const headers: Record<string, string> = { ...json };
    if (out.total !== undefined) headers["content-range"] = `${out.n ? offset : "*"}${out.n ? `-${offset + out.n - 1}` : ""}/${out.total}`;
    const status = out.total !== undefined && out.n < out.total ? 206 : 200;
    if (wantsObject) {
      if (out.n !== 1) throw new RestError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${out.n} rows`);
      return { status: 200, headers: { ...headers, "content-type": "application/vnd.pgrst.object+json" }, body: JSON.stringify((JSON.parse(out.body) as unknown[])[0]) };
    }
    return { status, headers, body: req.method === "HEAD" ? "" : out.body };
  }

  const returning = pf.return === "representation";
  const wrap = (cte: string) => (returning ? `WITH _w AS (${cte} RETURNING ${qt}.*) ${AGG("SELECT * FROM _w")}` : `WITH _w AS (${cte} RETURNING 1) SELECT '[]'::text AS body, count(*)::int AS n FROM _w`);

  if (req.method === "POST") {
    const body = jsonBody(req.body);
    const rows = Array.isArray(body) ? body : [body];
    if (rows.length === 0 || rows.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) throw bad("body must be an object or a non-empty array of objects", "PGRST102");
    if (rows.length > 5000) throw bad("too many rows in one request", "PGRST102");
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r as object)))];
    if (cols.length === 0) throw bad("no columns in body", "PGRST102");
    const qcols = cols.map((k) => ident(k, "column"));
    params.push(JSON.stringify(rows));
    let conflict = "";
    if (pf.resolution === "merge-duplicates" || pf.resolution === "ignore-duplicates") {
      const target = q(req.query, "on_conflict");
      const keys = target ? target.split(",").map((k) => ident(k, "column")) : null;
      if (pf.resolution === "ignore-duplicates") conflict = ` ON CONFLICT ${keys ? `(${keys.join(", ")})` : ""} DO NOTHING`;
      else {
        const pkCols = keys ?? (await pm.withRole(req.ref, { ...ctx, readOnly: true }, (c) => primaryKey(c, table))).map((k) => ident(k));
        if (!pkCols.length) throw bad("upsert needs on_conflict or a primary key", "PGRST102");
        const sets = qcols.filter((q) => !pkCols.includes(q)).map((q) => `${q} = EXCLUDED.${q}`);
        conflict = sets.length ? ` ON CONFLICT (${pkCols.join(", ")}) DO UPDATE SET ${sets.join(", ")}` : ` ON CONFLICT (${pkCols.join(", ")}) DO NOTHING`;
      }
    }
    const cte = `INSERT INTO ${qt} (${qcols.join(", ")}) SELECT ${qcols.join(", ")} FROM json_populate_recordset(null::${qt}, $1::json)${conflict}`;
    const out = await pm.withRole(req.ref, ctx, async (c) => (await c.query<{ body: string; n: number }>(wrap(cte), params)).rows[0]!);
    if (wantsObject && returning) {
      if (out.n !== 1) throw new RestError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
      return { status: 201, headers: json, body: JSON.stringify((JSON.parse(out.body) as unknown[])[0]) };
    }
    return returning ? { status: 201, headers: json, body: out.body } : { status: 201, headers: {}, body: "" };
  }

  if (req.method === "PATCH" || req.method === "DELETE") {
    const body = req.method === "PATCH" ? jsonBody(req.body) : undefined;
    let cte: string;
    if (req.method === "PATCH") {
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("PATCH body must be a JSON object", "PGRST102");
      const cols = Object.keys(body as object);
      if (!cols.length) throw bad("PATCH body has no columns", "PGRST102");
      params.push(JSON.stringify(body));
      const sets = cols.map((k) => `${ident(k, "column")} = _r.${ident(k, "column")}`).join(", ");
      const conds = buildFilters(table, req.query, params);
      if (!conds.length) throw bad("unfiltered PATCH is not allowed; add a filter", "PGRST106");
      cte = `UPDATE ${qt} SET ${sets} FROM (SELECT * FROM json_populate_record(null::${qt}, $1::json)) _r WHERE ${conds.join(" AND ")}`;
    } else {
      const conds = buildFilters(table, req.query, params);
      if (!conds.length) throw bad("unfiltered DELETE is not allowed; add a filter", "PGRST106");
      cte = `DELETE FROM ${qt} WHERE ${conds.join(" AND ")}`;
    }
    const out = await pm.withRole(req.ref, ctx, async (c) => (await c.query<{ body: string; n: number }>(wrap(cte), params)).rows[0]!);
    if (returning) {
      if (wantsObject) {
        if (out.n !== 1) throw new RestError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
        return { status: 200, headers: json, body: JSON.stringify((JSON.parse(out.body) as unknown[])[0]) };
      }
      return { status: 200, headers: json, body: out.body };
    }
    return { status: 204, headers: { "content-range": `*/${out.n}` }, body: "" };
  }

  throw new RestError(405, "PGRST117", `method ${req.method} not allowed`);
}

async function rpc(pm: PoolManager, req: RestRequest, fn: string, wantsObject: boolean): Promise<RestResponse> {
  const qf = `"public".${ident(fn, "function")}`;
  let args: Record<string, unknown> = {};
  if (req.method === "POST") {
    const b = req.body && req.body.length ? jsonBody(req.body) : {};
    if (b === null || typeof b !== "object" || Array.isArray(b)) throw bad("rpc body must be a JSON object", "PGRST102");
    args = b as Record<string, unknown>;
  } else if (req.method === "GET") {
    for (const [k, v] of Object.entries(req.query)) if (!RESERVED.has(k) && v !== undefined) args[k] = Array.isArray(v) ? v[0] : v;
  } else throw new RestError(405, "PGRST117", "rpc supports GET and POST");
  const params: unknown[] = [];
  const named = Object.entries(args).map(([k, v]) => {
    params.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
    return `${ident(k, "argument")} := $${params.length}`;
  });
  const sql = `SELECT coalesce(json_agg(_t), '[]'::json)::text AS body, count(*)::int AS n FROM (SELECT * FROM ${qf}(${named.join(", ")})) _t`;
  const out = await pm.withRole(req.ref, { role: req.role, claims: req.claims, readOnly: req.method === "GET" }, async (c) => (await c.query<{ body: string; n: number }>(sql, params)).rows[0]!);
  const rows = JSON.parse(out.body) as Array<Record<string, unknown>>;
  const first = rows[0];
  // A scalar function returns its value directly, as PostgREST does.
  const scalar = rows.length === 1 && first !== undefined && Object.keys(first).length === 1 && Object.keys(first)[0] === fn;
  const value = scalar ? first![fn] : wantsObject ? first : rows;
  return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(value ?? null) };
}
