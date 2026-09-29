# baas

A self-hosted, multi-project backend in the shape of Supabase: **Postgres, Auth, an auto-generated REST API, Realtime, Storage, Edge Functions and a dashboard**, with many isolated projects on one installation. TypeScript, no framework beyond Fastify, runs from one `docker compose up`.

Each project gets its **own Postgres database**, its own login role, its own JWT secret and keys, and its own subdomain: `https://<ref>.your-domain`. One control plane creates, pauses, backs up and deletes them.

## Quick start

```bash
cp .env.example .env            # then fill in the three secrets (commands are in the file)
docker compose up -d --build
open http://localhost:8080      # dashboard
```

Create the first organisation with the bootstrap secret, then sign in to the dashboard with the token it returns:

```bash
curl -XPOST localhost:8080/v1/organizations -H "x-bootstrap-token: $BAAS_BOOTSTRAP_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Acme","slug":"acme"}'      # → {"owner_token":"baas_…"}
```

Projects are served at `http://<ref>.localhost:8081` (browsers resolve `*.localhost` themselves; for a real domain see [Production](#production)).

Without Docker: `npm ci && npm run build`, set the variables in `.env.example`, and `npm start`.

## What you get

| Area | What it does | Where |
|---|---|---|
| **Control plane** | Organisations, role-scoped API tokens (developer < admin < owner), project lifecycle (create, pause, resume, soft delete, purge), settings, audit log | `src/control.ts`, `src/api.ts` |
| **Gateway** | Routes `<ref>.domain` to the project; verifies its keys; per-project rate limits and quotas | `src/gateway.ts`, `src/usage.ts` |
| **REST** | PostgREST-compatible subset: filters, `or`, order, pagination, counts, upsert, single-object, RPC | `src/rest.ts` |
| **Auth** | GoTrue-compatible: sign-up, password login, refresh-token rotation with reuse detection, user admin, bans | `src/authsvc.ts` |
| **Realtime** | Row changes over WebSocket, delivered only if the subscriber's own role can read the row | `src/realtime.ts` |
| **Storage** | Buckets and objects governed by RLS policies, signed URLs, public buckets, size/type/quota limits | `src/storage.ts` |
| **Functions** | Your JavaScript in an isolated Node process with a timeout, memory cap and no filesystem/subprocess access | `src/functions.ts`, `src/sandbox.ts` |
| **Dashboard** | Projects, table editor, SQL editor, users, storage, functions, realtime inspector, logs, backups, settings | `dashboard/` |
| **Ops** | Usage metering, plan quotas, idle auto-pause, `pg_dump` backups with integrity-checked restore, housekeeping | `src/usage.ts`, `src/backup.ts`, `src/platform.ts` |
| **CLI** | `baas` — projects, SQL, checksummed atomic migrations, functions, backups | `src/cli.ts` |
| **SDK** | `createClient(url, key)` shaped like supabase-js | `src/client.ts` |

## How isolation works

- **Database per project** on a shared Postgres. A project's login role (`authenticator_<ref>`) can `CONNECT` only to its own database; `anon`, `authenticated` and `service_role` are shared *names*, but privileges are granted per database.
- **Keys per project.** Each project has its own HS256 secret, so its keys are meaningless anywhere else. Secrets are stored AES-256-GCM encrypted and bound to the project ref.
- **RLS applies to everything.** Every data-plane request runs in a transaction that switches to the caller's role and publishes their JWT claims. Realtime and Storage re-check access under the subscriber's role.
- **Secure by default.** A new table is invisible to the API until you `GRANT` access to `anon`/`authenticated` and enable RLS. The dashboard's "New table" does both.
- **Limits per project:** connection cap, a server-side query watchdog users cannot lift with `SET statement_timeout`, token-bucket rate limits, daily request and size quotas by plan, bounded password hashing and function concurrency.

`src/hardening.test.ts` attacks this from outside: every service with another tenant's credentials, every management route with a foreign organisation's token, protocol tricks (duplicate `Host`, absolute-form requests), oversized input, seeded fuzzing, and noisy-neighbour scenarios.

## Using a project

```ts
import { createClient } from "baas/client";
const baas = createClient("http://<ref>.localhost:8081", "<anon key>");

await baas.auth.signUp({ email, password });
const { data } = await baas.from("todos").select("*").eq("done", false).order("id");
baas.channel("feed").on("postgres_changes", { event: "*", table: "todos" }, console.log).subscribe();
await baas.storage.from("files").upload("a/b.txt", "hello");
await baas.functions.invoke("hello", { body: { name: "you" } });
```

Or with `curl` and the same URLs Supabase uses: `/rest/v1/…`, `/auth/v1/…`, `/storage/v1/…`, `/functions/v1/…`, `/realtime/v1/websocket`.

A function is a module with a default export taking a `Request` and returning a `Response`:

```js
export default async (req) => Response.json({ hello: (await req.json()).name });
```

## CLI

```bash
npx baas login --url http://localhost:8080 --token baas_…
npx baas projects create my-app && npx baas link <ref>
npx baas sql "select now()"
npx baas db push          # applies baas/migrations/*.sql in order, once each, each in one transaction
npx baas functions deploy hello functions/hello.mjs
npx baas backups create --note "before release"
```

Editing a migration after it was applied is refused, and a failing migration rolls back and is not recorded.

## Configuration

| Variable | Meaning |
|---|---|
| `BAAS_CONTROL_URL` | Postgres URL of the control-plane database |
| `BAAS_PG_ADMIN_URL` | **Superuser** URL of the cluster that holds project databases |
| `BAAS_MASTER_KEY` | 64 hex chars; encrypts project secrets. **Losing it loses every project's secrets** |
| `BAAS_BOOTSTRAP_TOKEN` | Secret that authorises creating organisations (≥ 24 chars) |
| `BAAS_GATEWAY_DOMAIN` / `BAAS_PUBLIC_SCHEME` / `BAAS_PUBLIC_PORT` | How projects are addressed: `<scheme>://<ref>.<domain>[:port]` |
| `PORT` / `GATEWAY_PORT` | Management API + dashboard (8080), data plane (8081) |
| `BAAS_STORAGE_DIR`, `BAAS_BACKUP_DIR` | Where object files and backups live |
| `BAAS_PG_BIN_DIR` | Directory with `pg_dump`/`pg_restore` (must match the server's major version) |
| `BAAS_PURGE_RETENTION_DAYS` | Days a deleted project's data is kept before purge (default 7) |

Plans (`src/plans.ts`) set request, size and rate limits. Changing a project's plan needs the owner role; there is no billing.

## Production

- Put a reverse proxy in front with a **wildcard DNS record and certificate** for `*.your-domain` (Caddy, Traefik, nginx), forwarding to the gateway port. Set `BAAS_GATEWAY_DOMAIN`, `BAAS_PUBLIC_SCHEME=https`, `BAAS_PUBLIC_PORT=443`. The proxy must send exactly one `Host` header.
- Serve the management API/dashboard on a separate hostname over TLS and firewall it if you can. Never expose Postgres.
- Back up the **master key**, the Postgres volume, and the storage volume separately: backups made by the platform contain the database only.
- Run functions on a host that cannot reach your internal network (see limitations).

## Known limitations — read before relying on it

- **Functions can reach the network.** Node 22 cannot restrict outbound connections, so function code can call anything the host can (including internal services). Filesystem, subprocess and worker access are blocked and tested, but this is defence in depth, not a hardened multi-tenant sandbox. Only run code from people you trust, or run the platform where egress is firewalled, or replace `src/sandbox.ts` with a Deno/gVisor/Firecracker runner.
- **No email or OAuth.** Password auth only; sign-ups are auto-confirmed, and password recovery, magic links and OTP return 501.
- **REST subset.** No embedded resources (joins in `select`), JSON-path operators, casts, or full-text operators. Unfiltered `PATCH`/`DELETE` are rejected.
- **No point-in-time recovery.** Backups are logical dumps; enable WAL archiving on the cluster if you need PITR. Stored files are not part of backups.
- **Bulk inserts** fill keys missing from some rows with `NULL` rather than defaults (PostgREST does the same without `missing=default`).
- **Realtime** DELETE events carry only the primary key and go to `service_role`, or to other roles only on tables without RLS; filtered subscriptions receive no deletes. One extra query per subscriber per event.
- **Single node.** One Postgres cluster, one process; request logs and rate-limit state are in memory. No sharding across clusters.
- **Settings `site_url`, `redirect_urls`, `cors_origins`** are accepted but not enforced yet (the data plane answers CORS `*`).
- Project and role **names are visible** to SQL run inside a project (`pg_database`, `pg_roles`); secrets are not.
- API tokens stand in for user accounts; there is no per-user login to the dashboard.

## Development and tests

```bash
npm ci
export BAAS_TEST_PG_URL=postgres://postgres:…@localhost:5432/postgres   # a superuser on a throwaway Postgres
npm test            # 150+ tests: isolation, control plane, REST/Auth, Storage, Functions, Realtime, ops, SDK, CLI, hardening
npm run e2e         # drives the dashboard in headless Chromium (needs a Chromium; set CHROMIUM_PATH)
npx tsx scripts/load.ts 8 32     # throughput and latency per workload
```

Tests create and drop their own databases. Without `BAAS_TEST_PG_URL` the database-backed suites are skipped.

Rough numbers from `scripts/load.ts` on one small machine with Postgres and the platform side by side (32 connections): REST reads 7–9k req/s (p95 5–10 ms), inserts with an RLS check ~7k req/s, public file download ~7k req/s, password login ~130/s (scrypt-bound), function calls ~30/s (a fresh process each). Treat these as an order of magnitude, not a benchmark.

See [PLAN.md](PLAN.md) for the architecture notes and how the build differs from the original plan.
