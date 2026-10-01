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
| **Auth** | GoTrue-compatible: sign-up, password login, refresh-token rotation with reuse detection, user admin, bans; email confirmation, password reset and magic links (with an SMTP server); sign in with Google, GitHub, GitLab, Discord or Microsoft | `src/authsvc.ts`, `src/oauth.ts`, `src/mailer.ts` |
| **Realtime** | Row changes over WebSocket, delivered only if the subscriber's own role can read the row | `src/realtime.ts` |
| **Storage** | Buckets and objects governed by RLS policies, signed URLs, public buckets, size/type/quota limits | `src/storage.ts` |
| **Functions** | Your JavaScript in an isolated Node process with a timeout, memory cap and no filesystem/subprocess access | `src/functions.ts`, `src/sandbox.ts` |
| **Ask AI** | Ask questions about your data in plain language; the assistant runs read-only SQL to answer and *proposes* changes for you to review and run | `src/ai/`, dashboard tab, `baas ask` |
| **Dashboard** | Supabase-style workspace: project overview with live per-service request charts (`GET /v1/projects/:ref/metrics`), table and SQL editors, a Schema Visualizer with foreign-key lines, a Database section (tables, database functions, triggers, enums, extensions, indexes, policies, roles, backups, migrations), Ask AI, Advisors (security and performance checks), Reports, Pipelines (signed webhook delivery of row changes), Integrations (Postgres extensions and connected services), users, storage, edge functions, realtime inspector, logs, settings, project/organisation switchers and a Ctrl/⌘+K page switcher | `dashboard/` |
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

## Ask AI: questions in plain language

Set `ANTHROPIC_API_KEY` on the server and an admin can turn the assistant on per project (dashboard → **Ask AI**, or `baas ai enable`). Then:

- "Which customers spent the most this month?" → the assistant writes SQL, runs it read-only, and answers from the results. The queries it ran are shown so you can check them.
- "Cancel all pending orders" → it checks what would be affected, then **proposes** the SQL. Nothing runs until you click *Run* (destructive statements also ask you to type `run`).

**Whose eyes it looks through.** Row-level security applies by default. Every question is asked *as* someone, and the answer says who:

- **An anonymous visitor** (the default): only what your `anon` grants and policies expose through the API.
- **A specific user** (search by email in the dashboard, `--as-user` in the CLI): exactly what that user's API calls would return, using their real claims, so `auth.uid()` and `auth.jwt()` in your policies work. This is the quick way to debug "why can't Ann see her orders?".
- **Everyone**, ignoring row-level security: off unless a project **owner** allows it (*Assistant settings* in the dashboard, or `baas ai config --allow-bypass-rls true`). Admins can turn it back off. When it is on, hidden rows can be read and sent to Anthropic, so the setting asks for confirmation and is audited.

The chosen identity cannot be changed by the SQL the model writes. Row-level security learns who is asking from a database setting, and any role can normally change a setting with `set_config()`, which would let generated SQL say "I am someone else". So while the assistant is on, `anon` and `authenticated` lose `EXECUTE` on `set_config` (the platform sets the claims first, as the project's login role, then drops to the caller's role). Before every question the assistant re-checks that this still holds, and repairs it if not (for example after a backup restore); if it cannot be confirmed it refuses. Switching the assistant off gives `set_config` back to everyone.

How it stays safe — none of this depends on the model behaving:

- **Reads are enforced by the database.** Queries run in a `READ ONLY` transaction, over the extended protocol (so `COMMIT; DROP …` cannot be smuggled in), as the chosen role: it can read only what that role may read, and never `auth` (password hashes, refresh tokens), storage or realtime internals. In "everyone" mode it uses a dedicated `SELECT`-only role over the `public` schema, which the project's login role can reach only while "everyone" mode is allowed. A server-side watchdog cancels slow queries.
- **The model cannot change anything.** It can only *propose*. Each proposal is planned with `EXPLAIN` where possible, and a risk label ("deletes EVERY row (no WHERE)", "turns row-level security OFF"…) is computed from the SQL itself and shown beside the model's own description, so a description that plays a change down does not hide it. Running a proposal uses the normal, audited SQL endpoint, as `service_role`, like anything typed in the SQL editor.
- **Instructions hidden in your data cannot make it act.** Rows are passed to the model as data and marked untrusted; and even a model that obeyed them could only propose.
- **Opt-in, with a notice.** Off by default per project. When on, your question, the structure of the tables the identity can read, and the rows its queries return (at most 50 rows, long values shortened) are sent to Anthropic. Use it only where that is acceptable for your data.
- **Bounded:** 8 steps and 90 s per question, 2 concurrent per project, a daily question limit by plan (20 free / 500 pro), token use recorded per day. The audit log records who asked what and as whom, never the results.

