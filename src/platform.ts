import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { ProjectAdmin } from "./admin-sql.js";
import { AiAssistant } from "./ai/assistant.js";
import { AnthropicLlm, type LlmClient } from "./ai/llm.js";
import { buildApi } from "./api.js";
import { AuthService, type AuthOptions } from "./authsvc.js";
import { BackupService } from "./backup.js";
import { ControlPlane } from "./control.js";
import { ExtensionService } from "./extensions.js";
import { FunctionService } from "./functions.js";
import { buildGateway } from "./gateway.js";
import { mailerFrom, type Mailer } from "./mailer.js";
import { migrate } from "./migrate.js";
import { PipelineService, type PipelineOptions } from "./pipelines.js";
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
  /** Hostname the dashboard is served on behind a TLS proxy (for certificate checks). */
  dashboardHost?: string;
  realtimeCheckMs?: number;
  /** Outgoing email for confirmation, password reset and magic links. Leave out to switch those flows off. Give `mailer` to supply your own (tests do). */
  mail?: { smtpUrl?: string; from?: string; mailer?: Mailer };
  auth?: Pick<AuthOptions, "providerOverrides" | "emailCooldownMs" | "maxEmailsPerHour" | "fetch">;
  /** Webhook pipelines. `tickMs` is how often pending changes are delivered (default 5 s). */
  pipelines?: PipelineOptions & { tickMs?: number };
  /** Server-side cap on any single data-plane query (default 20 s). Users cannot raise it with SET statement_timeout. */
  queryTimeoutMs?: number;
  /** Omit to leave the AI assistant unavailable. Give `llm` to supply your own model client (tests do), or `model` to use Anthropic. */
  ai?: {
    llm?: LlmClient;
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    serverFallbacks?: boolean;
    queryTimeoutMs?: number;
    totalTimeoutMs?: number;
  };
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
  const publicUrl = (ref: string) => `${cfg.publicScheme}://${ref}.${cfg.gatewayDomain}${cfg.publicPort ? `:${cfg.publicPort}` : ""}`;
  const functions = new FunctionService(control, { publicUrl });
  const auth = new AuthService(pm, {
    adminUrl: cfg.pgAdminUrl, vault, mailer: mailerFrom(cfg.mail), publicUrl, secureCookies: cfg.publicScheme === "https",
    log: (m) => console.error(`[auth] ${m}`), ...cfg.auth,
  });
  const realtime = new RealtimeHub(pm, cfg.pgAdminUrl, { checkMs: cfg.realtimeCheckMs });
  const backups = new BackupService(control, { dir: cfg.backupDir, pgBinDir: cfg.pgBinDir });
  const admin = new ProjectAdmin(pm);
  const pipelines = new PipelineService(pool, control, pm, cfg.pgAdminUrl, vault, cfg.pipelines);
  const extensions = new ExtensionService(control, pm, cfg.pgAdminUrl);
  const llm = cfg.ai?.llm ?? (cfg.ai?.model ? new AnthropicLlm({ model: cfg.ai.model, effort: cfg.ai.effort, serverFallbacks: cfg.ai.serverFallbacks }) : undefined);
  const ai = new AiAssistant(control, pm, llm, { queryTimeoutMs: cfg.ai?.queryTimeoutMs, totalTimeoutMs: cfg.ai?.totalTimeoutMs });

  const gateway: FastifyInstance = buildGateway(pm, { auth, storage, functions, realtime }, { domain: cfg.gatewayDomain, hooks: usage.hooks() });
  const api: FastifyInstance = buildApi(control, cfg.bootstrapToken, {
    admin, usage, backups, functions, ai, pipelines, extensions, auth,
    gateway: { domain: cfg.gatewayDomain, scheme: cfg.publicScheme, port: cfg.publicPort },
    dashboardDir: cfg.dashboardDir ?? defaultDashboardDir, dashboardHost: cfg.dashboardHost,
  });

  let timer: NodeJS.Timeout | undefined;
  let pipelineTimer: NodeJS.Timeout | undefined;

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
    await step("prunedHourly", () => usage.pruneHourly());
    await step("scheduledBackups", () => backups.runScheduled());
    return report;
  }

  return {
    cfg, pool, control, pm, dir, storage, usage, functions, realtime, backups, admin, ai, pipelines, extensions, auth, gateway, api, migrations, housekeep,

    start(intervalMs = 10 * 60_000) {
      usage.start();
      timer = setInterval(() => void housekeep().catch(() => {}), intervalMs);
      timer.unref();
      pipelineTimer = setInterval(() => void pipelines.tick().catch(() => {}), cfg.pipelines?.tickMs ?? 5_000);
      pipelineTimer.unref();
    },

    async listen(ports: { api: number; gateway: number; host?: string }) {
      const host = ports.host ?? "0.0.0.0";
      await api.listen({ host, port: ports.api });
      await gateway.listen({ host, port: ports.gateway });
      return { api: (api.server.address() as { port: number }).port, gateway: (gateway.server.address() as { port: number }).port };
    },

    async stop() {
      if (timer) clearInterval(timer);
      if (pipelineTimer) clearInterval(pipelineTimer);
      await gateway.close();
      await api.close();
      await usage.stop();
      await pm.end();
      await pool.end();
    },
  };
}
