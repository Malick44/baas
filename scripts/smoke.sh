#!/usr/bin/env bash
# End-to-end check of the real container stack: build, start, create an organisation and a project, and use every
# part of the data plane once. Run from the repository root:  scripts/smoke.sh   (needs docker, curl, jq)
set -euo pipefail

cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="baas-smoke-$$"
API_PORT="${SMOKE_API_PORT:-18080}"
GW_PORT="${SMOKE_GATEWAY_PORT:-18081}"
BOOT="smoke-bootstrap-$(openssl rand -hex 12)"
ENVF="$(mktemp)"
OVERRIDE="$(mktemp --suffix=.yml)"

cat > "$ENVF" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 12)
S3_ACCESS_KEY_ID=smoke$(openssl rand -hex 6)
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 16)
BAAS_MASTER_KEY=$(openssl rand -hex 32)
BAAS_BOOTSTRAP_TOKEN=$BOOT
BAAS_PUBLIC_PORT=$GW_PORT
BAAS_PITR_ARCHIVE_TOKEN=$(openssl rand -hex 24)
ENV
if [ "${SMOKE_NODES:-}" = 2 ]; then PUBLISHER=lb; else PUBLISHER=baas; fi   # whatever is in front publishes the ports
cat > "$OVERRIDE" <<YML
services:
  $PUBLISHER:
    ports: !override
      - "127.0.0.1:$API_PORT:8080"
      - "127.0.0.1:$GW_PORT:8081"
YML
# SMOKE_PITR=1 also runs the stack with WAL archiving (docker-compose.pitr.yml) and restores to a moment.
# SMOKE_PITR=shared does the same with the archive in the shared store: Postgres uploads WAL over HTTP, no volume is shared (docker-compose.pitr-shared.yml).
# SMOKE_NODES=2 runs two baas nodes behind a load balancer (docker-compose.nodes.yml) and kills the leader.
# SMOKE_S3=1 keeps object files in a bundled S3 server (docker-compose.s3.yml) and checks nothing lands on the local volume.
PITR_FILE=()
NODES_FILE=()
S3_FILE=()
[ "${SMOKE_S3:-}" = 1 ] && S3_FILE=(-f docker-compose.s3.yml)
[ "${SMOKE_NODES:-}" = 2 ] && NODES_FILE=(-f docker-compose.nodes.yml)
EXTRA_FILE=()
[ -n "${SMOKE_EXTRA_COMPOSE:-}" ] && EXTRA_FILE=(-f "$SMOKE_EXTRA_COMPOSE")   # for environments that need extra build settings (a proxy CA)
[ "${SMOKE_PITR:-}" = 1 ] && PITR_FILE=(-f docker-compose.pitr.yml)
[ "${SMOKE_PITR:-}" = shared ] && PITR_FILE=(-f docker-compose.pitr-shared.yml)
if [ "${SMOKE_S3:-}" = 1 ] && [ "${SMOKE_NODES:-}" = 2 ]; then
  # The nodes overlay gives baas2 its own volumes; it only needs the same S3 settings as baas.
  cat >> "$OVERRIDE" <<YML
  baas2:
    depends_on:
      s3: { condition: service_started }
    environment:
      S3_ENDPOINT: http://s3:8333
      S3_BUCKET: baas
      S3_REGION: us-east-1
      S3_ACCESS_KEY_ID: \${S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: \${S3_SECRET_ACCESS_KEY}
      S3_CREATE_BUCKET: "true"
YML
fi
compose() { docker compose --env-file "$ENVF" -f docker-compose.yml "${PITR_FILE[@]}" "${NODES_FILE[@]}" "${S3_FILE[@]}" -f "$OVERRIDE" "${EXTRA_FILE[@]}" "$@"; }

cleanup() {
  status=$?
  if [ $status -ne 0 ]; then echo "--- smoke test failed; container logs ---"; compose logs --no-color --tail=80 || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENVF" "$OVERRIDE"
  exit $status
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
expect() { # expect <label> <want> <got>
  [ "$2" = "$3" ] || fail "$1: expected '$2', got '$3'"; echo "ok  $1"
}
api() { curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

step "build and start"
compose up -d --build --wait --wait-timeout 240

step "management API"
curl -fsS "http://127.0.0.1:$API_PORT/healthz" | jq -e .ok >/dev/null && echo "ok  healthz"
curl -fsS "http://127.0.0.1:$API_PORT/" | grep -q "<title>" && echo "ok  dashboard is served"
ORG=$(curl -fsS -XPOST "http://127.0.0.1:$API_PORT/v1/organizations" -H "x-bootstrap-token: $BOOT" -H 'content-type: application/json' -d '{"name":"Smoke","slug":"smoke"}')
TOKEN=$(jq -r .owner_token <<<"$ORG")
case "$TOKEN" in baas_*) echo "ok  organisation created";; *) fail "no owner token: $ORG";; esac
expect "bad bootstrap token is refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' -XPOST "http://127.0.0.1:$API_PORT/v1/organizations" -H 'x-bootstrap-token: nope-nope-nope-nope-nope-nope' -H 'content-type: application/json' -d '{"name":"x","slug":"x"}')"

step "project"
REF=$(api -fXPOST "http://127.0.0.1:$API_PORT/v1/projects" -d '{"name":"smoke"}' | jq -r .ref)
[[ "$REF" =~ ^[a-z0-9]{20}$ ]] || fail "bad project ref: $REF"; echo "ok  project $REF"
KEYS=$(api -fS "http://127.0.0.1:$API_PORT/v1/projects/$REF/api-keys")
ANON=$(jq -r .anon <<<"$KEYS"); SERVICE=$(jq -r .service_role <<<"$KEYS")
gw() { local method=$1 path=$2; shift 2; curl -sS -X "$method" -H "host: $REF.localhost:$GW_PORT" "http://127.0.0.1:$GW_PORT$path" "$@"; }
sql() { api -fS -XPOST "http://127.0.0.1:$API_PORT/v1/projects/$REF/sql" -d "$(jq -nc --arg q "$1" '{query:$q}')"; }

step "database, REST and row-level security"
sql "create table public.todos (id serial primary key, owner uuid default auth.uid(), title text not null);
     alter table public.todos enable row level security;
     grant select, insert on public.todos to authenticated; grant usage on sequence public.todos_id_seq to authenticated;
     create policy mine on public.todos for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());" >/dev/null
