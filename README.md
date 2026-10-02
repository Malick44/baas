# baas

A self-hosted, multi-project backend in the shape of Supabase: **Postgres, Auth, an auto-generated REST API, Realtime, Storage, Edge Functions and a dashboard**, with many isolated projects on one installation. TypeScript, no framework beyond Fastify, runs from one `docker compose up`.

Each project gets its **own Postgres database**, its own login role, its own JWT secret and keys, and its own subdomain: `https://<ref>.your-domain`. One control plane creates, pauses, backs up and deletes them.

## Quick start

```bash
cp .env.example .env            # then fill in the three secrets (commands are in the file)
docker compose up -d --build
open http://localhost:8080      # dashboard
```

Create the first organisation with the bootstrap secret. Include an owner email and password to get a dashboard account, or omit them and use the API token it returns:

```bash
curl -XPOST localhost:8080/v1/organizations -H "x-bootstrap-token: $BAAS_BOOTSTRAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Acme","slug":"acme","owner_email":"you@example.com","owner_password":"a-long-passphrase"}'   # → {"owner_token":"baas_…","owner":{…}}
```

**People and tokens.** Each person signs in to the dashboard with their own email and password, under **Team** (invite by link; roles developer < admin < owner; sessions last 7 days; changing a role or removing someone takes effect immediately; there is always at least one owner member). API tokens remain for scripts and CI, and the CLI accepts either: `baas login --url … --email you@example.com` (password from `--password` or `BAAS_PASSWORD`). An account belongs to one organisation, and an owner can set a new password for someone who lost theirs; if the server can send email (`SMTP_URL`) and knows its dashboard address (`BAAS_DASHBOARD_URL`, or derived from `DASHBOARD_HOST`/`BAAS_DASHBOARD_ORIGINS`), **Forgot password?** emails a link that works once for an hour and signs the account out everywhere; otherwise an owner sets a new password. Members can turn on **Two-step verification** (an authenticator app: 6-digit codes, each usable once, plus eight single-use recovery codes shown once). Signing in then asks for a code, five tries per attempt, and misses count against the address; a reset by email does not switch it off. Turning it off needs the password and a code; an owner can remove it for someone who lost their device and codes (`baas login --email … --code …` for the CLI).

