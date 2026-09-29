import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { ProjectAdmin } from "./admin-sql.js";
import { buildApi } from "./api.js";
import { AuthService } from "./authsvc.js";
import { BackupService } from "./backup.js";
import { ControlPlane } from "./control.js";
import { FunctionService } from "./functions.js";
import { buildGateway } from "./gateway.js";
import { migrate } from "./migrate.js";
import { planOf } from "./plans.js";
import { Directory, PoolManager } from "./pools.js";
import { RealtimeHub } from "./realtime.js";
import { StorageService } from "./storage.js";
import { UsageService } from "./usage.js";
import { Vault } from "./vault.js";

export type PlatformConfig = {
  controlUrl: string;
  /** Superuser connection to the cluster that hosts project databases. */
  pgAdminUrl: string;
  masterKey: string;
  bootstrapToken: string;
  storageDir: string;
  backupDir: string;
  pgBinDir?: string;
  /** Base domain for project hosts: <ref>.<gatewayDomain>. */
  gatewayDomain: string;
  publicScheme: string;
  /** Port clients use to reach the gateway (null for the default port of the scheme). */
  publicPort: number | null;
  purgeRetentionMs: number;
  dashboardDir?: string;
  realtimeCheckMs?: number;
  /** Server-side cap on any single data-plane query (default 20 s). Users cannot raise it with SET statement_timeout. */
  queryTimeoutMs?: number;
};

export const defaultDashboardDir = fileURLToPath(new URL("../dashboard", import.meta.url));

export type Platform = Awaited<ReturnType<typeof createPlatform>>;

/** Assemble the control plane, data plane and background jobs. Nothing listens until you call listen(). */
export async function createPlatform(cfg: PlatformConfig) {
  const pool = new pg.Pool({ connectionString: cfg.controlUrl });
  pool.on("error", () => {});
  const migrations = await migrate(pool);
  const vault = new Vault(cfg.masterKey);
  const control = new ControlPlane(pool, cfg.pgAdminUrl, vault);
  const dir = new Directory(control);
  const pm = new PoolManager(dir, cfg.pgAdminUrl, { maxPools: 100, perPool: 5, queryTimeoutMs: cfg.queryTimeoutMs });

  const storage = new StorageService(pm, {
    root: cfg.storageDir,
    limits: (p) => {
      const plan = planOf(p.plan);
      return { fileSize: plan.fileSizeBytes, totalBytes: plan.storageBytes };
    },
  });
  const usage = new UsageService(control, cfg.pgAdminUrl, storage);
  const functions = new FunctionService(control, {
    publicUrl: (ref) => `${cfg.publicScheme}://${ref}.${cfg.gatewayDomain}${cfg.publicPort ? `:${cfg.publicPort}` : ""}`,
  });
  const realtime = new RealtimeHub(pm, cfg.pgAdminUrl, { checkMs: cfg.realtimeCheckMs });
  const backups = new BackupService(control, { dir: cfg.backupDir, pgBinDir: cfg.pgBinDir });
  const admin = new ProjectAdmin(pm);

  const gateway: FastifyInstance = buildGateway(pm, { auth: new AuthService(pm), storage, functions, realtime }, { domain: cfg.gatewayDomain, hooks: usage.hooks() });
  const api: FastifyInstance = buildApi(control, cfg.bootstrapToken, {
    admin, usage, backups, functions,
    gateway: { domain: cfg.gatewayDomain, scheme: cfg.publicScheme, port: cfg.publicPort },
    dashboardDir: cfg.dashboardDir ?? defaultDashboardDir,
  });

  let timer: NodeJS.Timeout | undefined;

  /** One pass of background work. Each step is independent: a failure in one does not stop the rest. */
  async function housekeep() {
    const report: Record<string, unknown> = {};
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        report[name] = await fn();
      } catch (err) {
        report[name] = `failed: ${(err as Error).message}`;
      }
    };
    await step("reconciled", () => control.reconcile());
    await step("purged", async () => {
      const refs = await control.purgeDeleted(cfg.purgeRetentionMs);
      for (const ref of refs) {
        await storage.purgeProject(ref);
        await backups.purgeProject(ref);
      }
      return refs;
    });
    await step("autoPaused", () => control.autoPauseIdle());
    await step("flushed", () => usage.flush());
    await step("measured", () => usage.measure());
    await step("scheduledBackups", () => backups.runScheduled());
    return report;
  }

  return {
    cfg, pool, control, pm, dir, storage, usage, functions, realtime, backups, admin, gateway, api, migrations, housekeep,

    start(intervalMs = 10 * 60_000) {
      usage.start();
      timer = setInterval(() => void housekeep().catch(() => {}), intervalMs);
      timer.unref();
    },

    async listen(ports: { api: number; gateway: number; host?: string }) {
      const host = ports.host ?? "0.0.0.0";
      await api.listen({ host, port: ports.api });
      await gateway.listen({ host, port: ports.gateway });
      return { api: (api.server.address() as { port: number }).port, gateway: (gateway.server.address() as { port: number }).port };
    },

    async stop() {
      if (timer) clearInterval(timer);
      await gateway.close();
      await api.close();
      await usage.stop();
      await pm.end();
      await pool.end();
    },
  };
}