Configuration: `BAAS_AI_MODEL` (default `claude-opus-5-5`; a smaller model such as `claude-sonnet-5-5` is cheaper), `BAAS_AI_EFFORT` (`low`…`max`, default `medium`), and `BAAS_AI_FALLBACKS=off` if you run on a platform without the server-side refusal-fallback beta (it is on by default). In "everyone" mode, tables created outside the SQL editor by another owner need `GRANT SELECT … TO baas_ai_reader` before the assistant can see them.

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
| `ANTHROPIC_API_KEY` | Optional. Turns the Ask AI assistant on for the server (projects still opt in) |
| `BAAS_AI_MODEL` / `BAAS_AI_EFFORT` / `BAAS_AI_FALLBACKS` | Model (default `claude-opus-5-5`), reasoning effort (default `medium`), and `off` to disable server-side refusal fallbacks |
| `BAAS_PURGE_RETENTION_DAYS` | Days a deleted project's data is kept before purge (default 7) |

Plans (`src/plans.ts`) set request, size and rate limits. Changing a project's plan needs the owner role; there is no billing.

## Production

- Put a reverse proxy in front with a **wildcard DNS record and certificate** for `*.your-domain` (Caddy, Traefik, nginx), forwarding to the gateway port. Set `BAAS_GATEWAY_DOMAIN`, `BAAS_PUBLIC_SCHEME=https`, `BAAS_PUBLIC_PORT=443`. The proxy must send exactly one `Host` header.
- Serve the management API/dashboard on a separate hostname over TLS and firewall it if you can. Never expose Postgres.
- Back up the **master key**, the Postgres volume, and the storage volume separately: backups made by the platform contain the database only.
- Run functions on a host that cannot reach your internal network (see limitations).

## Known limitations — read before relying on it

