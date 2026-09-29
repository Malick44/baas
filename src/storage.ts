import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { HttpError, type Resolved } from "./control.js";
import { type Helpers, type Mountable, type ProjectCtx, jsonBody } from "./gateway.js";
import { signJwt, verifyJwt } from "./keys.js";
import type { ApiRole, PoolManager } from "./pools.js";

export type StorageLimits = { fileSize: number; totalBytes: number };
export type StorageOptions = { root: string; limits?: (project: Resolved) => StorageLimits };

const DEFAULT_LIMITS: StorageLimits = { fileSize: 50 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 };
const BUCKET_ID = /^[A-Za-z0-9._-]{1,63}$/;
const RESERVED_BUCKETS = new Set(["public", "sign", "list", "move", "copy", "authenticated", "bucket"]);
const UUID = /^[0-9a-f-]{36}$/;

export function validObjectName(name: string): boolean {
  return (
    name.length > 0 && name.length <= 1024 && !name.includes("\0") && !name.startsWith("/") && !name.endsWith("/") &&
    !name.includes("//") && !name.split("/").some((s) => s === ".." || s === ".")
  );
}

/** Minimal multipart/form-data reader: returns the first file part (field "file" preferred). */
export function parseMultipart(body: Buffer, contentType: string): { data: Buffer; type: string } | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return null;
  const delim = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let best: { data: Buffer; type: string } | null = null;
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const next = body.indexOf(delim, pos + delim.length);
    if (next === -1) break;
    const part = body.subarray(pos + delim.length + 2, next - 2); // strip CRLF around
    const split = part.indexOf("\r\n\r\n");
    if (split !== -1) {
      const head = part.subarray(0, split).toString("utf8");
      const data = part.subarray(split + 4);
      const isFile = /filename=/i.test(head);
      const named = /name="file"/i.test(head);
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "application/octet-stream";
      if (named || (isFile && !best)) best = { data, type };
      if (named) break;
    }
    pos = next;
  }
  return best;
}

type Bucket = { id: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null; created_at: Date };

export class StorageService implements Mountable {
  constructor(private pm: PoolManager, private opts: StorageOptions) {}

  private limits(p: Resolved) {
    return this.opts.limits?.(p) ?? DEFAULT_LIMITS;
  }
  private file(ref: string, id: string) {
    if (!UUID.test(id)) throw new HttpError(500, "bad object id");
    return join(this.opts.root, ref, id.slice(0, 2), id);
  }
  private svc<T>(ref: string, fn: (c: pg.PoolClient) => Promise<T>) {
    return this.pm.withRole(ref, { role: "service_role", claims: { role: "service_role" } }, (c) => fn(c));
  }
  private as<T>(ctx: ProjectCtx, fn: (c: pg.PoolClient) => Promise<T>, readOnly = false) {
    return this.pm.withRole(ctx.ref, { role: ctx.who.role, claims: ctx.who.claims, readOnly }, (c) => fn(c));
  }

  private async bucket(ref: string, id: string): Promise<Bucket> {
    if (!BUCKET_ID.test(id)) throw new HttpError(404, "Bucket not found");
    const b = await this.svc(ref, async (c) => (await c.query<Bucket>(`SELECT * FROM storage.buckets WHERE id = $1`, [id])).rows[0]);
    if (!b) throw new HttpError(404, "Bucket not found");
    return b;
  }

  /** Total stored bytes for the project (for quota checks and metering). */
  async totalBytes(ref: string): Promise<number> {
    return this.svc(ref, async (c) => Number((await c.query(`SELECT coalesce(sum(size), 0)::bigint AS n FROM storage.objects`)).rows[0].n));
  }

  /** Remove every stored file of a project (used when a project is purged). */
  async purgeProject(ref: string): Promise<void> {
    await rm(join(this.opts.root, ref), { recursive: true, force: true });
  }

