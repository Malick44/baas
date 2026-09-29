import pg from "pg";
import { buildApi } from "./api.js";
import { ControlPlane } from "./control.js";
import { migrate } from "./migrate.js";
import { Vault } from "./vault.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const pool = new pg.Pool({ connectionString: need("BAAS_CONTROL_URL") });
const applied = await migrate(pool);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const control = new ControlPlane(pool, need("BAAS_PG_ADMIN_URL"), new Vault(need("BAAS_MASTER_KEY")));
const app = buildApi(control, need("BAAS_BOOTSTRAP_TOKEN"));

const RETENTION_MS = Number(process.env.BAAS_PURGE_RETENTION_DAYS ?? 7) * 86_400_000;
const sweep = async () => {
  const gone = [...(await control.reconcile()), ...(await control.purgeDeleted(RETENTION_MS))];
  if (gone.length) console.log(`housekeeping touched: ${gone.join(", ")}`);
};
await sweep();
setInterval(() => sweep().catch((e) => console.error("housekeeping failed", e)), 10 * 60_000).unref();

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