CODE=$(gw GET /rest/v1/todos -H "apikey: $ANON" -o /dev/null -w '%{http_code}'); [ "$CODE" = 401 ] || [ "$CODE" = 403 ] || [ "$CODE" = 404 ] || fail "anon read answered $CODE"; echo "ok  anon cannot read a new table ($CODE)"

step "auth"
SIGNUP=$(gw POST /auth/v1/signup -H "apikey: $ANON" -H 'content-type: application/json' -d '{"email":"smoke@example.com","password":"smoke-password-1"}')
USER_TOKEN=$(jq -r .access_token <<<"$SIGNUP"); [ "$USER_TOKEN" != null ] || fail "sign-up gave no session: $SIGNUP"; echo "ok  sign-up"
expect "insert as the user" 201 "$(gw POST /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' -d '{"title":"from the smoke test"}' -o /dev/null -w '%{http_code}')"
expect "the user reads their row" "from the smoke test" "$(gw GET /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $USER_TOKEN" | jq -r '.[0].title')"
SECOND=$(gw POST /auth/v1/signup -H "apikey: $ANON" -H 'content-type: application/json' -d '{"email":"other@example.com","password":"smoke-password-1"}' | jq -r .access_token)
expect "another user sees none of it" 0 "$(gw GET /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $SECOND" | jq length)"

