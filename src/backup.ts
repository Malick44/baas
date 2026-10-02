import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { ControlPlane, HttpError, type Principal } from "./control.js";
import { planOf } from "./plans.js";
import { dbNameOf, setProjectAccess, urlFor } from "./provision.js";

export type BackupOptions = {
  dir: string;
  /** Directory containing pg_dump and pg_restore; defaults to PATH. */
  pgBinDir?: string;
};

export type BackupRow = { id: string; ref: string; kind: string; status: string; size_bytes: string | null; sha256: string | null; note: string | null; error: string | null; created_at: Date };

/**
 * Logical backups (pg_dump custom format) of a project's database, with retention per plan and restore by
 * building a fresh database and swapping it in. For recovery to any moment, see PitrService (needs WAL archiving).
 * Stored files (Storage) are NOT part of these backups.
 */
export class BackupService {
  private busy = new Set<string>();

  constructor(private control: ControlPlane, private opts: BackupOptions) {}

  private bin(name: string) {
    return this.opts.pgBinDir ? join(this.opts.pgBinDir, name) : name;
  }

  private run(cmd: string, args: string[], adminUrl: string): Promise<void> {
    const u = new URL(adminUrl);
    const full = ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username), ...args];
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin(cmd), full, { env: { PGPASSWORD: decodeURIComponent(u.password), PATH: process.env.PATH ?? "" }, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => reject(new Error(`${cmd} could not start: ${e.message}`)));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.trim().split("\n").slice(-2).join(" ")}`))));
    });
  }

  private file(ref: string, id: string) {
    return join(this.opts.dir, ref, `${id}.dump`);
  }

  async create(p: Principal | null, ref: string, kind: "manual" | "scheduled", note?: string): Promise<BackupRow> {
    if (p) {
      ControlPlane.require(p, "admin");
      await this.control.getProject(p, ref);
    }
    if (this.busy.has(ref)) throw new HttpError(409, "a backup or restore is already running for this project");
    this.busy.add(ref);
    const id = randomUUID();
    const path = this.file(ref, id);
    const pool = this.control.pool;
    await pool.query(`INSERT INTO backups (id, ref, kind, status, path, note) VALUES ($1, $2, $3, 'running', $4, $5)`, [id, ref, kind, path, note ?? null]);
    try {
      await mkdir(join(this.opts.dir, ref), { recursive: true, mode: 0o700 });
      await this.run("pg_dump", ["-Fc", "-f", path, "-d", dbNameOf(ref)], this.control.adminUrl);
      const size = (await stat(path)).size;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      const row = (await pool.query<BackupRow>(`UPDATE backups SET status = 'complete', size_bytes = $2, sha256 = $3 WHERE id = $1 RETURNING id, ref, kind, status, size_bytes, sha256, note, error, created_at`, [id, size, hash.digest("hex")])).rows[0]!;
      await this.prune(ref);
      return row;
    } catch (err) {
      await rm(path, { force: true });
      await pool.query(`UPDATE backups SET status = 'failed', error = $2, path = NULL WHERE id = $1`, [id, (err as Error).message.slice(0, 500)]);
      throw new HttpError(500, "backup failed");
    } finally {
      this.busy.delete(ref);
    }
  }

  private async prune(ref: string) {
    const plan = planOf((await this.control.pool.query(`SELECT plan FROM projects WHERE ref = $1`, [ref])).rows[0]?.plan);
    const old = (await this.control.pool.query<{ id: string }>(
      `SELECT id FROM backups WHERE ref = $1 AND status = 'complete' ORDER BY created_at DESC OFFSET $2`, [ref, plan.backupsKept])).rows;
    for (const { id } of old) await this.remove(ref, id);
  }

  async list(p: Principal, ref: string): Promise<BackupRow[]> {
    await this.control.getProject(p, ref);
    return (await this.control.pool.query<BackupRow>(
      `SELECT id, ref, kind, status, size_bytes, sha256, note, error, created_at FROM backups WHERE ref = $1 ORDER BY created_at DESC LIMIT 100`, [ref])).rows;
  }

  private async remove(ref: string, id: string) {
    await rm(this.file(ref, id), { force: true });
    await this.control.pool.query(`DELETE FROM backups WHERE id = $1 AND ref = $2`, [id, ref]);
  }

  async delete(p: Principal, ref: string, id: string) {
    ControlPlane.require(p, "admin");
    await this.control.getProject(p, ref);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "backup not found");
    const n = (await this.control.pool.query(`SELECT 1 FROM backups WHERE id = $1 AND ref = $2`, [id, ref])).rowCount;
    if (!n) throw new HttpError(404, "backup not found");
    await this.remove(ref, id);
    await this.control.audit(p.tokenId, p.orgId, "backup.delete", ref, { id });
  }

  /**
   * Replace the project's database with the contents of a backup. The database is rebuilt beside the live one and
   * swapped in by rename, so a failed restore leaves the project as it was. Access is cut during the swap.
   */
  async restore(p: Principal, ref: string, id: string): Promise<void> {
    ControlPlane.require(p, "owner");
    const project = await this.control.getProject(p, ref);
    if (project.status !== "active") throw new HttpError(409, `cannot restore a project that is ${project.status}`);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "backup not found");
    const b = (await this.control.pool.query<{ path: string; sha256: string }>(`SELECT path, sha256 FROM backups WHERE id = $1 AND ref = $2 AND status = 'complete'`, [id, ref])).rows[0];
    if (!b) throw new HttpError(404, "backup not found");
    const hash = createHash("sha256");
    try {
      for await (const chunk of createReadStream(b.path)) hash.update(chunk);
    } catch {
      throw new HttpError(500, "backup file is missing");
    }
    if (hash.digest("hex") !== b.sha256) throw new HttpError(500, "backup file failed its integrity check");
    await this.swapIn(ref, b.path, p, "backup.restore", { id });
  }

  /**
   * Build a fresh database from a pg_dump file beside the live one and swap it in by rename. Access is cut during the swap
   * and a failure leaves the project as it was. Shared by backup restore and point-in-time recovery.
   */
  async swapIn(ref: string, dumpPath: string, p: Principal, action: string, meta: object): Promise<void> {
    if (this.busy.has(ref)) throw new HttpError(409, "a backup or restore is already running for this project");
    this.busy.add(ref);
    const live = dbNameOf(ref);
    const fresh = `${live}_restore`;
    const old = `${live}_old`;
    const adminUrl = this.control.adminUrl;
    const admin = new pg.Client({ connectionString: adminUrl });
    admin.on("error", () => {});
    await admin.connect();
    let swapped = false;
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${old}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${fresh}"`);
      await this.run("pg_restore", ["--exit-on-error", "-d", fresh, dumpPath], adminUrl);
      // From here the project is briefly unavailable.
      await setProjectAccess(adminUrl, ref, false);
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [live]);
      await admin.query(`ALTER DATABASE "${live}" RENAME TO "${old}"`);
      await admin.query(`ALTER DATABASE "${fresh}" RENAME TO "${live}"`);
      swapped = true;
      await admin.query(`REVOKE ALL ON DATABASE "${live}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE "${live}" TO "authenticator_${ref}"`);
      await admin.query(`GRANT CREATE ON DATABASE "${live}" TO service_role`);
      await admin.query(`DROP DATABASE "${old}" WITH (FORCE)`);
      await this.control.audit(p.tokenId, p.orgId, action, ref, meta);
    } catch (err) {
      if (!swapped) await admin.query(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`).catch(() => {});
      else await admin.query(`ALTER DATABASE "${live}" RENAME TO "${fresh}"`).then(() => admin.query(`ALTER DATABASE "${old}" RENAME TO "${live}"`)).catch(() => {});
      throw new HttpError(500, `restore failed: ${(err as Error).message.slice(0, 200)}`);
    } finally {
      await setProjectAccess(adminUrl, ref, true).catch(() => {});
      await admin.end().catch(() => {});
      this.busy.delete(ref);
    }
  }

  /** Delete all backups of a purged project. */
  async purgeProject(ref: string) {
    await rm(join(this.opts.dir, ref), { recursive: true, force: true });
    await this.control.pool.query(`DELETE FROM backups WHERE ref = $1`, [ref]);
  }

  /** Take a backup for every active project on a plan with scheduled backups that has none in the last 24 hours. */
  async runScheduled(): Promise<string[]> {
    const done: string[] = [];
    const due = (await this.control.pool.query<{ ref: string; plan: string }>(
      `SELECT p.ref, p.plan FROM projects p WHERE p.status = 'active' AND NOT EXISTS
         (SELECT 1 FROM backups b WHERE b.ref = p.ref AND b.status IN ('complete', 'running') AND b.created_at > now() - interval '24 hours')`)).rows;
    for (const { ref, plan } of due) {
      if (!planOf(plan).scheduledBackups) continue;
      try {
        await this.create(null, ref, "scheduled");
        done.push(ref);
      } catch {
        /* recorded as a failed backup row */
      }
    }
    return done;
  }
}

export { urlFor };
