#!/usr/bin/env bash
# Start a throwaway local Postgres for the isolation tests and print its URL.
# Usage: eval "$(scripts/test-postgres.sh)" && npm test
# Uses the docker-compose Postgres if you'd rather: BAAS_TEST_PG_URL=postgres://postgres:$POSTGRES_PASSWORD@localhost:5432/postgres
set -euo pipefail
docker run -d --rm --name baas-test-pg -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:16 >/dev/null
until docker exec baas-test-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
echo "export BAAS_TEST_PG_URL=postgres://postgres:test@localhost:54329/postgres"
