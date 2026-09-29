# baas — design notes and status

Self-hosted, multi-project Supabase-style platform. All six phases of the original plan are implemented; this file records the design and where the build departs from the plan. Usage and limitations are in [README.md](README.md).

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
| Deno edge functions | Node child process under the permission model | No Deno dependency. Network egress is **not** restricted (Node 22 limitation) |
| WAL-based Realtime | Trigger → `realtime.changes` + `NOTIFY`, one `LISTEN` per project | Payload-size safe; lets each event be re-checked under the subscriber's role |
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

## Things the tests found (kept as regression tests)

Concurrent provisioning race on shared roles; realtime handled `access_token` and `subscribe` out of order; SQL-editor users could not create schemas or storage policies; new tables were writable by `anon` (now secure by default); object names were percent-decoded twice (500 on `100%.txt`); duplicate `Host` headers were silently accepted; password hashing could starve other projects; and in the dashboard, integer-like object keys reordered the column-default menu, two `pattern` attributes were invalid regexes, and a long key overflowed its card.

## Open work

Email delivery and OAuth; embedded resources in REST; enforcing `cors_origins`/`redirect_urls`; an egress-restricted function runner; PITR; multi-node (shard project databases across clusters, move request logs and rate-limit state to shared storage); per-user dashboard accounts.
