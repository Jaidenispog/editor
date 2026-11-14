#!/usr/bin/env bash
# Runs the Stage C browser test for bookings, email and reviews against a throwaway stack and removes it again:
#   1. creates a fresh database (default studio_e2e_c1) and applies the migrations,
#   2. builds the web app (skip with E2E_SKIP_BUILD=1),
#   3. starts the local fakes of Square and Postmark (apps/web/e2e/fake-stage-c.ts: three free ports, one for Square,
#      one for Postmark and one control port for the test), then `next start` and the worker with NODE_ENV=test,
#      SQUARE_API_BASE_URL and POSTMARK_API_BASE_URL pointing at the fakes and SQUARE_ENVIRONMENT=sandbox,
#   4. runs apps/web/e2e/stage-c-bookings.e2e.mjs, phase "sandbox",
#   5. stops the web app and the worker (the fakes keep running and keep what they recorded), starts both again with
#      SQUARE_ENVIRONMENT=production (still the fake), and runs the same test file, phase "production", which adds its
#      checks to the first phase's and prints the total,
#   6. stops every process, drops the database and deletes the scratch folder (kept with E2E_KEEP=1 or on failure).
#
#   bash apps/web/e2e/run-stage-c-bookings.sh
#
# Settings: E2E_PG_URL (server admin URL, default postgres://postgres@127.0.0.1:55432/postgres), E2E_DB (database
# name, default studio_e2e_c1), E2E_PORT (default 3800), E2E_WORK_DIR (scratch folder, default a new temp folder).
# Needs psql, curl, setsid and Playwright with Chromium.
#
# NODE_ENV=test is what lets the app use the fake hosts (packages/config `testOnlyBaseUrl`); a deployment runs with
# NODE_ENV=production and always calls Square and Postmark themselves. The Square and Postmark values below are
# dummies the fakes accept; nothing here reaches a real provider.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG_URL="${E2E_PG_URL:-postgres://postgres@127.0.0.1:55432/postgres}"
DB_NAME="${E2E_DB:-studio_e2e_c1}"
PORT="${E2E_PORT:-3800}"
WORK="${E2E_WORK_DIR:-$(mktemp -d -t studio-e2e-c-XXXXXX)}"
DB_URL="${PG_URL%/*}/${DB_NAME}"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  printf 'E2E_DB must be a plain lower-case database name.\n' >&2
  exit 2
fi
for tool in psql node pnpm curl setsid od; do
  command -v "$tool" >/dev/null || { printf 'Missing %s on PATH.\n' "$tool" >&2; exit 2; }
done

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
SQUARE_PORT="$(free_port)"
POSTMARK_PORT="$(free_port)"
CONTROL_PORT="$(free_port)"
FAKE_SQUARE_URL="http://127.0.0.1:$SQUARE_PORT"
FAKE_POSTMARK_URL="http://127.0.0.1:$POSTMARK_PORT"
FAKE_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT"

mkdir -p "$WORK/storage" "$WORK/tmp" "$WORK/logs" "$WORK/out"
export LOG_LEVEL=info NEXT_TELEMETRY_DISABLED=1
export APP_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL"
APP_SECRET="e2e-only-secret-$(random_hex 24)"
export APP_SECRET
export STORAGE_DRIVER=local STORAGE_LOCAL_ROOT="$WORK/storage" WORKER_TMP_DIR="$WORK/tmp" WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-2}"
export AI_PROVIDER=none TRANSCRIPTION_PROVIDER=none
# Square, against the local fake only (the fake's revoke endpoint accepts exactly this dummy secret).
export SQUARE_APPLICATION_ID=fake-square-app SQUARE_APPLICATION_SECRET=fake-square-secret
SQUARE_WEBHOOK_SIGNATURE_KEY="e2e-square-signature-$(random_hex 16)"
export SQUARE_WEBHOOK_SIGNATURE_KEY SQUARE_API_BASE_URL="$FAKE_SQUARE_URL"
# Postmark, against the local fake only.
export EMAIL_PROVIDER=postmark POSTMARK_SERVER_TOKEN=fake-postmark-token EMAIL_FROM='"Ivanhoe Test Barbers" <hello@ivanhoe-barbers.test>'
POSTMARK_WEBHOOK_PASSWORD="$(random_hex 24)"
export POSTMARK_WEBHOOK_USERNAME=e2e-postmark-hook POSTMARK_WEBHOOK_PASSWORD POSTMARK_API_BASE_URL="$FAKE_POSTMARK_URL"
# No Google Maps key, no Meta app, no YouTube key: those cards must show their honest "needs setup" states.
unset GOOGLE_MAPS_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET META_APP_ID META_APP_SECRET YOUTUBE_API_KEY SQUARE_WEBHOOK_NOTIFICATION_URL

FAKE_PID=""
WEB_PID=""
WORKER_PID=""
stop_group() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do kill -0 -- "-$pid" 2>/dev/null || return 0; sleep 1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  stop_group "$WEB_PID"
  stop_group "$WORKER_PID"
  stop_group "$FAKE_PID"
  psql "$PG_URL" -qX -c "drop database if exists $DB_NAME with (force)" >/dev/null || true
  if [[ "${E2E_KEEP:-0}" == "1" || $code -ne 0 ]]; then
    printf 'Logs and screenshots kept in %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

