# baas — design notes and status

Self-hosted, multi-project Supabase-style platform. All six phases of the original plan are implemented, and the dashboard and auth have since grown past it; this file records the design, where the build departs from the plan, and what is still open. Usage and limitations are in [README.md](README.md).

## Decisions

- **TypeScript** control plane, gateway, data-plane services and CLI/SDK; **Docker Compose** on one host.
- **Database-per-project** on a shared Postgres: own database, own login role (connection-limited, with server-side timeouts), own JWT secret.
- **All of Auth, REST, Realtime, Storage, Functions and the dashboard in v1.**

## Where the build differs from the plan

| Plan | Built | Why |
|---|---|---|
| Reuse PostgREST, GoTrue, Realtime, Storage-api, edge-runtime | Wrote TypeScript, multi-tenant implementations of the API subsets that matter | The open-source services are single-tenant; running one set per project costs ~1 GB idle each, and per-request tenant routing was the plan's main risk. One process resolving the project per request avoids both. The cost is that these are subsets (see README limitations), not full re-implementations |
| Next.js dashboard | Dependency-free SPA served by the API (`dashboard/`) | No build step, strict CSP (no inline script/style), easy to test in a browser |
| MinIO for storage | Files on a volume, keyed by object id | Simpler; an S3 backend can sit behind `StorageService` later. Object names never touch the filesystem |
| Deno edge functions | Node child process under the permission model, plus an in-process egress guard | No Deno dependency. Node 22 cannot turn the network off, so `fetch` is replaced by one that refuses private addresses and the socket-opening modules and `process.kill` are removed: defence in depth, not isolation |
| WAL-based Realtime | Trigger → `realtime.changes` + `NOTIFY`, one `LISTEN` per project | Payload-size safe; lets each event be re-checked under the subscriber's role |
| GoTrue email and OAuth deferred | Built after the plan: email confirmation, password reset and magic links over SMTP, and sign-in with Google, GitHub, GitLab, Discord and Microsoft (`src/mailer.ts`, `src/oauth.ts`, `src/authsvc.ts`) | Shared by every project: the operator supplies one SMTP server; each project owns its templates, redirect allow-list and provider credentials (sealed with the vault) |
| — | **Pipelines**, **Integrations** and **Advisors** (added after the plan): signed webhook delivery of row changes with filters, extension install for Postgres-trusted extensions, read-only security and performance checks (`src/pipelines.ts`, `src/extensions.ts`) | Studio-style features that need the platform's own access, so they are admin-only and parameterized end to end |
| — | **Ask AI** (added after the plan): LLM tool loop with a database-enforced read-only reader role and human-approved proposals | Requested feature; see README for the safety model |
| Supavisor pooling | One small `pg.Pool` per project, LRU-evicted | Enough for one node |
| PITR | Not built | Logical backups only; documented |

## Architecture

```
Dashboard / CLI / SDK ─► Management API (Fastify) ─► ControlPlane ─► control DB (orgs, tokens, projects, encrypted secrets, usage, backups, functions)
                                                         │ provisioner: CREATE DATABASE, roles, schema, keys
Client ─► Gateway (host <ref>.domain → project; apikey/JWT) ─► admit: rate limit + quota + metering
             ├─ /rest/v1      REST        ┐
             ├─ /auth/v1      Auth        │ PoolManager: one small pool per project,
             ├─ /storage/v1   Storage     │ each request in a transaction: SET LOCAL ROLE + JWT claims (RLS)
             ├─ /functions/v1 Functions   │
             └─ /realtime/v1  Realtime    ┘ (WebSocket; per-project LISTEN feed)
Housekeeping: reconcile stuck provisioning, purge deleted (+files, backups), idle pause, measure usage, scheduled backups
```

## Phases

