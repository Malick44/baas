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
  backupDir: resolve(process.env.BAAS_BACKUP_DIR ?? "./data/backups"),
  pgBinDir: process.env.BAAS_PG_BIN_DIR,
  gatewayDomain: process.env.BAAS_GATEWAY_DOMAIN ?? "localhost",
  publicScheme: process.env.BAAS_PUBLIC_SCHEME ?? "http",
  publicPort: process.env.BAAS_PUBLIC_PORT ? Number(process.env.BAAS_PUBLIC_PORT) : gatewayPort,
  // The assistant is offered only when the operator has given the server Anthropic credentials.
  ai: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? { model: process.env.BAAS_AI_MODEL ?? "claude-opus-5-5", effort: (process.env.BAAS_AI_EFFORT as "low" | "medium" | "high" | "xhigh" | "max" | undefined) ?? "medium", serverFallbacks: process.env.BAAS_AI_FALLBACKS !== "off" }
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

console.log("housekeeping:", JSON.stringify(await platform.housekeep()));
platform.start();
const ports = await platform.listen({ api: Number(process.env.PORT ?? 8080), gateway: gatewayPort });
console.log(platform.ai.available ? `AI assistant on (${process.env.BAAS_AI_MODEL ?? "claude-opus-5-5"})` : "AI assistant off (set ANTHROPIC_API_KEY to enable)");
console.log(`management API + dashboard on :${ports.api}, data plane on :${ports.gateway} (<ref>.${process.env.BAAS_GATEWAY_DOMAIN ?? "localhost"})`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => void platform.stop().finally(() => process.exit(0)));
