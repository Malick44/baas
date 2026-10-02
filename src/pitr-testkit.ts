/** Starts a throwaway Postgres cluster that archives its WAL, for point-in-time recovery tests. */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdtempSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PG_BIN } from "./platform-testkit.js";

export const HAVE_SERVER_BINARIES = !!PG_BIN && existsSync(join(PG_BIN, "initdb")) && existsSync(join(PG_BIN, "postgres")) && existsSync(join(PG_BIN, "pg_basebackup")) && existsSync(join(PG_BIN, "pg_archivecleanup"));

const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

export async function archivingCluster() {
  const root = mkdtempSync(join(tmpdir(), "baas-pitr-"));
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const owner = asRoot ? { uid: Number(execFileSync("id", ["-u", "postgres"]).toString()), gid: Number(execFileSync("id", ["-g", "postgres"]).toString()) } : undefined;
  chmodSync(root, 0o755);
  if (owner) chownSync(root, owner.uid, owner.gid);
  const data = join(root, "data");
  const wal = join(root, "wal");
  mkdirSync(wal, { mode: 0o755 });
  if (owner) chownSync(wal, owner.uid, owner.gid);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(join(PG_BIN!, cmd), args, { encoding: "utf8", ...(owner ? { uid: owner.uid, gid: owner.gid } : {}), env: { PATH: process.env.PATH ?? "", LANG: "C" } });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  };
  const port = await freePort();
  run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync"]);
  appendFileSync(join(data, "postgresql.conf"), [
    `listen_addresses = '127.0.0.1'`, `port = ${port}`, `unix_socket_directories = '${root}'`, `max_connections = 200`, `fsync = off`,
    `wal_level = replica`, `archive_mode = on`, `archive_command = 'test ! -f ${wal}/%f && cp %p ${wal}/%f'`, `max_wal_senders = 5`,
  ].join("\n") + "\n");
  run("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-w", "-t", "60", "start"]);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    archiveDir: wal,
    root,
    async stop() {
      try { run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* already down */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
