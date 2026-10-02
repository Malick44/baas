import type pg from "pg";
import { condition, ident, RestError, splitTop } from "./rest.js";

/**
 * Embedded resources for the REST API: select=*,orders(*), customer:customers(name), orders!inner(id), orders(*,items(*)).
 * A relationship is a foreign key between two tables in the public schema. A forward one (this table points at the other) embeds one
 * object or null; a reverse one (the other table points here) embeds an array. Each embed is a correlated subquery run as the caller's role,
 * so row-level security applies to the joined table exactly as it would if it were queried on its own.
 * Many-to-many through a join table, aggregates and spreading (...table) are not supported.
 */

const MAX_DEPTH = 3;
const MAX_EMBEDS = 10;
const EMBED_ROWS = 1000;
const bad = (m: string, code = "PGRST100") => new RestError(400, code, m);

export type Embed = { name: string; alias: string; hint: string | null; inner: boolean; columns: string[]; embeds: Embed[] };
export type SelectTree = { columns: string[]; embeds: Embed[] };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Parse a select list into plain columns and embeds. Columns come back already quoted. */
export function parseSelectTree(sel: string | undefined, depth = 0, count = { n: 0 }): SelectTree {
  if (!sel || sel.trim() === "") return { columns: ["*"], embeds: [] };
  const columns: string[] = [];
  const embeds: Embed[] = [];
  for (const raw of splitTop(sel)) {
    const item = raw.trim();
    if (item === "*") { columns.push("*"); continue; }
    const paren = item.indexOf("(");
    if (paren < 0) {
      if (/[!>]|::|->/.test(item)) throw bad("casts, JSON operators and join hints belong on an embedded resource, like orders!inner(*)");
      const parts = item.split(":");
      if (parts.length > 2) throw bad("malformed select item");
      columns.push(parts.length === 1 ? ident(parts[0]!, "column") : `${ident(parts[1]!, "column")} AS ${ident(parts[0]!, "alias")}`);
      continue;
    }
    if (!item.endsWith(")")) throw bad("malformed embedded resource");
    if (depth + 1 > MAX_DEPTH) throw bad(`embedded resources can be nested at most ${MAX_DEPTH} deep`);
    if (++count.n > MAX_EMBEDS) throw bad(`a request can embed at most ${MAX_EMBEDS} resources`);
    let head = item.slice(0, paren);
    if (head.startsWith("...")) throw bad("spreading an embedded resource is not supported");
    let alias: string | null = null;
    const colon = head.indexOf(":");
    if (colon >= 0) { alias = head.slice(0, colon); head = head.slice(colon + 1); }
    const [name, ...mods] = head.split("!");
    if (!name || !NAME.test(name)) throw bad(`invalid embedded resource name: ${JSON.stringify((name ?? "").slice(0, 64))}`);
    if (alias !== null && !NAME.test(alias)) throw bad(`invalid alias: ${JSON.stringify(alias.slice(0, 64))}`);
    let inner = false;
    let hint: string | null = null;
    for (const m of mods) {
      if (m === "inner") inner = true;
      else if (m === "left") inner = false;
      else if (NAME.test(m) && hint === null) hint = m;
      else throw bad(`unsupported join modifier: ${JSON.stringify(m.slice(0, 32))}`);
    }
    const sub = parseSelectTree(item.slice(paren + 1, -1) || "*", depth + 1, count);
    embeds.push({ name, alias: alias ?? name, hint, inner, columns: sub.columns, embeds: sub.embeds });
  }
  if (new Set(embeds.map((e) => e.alias)).size !== embeds.length) throw bad("two embedded resources have the same name; give one an alias");
  return { columns, embeds };
}

export type Relationship = { name: string; childTable: string; parentTable: string; childCols: string[]; parentCols: string[] };

export async function loadRelationships(c: pg.PoolClient): Promise<Relationship[]> {
  const r = await c.query<{ name: string; child_table: string; parent_table: string; child_cols: string[]; parent_cols: string[] }>(
    `SELECT con.conname::text AS name, rel.relname::text AS child_table, ref.relname::text AS parent_table,
       (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS child_cols,
       (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS parent_cols
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace rn ON rn.oid = rel.relnamespace
     JOIN pg_class ref ON ref.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = ref.relnamespace
     WHERE con.contype = 'f' AND rn.nspname = 'public' AND pn.nspname = 'public'`,
  );
  return r.rows.map((x) => ({ name: x.name, childTable: x.child_table, parentTable: x.parent_table, childCols: x.child_cols, parentCols: x.parent_cols }));
}

type Candidate = { rel: Relationship; forward: boolean };

