# baas

Self-hosted, multi-project Supabase-style platform. See [PLAN.md](PLAN.md) for architecture and phases.

## Status: Phase 1 (control plane)

- **Provisioning** (`src/provision.ts`): each project gets its own Postgres database (`proj_<ref>`), its own login role that can connect only to that database, and its own JWT secret with anon/service_role keys.
- **Control plane** (`src/control.ts`, `src/api.ts`): organisations, role-scoped API tokens (developer < admin < owner), project lifecycle (create, pause, resume, soft delete, purge after retention), settings, and an audit log. Every project lookup is scoped to the caller's organisation, so another org's project reads as 404.
- **Vault** (`src/vault.ts`): project secrets are stored AES-256-GCM encrypted and bound to the project ref, so a ciphertext copied to another project will not open.
- **Housekeeping:** `reconcile()` cleans up projects stuck mid-provision after a crash; `purgeDeleted()` drops the databases of projects deleted longer than the retention period.

Not built yet: gateway and per-project routing of Auth, REST, Realtime, Storage and Functions (Phases 2-3), dashboard and sign-in (Phase 4), usage metering and backups (Phase 5). `docker-compose.yml` does not yet run the control plane.

## Run the control plane

```bash
export BAAS_CONTROL_URL=postgres://.../baas_control      # metadata database (create it first)
export BAAS_PG_ADMIN_URL=postgres://postgres:...@host/postgres  # superuser on the project cluster
export BAAS_MASTER_KEY=$(openssl rand -hex 32)          # keep this; losing it loses every project's secrets
export BAAS_BOOTSTRAP_TOKEN=$(openssl rand -hex 24)     # creates organisations
npx tsx src/server.ts                                    # migrates, then serves :8080
```

```bash
curl -XPOST :8080/v1/organizations -H "x-bootstrap-token: $BAAS_BOOTSTRAP_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Acme","slug":"acme"}'   # returns the owner token once
curl -XPOST :8080/v1/projects -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"my-app"}'
```

Routes: `POST /v1/organizations`, `POST|DELETE /v1/tokens`, `GET|POST /v1/projects`, `GET|DELETE /v1/projects/:ref`, `POST /v1/projects/:ref/{pause,resume}`, `GET /v1/projects/:ref/api-keys`, `GET|PATCH /v1/projects/:ref/settings`, `GET /v1/audit-log`, `GET /healthz`.

## Run the tests

The database-backed suites need a Postgres superuser URL (the vault tests do not). Either start a throwaway one with Docker:

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
