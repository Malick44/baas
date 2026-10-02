/** Copy object bytes from a directory of files into another store (moving from disk to S3). Safe to run again: it only copies what is missing. */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { BlobStore } from "./blobs.js";
import type { ControlPlane } from "./control.js";
import { urlFor } from "./provision.js";

export type MigrationReport = { projects: number; objects: number; copied: number; alreadyThere: number; missingAtSource: number; failed: number; backups?: { copied: number; alreadyThere: number; missing: number; failed: number } };

export async function migrateStorage(control: ControlPlane, from: BlobStore, to: BlobStore, key: (ref: string, id: string) => string): Promise<MigrationReport> {
  const report: MigrationReport = { projects: 0, objects: 0, copied: 0, alreadyThere: 0, missingAtSource: 0, failed: 0 };
  const projects = (await control.pool.query<{ ref: string; db_name: string }>(`SELECT ref, db_name FROM projects WHERE status IN ('active', 'paused')`)).rows;
  for (const p of projects) {
    const c = new pg.Client({ connectionString: urlFor(await control.adminUrlFor(p.ref), p.db_name) });
    c.on("error", () => {});
    try {
      await c.connect();
      const ids = (await c.query<{ id: string }>(`SELECT id FROM storage.objects`)).rows.map((r) => r.id);
      report.projects++;
      for (const id of ids) {
        report.objects++;
        const k = key(p.ref, id);
        try {
          if (await to.exists(k)) { report.alreadyThere++; continue; }
          const src = await from.get(k);
          if (!src) { report.missingAtSource++; continue; }
          const chunks: Buffer[] = [];
          for await (const part of src.stream) chunks.push(Buffer.from(part));
          await to.put(k, Buffer.concat(chunks));
          report.copied++;
        } catch {
          report.failed++;
        }
      }
    } catch {
      // A project without a storage schema (or an unreachable cluster) has nothing to copy now.
    } finally {
      await c.end().catch(() => {});
    }
  }
  return report;
}

/** Copy backup dumps kept as files under `dir` into a shared store (only what is missing, so it is safe to repeat). The source files are left alone. */
export async function migrateBackups(control: ControlPlane, dir: string, to: BlobStore): Promise<{ copied: number; alreadyThere: number; missing: number; failed: number }> {
  const r = { copied: 0, alreadyThere: 0, missing: 0, failed: 0 };
  const rows = (await control.pool.query<{ ref: string; id: string }>(`SELECT ref, id FROM backups WHERE status = 'complete'`)).rows;
  for (const { ref, id } of rows) {
    const key = `${ref}/${id}.dump`;
    try {
      if (await to.exists(key)) { r.alreadyThere++; continue; }
      const file = join(dir, key);
      if (!(await stat(file).then(() => true, () => false))) { r.missing++; continue; }
      await to.putFile(key, file);
      r.copied++;
    } catch {
      r.failed++;
    }
  }
  return r;
}