function resolve(rels: Relationship[], from: string, e: Embed): Candidate {
  const cands: Candidate[] = [];
  for (const rel of rels) {
    if (rel.childTable === from && rel.parentTable === e.name) cands.push({ rel, forward: true });
    if (rel.parentTable === from && rel.childTable === e.name) cands.push({ rel, forward: false });
  }
  const narrowed = e.hint ? cands.filter((c) => c.rel.name === e.hint || c.rel.childCols.includes(e.hint!)) : cands;
  if (narrowed.length === 0)
    throw new RestError(400, "PGRST200", `Could not find a relationship between '${from}' and '${e.name}' in the public schema`, null,
      e.hint ? `No foreign key matches the hint '${e.hint}'.` : "Embedding follows foreign keys: add one between the tables, or check the name.");
  if (narrowed.length > 1)
    throw new RestError(300, "PGRST201", `More than one relationship was found for '${from}' and '${e.name}'`, null,
      `Name the one you want: ${narrowed.map((c) => `${e.name}!${c.rel.name}`).join(", ")}`);
  return narrowed[0]!;
}

export type Built = { selects: string[]; inner: string[] };

/**
 * SQL for a list of embeds hanging off one parent row. `parentRef` is how the parent row is named in SQL (a table or an alias).
 * Filters, order, limit and offset for an embed come from the query string as `<name>.<column>=op.value`, `<name>.order=…`, `<name>.limit=…`.
 */
export function buildEmbeds(rels: Relationship[], parentTable: string, parentRef: string, embeds: Embed[], query: Record<string, string | string[] | undefined>,
  params: unknown[], used: Set<string>, prefix = "", level = 0): Built {
  const selects: string[] = [];
  const inner: string[] = [];
  embeds.forEach((e, i) => {
    const { rel, forward } = resolve(rels, parentTable, e);
    const alias = `_e${level}_${i}`;
    const child = forward ? rel.parentTable : rel.childTable;
    const joinSql = forward
      ? rel.childCols.map((cc, k) => `${alias}.${ident(rel.parentCols[k]!)} = ${parentRef}.${ident(cc)}`).join(" AND ")
      : rel.childCols.map((cc, k) => `${alias}.${ident(cc)} = ${parentRef}.${ident(rel.parentCols[k]!)}`).join(" AND ");
    const path = `${prefix}${e.alias}`;
    const conds = [joinSql];
    let order = "";
    let limit = EMBED_ROWS;
    let offset = 0;
    for (const [key, raw] of Object.entries(query)) {
      if (!key.startsWith(`${path}.`) || raw === undefined) continue;
      const rest = key.slice(path.length + 1);
      if (rest.includes(".")) continue; // deeper levels, handled by the nested embed (or reported below)
      used.add(key);
      const vals = Array.isArray(raw) ? raw : [raw];
      if (rest === "order") order = ` ORDER BY ${orderItems(vals[0]!, alias)}`;
      else if (rest === "limit") { if (!/^\d{1,9}$/.test(vals[0]!)) throw bad("limit must be a non-negative integer"); limit = Math.min(Number(vals[0]), EMBED_ROWS); }
      else if (rest === "offset") { if (!/^\d{1,9}$/.test(vals[0]!)) throw bad("offset must be a non-negative integer"); offset = Number(vals[0]); }
      else for (const v of vals) conds.push(condition(`${alias}.${ident(rest, "column")}`, v, params));
    }
    const nested = e.embeds.length ? buildEmbeds(rels, child, alias, e.embeds, query, params, used, `${path}.`, level + 1) : { selects: [], inner: [] };
    conds.push(...nested.inner);
    const list = [...e.columns, ...nested.selects].join(", ") || "*";
    const where = conds.join(" AND ");
    const body = `SELECT ${list} FROM "public".${ident(child)} ${alias} WHERE ${where}${order}`;
    if (forward) selects.push(`(SELECT to_json(_x) FROM (${body} LIMIT 1) _x) AS ${ident(e.alias)}`);
    else selects.push(`coalesce((SELECT json_agg(_x) FROM (${body} LIMIT ${limit} OFFSET ${offset}) _x), '[]'::json) AS ${ident(e.alias)}`);
    // !inner keeps only parent rows that have at least one matching embedded row (after the embed's own filters).
    if (e.inner) inner.push(`EXISTS (SELECT 1 FROM "public".${ident(child)} ${alias} WHERE ${where})`);
  });
  return { selects, inner };
}

function orderItems(spec: string, alias: string): string {
  return splitTop(spec).map((item) => {
    const [col, ...mods] = item.split(".");
    let dir = "", nulls = "";
    for (const m of mods) {
      if (m === "asc") dir = " ASC"; else if (m === "desc") dir = " DESC";
      else if (m === "nullsfirst") nulls = " NULLS FIRST"; else if (m === "nullslast") nulls = " NULLS LAST";
      else throw bad(`unsupported order modifier: ${JSON.stringify(m.slice(0, 32))}`);
    }
    return `${alias}.${ident(col!, "column")}${dir}${nulls}`;
  }).join(", ");
}