  async upload(ctx: ProjectCtx, bucketId: string, name: string, data: Buffer, mime: string, upsert: boolean) {
    if (!validObjectName(name)) throw new HttpError(400, "Invalid object name");
    const bucket = await this.bucket(ctx.ref, bucketId);
    const lim = this.limits(ctx.project);
    const max = Math.min(bucket.file_size_limit ?? Infinity, lim.fileSize);
    if (data.length > max) throw new HttpError(413, "The object exceeded the maximum allowed size");
    if (bucket.allowed_mime_types?.length && !bucket.allowed_mime_types.some((m) => (m.endsWith("/*") ? mime.startsWith(m.slice(0, -1)) : m === mime)))
      throw new HttpError(415, `mime type ${mime} is not supported`);
    if ((await this.totalBytes(ctx.ref)) + data.length > lim.totalBytes) throw new HttpError(413, "Storage quota exceeded");

    const owner = ctx.who.role === "authenticated" ? (ctx.who.claims.sub as string) : null;
    let tmp: string | undefined;
    try {
      return await this.as(ctx, async (c) => {
        const sql = upsert
          ? `INSERT INTO storage.objects (bucket_id, name, owner, size, mimetype, metadata) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (bucket_id, name) DO UPDATE SET size = EXCLUDED.size, mimetype = EXCLUDED.mimetype, metadata = EXCLUDED.metadata, updated_at = now()
             RETURNING id`
          : `INSERT INTO storage.objects (bucket_id, name, owner, size, mimetype, metadata) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`;
        let id: string;
        try {
          id = (await c.query<{ id: string }>(sql, [bucketId, name, owner, data.length, mime, JSON.stringify({ size: data.length, mimetype: mime })])).rows[0]!.id;
        } catch (err) {
          if ((err as { code?: string }).code === "23505") throw new HttpError(409, "The resource already exists");
          if ((err as { code?: string }).code === "42501") throw new HttpError(ctx.who.role === "anon" ? 401 : 403, "new row violates row-level security policy");
          throw err;
        }
        const final = this.file(ctx.ref, id);
        await mkdir(dirname(final), { recursive: true });
        tmp = `${final}.${randomUUID()}.tmp`;
        await writeFile(tmp, data);
        await rename(tmp, final); // just before COMMIT; a failed commit leaves an orphan file, never a dangling row
        tmp = undefined;
        return { Id: id, Key: `${bucketId}/${name}` };
      });
    } finally {
      if (tmp) await rm(tmp, { force: true });
    }
  }