- **Functions can reach the network.** Node 22 cannot restrict outbound connections, so function code can call anything the host can (including internal services). Filesystem, subprocess and worker access are blocked and tested, but this is defence in depth, not a hardened multi-tenant sandbox. Only run code from people you trust, or run the platform where egress is firewalled, or replace `src/sandbox.ts` with a Deno/gVisor/Firecracker runner.
- **The assistant is only as good as the model, and has only been tested against a scripted one.** The safety properties above are enforced by the database and server and are tested adversarially, but the live call to Anthropic (request shape is tested against the SDK's types and a stubbed client) had no API key available to run against. Try it on a non-critical project first. Its answers can be wrong: check the queries it shows before relying on a number. In "everyone" mode (owner-enabled) it sees all rows, like the SQL editor.
- **Enabling the assistant revokes `set_config` from `anon` and `authenticated`** in that project's database (see above). A function of yours that calls `set_config` while running as one of those roles will fail with "permission denied". `current_setting`, `SET LOCAL` inside your own `SECURITY DEFINER` functions, and everything `service_role` does are unaffected. Turning the assistant off restores it.
- **Email needs an SMTP server.** Without `SMTP_URL`, sign-ups are confirmed automatically and password reset and magic links answer 501. There are no numeric one-time codes (links only), no phone sign-in, and no custom OIDC provider.
- **REST subset.** No embedded resources (joins in `select`), JSON-path operators, casts, or full-text operators. Unfiltered `PATCH`/`DELETE` are rejected.
- **No point-in-time recovery.** Backups are logical dumps; enable WAL archiving on the cluster if you need PITR. Stored files are not part of backups.
- **Bulk inserts** fill keys missing from some rows with `NULL` rather than defaults (PostgREST does the same without `missing=default`).
- **Realtime** DELETE events carry only the primary key and go to `service_role`, or to other roles only on tables without RLS; filtered subscriptions receive no deletes. One extra query per subscriber per event.
- **Single node.** One Postgres cluster, one process; request logs and rate-limit state are in memory. No sharding across clusters.
- **Settings `site_url`, `redirect_urls`, `cors_origins`** are accepted but not enforced yet (the data plane answers CORS `*`).
- Project and role **names are visible** to SQL run inside a project (`pg_database`, `pg_roles`); secrets are not.
- API tokens stand in for user accounts; there is no per-user login to the dashboard.

## Development and tests

CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests and browser tests against a Postgres service, and a second job runs `scripts/smoke.sh`: it builds the images, starts the real Compose stack, creates an organisation and a project, and exercises REST with row-level security, auth, storage, a function, metrics, a backup and a restart. Run it yourself with `scripts/smoke.sh` (needs docker, curl and jq).

```bash
npm ci
export BAAS_TEST_PG_URL=postgres://postgres:…@localhost:5432/postgres   # a superuser on a throwaway Postgres
npm test            # about 250 tests: isolation, control plane, REST/Auth, Storage, Functions, Realtime, ops, SDK, CLI, hardening, AI assistant
npm run e2e         # drives the dashboard in headless Chromium (needs a Chromium; set CHROMIUM_PATH)
npx tsx scripts/load.ts 8 32     # throughput and latency per workload
```

Tests create and drop their own databases. Without `BAAS_TEST_PG_URL` the database-backed suites are skipped.

Rough numbers from `scripts/load.ts` on one small machine with Postgres and the platform side by side (32 connections): REST reads 7–9k req/s (p95 5–10 ms), inserts with an RLS check ~7k req/s, public file download ~7k req/s, password login ~130/s (scrypt-bound), function calls ~30/s (a fresh process each). Treat these as an order of magnitude, not a benchmark.

See [PLAN.md](PLAN.md) for the architecture notes and how the build differs from the original plan.

## Authentication: email and providers

Set these on the server to turn on email (confirmation, password reset, magic links); without them those flows are off:

```
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM="My App <no-reply@example.com>"
```

Then, per project (dashboard → Authentication, or `PATCH /v1/projects/:ref/settings`; `GET /v1/projects/:ref/auth-config` shows everything in one call):

- **Require email confirmation** (`email_confirm`): sign-up returns the user without a session, a link is emailed, and sign-in is refused until it is used. Links work once, expire (24 hours for confirmation, 1 hour otherwise), and only the newest of each kind works. Emails are limited to one per address per minute and 100 per project per hour. Changing your address also needs confirming.
- **URL configuration** (`site_url`, `redirect_urls`): where emailed links and provider sign-ins may send the browser. The site URL's origin is always allowed; add others (a trailing `*` is a prefix match, and app deep links like `myapp://callback` work). Anything else is refused. The redirect is chosen when the link is made (`?redirect_to=` on `/signup`, `/recover`, `/magiclink`, `/resend`), never taken from the link itself, and the session arrives in the URL fragment (`#access_token=…&type=signup|recovery|magiclink|oauth`).
- **Templates** (`email_templates`, `mailer_from_name`): subject and plain-text body per email, with `{{ .ConfirmationURL }}`, `{{ .Email }}` and `{{ .SiteURL }}`.
- **Providers** (`auth_providers`): client ID and secret per provider, with the callback URL `http://<ref>.<domain>/auth/v1/callback` for the provider's console. Secrets are stored encrypted and never returned. The flow is the authorization-code flow with a signed state tied to the browser by a cookie, plus PKCE where the provider supports it. A sign-in links to an existing account only when the provider says the address is verified; if that account was never confirmed, the password it was registered with is removed.
- **Other:** `password_min_length` (6 to 64), `jwt_expiry`, `disable_signup`. A signed-in user cannot set their own `app_metadata`, confirm their own address or ban themselves.

In the client: `auth.signUp` (a session, or only the user when confirmation is required), `resetPasswordForEmail`, `signInWithOtp`, `verifyOtp`, `resend`, `signInWithOAuth` and `getSessionFromUrl` (reads the fragment on the page you redirected to).

## Pipelines and extensions

**Pipelines** send a project's row changes to a webhook (dashboard → Database → Pipelines, or `POST /v1/projects/:ref/pipelines`). Admins only.

- Choose tables and events (insert, update, delete) and a URL. A pipeline starts from *now*; it does not replay existing rows.
- Optionally send only rows that match conditions (`status` equals `paid`, `total` at least 100, `region` is one of eu, us, `note` is empty). A change is checked against the row as it is at delivery time; a row that is gone or no longer matches is skipped. Deletes carry no row, so they are always sent (switch them off under events). Conditions are structured, not SQL.
- Delivery is at least once and in order, one batch at a time. Failures are retried with a growing delay (up to 15 minutes) and a pipeline pauses itself after 30 in a row. Undelivered changes are kept for at most 24 hours.
- Each request carries `X-Baas-Signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of `"<t>.<body>"` with the signing secret shown once at creation (rotate it any time).
- Rows are read with the platform's own access at delivery time: row-level security does not apply, and the row is the current one, not a snapshot. Turn off "include the row" to send only primary keys.
- Destinations on private, loopback or link-local addresses are refused, and the connection is pinned to the address that was checked. Operators can allow them for development with `pipelines.allowPrivateTargets`.

From the command line: `baas pipelines list | show | create <name> --tables a,b --url <url> [--events insert,update,delete] [--no-rows] [--where orders.status:eq:paid]... | edit | pause | resume | run | test | deliveries [--follow] | rotate-secret | delete`. `--where table.column:op:value` can be repeated (ops: eq neq gt gte lt lte in null notnull; `in` takes `a|b|c`); `deliveries --follow` prints new deliveries as they happen until Ctrl-C. `<pipeline>` is a name or an id (or its first 8 characters). The signing secret is printed once, by `create` and `rotate-secret`.

From the command line: `baas extensions list [--installed|--available] [--search <text>]` and `baas extensions install|remove <name...>`.

**Integrations → Postgres extensions** installs and removes extensions into the `extensions` schema. Only extensions Postgres marks as trusted (or that need no superuser) are offered; the rest need the server operator.