Projects are served at `http://<ref>.localhost:8081` (browsers resolve `*.localhost` themselves; for a real domain see [Production](#production)).

Without Docker: `npm ci && npm run build`, set the variables in `.env.example`, and `npm start`.

## What you get

| Area | What it does | Where |
|---|---|---|
| **Control plane** | Organisations, role-scoped API tokens (developer < admin < owner), project lifecycle (create, pause, resume, soft delete, purge), settings, audit log | `src/control.ts`, `src/api.ts` |
| **Gateway** | Routes `<ref>.domain` to the project; verifies its keys; per-project rate limits and quotas | `src/gateway.ts`, `src/usage.ts` |
| **REST** | PostgREST-compatible subset: filters, `or`, order, pagination, counts, upsert, single-object, RPC, embedded resources (`select=*,orders(*)`) | `src/rest.ts` |
| **Auth** | GoTrue-compatible: sign-up, password login, refresh-token rotation with reuse detection, user admin, bans; email confirmation, password reset and magic links (with an SMTP server); sign in with Google, GitHub, GitLab, Discord or Microsoft | `src/authsvc.ts`, `src/oauth.ts`, `src/mailer.ts` |
| **Realtime** | Row changes over WebSocket, delivered only if the subscriber's own role can read the row | `src/realtime.ts` |
| **Storage** | Buckets and objects governed by RLS policies, signed URLs, public buckets, size/type/quota limits | `src/storage.ts` |
| **Functions** | Your JavaScript in an isolated Node process with a timeout, memory cap and no filesystem/subprocess access | `src/functions.ts`, `src/sandbox.ts` |
| **Ask AI** | Ask questions about your data in plain language; the assistant runs read-only SQL to answer and *proposes* changes for you to review and run | `src/ai/`, dashboard tab, `baas ask` |
| **Dashboard** | Supabase-style workspace: project overview with live per-service request charts (`GET /v1/projects/:ref/metrics`), table and SQL editors, a Schema Visualizer with foreign-key lines, a Database section (tables, database functions, triggers, enums, extensions, indexes, policies, roles, backups, migrations), Ask AI, Advisors (security and performance checks), Reports, Pipelines (signed webhook delivery of row changes), Integrations (Postgres extensions and connected services), users, storage, edge functions, realtime inspector, logs, settings, project/organisation switchers and a Ctrl/⌘+K page switcher | `dashboard/` |
| **Ops** | Usage metering, plan quotas, idle auto-pause, `pg_dump` backups with integrity-checked restore, point-in-time recovery from archived WAL, housekeeping | `src/usage.ts`, `src/backup.ts`, `src/pitr.ts`, `src/platform.ts` |
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
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ `S3_ENDPOINT`, `S3_REGION`, `S3_PATH_STYLE`, `S3_PREFIX`, `S3_CREATE_BUCKET`) | Keep object files in an S3-compatible store (AWS S3, R2, B2, MinIO, Ceph, SeaweedFS) instead of `BAAS_STORAGE_DIR`; nodes then need no shared filesystem |
| `BAAS_PG_BIN_DIR` | Directory with `pg_dump`/`pg_restore` (must match the server's major version) |
| `ANTHROPIC_API_KEY` | Optional. Turns the Ask AI assistant on for the server (projects still opt in) |
| `BAAS_AI_MODEL` / `BAAS_AI_EFFORT` / `BAAS_AI_FALLBACKS` | Model (default `claude-opus-5-5`), reasoning effort (default `medium`), and `off` to disable server-side refusal fallbacks |
| `BAAS_PURGE_RETENTION_DAYS` | Days a deleted project's data is kept before purge (default 7) |

Plans (`src/plans.ts`) set request, size and rate limits. Changing a project's plan needs the owner role; there is no billing.

## Production

- **HTTPS with one extra file.** Point two DNS records at the machine (`baas.example.com` and a wildcard `*.example.com`), put `DOMAIN`, `DASHBOARD_HOST` and `ACME_EMAIL` in `.env`, and run `docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d`. A Caddy container then gets certificates automatically. It asks the platform (`/v1/tls-check`) before requesting each one, so certificates are only issued for the dashboard host and for projects that exist, with no wildcard certificate or DNS API token needed. The app's own ports are closed; only 80 and 443 are open. CI checks that the Caddyfile and the Compose overlay are valid, but not a real certificate issue, which needs real DNS. Using another proxy instead: forward `*.your-domain` to the gateway port, set `BAAS_GATEWAY_DOMAIN`, `BAAS_PUBLIC_SCHEME=https`, `BAAS_PUBLIC_PORT=443`, and make sure it sends exactly one `Host` header.
- **Releases.** Pushing a tag like `v1.0.0` builds the image and publishes it to `ghcr.io/<owner>/baas` as `1.0.0`, `1.0` and `latest` (`.github/workflows/release.yml`). To use it, replace `build: .` in `docker-compose.yml` with `image: ghcr.io/<owner>/baas:1.0.0`.
- Serve the management API/dashboard on a separate hostname over TLS and firewall it if you can. Never expose Postgres.
- Back up the **master key**, the Postgres volume, and the storage volume separately: backups made by the platform contain the database only.
- Run functions on a host that cannot reach your internal network (see limitations).

## Known limitations — read before relying on it

- **Function network isolation is partial.** Node 22 cannot switch the network off, so functions run under the permission model (no filesystem, subprocesses or workers) plus an in-process guard (`src/egress-guard.mjs`): `fetch` refuses private, loopback and link-local addresses (including by name, IPv6 and mapped forms), connects to the address it checked, re-checks every redirect, and the modules that open sockets, spawn or signal are not importable, and `process.kill` is removed (a function shares a user with the server, so it could otherwise signal it). A project's own URL is always reachable; add exceptions with `BAAS_FUNCTION_EGRESS_ALLOW=host:port,...`, or lift the address rule with `BAAS_FUNCTION_EGRESS=open`. This is defence in depth, not isolation: it is tested against the bypasses I could think of, but only a runner in its own network namespace or VM (gVisor, Firecracker, Deno with network permissions) is a real boundary. Run untrusted tenants' code on a host that cannot reach your internal network.
- **The assistant is only as good as the model, and has only been tested against a scripted one.** The safety properties above are enforced by the database and server and are tested adversarially, but the live call to Anthropic (request shape is tested against the SDK's types and a stubbed client) had no API key available to run against. Try it on a non-critical project first. Its answers can be wrong: check the queries it shows before relying on a number. In "everyone" mode (owner-enabled) it sees all rows, like the SQL editor.
- **Enabling the assistant revokes `set_config` from `anon` and `authenticated`** in that project's database (see above). A function of yours that calls `set_config` while running as one of those roles will fail with "permission denied". `current_setting`, `SET LOCAL` inside your own `SECURITY DEFINER` functions, and everything `service_role` does are unaffected. Turning the assistant off restores it.
- **Email needs an SMTP server.** Without `SMTP_URL`, sign-ups are confirmed automatically and password reset and magic links answer 501. 
- **REST subset.** No JSON-path operators, casts, spread (`...table`), or full-text operators. Embedded resources follow foreign keys (`orders(id,items(*))`, aliases `a:orders(*)`, hints `orders!fk_name(*)`, `!inner`, per-embed filters/order/limit like `orders.status=eq.paid`), at most 3 deep and 10 per request, up to 1000 rows per embed; an ambiguous relationship returns `PGRST201` until hinted. Row-level security applies to embedded tables as the caller. Unfiltered `PATCH`/`DELETE` are rejected.
- **Point-in-time recovery needs WAL archiving** (below); without it, backups are logical dumps taken daily on the pro plan. Stored files are never part of either.
- **Bulk inserts** fill keys missing from some rows with `NULL` rather than defaults (PostgREST does the same without `missing=default`).
- **Realtime** DELETE events carry only the primary key and go to `service_role`, or to other roles only on tables without RLS; filtered subscriptions receive no deletes. One extra query per subscriber per event.
- **Scaling has edges.** Several baas processes and several Postgres clusters are supported (below), but object files need a filesystem shared by all nodes (a mounted volume, not S3), and the data plane's request rate limit is split between nodes (so it is exact only when a load balancer spreads requests evenly). Moving a project to another cluster takes it offline for the length of a backup and restore. Point-in-time recovery covers the main cluster only.
- Project and role **names are visible** to SQL run inside a project (`pg_database`, `pg_roles`); secrets are not.
- Dashboard accounts have no single sign-on, and one account belongs to one organisation.

## Development and tests

**S3 object storage.** Set the `S3_*` variables (or use `docker compose -f docker-compose.yml -f docker-compose.s3.yml up -d`, which bundles SeaweedFS) and object files go to the bucket, keyed `<project>/<id>`; nothing is written to the local volume. Requests are signed with SigV4 by `src/s3.ts` (no SDK), verified in CI against a real independent S3 server. Unreachable or misconfigured buckets stop start-up with a clear error. To move files kept on disk, run `baas admin storage migrate` (or `POST /v1/admin/storage/migrate` with the bootstrap token) with `BAAS_STORAGE_DIR` still mounted: it is idempotent and reports copied / already there / missing. When combining the overlay with `docker-compose.nodes.yml`, give `baas2` the same `S3_*` environment (see `scripts/smoke.sh`).

CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests and browser tests against a Postgres service, and a second job runs `scripts/smoke.sh`: it builds the images, starts the real Compose stack, creates an organisation and a project, and exercises REST with row-level security, auth, storage, a function, metrics, a backup that it then restores, the certificate check and a restart. Run it yourself with `scripts/smoke.sh` (needs docker, curl and jq).

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

## Scaling out

**More than one baas process.** Run several nodes against the same Postgres and put a load balancer in front:

```bash
docker compose -f docker-compose.yml -f docker-compose.nodes.yml up -d     # two nodes + a Caddy balancer on 8080/8081
npx baas admin nodes                                                       # who is running, and who leads
```

Nodes share everything that matters through the control database: sessions and keys, settings (a change reaches another node within about two seconds, the length of its short cache), failed-sign-in counts and email/text cooldowns (so guesses spread across nodes still add up), and request and function logs (written in batches, so another node's requests show within a couple of seconds). The jobs that must run once (housekeeping: scheduled backups, base backups, purging, idle pause, measuring; and webhook delivery) run on one node, the **leader**, chosen with a Postgres advisory lock; if it stops, another takes over within seconds. Usage counters are added up from every node. Realtime works from any node, since each listens to the database itself.

What to know: every node must mount the same **storage and backup volumes** (the Compose overlay does this); add a node by copying the `baas2` block and a line in `deploy/Caddyfile.lb`; the per-project **rate limit** (requests per second) is divided by the number of live nodes, so with even balancing the total is the plan's limit, and a lopsided balancer is throttled harder than it needs to be; the **daily quota** is read from the shared counters and can overshoot by a few seconds of traffic per node. The overlay is tested in CI on real containers: two nodes behind the balancer, the leader stopped, the survivor taking over while the project keeps serving.

**More than one Postgres cluster.** One cluster is the default (`BAAS_PG_ADMIN_URL`, called `main`). To spread projects over more servers, register them (the operator secret is needed, because this is infrastructure):

```bash
export BAAS_BOOTSTRAP_TOKEN=…
npx baas admin clusters add eu2 --url postgres://postgres:pw@db2.internal:5432/postgres --max-projects 200
npx baas admin clusters list
npx baas admin move <project-ref> eu2        # copy a project to another cluster
npx baas admin clusters update eu2 --drain   # take no new projects (existing ones stay)
npx baas admin clusters remove eu2           # only when nothing lives on it
```

New projects go to the active, reachable cluster that is least full (by share of its project limit, else by count); if provisioning fails on one, the next is tried. Everything per project follows it: its REST, auth, storage metadata, realtime, pipelines, backups and usage measurement use the cluster it lives on. A cluster's address is sealed with the platform key and never returned. **Moving** a project cuts its access, dumps it, builds it on the target with the same login password, checks the table and row counts match, switches, and drops the old copy; any failure before the switch gives the project back exactly as it was. Keys, users, sessions, files and settings are unaffected, so tokens issued before the move keep working. Limits: extensions the project uses must exist on the target, roles created by hand with SQL are not carried over (the platform's own are), and a node that dies mid-move leaves the project cut off until housekeeping gives it back (after 30 minutes at most). A cluster being down affects only its own projects. Tested against real extra clusters (`initdb`) in CI.

## Point-in-time recovery

Restore one project's database to any moment in the last 7 days (pro plan), for the "I dropped the wrong table at 14:02" case. The projects share one Postgres cluster, so history cannot be rewound in place. Instead baas keeps periodic **base backups** of the cluster plus the **archived WAL**. To recover, it starts a throwaway Postgres from the newest base backup before your moment, replays the WAL up to it, dumps that one project's database, and swaps the dump in like a backup restore. Other projects are never touched, and the state being replaced is saved as an ordinary backup first, so a restore can be undone.

```bash
docker compose -f docker-compose.yml -f docker-compose.pitr.yml up -d    # archive WAL + keep base backups
npx baas pitr status                                                      # the window you can restore to
npx baas pitr restore --to 2026-10-02T14:01:30Z --yes
```

The overlay makes Postgres archive WAL into a shared volume (`archive_mode=on`, group-readable files so baas can replay and prune them), allows `pg_basebackup` to connect (a `replication` line in `pg_hba.conf`), and sets `BAAS_PITR_ARCHIVE_DIR`. A base backup is taken at start-up when none exists, then daily (`BAAS_PITR_BASE_EVERY_HOURS`); backups and WAL older than `BAAS_PITR_RETENTION_DAYS` (default 7) are pruned, always keeping the base backup that anchors the oldest moment in the window. The image carries the Postgres server binaries and the `en_US.UTF-8` locale for the recovery server; without Docker you need the **same major version** of `postgres`, `pg_basebackup` and `pg_archivecleanup` in `BAAS_PG_BIN_DIR`, and baas must not run as root (or a `postgres` user must exist to drop to). Restoring needs the **owner** role, and a plan with `pitr` (pro). The dashboard has it under **Backups**.

What it costs and what it does not do: WAL grows with write volume (budget disk for it, plus one cluster-sized base backup per retained day); a recovery copies a base backup, so it needs that much free space under `BAAS_PITR_SCRATCH_DIR` and takes as long as the WAL replay; the project is unreachable only for the moment of the swap. It restores the **database only**, not Storage files, function code or settings. Archiving errors show in `baas pitr status` and in the dashboard (`pg_stat_archiver`): if the archive command is failing, recent moments are not restorable. History on the cluster is linear: a restore is itself part of history, so restoring to a moment after an earlier restore includes it, and moments before it stay reachable. This is tested against a real archiving cluster in CI and on the real Postgres 15 and baas containers with `SMOKE_PITR=1 scripts/smoke.sh`.

## Authentication: email and providers

Set these on the server to turn on email (confirmation, password reset, magic links); without them those flows are off:

```
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM="My App <no-reply@example.com>"
```

Then, per project (dashboard → Authentication, or `PATCH /v1/projects/:ref/settings`; `GET /v1/projects/:ref/auth-config` shows everything in one call):

- **Require email confirmation** (`email_confirm`): sign-up returns the user without a session, a link is emailed, and sign-in is refused until it is used. Links work once, expire (24 hours for confirmation, 1 hour otherwise), and only the newest of each kind works. Emails are limited to one per address per minute and 100 per project per hour. Changing your address also needs confirming.
- **URL configuration** (`site_url`, `redirect_urls`): where emailed links and provider sign-ins may send the browser. The site URL's origin is always allowed; add others (a trailing `*` is a prefix match, and app deep links like `myapp://callback` work). Anything else is refused. The redirect is chosen when the link is made (`?redirect_to=` on `/signup`, `/recover`, `/magiclink`, `/resend`), never taken from the link itself, and the session arrives in the URL fragment (`#access_token=…&type=signup|recovery|magiclink|oauth`).
- **Templates** (`email_templates`, `mailer_from_name`): subject and plain-text body per email, with `{{ .ConfirmationURL }}`, `{{ .Token }}` (a six-digit code), `{{ .Email }}` and `{{ .SiteURL }}`.
- **Codes:** every confirmation, recovery and magic-link email also carries a six-digit code, for apps that cannot open a link: `auth.verifyOtp({ type: 'email' | 'signup' | 'recovery', email, token: code })` (`POST /auth/v1/verify` with `email`). A code is only valid with its address and kind, works once, expires with the link, gets five wrong guesses before it is dead, and ten failures lock the address for a while. Codes are stored hashed.
- **Passkeys and security keys** (WebAuthn) as a second factor, next to authenticator codes: `auth.mfa.webauthn.register({ friendlyName })` and `auth.mfa.webauthn.authenticate({ factorId })` in the client library (or `POST /auth/v1/factors` with `factor_type: "webauthn"`, then `/challenge` and `/verify` with the browser's response). They need to know which website they belong to: the **site URL** is used by default, or set `webauthn` (`rp_id`, `origins`, optional `rp_name` and `require_user_verification`) under Authentication → URL configuration. Supported keys: ES256, EdDSA and RS256. Registration is checked for the right site, challenge, relying party and presence flag; sign-in also for the signature and a signature counter that goes up (a counter that goes backwards means a cloned key and is refused). The attestation statement is not verified, because a second factor only needs proof of holding the key. Sessions upgrade to aal2 exactly as with codes, and adding or removing a factor from an account that has one needs an aal2 session. Verified against Chromium's virtual authenticator in CI; hardware keys and platform authenticators follow the same protocol but are not part of the automated tests.
- **Phone sign-in** (text message codes): set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` (a number, or a messaging service SID starting `MG`). Then `signUp({ phone, password })`, `signInWithOtp({ phone })` and `verifyOtp({ type: "sms", phone, token })` work, as do `POST /auth/v1/otp|signup|verify` and password sign-in with `phone`. Numbers are stored in E.164 form; a six-digit code lasts 10 minutes, gets five tries, and only the newest works; a number can be texted once a minute, and a project 30 times an hour, because each text costs money. `/otp` answers the same for known and unknown numbers and respects `disable_signup` and `create_user: false`. The message comes from the `sms_template` setting (must contain `{{ .Token }}`, up to 160 characters). Without credentials these routes answer 501 and the dashboard says so.
- **Custom OpenID Connect providers** (`oidc_providers`, up to 5 per project): Okta, Auth0, Keycloak, Entra or your own. Give an `issuer` (https, no query), a client ID and secret, and optionally `scopes` (must include `openid`); endpoints come from `<issuer>/.well-known/openid-configuration`, which must name the same issuer. Sign-in uses PKCE and a nonce, and every ID token is verified (RS256/RS384/RS512/ES256/ES384 signature against the issuer's published keys, with one re-fetch when keys rotate; issuer, audience, expiry, not-before, nonce). Use it as `?provider=<name>`. Every request to the provider goes through a guard that refuses private and local addresses (set `oidcAllowPrivate` only for an identity provider inside your own network), pins the checked address, and does not follow redirects. Linking to an existing account needs `email_verified`. Managed under **Authentication → Sign-in providers → Add custom provider**.
- **Providers** (`auth_providers`): client ID and secret per provider, with the callback URL `http://<ref>.<domain>/auth/v1/callback` for the provider's console. Secrets are stored encrypted and never returned. The flow is the authorization-code flow with a signed state tied to the browser by a cookie, plus PKCE where the provider supports it. A sign-in links to an existing account only when the provider says the address is verified; if that account was never confirmed, the password it was registered with is removed.
- **Browser origins** (`cors_origins`): with no list, any website may read the project's API from a browser; with a list, only those origins (`https://app.example.com`, or `https://*.example.com`) get the permission, plus the dashboard's own origins (`BAAS_DASHBOARD_ORIGINS` adds more). This protects users' browsers; it does not stop servers or scripts, which API keys govern.
- **Multi-factor authentication (authenticator apps):** `auth.mfa.enroll()` returns a secret and an `otpauth://` address to show as a QR code (the platform does not draw the QR); `challenge` then `verify` with the app's six-digit code marks the factor verified and upgrades the session to **aal2**, which appears in the access token as `aal`. A password or provider sign-in is aal1, so a policy can require more: `using ((auth.jwt() ->> 'aal') = 'aal2')`. Once a user has a verified factor, changing their password or email, adding or removing a factor needs an aal2 session, so access to their mailbox alone (a recovery link) is not enough. Codes are checked a step either side for clock drift, each step works once, a challenge answers once and lasts five minutes, and ten wrong answers lock a factor for a while. Secrets are sealed with the platform key. A user who loses their device is recovered by an administrator (dashboard → Users → Remove authenticator), which also ends their upgraded sessions. Limits: 10 factors per user; no recovery codes and no SMS or WebAuthn factors.
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
