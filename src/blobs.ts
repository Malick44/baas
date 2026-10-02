/** Where object bytes live. Metadata is always in the project's database; this is only the bytes, under keys like <ref>/ab/<uuid>. */
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { HttpError } from "./control.js";
import { S3, S3Error, type S3Config } from "./s3.js";

export interface BlobStore {
  readonly kind: "disk" | "s3";
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** null when there is no such blob. */
  get(key: string): Promise<{ stream: Readable; size: number } | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Every key under a prefix. */
  list(prefix: string): Promise<string[]>;
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
  get(key: string) { return this.wrap(() => this.s3.get(key)); }
  exists(key: string) { return this.wrap(() => this.s3.exists(key)); }
  delete(key: string) { return this.wrap(() => this.s3.delete(key)); }
  copy(from: string, to: string) { return this.wrap(() => this.s3.copy(from, to)); }
  list(prefix: string) { return this.wrap(() => this.s3.list(prefix)); }
  deletePrefix(prefix: string) {
    return this.wrap(async () => this.s3.deleteMany(await this.s3.list(prefix.replace(/\/*$/, "/"))));
  }
}
