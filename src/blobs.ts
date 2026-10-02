/** Where object bytes live. Metadata is always in the project's database; this is only the bytes, under keys like <ref>/ab/<uuid>. */
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { guard } from "./pgguard.js";
import { HttpError } from "./control.js";
import { S3, S3Error, type S3Config } from "./s3.js";

export interface BlobStore {
  readonly kind: "disk" | "s3" | "postgres";
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** null when there is no such blob. */
  get(key: string): Promise<{ stream: Readable; size: number } | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Every key under a prefix. */
  list(prefix: string): Promise<string[]>;
  /** Store a file of any size (moved or streamed, not read whole into memory where the backend can avoid it). */
  putFile(key: string, path: string): Promise<void>;
  /** Write a blob to a file; false when there is no such blob. */
  getToFile(key: string, path: string): Promise<boolean>;
}

async function streamToFile(blob: { stream: Readable } | null, path: string): Promise<boolean> {
  if (!blob) return false;
  await mkdir(dirname(path), { recursive: true });
  try {
    await pipeline(blob.stream, createWriteStream(path));
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
  return true;
}

/** The same store with every key under a prefix, so two kinds of data can share a bucket or table without touching each other. */
export class PrefixStore implements BlobStore {
  constructor(private inner: BlobStore, private prefix: string) {}
  get kind() { return this.inner.kind; }
  put(key: string, data: Buffer, contentType?: string) { return this.inner.put(this.prefix + key, data, contentType); }
  get(key: string) { return this.inner.get(this.prefix + key); }
  exists(key: string) { return this.inner.exists(this.prefix + key); }
  delete(key: string) { return this.inner.delete(this.prefix + key); }
  copy(from: string, to: string) { return this.inner.copy(this.prefix + from, this.prefix + to); }
  deletePrefix(prefix: string) { return this.inner.deletePrefix(this.prefix + prefix); }
  async list(prefix: string) { return (await this.inner.list(this.prefix + prefix)).map((k) => k.slice(this.prefix.length)); }
  putFile(key: string, path: string) { return this.inner.putFile(this.prefix + key, path); }
  getToFile(key: string, path: string) { return this.inner.getToFile(this.prefix + key, path); }
}

/** Files under a directory. Several nodes need it to be a shared filesystem. */
export class DiskStore implements BlobStore {
  readonly kind = "disk" as const;
  constructor(private root: string) {}

  private path(key: string) {
    if (key.split("/").some((s) => s === ".." || s === "." || s === "") ) throw new HttpError(500, "bad blob key");
    return join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const final = this.path(key);
    await mkdir(dirname(final), { recursive: true });
    const tmp = `${final}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, final);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** Moves the file in (so a large dump is not copied twice) when it is on the same filesystem, else copies it. The source is consumed either way. */
  async putFile(key: string, path: string): Promise<void> {
    const final = this.path(key);
    await mkdir(dirname(final), { recursive: true });
    try {
      await rename(path, final);
      return;
    } catch { /* another filesystem: copy instead */ }
    const tmp = `${final}.${randomUUID()}.tmp`;
    try {
      await copyFile(path, tmp);
      await rename(tmp, final);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async getToFile(key: string, path: string): Promise<boolean> {
    return streamToFile(await this.get(key), path);
  }

  async get(key: string) {
    const p = this.path(key);
    try {
      const s = await stat(p);
      return { stream: createReadStream(p), size: s.size };
    } catch {
      return null;
    }
  }

  async exists(key: string) {
    return stat(this.path(key)).then(() => true, () => false);
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  async copy(from: string, to: string) {
    await mkdir(dirname(this.path(to)), { recursive: true });
    await copyFile(this.path(from), this.path(to));
  }

  async deletePrefix(prefix: string) {
    await rm(join(this.root, prefix), { recursive: true, force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      for (const e of await readdir(join(this.root, rel), { withFileTypes: true }).catch(() => [])) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(r);
        else if (!e.name.endsWith(".tmp")) out.push(r);
      }
    };
    await walk(prefix.replace(/\/+$/, ""));
    return out;
  }
}

/** An S3 bucket (AWS or anything compatible). Nodes need no shared filesystem. */
export class S3Store implements BlobStore {
  readonly kind = "s3" as const;
  readonly s3: S3;
  constructor(cfg: S3Config) {
    this.s3 = new S3(cfg);
  }

  private wrap<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((e) => {
      if (e instanceof S3Error) throw new HttpError(502, "the object storage backend is not answering properly");
      throw e;
    });
  }

  put(key: string, data: Buffer, contentType?: string) { return this.wrap(() => this.s3.put(key, data, contentType)); }
  putFile(key: string, path: string) { return this.wrap(() => this.s3.putFile(key, path)); }
  getToFile(key: string, path: string) { return this.wrap(async () => streamToFile(await this.s3.get(key), path)); }
  get(key: string) { return this.wrap(() => this.s3.get(key)); }
  exists(key: string) { return this.wrap(() => this.s3.exists(key)); }
  delete(key: string) { return this.wrap(() => this.s3.delete(key)); }
  copy(from: string, to: string) { return this.wrap(() => this.s3.copy(from, to)); }
  list(prefix: string) { return this.wrap(() => this.s3.list(prefix)); }
  deletePrefix(prefix: string) {
    return this.wrap(async () => this.s3.deleteMany(await this.s3.list(prefix.replace(/\/*$/, "/"))));
  }
}

const CHUNK = 1024 * 1024;
const like = (p: string) => `${p.replace(/[\\%_]/g, "\\$&")}%`;
const dirPrefix = (p: string) => (p === "" ? "" : p.replace(/\/*$/, "/"));

/** Postgres (the control database) as the file store: no shared filesystem and no S3 account, at the cost of database size and speed. */
export class PgStore implements BlobStore {
  readonly kind = "postgres" as const;
  constructor(private pool: pg.Pool) {}

  async put(key: string, data: Buffer): Promise<void> {
    await this.write(key, async (add) => { for (let i = 0; i < data.length || i === 0; i += CHUNK) await add(data.subarray(i, i + CHUNK)); });
  }

  async putFile(key: string, path: string): Promise<void> {
    await this.write(key, async (add) => {
      const fh = await open(path, "r");
      try {
        for (let pos = 0; ; pos += CHUNK) {
          const buf = Buffer.alloc(CHUNK);
          const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
          if (bytesRead === 0 && pos > 0) break;
          await add(buf.subarray(0, bytesRead));
          if (bytesRead < CHUNK) break;
        }
      } finally { await fh.close(); }
    });
  }

  private async write(key: string, fill: (add: (b: Buffer) => Promise<void>) => Promise<void>): Promise<void> {
    const c = await this.pool.connect();
    let broken = false;
    const unguard = guard(c, () => { broken = true; });
    try {
      await c.query("BEGIN");
      await c.query(`DELETE FROM blob_objects WHERE key = $1`, [key]);
      await c.query(`INSERT INTO blob_objects (key, size) VALUES ($1, 0)`, [key]);
      let idx = 0, size = 0;
      await fill(async (b) => { await c.query(`INSERT INTO blob_chunks (key, idx, data) VALUES ($1, $2, $3)`, [key, idx++, b]); size += b.length; });
      await c.query(`UPDATE blob_objects SET size = $2 WHERE key = $1`, [key, size]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      unguard();
      c.release(broken);
    }
  }

  async get(key: string) {
    const r = (await this.pool.query<{ size: string }>(`SELECT size FROM blob_objects WHERE key = $1`, [key])).rows[0];
    if (!r) return null;
    const pool = this.pool;
    async function* chunks() {
      for (let idx = 0; ; idx++) {
        const row = (await pool.query<{ data: Buffer }>(`SELECT data FROM blob_chunks WHERE key = $1 AND idx = $2`, [key, idx])).rows[0];
        if (!row) return;
        yield row.data;
      }
    }
    return { stream: Readable.from(chunks(), { objectMode: false }), size: Number(r.size) };
  }

  async getToFile(key: string, path: string): Promise<boolean> {
    return streamToFile(await this.get(key), path);
  }

  async exists(key: string) {
    return (await this.pool.query(`SELECT 1 FROM blob_objects WHERE key = $1`, [key])).rowCount === 1;
  }

  async delete(key: string) {
    await this.pool.query(`DELETE FROM blob_objects WHERE key = $1`, [key]);
  }

  async copy(from: string, to: string) {
    const c = await this.pool.connect();
    let broken = false;
    const unguard = guard(c, () => { broken = true; });
    try {
      await c.query("BEGIN");
      const src = (await c.query<{ size: string }>(`SELECT size FROM blob_objects WHERE key = $1`, [from])).rows[0];
      if (!src) throw new HttpError(404, "object not found");
      await c.query(`DELETE FROM blob_objects WHERE key = $1`, [to]);
      await c.query(`INSERT INTO blob_objects (key, size) VALUES ($1, $2)`, [to, src.size]);
      await c.query(`INSERT INTO blob_chunks (key, idx, data) SELECT $2, idx, data FROM blob_chunks WHERE key = $1`, [from, to]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      unguard();
      c.release(broken);
    }
  }

  async deletePrefix(prefix: string) {
    await this.pool.query(`DELETE FROM blob_objects WHERE key LIKE $1 ESCAPE '\\'`, [like(dirPrefix(prefix))]);
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.pool.query<{ key: string }>(`SELECT key FROM blob_objects WHERE key LIKE $1 ESCAPE '\\' ORDER BY key`, [like(dirPrefix(prefix))])).rows.map((r) => r.key);
  }
}
