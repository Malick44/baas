/**
 * Point-in-time recovery for a project's database.
 *
 * Projects share a Postgres cluster, and WAL archiving is cluster-wide, so history cannot be rewound for one
 * project in place. Instead: keep periodic base backups of the cluster plus the archived WAL; to recover, start a throwaway
 * server from the newest base backup before the target, let it replay the WAL up to the target moment, dump that one
 * project's database from it, and swap the dump in with the same machinery as a backup restore. Nothing else on the
 * cluster is touched, and a logical backup of the current state is taken first so the restore can itself be undone.
 *
 * Every cluster has its own archive and base backups: the main cluster's archive is `archiveDir`, an added cluster's is the
 * `archive_dir` registered with it. A project is recovered on the cluster it lives on now.
 *
 * Not covered: files in Storage, and anything outside the project's database.
 *
 * Two ways to keep the archive and the base backups. In a directory (`archiveDir`, `baseDir`): simple, but every baas node and the
 * database host must share it. In a shared store (`store`, S3 or Postgres): the database's archive_command uploads each WAL segment
 * to baas over HTTP (`PUT /v1/pitr/wal/<cluster>/<file>`, authenticated with a per-cluster token), base backups are stored as
 * tarballs, and a recovery pulls what it needs into scratch space, so any node can take a base backup or run a recovery and nothing
 * has to be shared at the filesystem level.
 *
 * Operator setup: the server needs archive_mode=on and an archive_command that copies WAL into `archiveDir` (a volume baas can read),
 * and baas needs the server binaries (`postgres`, `pg_basebackup`, `pg_archivecleanup`) of the SAME major version in `pgBinDir`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cp, chmod, chown, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import type { BackupService } from "./backup.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BlobStore } from "./blobs.js";
import { MAIN } from "./clusters.js";
import { ControlPlane, HttpError, type Principal } from "./control.js";
import { planOf } from "./plans.js";
import { dbNameOf } from "./provision.js";

export type PitrOptions = {
  /** Where the server's archive_command puts WAL segments, as baas sees it. Not used with `store`. */
  archiveDir?: string;
  /** Where base backups of the cluster are kept. Not used with `store`. */
  baseDir?: string;
  /** Keep WAL and base backups in a shared store instead of directories (see above). Needs `archiveSecret`. */
  store?: BlobStore;
  /** Secret the per-cluster WAL upload tokens are derived from (the platform key will do). */
  archiveSecret?: string;
  /** A fixed upload token for the main cluster, for setups (Compose) where the database's command line is written before baas has run. */
  mainToken?: string;
  /** Scratch space for the recovery server; needs room for one copy of the cluster. */
  scratchDir: string;
  /** Directory holding postgres, pg_basebackup and pg_archivecleanup. */
  pgBinDir?: string;
  /** How far back recovery can go. */
  retentionDays?: number;
  /** Take a new base backup when the last is older than this. */
  baseEveryHours?: number;
  /** How long to wait for a recovery to finish. */
  recoveryTimeoutMs?: number;
  /** Run the scratch server as this user (PostgreSQL refuses to run as root). Defaults to the "postgres" user when baas runs as root. */
  runAs?: { uid: number; gid: number };
};

/** One cluster as recovery sees it. `archiveDir` is null for an added cluster whose operator has not said where its WAL goes. */
type Target = { id: string; adminUrl: string; archiveDir: string | null; baseDir: string; /** WAL has somewhere to go: a registered directory, or the shared store. */ archived: boolean };

export type BaseBackup = { id: string; status: string; started_at: Date; finished_at: Date | null; size_bytes: string | null; error: string | null };

const run = (cmd: string, args: string[], env: Record<string, string> = {}, o: { uid?: number; gid?: number } = {}): Promise<{ out: string; err: string }> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"], ...(o.uid !== undefined ? { uid: o.uid, gid: o.gid } : {}) });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`${cmd} could not start: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
  });

