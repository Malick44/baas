import { resolve } from "node:path";
import { createPlatform } from "./platform.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const gatewayPort = Number(process.env.GATEWAY_PORT ?? 8081);
const platform = await createPlatform({
  controlUrl: need("BAAS_CONTROL_URL"),
  pgAdminUrl: need("BAAS_PG_ADMIN_URL"),
  masterKey: need("BAAS_MASTER_KEY"),
  bootstrapToken: need("BAAS_BOOTSTRAP_TOKEN"),
  storageDir: resolve(process.env.BAAS_STORAGE_DIR ?? "./data/storage"),
  s3: process.env.S3_BUCKET ? {
    endpoint: process.env.S3_ENDPOINT ?? "https://s3.amazonaws.com",
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || undefined,
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    pathStyle: process.env.S3_PATH_STYLE !== "false",
    prefix: process.env.S3_PREFIX || undefined,
    createBucket: process.env.S3_CREATE_BUCKET === "true",
  } : undefined,
  storageBackend: process.env.BAAS_STORAGE_BACKEND === "postgres" ? "postgres" : undefined,
  backupDir: resolve(process.env.BAAS_BACKUP_DIR ?? "./data/backups"),
  pgBinDir: process.env.BAAS_PG_BIN_DIR,
  pitr: process.env.BAAS_PITR_ARCHIVE_DIR || process.env.BAAS_PITR_SHARED === "true" ? {
    shared: process.env.BAAS_PITR_SHARED === "true",
    mainToken: process.env.BAAS_PITR_ARCHIVE_TOKEN && process.env.BAAS_PITR_ARCHIVE_TOKEN.length >= 32 ? process.env.BAAS_PITR_ARCHIVE_TOKEN : undefined,
    archiveDir: process.env.BAAS_PITR_ARCHIVE_DIR ? resolve(process.env.BAAS_PITR_ARCHIVE_DIR) : undefined,
    baseDir: resolve(process.env.BAAS_PITR_BASE_DIR ?? "./data/pitr/base"),
    scratchDir: resolve(process.env.BAAS_PITR_SCRATCH_DIR ?? "./data/pitr/scratch"),
    retentionDays: process.env.BAAS_PITR_RETENTION_DAYS ? Number(process.env.BAAS_PITR_RETENTION_DAYS) : undefined,
    baseEveryHours: process.env.BAAS_PITR_BASE_EVERY_HOURS ? Number(process.env.BAAS_PITR_BASE_EVERY_HOURS) : undefined,
  } : undefined,
  gatewayDomain: process.env.BAAS_GATEWAY_DOMAIN ?? "localhost",
  publicScheme: process.env.BAAS_PUBLIC_SCHEME ?? "http",
  publicPort: process.env.BAAS_PUBLIC_PORT ? Number(process.env.BAAS_PUBLIC_PORT) : gatewayPort,
  // The assistant is offered only when the operator has given the server Anthropic credentials.
  // Or a model behind an OpenAI-style API: BAAS_AI_PROVIDER=openai (or just OPENAI_API_KEY / BAAS_AI_BASE_URL), with BAAS_AI_MODEL.
  ai: process.env.BAAS_AI_PROVIDER === "openai" || (!process.env.BAAS_AI_PROVIDER && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && (process.env.OPENAI_API_KEY || process.env.BAAS_AI_BASE_URL))
    ? { openai: {
        model: process.env.BAAS_AI_MODEL || "gpt-4.1",
        baseUrl: process.env.BAAS_AI_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
        apiKey: process.env.OPENAI_API_KEY || undefined,
        reasoningEffort: process.env.BAAS_AI_EFFORT === "low" || process.env.BAAS_AI_EFFORT === "medium" || process.env.BAAS_AI_EFFORT === "high" ? process.env.BAAS_AI_EFFORT : undefined,
        maxTokensField: process.env.BAAS_AI_MAX_TOKENS_FIELD === "max_completion_tokens" ? "max_completion_tokens" : undefined,
      } }
    : process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? { model: process.env.BAAS_AI_MODEL || "claude-opus-5-5", effort: (process.env.BAAS_AI_EFFORT as "low" | "medium" | "high" | "xhigh" | "max" | undefined) || "medium", serverFallbacks: process.env.BAAS_AI_FALLBACKS !== "off" }
    : undefined,
  // Email for confirmation, password reset and magic links is offered only when the operator provides an SMTP server.
  mail: process.env.SMTP_URL ? { smtpUrl: process.env.SMTP_URL, from: process.env.MAIL_FROM } : undefined,
  sms: process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM ? { twilio: { accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN, from: process.env.TWILIO_FROM } } : undefined,
  dashboardHost: process.env.BAAS_DASHBOARD_HOST || undefined,
  dashboardUrl: process.env.BAAS_DASHBOARD_URL || undefined,
  // Where the dashboard is opened from; these origins are always allowed by a project's CORS list. Add more with BAAS_DASHBOARD_ORIGINS (comma separated).
  dashboardOrigins: [`http://localhost:${process.env.PORT ?? 8080}`, `http://127.0.0.1:${process.env.PORT ?? 8080}`, ...(process.env.BAAS_DASHBOARD_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean)],
  // Edge functions may not reach private or local addresses unless the operator opens it up or lists exceptions (host:port, comma separated).
  functions: { egress: process.env.BAAS_FUNCTION_EGRESS === "open" ? "open" : "public", egressAllow: (process.env.BAAS_FUNCTION_EGRESS_ALLOW ?? "").split(",").map((x) => x.trim()).filter(Boolean) },
  purgeRetentionMs: Number(process.env.BAAS_PURGE_RETENTION_DAYS ?? 7) * 86_400_000,
});
if (platform.migrations.length) console.log(`applied migrations: ${platform.migrations.join(", ")}`);

platform.start().catch((e) => { console.error("could not start background work:", e); process.exit(1); });
// Listen before the first housekeeping run: a base backup waits for the database to archive its WAL, and with the archive in the
// shared store the database uploads that WAL to this very server.
const ports = await platform.listen({ api: Number(process.env.PORT ?? 8080), gateway: gatewayPort });
void platform.housekeep().then((r) => console.log("housekeeping:", JSON.stringify(r))).catch((e) => console.error("housekeeping failed:", e));
console.log(platform.ai.available ? `AI assistant on (${platform.ai.model})` : "AI assistant off (set ANTHROPIC_API_KEY, or OPENAI_API_KEY / BAAS_AI_BASE_URL for an OpenAI-style provider)");
console.log(`management API + dashboard on :${ports.api}, data plane on :${ports.gateway} (<ref>.${process.env.BAAS_GATEWAY_DOMAIN ?? "localhost"})`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => void platform.stop().finally(() => process.exit(0)));