| # | Scope | State |
|---|---|---|
| 0 | Per-project database, role, keys; isolation tests | done |
| 1 | Control plane: orgs, tokens, lifecycle, encrypted secrets, audit log | done |
| 2 | Gateway, REST, Auth, per-project routing and pools | done |
| 3 | Realtime, Storage, Functions | done |
| 4 | Dashboard | done, browser-tested (`npm run e2e`) |
| 5 | Metering, quotas, rate limits, idle pause, backups/restore, CLI with migrations, SDK | done |
| 6 | Hardening: cross-tenant attack suite, fuzzing, noisy neighbours, load test | done |

## Dashboard

A Supabase-Studio-shaped workspace: top bar with project switcher and command palette, an icon rail, a second sidebar for Database and Authentication, and per-service request charts on the overview. Database pages edit what they list: tables, functions, triggers, indexes, enum types and row-level security policies, each in a side panel that shows the SQL it will run, plus a Schema Visualizer with relationship lines and an access tester that runs a read-only query as a chosen identity. Authentication has users, providers, URL configuration, email templates and session settings. It stays dependency-free with a strict CSP. Browser tests cover every page, including a phone-width overflow check.

## Pipelines

A pipeline adds the Realtime change trigger to chosen tables and reads `realtime.changes` with its own cursor, kept in the project's database (`realtime.pipeline_cursors`) so the cursor and the log live and die together. Delivery is at-least-once and in order, one batch at a time per pipeline, with back-off and self-pausing. Rows are read with the platform's own access at delivery time, which is why only admins can create pipelines and why row filters are structured conditions, never SQL: values are cast through `jsonb_populate_record`, so Postgres types them from the column and nothing the caller wrote reaches the statement. Destinations are resolved once, checked against private ranges, and the connection is pinned to the checked address. The change log is kept for whatever any pipeline still needs, capped at a day.

## Things the tests found (kept as regression tests)

A signed-in user could set their own `app_metadata`, which policies may trust (now administrator-only); concurrent provisioning race on shared roles; realtime handled `access_token` and `subscribe` out of order; SQL-editor users could not create schemas or storage policies; new tables were writable by `anon` (now secure by default); object names were percent-decoded twice (500 on `100%.txt`); duplicate `Host` headers were silently accepted; password hashing could starve other projects; and in the dashboard, integer-like object keys reordered the column-default menu, two `pattern` attributes were invalid regexes, and a long key overflowed its card.

## Ask AI design notes

`src/ai/`: `llm.ts` (a small model interface plus the Anthropic adapter, so tests can script the model), `setup.ts` (the identity lock — no `set_config` for `anon`/`authenticated` — and, only if the owner allows "everyone" mode, the `baas_ai_reader` role: SELECT on `public`, bypassing RLS, reachable only while allowed), `risk.ts` (statement splitter and SQL-derived risk labels), `assistant.ts` (schema summary, `run_query` / `propose_change` tools, bounded loop, quotas). The assistant asks as an identity — anonymous visitor (default), a chosen user (their real claims), or everyone (owner-enabled) — so row-level security applies to it exactly as to that identity's API calls. Because RLS reads the caller from `request.jwt.claims` and any role can `set_config` it, generated SQL could otherwise impersonate; the lock removes that capability, is verified before every question, and is repaired or refused otherwise (a mutation test confirms the tests fail without it). The trust boundary is deliberately not the model: reads are constrained by Postgres (read-only transaction, extended protocol, restricted role, server watchdog), writes are never executed by the assistant, and the person running a proposal sees the SQL and a label derived from it. Assistant turns, including thinking blocks, are sent back unchanged so history stays append-only.

## Open work

- **CI.** Nothing runs the 250 unit tests or the browser suite automatically, and `docker compose up` has not been exercised end to end by a test. A workflow plus a compose smoke test (start, create an org and project, make a request) is the next step.
- **Auth gaps.** Numeric one-time codes (links only today), phone sign-in, WebAuthn.
- **Dashboard gaps.** Roles and Publications are read-only; the Schema Visualizer shows relationships but does not edit them; editors are plain textareas without syntax highlighting.
- **Platform.** A function runner that is a real network boundary (the in-process egress guard is defence in depth); PITR; multi-node (shard project databases across clusters, move request logs and rate-limit state to shared storage). Member accounts: email password reset, MFA, SSO.