step "storage"
gw POST /storage/v1/bucket -H "apikey: $SERVICE" -H "authorization: Bearer $SERVICE" -H 'content-type: application/json' -d '{"id":"files","name":"files","public":true}' -o /dev/null -f
echo "hello storage" | gw POST /storage/v1/object/files/hello.txt -H "apikey: $SERVICE" -H "authorization: Bearer $SERVICE" -H 'content-type: text/plain' --data-binary @- -o /dev/null -f
expect "public file downloads" "hello storage" "$(gw GET /storage/v1/object/public/files/hello.txt)"
if [ "${SMOKE_S3:-}" = 1 ] || [ "${SMOKE_NODES:-}" = 2 ]; then
  # Whichever node answers, the file is served although no node holds it on disk: it is in the S3 bucket or in Postgres.
  for i in 1 2 3 4; do expect "file $i is served from the shared store" "hello storage" "$(gw GET /storage/v1/object/public/files/hello.txt)"; done
  for svc in baas $([ "${SMOKE_NODES:-}" = 2 ] && echo baas2); do
    expect "no object files on $svc's disk" 0 "$(compose exec -T "$svc" sh -c 'find /data/storage -type f | wc -l' | tr -d '[:space:]')"
  done
fi

step "edge function"
api -fS -XPUT "http://127.0.0.1:$API_PORT/v1/projects/$REF/functions/hi" -d '{"source":"export default async () => Response.json({ hi: 1 });"}' >/dev/null
expect "function runs" 1 "$(gw POST /functions/v1/hi -H "apikey: $ANON" -H "authorization: Bearer $SERVICE" | jq .hi)"

step "metrics, backup and restart"
expect "requests were counted" true "$(api -fS "http://127.0.0.1:$API_PORT/v1/projects/$REF/metrics" | jq '.totals.requests > 0')"
BACKUP_JSON=$(api -fS -XPOST "http://127.0.0.1:$API_PORT/v1/projects/$REF/backups" -d '{"note":"smoke"}')
expect "backup completes" complete "$(jq -r .status <<<"$BACKUP_JSON")"
BACKUP_ID=$(jq -r .id <<<"$BACKUP_JSON")

step "restore a backup"
sql "insert into public.todos (owner, title) values (null, 'written after the backup')" >/dev/null
expect "the later row exists" 1 "$(sql "select count(*) from public.todos where title = 'written after the backup'" | jq -r '.results[0].rows[0][0]')"
api -fS -XPOST "http://127.0.0.1:$API_PORT/v1/projects/$REF/backups/$BACKUP_ID/restore" -d "{}" >/dev/null
expect "restore removes what came after the backup" 0 "$(sql "select count(*) from public.todos where title = 'written after the backup'" | jq -r '.results[0].rows[0][0]')"
expect "restore keeps what was in the backup" 1 "$(sql "select count(*) from public.todos where title = 'from the smoke test'" | jq -r '.results[0].rows[0][0]')"
expect "the project still serves requests after a restore" 200 "$(gw GET /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $USER_TOKEN" -o /dev/null -w '%{http_code}')"

if [ "${SMOKE_PITR:-}" = 1 ] || [ "${SMOKE_PITR:-}" = shared ]; then
  step "point-in-time recovery"
  api -fS -XPATCH "http://127.0.0.1:$API_PORT/v1/projects/$REF" -d '{"plan":"pro"}' >/dev/null
  expect "WAL archiving is on" true "$(api -fS "http://127.0.0.1:$API_PORT/v1/projects/$REF/pitr" | jq .enabled)"
  BASE=$(api -fS -XPOST "http://127.0.0.1:$API_PORT/v1/projects/$REF/pitr/base-backup" -d '{}')
  expect "a base backup completes" complete "$(jq -r .status <<<"$BASE")"
  sql "create table public.ledger (n int); insert into public.ledger values (1), (2)" >/dev/null
  sleep 2
  MOMENT=$(sql "select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')" | jq -r '.results[0].rows[0][0]')
  sleep 2
  sql "insert into public.ledger values (3); drop table public.todos" >/dev/null
  expect "the later change happened" 3 "$(sql "select count(*) from public.ledger" | jq -r '.results[0].rows[0][0]')"
  RESTORED=$(api -fS -XPOST "http://127.0.0.1:$API_PORT/v1/projects/$REF/pitr/restore" -d "{\"to\":\"$MOMENT\"}")
  [ "$(jq -r .safety_backup <<<"$RESTORED")" != null ] || fail "restore answered: $RESTORED"; echo "ok  restore to $MOMENT"
  expect "rows after the moment are gone" 2 "$(sql "select count(*) from public.ledger" | jq -r '.results[0].rows[0][0]')"
  expect "the dropped table is back" 1 "$(sql "select count(*) from public.todos where title = 'from the smoke test'" | jq -r '.results[0].rows[0][0]')"
