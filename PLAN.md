# baas — self-hosted Supabase-style platform, multi-project

One control plane provisions many isolated projects on shared infrastructure.

## Decisions

- **Language:** TypeScript for the control plane, gateway and dashboard. Data-plane services are the open-source Supabase components (PostgREST, GoTrue/auth, Realtime, Storage-api, postgres-meta, edge-runtime), not rewritten.
- **Deployment:** Docker Compose on a single host for v1.
- **v1 scope:** Auth, REST, Dashboard, Realtime, Storage and Functions, all from the start.
- **Isolation:** database-per-project on a shared Postgres cluster (own DB, roles, JWT secret per project). Assumed; revisit if a project needs its own cluster.

## Architecture

```
Dashboard (Next.js) ─► Management API (Fastify/TS) ─► Provisioner
                                   │                     │ creates DB, roles, keys
                              control-plane DB           ▼
Client ─► Gateway (TS, host <ref>.domain + apikey) ─► per-project routing
            ├─ /auth/v1      GoTrue        (project JWT secret + DB)
            ├─ /rest/v1      PostgREST     (project DB, role switching)
            ├─ /realtime/v1  Realtime      (project replication slot)
            ├─ /storage/v1   Storage-api   (MinIO, bucket prefix per project)
            └─ /functions/v1 edge-runtime  (per-project function dir)
         Pooler (Supavisor/PgBouncer) in front of Postgres
```

Because the OSS services are single-tenant by default, v1 runs them **multi-tenant via config lookup**: the gateway resolves the project and injects the project's DB URL and JWT secret per request where the service supports it (Realtime, Supavisor, Storage are tenant-aware); for PostgREST and GoTrue a worker pool keyed by project is spawned by the provisioner and reaped when idle. This is the highest-risk area; Phase 0 validates it.

## Control-plane data model

`organizations`, `members`, `projects` (ref, org, status, db_name, plan), `project_secrets` (JWT secret, anon/service keys, DB password; encrypted with a master key), `project_settings`, `usage_events`, `audit_log`.

## Provisioning (`POST /projects`)

1. Insert project (`provisioning`), generate ref, JWT secret, anon and service_role JWTs.
2. `CREATE DATABASE proj_<ref>` from a template with extensions (pgcrypto, pgvector, pg_graphql).
3. Create roles `anon`, `authenticated`, `service_role`, `authenticator`; apply base schemas (`auth`, `storage`, `realtime`) and RLS.
4. Register with gateway, pooler, replication slot/publication, storage bucket prefix, functions directory.
5. Mark `active`. Every step idempotent; failure rolls back with no orphan DB.

Also: pause/resume, soft delete + purge, backup/restore.

## Phases

0. **Spike (1 wk):** stock Supabase compose, two projects on one Postgres; prove per-project routing for each service.
1. **Control plane (2–3 wk):** metadata DB, Management API, provisioner, secrets vault.
2. **Gateway + Auth + REST (2–3 wk):** host/apikey routing, per-project isolation tests.
3. **Realtime, Storage, Functions (3 wk).**
4. **Dashboard (3 wk):** project switcher, table + SQL editor, auth users, storage browser, functions, keys, logs.
5. **Ops (2–3 wk):** metering, quotas, rate limits, backups/PITR, idle pause, migrations CLI.
6. **Hardening:** cross-tenant fuzz suite, noisy-neighbour and load tests.

## Risks

Noisy neighbours (statement timeouts, connection caps per project); Realtime replication slots per project; JWT secret handling and rotation; Postgres/extension upgrades across many DBs; component licences and no Supabase branding.

## Definition of done for v1

Create two projects via the dashboard; each has working Auth, REST, Realtime, Storage and Functions; project A's keys and host cannot reach project B's data through any service; the isolation test suite passes in CI.
