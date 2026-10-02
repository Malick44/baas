/** Copy object bytes from a directory of files into another store (moving from disk to S3). Safe to run again: it only copies what is missing. */
import pg from "pg";
import type { BlobStore } from "./blobs.js";
import type { ControlPlane } from "./control.js";
import { urlFor } from "./provision.js";

export type MigrationReport = { projects: number; objects: number; copied: number; alreadyThere: number; missingAtSource: number; failed: number };

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
