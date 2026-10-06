import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { ProjectAdmin } from "./admin-sql.js";
import { AiAssistant } from "./ai/assistant.js";
import { AnthropicLlm, type LlmClient } from "./ai/llm.js";
import { OpenAiLlm, type OpenAiLlmOptions } from "./ai/openai.js";
import { buildApi } from "./api.js";
import { AuthService, type AuthOptions } from "./authsvc.js";
import { BackupService } from "./backup.js";
import { ControlPlane } from "./control.js";
import { ExtensionService } from "./extensions.js";
import { FunctionService } from "./functions.js";
import { buildGateway } from "./gateway.js";
import { mailerFrom, type Mailer } from "./mailer.js";
import { DiskStore, PgStore, PrefixStore, S3Store } from "./blobs.js";
import { ClusterMover } from "./clusters.js";
import type { S3Config } from "./s3.js";
import { migrateBackups, migrateStorage } from "./storage-migrate.js";
import { Coordinator } from "./coordinator.js";
import { PgLimits } from "./limits.js";
import { PitrService, type PitrOptions } from "./pitr.js";
import { smsFrom, type SmsSender, type TwilioConfig } from "./sms.js";
import { migrate } from "./migrate.js";
import { initializeMembers, type InitialMembers } from "./initial-members.js";
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
  /** Optional, one-time owner/admin accounts for an empty installation. */
  initialMembers?: InitialMembers;
  storageDir: string;
  /** "postgres" keeps object bytes (and backups) in the control database instead of storageDir: no shared filesystem, no S3 account. Ignored when s3 is set. */
  storageBackend?: "disk" | "postgres";
  /** Keep object bytes in an S3 bucket instead of storageDir. Nodes then need no shared filesystem. */
  s3?: S3Config & { /** Create the bucket at start-up if it does not exist (for a bundled S3 server). */ createBucket?: boolean };
  backupDir: string;
  pgBinDir?: string;
  /** Point-in-time recovery. Set to turn it on; the Postgres server must archive its WAL into `archiveDir`. */
  /** `shared: true` keeps the WAL archive and base backups in the shared store (S3, else Postgres) instead of directories. */
  pitr?: PitrOptions & { shared?: boolean };
  /** Base domain for project hosts: <ref>.<gatewayDomain>. */
  gatewayDomain: string;
  publicScheme: string;
  /** Port clients use to reach the gateway (null for the default port of the scheme). */
  publicPort: number | null;
  purgeRetentionMs: number;
  dashboardDir?: string;
  /** Hostname the dashboard is served on behind a TLS proxy (for certificate checks). */
  /** Text messages for phone sign-in: a sender (tests) or Twilio credentials. */
  sms?: { sender?: SmsSender; twilio?: TwilioConfig };
  dashboardHost?: string;
  /** Full address of the dashboard for links in emails (overrides one derived from dashboardHost or dashboardOrigins). */
  dashboardUrl?: string;
  /** Origins the dashboard runs on. Always allowed by the data plane's CORS, so restricting a project's cors_origins cannot lock the dashboard out. */
  dashboardOrigins?: string[];
  realtimeCheckMs?: number;
  /** Edge function network policy: "public" (default) refuses private and local addresses; "open" does not. `allow` lists host:port exceptions. */
  functions?: { egress?: "public" | "open"; egressAllow?: string[] };
  /** Outgoing email for confirmation, password reset and magic links. Leave out to switch those flows off. Give `mailer` to supply your own (tests do). */
  mail?: { smtpUrl?: string; from?: string; mailer?: Mailer };
  auth?: Pick<AuthOptions, "providerOverrides" | "emailCooldownMs" | "maxEmailsPerHour" | "fetch" | "oidcAllowPrivate" | "smsCooldownMs" | "maxSmsPerHour">;
  /** Webhook pipelines. `tickMs` is how often pending changes are delivered (default 5 s). */
  pipelines?: PipelineOptions & { tickMs?: number };
  /** Server-side cap on any single data-plane query (default 20 s). Users cannot raise it with SET statement_timeout. */
  queryTimeoutMs?: number;
  /** Omit to leave the AI assistant unavailable. Give `llm` to supply your own model client (tests do), or `model` to use Anthropic. */
  ai?: {
    llm?: LlmClient;
    /** Use a model behind an OpenAI-style Chat Completions API (OpenAI, Azure, OpenRouter, Ollama, vLLM...) instead of Anthropic. */
    openai?: OpenAiLlmOptions;
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
  let initialMembers;
  try {
    initialMembers = await initializeMembers(pool, cfg.initialMembers);
  } catch (err) {
    await pool.end();
    throw err;
  }
  const dir = new Directory(control);
  const pm = new PoolManager(dir, cfg.pgAdminUrl, { maxPools: 100, perPool: 5, queryTimeoutMs: cfg.queryTimeoutMs });

  // Where object bytes go: S3 if configured, else Postgres if asked for, else the local disk. The first two are shared by every node.
  const blobs = cfg.s3 ? new S3Store(cfg.s3) : cfg.storageBackend === "postgres" ? new PgStore(pool) : new DiskStore(cfg.storageDir);
  // A wrong bucket or key is found now, not at the first upload.
  if (blobs instanceof S3Store) {
    let last: unknown;
    // A bundled S3 server may still be starting; try for a while before giving up.
    for (let i = 0; i < 15; i++) {
      try {
        if (cfg.s3!.createBucket) await blobs.s3.createBucket();
        await blobs.s3.check();
        last = undefined;
        break;
      } catch (e) {
        last = e;
        const status = (e as { status?: number }).status ?? 0;
        if (status !== 0 && status !== 503) break; // a real answer, such as a wrong key: waiting will not change it
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (last) throw new Error(`cannot use the S3 bucket "${cfg.s3!.bucket}": ${(last as Error).message}`);
  }
  const storage = new StorageService(pm, {
    blobs,
    limits: (p) => {
      const plan = planOf(p.plan);
      return { fileSize: plan.fileSizeBytes, totalBytes: plan.storageBytes };
    },
  });
  const coordinator = new Coordinator(pool, cfg.controlUrl, { log: (m) => console.error(`[nodes] ${m}`) });
  const limits = new PgLimits(pool);
  const usage = new UsageService(control, cfg.pgAdminUrl, storage, Date.now, () => coordinator.nodeCount());
  const publicUrl = (ref: string) => `${cfg.publicScheme}://${ref}.${cfg.gatewayDomain}${cfg.publicPort ? `:${cfg.publicPort}` : ""}`;
  const functions = new FunctionService(control, { publicUrl, ...cfg.functions });
  const mailer = mailerFrom(cfg.mail);
  const auth = new AuthService(pm, {
    adminUrl: cfg.pgAdminUrl, vault, mailer, limits, sms: smsFrom(cfg.sms), publicUrl, secureCookies: cfg.publicScheme === "https",
    log: (m) => console.error(`[auth] ${m}`), ...cfg.auth,
  });
  const realtime = new RealtimeHub(pm, { checkMs: cfg.realtimeCheckMs });
  // Backups follow the files: in a shared store any node can restore a backup any other node took (the backup directory is then scratch only).
  const backupBlobs = blobs.kind === "disk" ? undefined : new PrefixStore(blobs, "backups/");
  const backups = new BackupService(control, { dir: cfg.backupDir, pgBinDir: cfg.pgBinDir, blobs: backupBlobs });
  const mover = new ClusterMover(control.clusters, pool, vault, backups, cfg.backupDir, (action, ref, orgId, meta) => control.audit("operator", orgId, action, ref, meta), (ref) => dir.forget(ref));
  const pitrStore = cfg.pitr?.shared ? new PrefixStore(blobs.kind === "disk" ? new PgStore(pool) : blobs, "pitr/") : undefined;
  const pitr = cfg.pitr ? new PitrService(control, backups, { pgBinDir: cfg.pgBinDir, archiveSecret: cfg.masterKey, ...cfg.pitr, store: pitrStore }) : undefined;
  const admin = new ProjectAdmin(pm);
  const pipelines = new PipelineService(pool, control, pm, vault, cfg.pipelines);
  const extensions = new ExtensionService(control, pm);
  const llm = cfg.ai?.llm ?? (cfg.ai?.openai ? new OpenAiLlm(cfg.ai.openai) : undefined) ?? (cfg.ai?.model ? new AnthropicLlm({ model: cfg.ai.model, effort: cfg.ai.effort, serverFallbacks: cfg.ai.serverFallbacks }) : undefined);
  const ai = new AiAssistant(control, pm, llm, { queryTimeoutMs: cfg.ai?.queryTimeoutMs, totalTimeoutMs: cfg.ai?.totalTimeoutMs });

  const gateway: FastifyInstance = buildGateway(pm, { auth, storage, functions, realtime }, {
    domain: cfg.gatewayDomain, hooks: usage.hooks(), settingsFor: async (ref) => (await dir.get(ref))?.settings,
    alwaysAllow: [...(cfg.dashboardOrigins ?? []), ...(cfg.dashboardHost ? [`https://${cfg.dashboardHost}`] : [])],
  });
  const api: FastifyInstance = buildApi(control, cfg.bootstrapToken, {
    admin, usage, backups, pitr, mover, coordinator, limits, functions,
    storageMigrate: backupBlobs ? async () => ({ ...(await migrateStorage(control, new DiskStore(cfg.storageDir), blobs, (r, i) => storage.key(r, i))), backups: await migrateBackups(control, cfg.backupDir, backupBlobs) }) : undefined, ai, pipelines, extensions, auth, vault, mailer,
    dashboardUrl: cfg.dashboardUrl ?? (cfg.dashboardHost ? `https://${cfg.dashboardHost}` : cfg.dashboardOrigins?.[0]),
    gateway: { domain: cfg.gatewayDomain, scheme: cfg.publicScheme, port: cfg.publicPort },
    dashboardDir: cfg.dashboardDir ?? defaultDashboardDir, dashboardHost: cfg.dashboardHost,
  });

  const platformState: { lastHousekeep?: { at: Date; report: Record<string, unknown> } } = {};
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
    await step("movesReconciled", () => mover.reconcile());
    await step("limitsPruned", () => limits.prune());
    if (pitr) await step("pitr", () => pitr.runScheduled());
    return report;
  }

  return {
    initialMembers,
    cfg, pool, control, pm, dir, storage, usage, functions, realtime, backups, pitr, mover, coordinator, limits, admin, ai, pipelines, extensions, auth, gateway, api, migrations, housekeep,

    /**
     * Start the background work. With several nodes sharing a control database, usage counters flush on every node, but
     * housekeeping and webhook delivery run only on the leader, so they do not run twice.
     */
    async start(intervalMs = 10 * 60_000, pipelineTickMs?: number) {
      await coordinator.start();
      usage.start();
      timer = setInterval(() => {
        if (!coordinator.isLeader()) return;
        void housekeep().then((report) => { platformState.lastHousekeep = { at: new Date(), report }; }).catch(() => {});
      }, intervalMs);
      timer.unref();
      pipelineTimer = setInterval(() => { if (coordinator.isLeader()) void pipelines.tick().catch(() => {}); }, pipelineTickMs ?? cfg.pipelines?.tickMs ?? 5_000);
      pipelineTimer.unref();
    },
    /** What the periodic housekeeping last did on this node (only the leader runs it). */
    get lastHousekeep() { return platformState.lastHousekeep; },

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
      await coordinator.stop();
      await usage.stop();
      await pm.end();
      await pool.end();
    },
  };
}