async function chownR(dir: string, uid: number, gid: number) {
  await chown(dir, uid, gid);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await chownR(p, uid, gid);
    else await chown(p, uid, gid).catch(() => {});
  }
}

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => res(port)); });
  s.on("error", rej);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A value for postgresql.conf: quoted, with quotes and backslashes escaped. */
const q = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

export class PitrService {
  /** Clusters with a base backup or recovery running: one at a time on each. */
  private busy = new Set<string>();
  private binMajor: number | null = null;
  private opts: Required<Omit<PitrOptions, "runAs" | "pgBinDir" | "store" | "archiveSecret" | "mainToken">> & Pick<PitrOptions, "runAs" | "pgBinDir" | "store" | "archiveSecret" | "mainToken">;
  private store?: BlobStore;

  constructor(private control: ControlPlane, private backups: BackupService, opts: PitrOptions) {
    if (opts.store && !opts.archiveSecret) throw new Error("a shared point-in-time recovery store needs an archive secret");
    if (!opts.store && !opts.archiveDir) throw new Error("point-in-time recovery needs a WAL archive directory or a shared store");
    if (opts.archiveDir && /["'\\\n]/.test(opts.archiveDir)) throw new Error("the WAL archive path must not contain quotes, backslashes or newlines");
    this.store = opts.store;
    this.opts = { retentionDays: 7, baseEveryHours: 24, recoveryTimeoutMs: 15 * 60_000, archiveDir: opts.archiveDir ?? "", baseDir: opts.baseDir ?? join(opts.scratchDir, "base"), ...opts };
  }

  private bin(n: string) {
    return this.opts.pgBinDir ? join(this.opts.pgBinDir, n) : n;
  }

  private async target(id: string): Promise<Target> {
    const adminUrl = await this.control.clusters.adminUrl(id);
    if (this.store) return { id, adminUrl, archiveDir: null, baseDir: this.opts.baseDir, archived: true };
    if (id === MAIN) return { id, adminUrl, archiveDir: this.opts.archiveDir, baseDir: this.opts.baseDir, archived: true };
    const r = (await this.control.pool.query<{ archive_dir: string | null }>(`SELECT archive_dir FROM clusters WHERE id = $1`, [id])).rows[0];
    if (!r) throw new HttpError(404, "cluster not found");
    return { id, adminUrl, archiveDir: r.archive_dir, baseDir: join(this.opts.baseDir, id), archived: r.archive_dir !== null };
  }

  /** Recovery runs this host's server binaries against the cluster's backups, so they have to be the same major version. */
  private async checkVersions(t: Target) {
    this.binMajor ??= Number(/PostgreSQL\) (\d+)/.exec((await run(this.bin("postgres"), ["--version"])).out)?.[1]);
    const server = await this.admin(t, async (c) => Math.floor(Number((await c.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)).rows[0]!.v) / 10000));
    if (this.binMajor !== server) throw new Error(`cluster ${t.id} runs PostgreSQL ${server}, but the server binaries baas uses for recovery are version ${this.binMajor} (set BAAS_PG_BIN_DIR to a matching install)`);
  }