  private async findObject(ctx: ProjectCtx, bucketId: string, name: string) {
    return this.as(ctx, async (c) => (await c.query<{ id: string; size: string; mimetype: string | null }>(
      `SELECT id, size, mimetype FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [bucketId, name])).rows[0], true);
  }

  private async send(reply: FastifyReply, ref: string, obj: { id: string; size: string; mimetype: string | null }) {
    const path = this.file(ref, obj.id);
    try {
      await stat(path);
    } catch {
      throw new HttpError(404, "Object not found");
    }
    return reply
      .header("content-type", obj.mimetype ?? "application/octet-stream")
      .header("content-length", obj.size)
      .header("cache-control", "max-age=3600")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .send(createReadStream(path));
  }

  async download(ctx: ProjectCtx, reply: FastifyReply, bucketId: string, name: string) {
    const obj = await this.findObject(ctx, bucketId, name);
    if (!obj) throw new HttpError(404, "Object not found");
    return this.send(reply, ctx.ref, obj);
  }

  async remove(ctx: ProjectCtx, bucketId: string, names: string[]) {
    if (names.length > 1000) throw new HttpError(400, "too many prefixes");
    const rows = await this.as(ctx, async (c) => (await c.query<{ id: string; name: string; bucket_id: string; size: string }>(
      `DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2) RETURNING id, name, bucket_id, size`, [bucketId, names])).rows);
    await Promise.all(rows.map((r) => rm(this.file(ctx.ref, r.id), { force: true })));
    return rows.map((r) => ({ name: r.name, bucket_id: r.bucket_id, id: r.id, metadata: { size: Number(r.size) } }));
  }

  async list(ctx: ProjectCtx, bucketId: string, prefix: string, limit: number, offset: number, search?: string) {
    let p = prefix.replace(/^\/+/, "");
    if (p && !p.endsWith("/")) p += "/";
    const rows = await this.as(ctx, async (c) => (await c.query(
      `WITH rel AS (
         SELECT id, created_at, updated_at, size, mimetype, substr(name, $2) AS rest FROM storage.objects
         WHERE bucket_id = $1 AND starts_with(name, $3) AND ($6::text IS NULL OR name ILIKE '%' || $6 || '%'))
       SELECT split_part(rest, '/', 1) AS name,
              CASE WHEN bool_or(position('/' in rest) > 0) THEN NULL ELSE (array_agg(id::text))[1] END AS id,
              max(updated_at) AS updated_at, min(created_at) AS created_at,
              CASE WHEN bool_or(position('/' in rest) > 0) THEN NULL ELSE jsonb_build_object('size', (array_agg(size))[1], 'mimetype', (array_agg(mimetype))[1]) END AS metadata
       FROM rel WHERE rest <> '' GROUP BY 1 ORDER BY 1 LIMIT $4 OFFSET $5`,
      [bucketId, p.length + 1, p, limit, offset, search ?? null])).rows, true);
    return rows.map((r) => ({ ...r, last_accessed_at: r.updated_at }));
  }

  mount(app: FastifyInstance, { withCtx }: Helpers): void {
    const B = "/storage/v1";
    const svcOnly = (ctx: ProjectCtx) => {
      if (ctx.who.role !== "service_role") throw new HttpError(403, "bucket management requires the service_role key");
    };
    // Fastify has already percent-decoded route parameters; decoding again would turn "100%25.txt" into a crash.
    const nameOf = (req: FastifyRequest) => (req.params as { "*": string })["*"] ?? "";
    const bucketOf = (req: FastifyRequest) => (req.params as { bucket: string }).bucket;

    // buckets
    app.post(`${B}/bucket`, (req, reply) => withCtx(req, reply, async (ctx) => {
      svcOnly(ctx);
      const b = jsonBody(req);
      const id = String(b.id ?? b.name ?? "");
      if (!BUCKET_ID.test(id) || RESERVED_BUCKETS.has(id)) throw new HttpError(400, "Invalid bucket name");
      const limit = b.file_size_limit === undefined || b.file_size_limit === null ? null : Number(b.file_size_limit);
      if (limit !== null && (!Number.isInteger(limit) || limit < 0)) throw new HttpError(400, "invalid file_size_limit");
      const mimes = Array.isArray(b.allowed_mime_types) ? b.allowed_mime_types.map(String) : null;
      try {
        await this.svc(ctx.ref, (c) => c.query(`INSERT INTO storage.buckets (id, public, file_size_limit, allowed_mime_types) VALUES ($1,$2,$3,$4)`, [id, b.public === true, limit, mimes]));
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "The resource already exists");
        throw err;
      }
      return reply.code(200).send({ name: id });
    }));
    app.get(`${B}/bucket`, (req, reply) => withCtx(req, reply, async (ctx) => {
      svcOnly(ctx);
      const rows = await this.svc(ctx.ref, async (c) => (await c.query<Bucket>(`SELECT * FROM storage.buckets ORDER BY id`)).rows);
      return reply.send(rows.map((r) => ({ id: r.id, name: r.id, public: r.public, file_size_limit: r.file_size_limit, allowed_mime_types: r.allowed_mime_types, created_at: r.created_at })));
    }));
    app.get(`${B}/bucket/:bucket`, (req, reply) => withCtx(req, reply, async (ctx) => {
      svcOnly(ctx);
      const r = await this.bucket(ctx.ref, bucketOf(req));
      return reply.send({ ...r, name: r.id });
    }));
    app.put(`${B}/bucket/:bucket`, (req, reply) => withCtx(req, reply, async (ctx) => {
      svcOnly(ctx);
      const id = bucketOf(req);
      await this.bucket(ctx.ref, id);
      const b = jsonBody(req);
      await this.svc(ctx.ref, (c) => c.query(
        `UPDATE storage.buckets SET public = coalesce($2, public), file_size_limit = CASE WHEN $3::boolean THEN $4::bigint ELSE file_size_limit END,
           allowed_mime_types = CASE WHEN $5::boolean THEN $6::text[] ELSE allowed_mime_types END WHERE id = $1`,
        [id, typeof b.public === "boolean" ? b.public : null, "file_size_limit" in b, b.file_size_limit ?? null, "allowed_mime_types" in b, Array.isArray(b.allowed_mime_types) ? b.allowed_mime_types.map(String) : null]));
      return reply.send({ message: "Successfully updated" });
    }));
    const emptyBucket = async (ref: string, id: string) => {
      const rows = await this.svc(ref, async (c) => (await c.query<{ id: string }>(`DELETE FROM storage.objects WHERE bucket_id = $1 RETURNING id`, [id])).rows);
      await Promise.all(rows.map((r) => rm(this.file(ref, r.id), { force: true })));
    };
    app.post(`${B}/bucket/:bucket/empty`, (req, reply) => withCtx(req, reply, async (ctx) => {
      svcOnly(ctx);
      await this.bucket(ctx.ref, bucketOf(req));
      await emptyBucket(ctx.ref, bucketOf(req));
      return reply.send({ message: "Successfully emptied" });
    }));
    app.delete(`${B}/bucket/:bucket`, (req, reply) => withCtx(req, reply, async (ctx) => {
      svcOnly(ctx);
      const id = bucketOf(req);
      await this.bucket(ctx.ref, id);
      const n = await this.svc(ctx.ref, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = $1`, [id])).rows[0].n));
      if (n > 0) throw new HttpError(409, "Bucket not empty");
      await this.svc(ctx.ref, (c) => c.query(`DELETE FROM storage.buckets WHERE id = $1`, [id]));
      return reply.send({ message: "Successfully deleted" });
    }));

    // objects
    const put = (upsertDefault: boolean) => (req: FastifyRequest, reply: FastifyReply) => withCtx(req, reply, async (ctx) => {
      const ct = String(req.headers["content-type"] ?? "application/octet-stream");
      let data = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
      let mime = ct;
      if (/^multipart\/form-data/i.test(ct)) {
        const part = parseMultipart(data, ct);
        if (!part) throw new HttpError(400, "no file in multipart body");
        data = part.data;
        mime = part.type;
      }
      const upsert = upsertDefault || String(req.headers["x-upsert"]).toLowerCase() === "true";
      return reply.send(await this.upload(ctx, bucketOf(req), nameOf(req), data, mime.split(";")[0]!.trim(), upsert));
    });
    // Registered before the wildcard object routes so "public", "sign", "list" etc. are not read as bucket names.
    app.get(`${B}/object/public/:bucket/*`, (req, reply) => withCtx(req, reply, async (ctx) => {
      const b = await this.bucket(ctx.ref, bucketOf(req));
      if (!b.public) throw new HttpError(404, "Object not found");
      const name = nameOf(req);
      const obj = await this.svc(ctx.ref, async (c) => (await c.query(`SELECT id, size, mimetype FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [b.id, name])).rows[0]);
      if (!obj) throw new HttpError(404, "Object not found");
      return this.send(reply, ctx.ref, obj);
    }, { anonymous: true }));
    app.get(`${B}/object/sign/:bucket/*`, (req, reply) => withCtx(req, reply, async (ctx) => {
      const token = (req.query as Record<string, string>).token ?? "";
      const claims = verifyJwt(token, ctx.project.secrets.jwtSecret);
      const bucket = bucketOf(req);
      const name = nameOf(req);
      if (!claims || claims.role !== "storage_signed" || claims.url !== `${bucket}/${name}`) throw new HttpError(400, "Invalid or expired token");
      const obj = await this.svc(ctx.ref, async (c) => (await c.query(`SELECT id, size, mimetype FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [bucket, name])).rows[0]);
      if (!obj) throw new HttpError(404, "Object not found");
      return this.send(reply, ctx.ref, obj);
    }, { anonymous: true }));
    app.post(`${B}/object/sign/:bucket/*`, (req, reply) => withCtx(req, reply, async (ctx) => {
      const bucket = bucketOf(req);
      const name = nameOf(req);
      const expiresIn = Number(jsonBody(req).expiresIn ?? 3600);
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 7 * 86400) throw new HttpError(400, "invalid expiresIn");
      if (!(await this.findObject(ctx, bucket, name))) throw new HttpError(404, "Object not found");
      const now = Math.floor(Date.now() / 1000);
      // role "storage_signed" is deliberately not an API role: this token cannot be used as an API key.
      const token = signJwt({ role: "storage_signed", url: `${bucket}/${name}`, iat: now, exp: now + expiresIn }, ctx.project.secrets.jwtSecret);
      return reply.send({ signedURL: `/object/sign/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}?token=${token}` });
    }));
    app.post(`${B}/object/list/:bucket`, (req, reply) => withCtx(req, reply, async (ctx) => {
      const b = jsonBody(req);
      const limit = Math.min(Math.max(Number(b.limit ?? 100) || 100, 1), 1000);
      const offset = Math.max(Number(b.offset ?? 0) || 0, 0);
      return reply.send(await this.list(ctx, bucketOf(req), String(b.prefix ?? ""), limit, offset, typeof b.search === "string" && b.search ? b.search : undefined));
    }));
    for (const kind of ["move", "copy"] as const)
      app.post(`${B}/object/${kind}`, (req, reply) => withCtx(req, reply, async (ctx) => {
        const b = jsonBody(req);
        const bucket = String(b.bucketId ?? "");
        const from = String(b.sourceKey ?? "");
        const to = String(b.destinationKey ?? "");
        if (!validObjectName(from) || !validObjectName(to)) throw new HttpError(400, "Invalid object name");
        await this.bucket(ctx.ref, bucket);
        const src = await this.findObject(ctx, bucket, from);
        if (!src) throw new HttpError(404, "Object not found");
        const out = await this.as(ctx, async (c) => {
          try {
            if (kind === "move") {
              const r = await c.query(`UPDATE storage.objects SET name = $3, updated_at = now() WHERE bucket_id = $1 AND name = $2 RETURNING id`, [bucket, from, to]);
              return r.rows[0]?.id as string | undefined;
            }
            const r = await c.query(
              `INSERT INTO storage.objects (bucket_id, name, owner, size, mimetype, metadata)
               SELECT bucket_id, $3, owner, size, mimetype, metadata FROM storage.objects WHERE bucket_id = $1 AND name = $2 RETURNING id`, [bucket, from, to]);
            const id = r.rows[0]?.id as string | undefined;
            if (id) {
              await mkdir(dirname(this.file(ctx.ref, id)), { recursive: true });
              const { copyFile } = await import("node:fs/promises");
              await copyFile(this.file(ctx.ref, src.id), this.file(ctx.ref, id));
            }
            return id;
          } catch (err) {
            if ((err as { code?: string }).code === "23505") throw new HttpError(409, "The resource already exists");
            if ((err as { code?: string }).code === "42501") throw new HttpError(403, "new row violates row-level security policy");
            throw err;
          }
        });
        if (!out) throw new HttpError(404, "Object not found");
        return reply.send(kind === "move" ? { message: "Successfully moved" } : { Key: `${bucket}/${to}` });
      }));
    app.delete(`${B}/object/:bucket`, (req, reply) => withCtx(req, reply, async (ctx) => {
      const prefixes = jsonBody(req).prefixes;
      if (!Array.isArray(prefixes)) throw new HttpError(400, "prefixes must be an array");
      return reply.send(await this.remove(ctx, bucketOf(req), prefixes.map(String)));
    }));
    app.route({ method: ["GET", "HEAD"], url: `${B}/object/authenticated/:bucket/*`, handler: (req, reply) => withCtx(req, reply, (ctx) => this.download(ctx, reply, bucketOf(req), nameOf(req))) });
    app.post(`${B}/object/:bucket/*`, put(false));
    app.put(`${B}/object/:bucket/*`, put(true));
    app.delete(`${B}/object/:bucket/*`, (req, reply) => withCtx(req, reply, async (ctx) => {
      const out = await this.remove(ctx, bucketOf(req), [nameOf(req)]);
      if (!out.length) throw new HttpError(404, "Object not found");
      return reply.send({ message: "Successfully deleted" });
    }));
    app.route({ method: ["GET", "HEAD"], url: `${B}/object/:bucket/*`, handler: (req, reply) => withCtx(req, reply, (ctx) => this.download(ctx, reply, bucketOf(req), nameOf(req))) });
  }
}

export type { ApiRole };