fi

if [ "${SMOKE_NODES:-}" = 2 ]; then
  step "two nodes behind a load balancer"
  op() { curl -fsS -H "x-bootstrap-token: $BOOT" "http://127.0.0.1:$API_PORT$1"; }
  for _ in $(seq 1 30); do [ "$(op /v1/admin/nodes | jq length)" = 2 ] && break; sleep 2; done
  NODES=$(op /v1/admin/nodes)
  expect "two nodes are alive" 2 "$(jq length <<<"$NODES")"
  expect "exactly one is the leader" 1 "$(jq '[.[] | select(.leader)] | length' <<<"$NODES")"
  for i in 1 2 3 4 5 6; do expect "request $i through the balancer" 200 "$(gw GET /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $USER_TOKEN" -o /dev/null -w '%{http_code}')"; done

  LEADER_HOST=$(jq -r '.[] | select(.leader) | .host' <<<"$NODES" | cut -d: -f1)
  LEADER_SVC=""
  for svc in baas baas2; do id=$(compose ps -q "$svc"); [ "${id:0:12}" = "$LEADER_HOST" ] && LEADER_SVC=$svc; done
  [ -n "$LEADER_SVC" ] || fail "could not tell which service leads ($LEADER_HOST)"
  echo "ok  $LEADER_SVC leads; stopping it"
  compose stop "$LEADER_SVC" >/dev/null
  SURVIVED=""
  for _ in $(seq 1 45); do
    N=$(op /v1/admin/nodes 2>/dev/null || echo '[]')
    if [ "$(jq length <<<"$N")" = 1 ] && [ "$(jq -r '.[0].leader' <<<"$N")" = true ]; then SURVIVED=1; break; fi
    sleep 2
  done
  [ -n "$SURVIVED" ] || fail "the surviving node did not take over: $N"; echo "ok  the other node took over leadership"
  expect "the project is still served" 200 "$(gw GET /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $USER_TOKEN" -o /dev/null -w '%{http_code}')"
  expect "writes still work" 201 "$(gw POST /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' -d '{"title":"written with one node down"}' -o /dev/null -w '%{http_code}')"
  compose start "$LEADER_SVC" >/dev/null
  BACK=""
  for _ in $(seq 1 45); do
    N=$(op /v1/admin/nodes 2>/dev/null || echo '[]')
    if [ "$(jq length <<<"$N")" = 2 ] && [ "$(jq '[.[] | select(.leader)] | length' <<<"$N")" = 1 ]; then BACK=1; break; fi
    sleep 2
  done
  [ -n "$BACK" ] || fail "the stopped node did not rejoin: $N"; echo "ok  the stopped node rejoined as a follower"
fi

step "certificate check used by the TLS proxy"
tls() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/v1/tls-check?domain=$1"; }
expect "a project's host is allowed" 200 "$(tls "$REF.localhost")"
expect "an unknown project's host is refused" 404 "$(tls "aaaaaaaaaaaaaaaaaaaa.localhost")"
expect "a foreign domain is refused" 404 "$(tls "$REF.example.org")"
compose restart baas >/dev/null
compose up -d --wait --wait-timeout 120 >/dev/null
expect "data survives a restart" "from the smoke test" "$(gw GET /rest/v1/todos -H "apikey: $ANON" -H "authorization: Bearer $USER_TOKEN" | jq -r '.[0].title')"
echo; echo "smoke test passed"