  private connEnv(t: Target) {
    const u = new URL(t.adminUrl);
    return { args: ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)], env: { PGPASSWORD: decodeURIComponent(u.password) } };
  }

  private async resolveUser(): Promise<{ uid: number; gid: number } | undefined> {
    if (this.opts.runAs) return this.opts.runAs;
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return undefined;
    try {
      const uid = Number((await run("id", ["-u", "postgres"])).out.trim());
      const gid = Number((await run("id", ["-g", "postgres"])).out.trim());
      if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
    } catch { /* fall through */ }
    throw new Error("baas is running as root and there is no postgres user to run the recovery server as; run baas as a normal user");
  }

  private async admin<T>(t: Target, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: t.adminUrl });
    c.on("error", () => {});
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }

  /** Is the cluster archiving, and what does the archive cover? */
  async status(clusterId: string = MAIN) {
    const t = await this.target(clusterId);
    const s = await this.admin(t, async (c) => {
      const set = (await c.query<{ name: string; setting: string }>(`SELECT name, setting FROM pg_settings WHERE name IN ('archive_mode', 'archive_command', 'wal_level')`)).rows;
      const v = Object.fromEntries(set.map((r) => [r.name, r.setting]));
      const a = (await c.query(`SELECT last_archived_wal, last_archived_time, failed_count, last_failed_wal, last_failed_time FROM pg_stat_archiver`)).rows[0];
      return { archive_mode: v.archive_mode ?? "off", wal_level: v.wal_level ?? "", archive_command_set: !!v.archive_command && v.archive_command !== "(disabled)", archiver: a };
    });
    const archive_dir_configured = t.archived;
    const enabled = archive_dir_configured && s.archive_mode !== "off" && s.archive_command_set && s.wal_level !== "minimal";
    const bases = (await this.control.pool.query<BaseBackup>(
      `SELECT id, status, started_at, finished_at, size_bytes, error FROM pitr_base_backups WHERE cluster_id = $1 ORDER BY started_at DESC LIMIT 20`, [t.id])).rows;
    const earliest = (await this.control.pool.query<{ t: Date | null }>(`SELECT min(finished_at) AS t FROM pitr_base_backups WHERE status = 'complete' AND cluster_id = $1`, [t.id])).rows[0]!.t;
    return {
      cluster: t.id, archive_dir_configured, enabled, archive_mode: s.archive_mode, retention_days: this.opts.retentionDays,
      archiver: s.archiver ? { last_archived_wal: s.archiver.last_archived_wal, last_archived_time: s.archiver.last_archived_time, failed_count: Number(s.archiver.failed_count), last_failed_time: s.archiver.last_failed_time } : null,
      window: enabled && earliest ? { earliest, latest: new Date() } : null,
      base_backups: bases,
    };
  }

  async takeBaseBackup(clusterId: string = MAIN): Promise<BaseBackup> {
    const t = await this.target(clusterId);
    if (this.busy.has(t.id)) throw new HttpError(409, "a base backup or recovery is already running on this cluster");
    this.busy.add(t.id);
    const id = (await this.control.pool.query<{ id: string }>(`INSERT INTO pitr_base_backups (status, cluster_id) VALUES ('running', $1) RETURNING id`, [t.id])).rows[0]!.id;
    const dir = join(this.store ? this.opts.scratchDir : t.baseDir, this.store ? `base-${id}` : id);
    const tarball = join(this.opts.scratchDir, `base-${id}.tar.gz`);
    try {
      const st = await this.status(t.id);
      if (!st.enabled) throw new Error(st.archive_dir_configured ? "WAL archiving is not switched on for this Postgres server" : `cluster ${t.id} has no WAL archive directory registered (baas admin clusters update ${t.id} --archive-dir <path>)`);
      await this.checkVersions(t);
      await mkdir(this.store ? this.opts.scratchDir : t.baseDir, { recursive: true, mode: 0o700 });
      const { args, env } = this.connEnv(t);
      // -X none: the WAL a backup needs is fetched from the archive at recovery time, which Postgres makes sure is complete before it returns.
      await run(this.bin("pg_basebackup"), [...args, "-D", dir, "-F", "p", "-X", "none", "-c", "fast", "--no-sync"], env);
      const label = await readFile(join(dir, "backup_label"), "utf8");
      const startWal = /START WAL LOCATION: \S+ \(file ([0-9A-F]{24})\)/.exec(label)?.[1] ?? null;
      const finished = (await this.admin(t, (c) => c.query<{ t: Date }>(`SELECT now() AS t`))).rows[0]!.t;
      const size = await dirSize(dir);
      let where = dir;
      if (this.store) {
        // Into the shared store as one tarball, then the local copy goes: any node can recover from it.
        await run("tar", ["-czf", tarball, "-C", dir, "."]);
        where = `${t.id}/base/${id}.tar.gz`;
        await this.store.putFile(where, tarball);
        await rm(dir, { recursive: true, force: true });
      }
      const row = (await this.control.pool.query<BaseBackup>(
        `UPDATE pitr_base_backups SET status = 'complete', path = $2, finished_at = $3, start_wal = $4, size_bytes = $5 WHERE id = $1
         RETURNING id, status, started_at, finished_at, size_bytes, error`, [id, where, finished, startWal, size])).rows[0]!;
      return row;
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      await rm(tarball, { force: true });
      if (this.store) await this.store.delete(`${t.id}/base/${id}.tar.gz`).catch(() => {});
      await this.control.pool.query(`UPDATE pitr_base_backups SET status = 'failed', error = $2, path = NULL WHERE id = $1`, [id, (err as Error).message.slice(0, 500)]);
      throw new HttpError(500, `base backup failed: ${(err as Error).message.slice(0, 200)}`);
    } finally {
      await rm(tarball, { force: true });
      this.busy.delete(t.id);
    }
  }

  /** Forget base backups past retention (always keeping the newest) and the WAL only they needed. */
  async prune(clusterId: string = MAIN): Promise<{ removedBackups: number }> {
    const t = await this.target(clusterId);
    const keep = (await this.control.pool.query<{ id: string; path: string | null; start_wal: string | null; finished_at: Date }>(
      `SELECT id, path, start_wal, finished_at FROM pitr_base_backups WHERE status = 'complete' AND cluster_id = $1 ORDER BY finished_at DESC`, [t.id])).rows;
    const cutoff = Date.now() - this.opts.retentionDays * 86_400_000;
    // Recovery to a moment needs the newest backup before it, so the newest backup older than the window is kept too.
    const firstOld = keep.findIndex((b) => b.finished_at.getTime() < cutoff);
    const drop = firstOld === -1 ? [] : keep.slice(firstOld + 1);
    for (const b of drop) {
      if (b.path) { if (this.store) await this.store.delete(b.path); else await rm(b.path, { recursive: true, force: true }); }
      await this.control.pool.query(`DELETE FROM pitr_base_backups WHERE id = $1`, [b.id]);
    }
    await this.control.pool.query(`DELETE FROM pitr_base_backups WHERE status = 'failed' AND cluster_id = $1 AND started_at < now() - interval '7 days'`, [t.id]);
    const oldest = keep.slice(0, keep.length - drop.length).at(-1);
    if (oldest?.start_wal && this.store) {
      // What pg_archivecleanup does for a directory: segments older than the oldest backup's first one are of no use any more.
      for (const k of await this.store.list(`${t.id}/wal/`).catch(() => [] as string[])) {
        const name = k.slice(k.lastIndexOf("/") + 1);
        if (/^[0-9A-F]{24}$/.test(name) && name < oldest.start_wal) await this.store.delete(k).catch(() => {});
      }
    } else if (oldest?.start_wal && t.archiveDir) await run(this.bin("pg_archivecleanup"), [t.archiveDir, oldest.start_wal]).catch(() => {});
    return { removedBackups: drop.length };
  }

  /** Housekeeping, for every cluster in turn: a fresh base backup when due, then pruning. Quiet where archiving is not switched on. */
  async runScheduled(): Promise<string> {
    const ids = (await this.control.pool.query<{ id: string }>(`SELECT id FROM clusters ORDER BY created_at, id`)).rows.map((r) => r.id);
    const done: string[] = [], failed: string[] = [];
    for (const id of ids) {
      try {
        const st = await this.status(id);
        if (!st.enabled) continue;
        const last = (await this.control.pool.query<{ t: Date | null }>(`SELECT max(started_at) AS t FROM pitr_base_backups WHERE status IN ('complete', 'running') AND cluster_id = $1`, [id])).rows[0]!.t;
        let taken = false;
        if (!last || Date.now() - last.getTime() > this.opts.baseEveryHours * 3_600_000) { await this.takeBaseBackup(id); taken = true; }
        const { removedBackups } = await this.prune(id);
        done.push(`${id === MAIN ? "" : `${id}: `}${taken ? "base backup taken" : "base backup current"}${removedBackups ? `, ${removedBackups} old removed` : ""}`);
      } catch (e) {
        failed.push(`${id}: ${(e as Error).message}`); // one cluster being down must not stop the others' backups
      }
    }
    if (failed.length) throw new Error(`${failed.join("; ")}${done.length ? ` (${done.join("; ")})` : ""}`);
    return done.length ? done.join("; ") : "off";
  }

  /** The secret a cluster's archive_command presents when it uploads WAL: derived, so there is nothing to store and a cluster's token is useless for another. */
  archiveToken(clusterId: string): string {
    if (!this.opts.archiveSecret) throw new HttpError(409, "WAL upload is not enabled: this server keeps its archive in a directory");
    if (clusterId === MAIN && this.opts.mainToken) return this.opts.mainToken;
    return createHmac("sha256", this.opts.archiveSecret).update(`pitr-wal:${clusterId}`).digest("hex");
  }

  get sharedStore(): boolean {
    return !!this.store;
  }

  /** Accept one WAL file from a cluster's archive_command. Safe to repeat: the same file again is fine, a different one under the same name is refused. */
  async ingestWal(clusterId: string, file: string, token: string, data: Buffer): Promise<void> {
    const want = Buffer.from(this.archiveToken(clusterId));
    const got = Buffer.from(token);
    // (a fixed main token must be long enough to be a secret)
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "bad archive token");
    if (!/^(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$/.test(file)) throw new HttpError(400, "not a WAL file name");
    if (!(await this.control.pool.query(`SELECT 1 FROM clusters WHERE id = $1`, [clusterId])).rowCount) throw new HttpError(404, "cluster not found");
    const key = `${clusterId}/wal/${file}`;
    const have = await this.store!.get(key);
    if (have) {
      const same = have.size === data.length;
      have.stream.destroy();
      if (same) return;
      throw new HttpError(409, "a different file with this name is already archived");
    }
    await this.store!.put(key, data);
  }

  /** The archive_command to give a cluster's Postgres (see deploy/pitr-archive.sh), for baas reachable at `baseUrl` from the database host. */
  archiveCommand(clusterId: string, baseUrl: string): { command: string; token: string } {
    const token = this.archiveToken(clusterId);
    return { token, command: `/etc/baas/pitr-archive.sh ${baseUrl.replace(/\/+$/, "")} ${clusterId} ${token} %p %f` };
  }

  /** Delete what a removed cluster left behind. */
  async forgetCluster(id: string): Promise<void> {
    if (this.store) { await this.store.deletePrefix(`${id}/`).catch(() => {}); return; }
    if (id !== MAIN) await rm(join(this.opts.baseDir, id), { recursive: true, force: true });
  }

  /** Make sure everything up to this moment is in the archive, so a target close to "now" can be replayed. */
  private async flushArchive(t: Target): Promise<Date> {
    return this.admin(t, async (c) => {
      // A WAL record first, so the switch has something to close; then wait for exactly that segment to be archived.
      await c.query(`SELECT pg_logical_emit_message(false, 'baas', 'point-in-time recovery')`);
      const { t, seg } = (await c.query<{ t: Date; seg: string }>(`SELECT now() AS t, pg_walfile_name(pg_switch_wal()) AS seg`)).rows[0]!;
      for (let i = 0; i < 100; i++) {
        const last = (await c.query<{ w: string | null }>(`SELECT last_archived_wal AS w FROM pg_stat_archiver`)).rows[0]!.w;
        if (last && last >= seg) return t;
        await sleep(300);
      }
      throw new Error("the server did not archive its latest WAL in time; check archive_command");
    });
  }

  /**
   * Replace the project's database with how it was at `to`. Owner only. The current state is saved as a backup first.
   * Resolves with what was done; the project is unreachable for the moment of the swap only.
   */
  async restore(p: Principal, ref: string, to: Date): Promise<{ restored_to: string; base_backup: string; safety_backup: string }> {
    ControlPlane.require(p, "owner");
    const project = await this.control.getProject(p, ref);
    if (project.status !== "active") throw new HttpError(409, `cannot restore a project that is ${project.status}`);
    if (!planOf(project.plan).pitr) throw new HttpError(403, `point-in-time recovery is not part of the ${project.plan} plan`);
    if (Number.isNaN(to.getTime())) throw new HttpError(400, "to must be a date and time");
    if (to.getTime() > Date.now()) throw new HttpError(400, "to is in the future");
    const t = await this.target(project.cluster_id);
    if (!t.archived) throw new HttpError(409, `point-in-time recovery is not set up for cluster ${t.id}: it has no WAL archive directory registered`);
    const st = await this.status(t.id);
    if (!st.enabled) throw new HttpError(409, "point-in-time recovery is not set up on this server (WAL archiving is off)");
    // A project that moved here has no history here from before it arrived; what came earlier lives on the cluster it left.
    const arrived = (await this.control.pool.query<{ at: Date }>(`SELECT max(at) AS at FROM audit_log WHERE action = 'project.move' AND target = $1 AND meta->>'to' = $2`, [ref, t.id])).rows[0]!.at;
    if (arrived && to < arrived) throw new HttpError(400, `this project moved onto cluster ${t.id} at ${arrived.toISOString()}, so it can only be restored to a moment after that`);
    const base = (await this.control.pool.query<{ id: string; path: string; finished_at: Date; start_wal: string | null }>(
      `SELECT id, path, finished_at, start_wal FROM pitr_base_backups WHERE status = 'complete' AND cluster_id = $2 AND finished_at <= $1 ORDER BY finished_at DESC LIMIT 1`, [to, t.id])).rows[0];
    if (!base) throw new HttpError(400, st.window ? `the earliest moment that can be restored is ${st.window.earliest.toISOString()}` : "no base backup exists yet");
    if (this.busy.has(t.id)) throw new HttpError(409, "a base backup or recovery is already running on this cluster");
    this.busy.add(t.id);
    const scratch = join(this.opts.scratchDir, `recover-${base.id.slice(0, 8)}-${Date.now()}`);
    const walCache = `${scratch}-wal`;
    let proc: ChildProcess | null = null;
    try {
      await this.checkVersions(t);
      await this.flushArchive(t);
      const user = await this.resolveUser();
      await mkdir(this.opts.scratchDir, { recursive: true, mode: 0o700 });
      if (user) await chmod(this.opts.scratchDir, 0o711); // the recovery user has to be able to reach its copy
      if (this.store) {
        // Pull the base backup and the WAL since it began out of the shared store into scratch space.
        const tarball = `${scratch}.tar.gz`;
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        if (!(await this.store.getToFile(base.path, tarball))) throw new Error("the base backup is missing from the store");
        await run("tar", ["-xzf", tarball, "-C", scratch]);
        await rm(tarball, { force: true });
        await mkdir(walCache, { recursive: true, mode: 0o755 });
        for (const k of await this.store.list(`${t.id}/wal/`)) {
          const name = k.slice(k.lastIndexOf("/") + 1);
          if (/^[0-9A-F]{24}$/.test(name) ? name >= (base.start_wal ?? "") : /^[0-9A-F]{8}\.history$/.test(name)) {
            await this.store.getToFile(k, join(walCache, name));
            await chmod(join(walCache, name), 0o644);
          }
        }
      } else await cp(base.path, scratch, { recursive: true });
      await chmod(scratch, 0o700);
      const port = await freePort();
      const settings = await this.admin(t, async (c) => Object.fromEntries((await c.query<{ name: string; setting: string }>(
        `SELECT name, setting FROM pg_settings WHERE name IN ('max_connections','max_worker_processes','max_wal_senders','max_prepared_transactions','max_locks_per_transaction','shared_preload_libraries','wal_level')`)).rows.map((r) => [r.name, r.setting])));
      const superuser = decodeURIComponent(new URL(t.adminUrl).username);
      await writeFile(join(scratch, "baas_hba.conf"), "local all all trust\n");
      await writeFile(join(scratch, "postgresql.auto.conf"), [
        // Later settings win, so these override whatever the copied configuration says.
        `# written by baas for a point-in-time recovery`,
        ...Object.entries(settings).filter(([k, v]) => v !== "" && k !== "wal_level").map(([k, v]) => `${k} = ${q(v)}`),
        `hot_standby = off`, `archive_mode = off`, `archive_command = ''`,
        // Formatting only, and this host may not have the primary's locales (the databases themselves need en_US.UTF-8 if they use it).
        `lc_messages = 'C'`, `lc_monetary = 'C'`, `lc_numeric = 'C'`, `lc_time = 'C'`, `ssl = off`, `listen_addresses = ''`, `port = ${port}`,
        `unix_socket_directories = ${q(scratch)}`, `hba_file = ${q(join(scratch, "baas_hba.conf"))}`,
        `fsync = off`, `synchronous_commit = off`, `full_page_writes = off`, `log_min_messages = warning`,
        `restore_command = ${q(`cp "${this.store ? walCache : t.archiveDir}/%f" "%p"`)}`,
        `recovery_target_time = ${q(to.toISOString().replace("T", " ").replace("Z", "+00"))}`, `recovery_target_action = 'promote'`, `recovery_target_inclusive = on`,
      ].join("\n") + "\n");
      await writeFile(join(scratch, "recovery.signal"), "");
      if (user) await chownR(scratch, user.uid, user.gid);

      proc = spawn(this.bin("postgres"), ["-D", scratch], { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "ignore", "pipe"], ...(user ? { uid: user.uid, gid: user.gid } : {}) });
      let log = "";
      proc.stderr!.on("data", (d) => { log = (log + d).slice(-4000); });
      let exited: number | null = null;
      proc.on("exit", (code) => { exited = code ?? -1; });
      proc.on("error", (e) => { log += `\n${e.message}`; exited = -1; });

      const dump = join(scratch, "baas.dump"); // inside the scratch directory, which the recovery user owns
      const deadline = Date.now() + this.opts.recoveryTimeoutMs;
      let ready = false;
      while (Date.now() < deadline) {
        if (exited !== null) throw new Error(`the recovery server stopped (${exited}): ${log.trim().split("\n").slice(-3).join(" ")}`);
        const c = new pg.Client({ host: scratch, port, user: superuser, database: "postgres" });
        c.on("error", () => {});
        try {
          await c.connect();
          const inRecovery = (await c.query<{ r: boolean }>(`SELECT pg_is_in_recovery() AS r`)).rows[0]!.r;
          const exists = (await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbNameOf(ref)])).rowCount;
          await c.end();
          if (!inRecovery) {
            if (!exists) throw new HttpError(400, "this project did not exist at that moment");
            ready = true;
            break;
          }
        } catch (e) {
          await c.end().catch(() => {});
          if (e instanceof HttpError) throw e;
        }
        await sleep(400);
      }
      if (!ready) throw new Error("the recovery did not finish in time");
      await run(this.bin("pg_dump"), ["-Fc", "-h", scratch, "-p", String(port), "-U", superuser, "-f", dump, "-d", dbNameOf(ref)], {}, user ?? {});
      await stopServer(proc);
      proc = null;
      await this.stopped(scratch);

      // Keep the way back: the state being replaced is saved as a backup first.
      const safety = await this.backups.create(null, ref, "manual", `before point-in-time restore to ${to.toISOString()}`);
      await this.backups.swapIn(ref, dump, p, "pitr.restore", { to: to.toISOString(), base_backup: base.id, safety_backup: safety.id });
      return { restored_to: to.toISOString(), base_backup: base.id, safety_backup: safety.id };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `point-in-time restore failed: ${(err as Error).message.slice(0, 300)}`);
    } finally {
      if (proc) await stopServer(proc).catch(() => {});
      await rm(scratch, { recursive: true, force: true });
      await rm(walCache, { recursive: true, force: true });
      this.busy.delete(t.id);
    }
  }

  private async stopped(dir: string) {
    for (let i = 0; i < 50; i++) {
      if (!(await stat(join(dir, "postmaster.pid")).then(() => true, () => false))) return;
      await sleep(100);
    }
  }
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGINT"); // fast shutdown
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { proc.kill("SIGKILL"); }, 15_000);
    proc.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

async function dirSize(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return n;
}
