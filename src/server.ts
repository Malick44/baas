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
  purgeRetentionMs: Number(process.env.BAAS_PURGE_RETENTION_DAYS ?? 7) * 86_400_000,
});
if (platform.migrations.length) console.log(`applied migrations: ${platform.migrations.join(", ")}`);

console.log("housekeeping:", JSON.stringify(await platform.housekeep()));
platform.start();
const ports = await platform.listen({ api: Number(process.env.PORT ?? 8080), gateway: gatewayPort });
console.log(`management API + dashboard on :${ports.api}, data plane on :${ports.gateway} (<ref>.${process.env.BAAS_GATEWAY_DOMAIN ?? "localhost"})`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => void platform.stop().finally(() => process.exit(0)));
