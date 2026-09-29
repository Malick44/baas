# baas

Self-hosted, multi-project Supabase-style platform. See [PLAN.md](PLAN.md) for architecture and phases.

## Status: Phase 0 (spike)

Each project gets its own Postgres database (`proj_<ref>`), its own login role that can connect only to that database, and its own JWT secret with anon/service_role keys. `src/provision.ts` creates and drops projects; `src/isolation.test.ts` proves one project cannot reach another (keys, database access, RLS).

Not built yet: control-plane metadata DB and API (Phase 1), gateway and per-project routing of Auth, REST, Realtime, Storage and Functions (Phases 2-3), dashboard (Phase 4).

## Run the isolation tests

Needs a Postgres superuser URL. Either start a throwaway one with Docker:

```bash
npm install
eval "$(scripts/test-postgres.sh)"   # exports BAAS_TEST_PG_URL
npm test
docker stop baas-test-pg
```

or point `BAAS_TEST_PG_URL` at any Postgres you can create databases and roles in. Without it the suite is skipped.

## Shared infrastructure

```bash
POSTGRES_PASSWORD=... MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... docker compose up -d
```