printf 'Database %s, scratch folder %s, fakes: Square %s, Postmark %s, control %s\n' "$DB_NAME" "$WORK" "$FAKE_SQUARE_URL" "$FAKE_POSTMARK_URL" "$FAKE_CONTROL_URL"
psql "$PG_URL" -qX -v ON_ERROR_STOP=1 -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME" >/dev/null
pnpm --dir "$REPO_ROOT" --silent db:migrate

if [[ "${E2E_SKIP_BUILD:-0}" != "1" ]]; then
  printf 'Building the web app (log: %s)\n' "$WORK/logs/build.log"
  NODE_ENV=production pnpm --dir "$REPO_ROOT/apps/web" build >"$WORK/logs/build.log" 2>&1
fi
export NODE_ENV=test

# Each process runs in its own session (setsid) so the cleanup can stop it with everything it started. The
# session leader writes its own pid, which is also the process-group id the cleanup signals.
start_detached() {
  local dir="$1" pidfile="$2" logfile="$3"
  shift 3
  rm -f "$pidfile"
  (cd "$dir" && exec setsid bash -c 'echo $$ >"$0"; exec "$@"' "$pidfile" "$@") </dev/null >"$logfile" 2>&1 &
  for _ in $(seq 1 50); do
    [[ -s "$pidfile" ]] && return 0
    sleep 0.1
  done
  printf 'Could not start %s\n' "$*" >&2
  return 1
}

FAKE_SQUARE_PORT="$SQUARE_PORT" FAKE_POSTMARK_PORT="$POSTMARK_PORT" FAKE_CONTROL_PORT="$CONTROL_PORT" FAKE_POSTMARK_TOKEN="$POSTMARK_SERVER_TOKEN" \
  FAKE_POSTMARK_WEBHOOK_URL="$APP_URL/api/webhooks/postmark" \
  start_detached "$REPO_ROOT/apps/web" "$WORK/fake.pid" "$WORK/logs/fakes.log" ./node_modules/.bin/tsx e2e/fake-stage-c.ts
FAKE_PID="$(cat "$WORK/fake.pid")"
for _ in $(seq 1 30); do
  curl -fsS "$FAKE_CONTROL_URL/state" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$FAKE_CONTROL_URL/state" >/dev/null || { printf 'The fakes did not start; see %s\n' "$WORK/logs/fakes.log" >&2; exit 1; }

# Starts the web app and the worker for one Square environment and waits until both are up.
start_app() {
  local phase="$1"
  SQUARE_ENVIRONMENT="$phase" start_detached "$REPO_ROOT/apps/web" "$WORK/web.pid" "$WORK/logs/web-$phase.log" ./node_modules/.bin/next start -p "$PORT"
  WEB_PID="$(cat "$WORK/web.pid")"
  SQUARE_ENVIRONMENT="$phase" start_detached "$REPO_ROOT/apps/worker" "$WORK/worker.pid" "$WORK/logs/worker-$phase.log" ./node_modules/.bin/tsx src/main.ts
  WORKER_PID="$(cat "$WORK/worker.pid")"
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && grep -q '"worker started"' "$WORK/logs/worker-$phase.log"; then break; fi
    sleep 1
  done
  curl -fsS "http://localhost:$PORT/api/health" >/dev/null || { printf 'The web app did not start; see %s\n' "$WORK/logs/web-$phase.log" >&2; exit 1; }
  grep -q '"worker started"' "$WORK/logs/worker-$phase.log" || { printf 'The worker did not start; see %s\n' "$WORK/logs/worker-$phase.log" >&2; exit 1; }
}

run_phase() {
  E2E_PHASE="$1" E2E_BASE_URL="http://localhost:$PORT" E2E_OUT_DIR="$WORK/out" E2E_FAKE_CONTROL_URL="$FAKE_CONTROL_URL" E2E_DATABASE_URL="$DB_URL" \
    E2E_STATE_FILE="$WORK/out/phase-state.json" E2E_LOG_DIR="$WORK/logs" \
    E2E_SQUARE_SIGNATURE_KEY="$SQUARE_WEBHOOK_SIGNATURE_KEY" E2E_POSTMARK_WEBHOOK_USERNAME="$POSTMARK_WEBHOOK_USERNAME" E2E_POSTMARK_WEBHOOK_PASSWORD="$POSTMARK_WEBHOOK_PASSWORD" \
    node "$REPO_ROOT/apps/web/e2e/stage-c-bookings.e2e.mjs"
}

printf 'Phase 1: Square sandbox\n'
start_app sandbox
run_phase sandbox

printf 'Phase 2: restarting the web app and the worker with SQUARE_ENVIRONMENT=production (still the local fake)\n'
stop_group "$WEB_PID"; WEB_PID=""
stop_group "$WORKER_PID"; WORKER_PID=""
start_app production
run_phase production
