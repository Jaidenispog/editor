#!/usr/bin/env bash
# Runs the Stage C website browser test (website check, prepared changes, WordPress apply, Search Console, Google
# Business Profile reviews and Performance) against a throwaway stack and removes it again:
#   1. creates a fresh database (default studio_e2e_c_website) and applies the migrations,
#   2. builds the web app (skip with E2E_SKIP_BUILD=1),
#   3. starts the local fakes (apps/web/e2e/fake-stage-c-website.ts: the worker's fixture website with a WordPress REST
#      fake on one port, and one Google fake for sign-in, Search Console and Business Profile on another), then
#      `next start` and the worker with NODE_ENV=test, WEBSITE_FIXTURE_BASE_URL and GOOGLE_API_BASE_URL pointing at them,
#   4. runs apps/web/e2e/stage-c-website.e2e.mjs,
#   5. stops all three processes, drops the database and deletes the scratch folder (kept with E2E_KEEP=1 or on
#      failure).
#
#   bash apps/web/e2e/run-stage-c-website.sh
#
# Settings: E2E_PG_URL (server admin URL, default postgres://postgres@127.0.0.1:55432/postgres), E2E_DB (database
# name, default studio_e2e_c_website), E2E_PORT (default 3900), E2E_FAKE_SITE_PORT / E2E_FAKE_GOOGLE_PORT (default:
# free ports), E2E_WORK_DIR (scratch folder, default a new temp folder). Needs psql, curl and Playwright with Chromium.
#
# NODE_ENV=test is what lets the app use the fakes (packages/config `testOnlyBaseUrl`, `googleApiUrl` and
# `testOnlyWebsiteFixture`); a deployment runs with NODE_ENV=production, always calls Google itself and never reaches a
# loopback or private address. The GOOGLE_CLIENT_* values below are dummies the fake accepts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG_URL="${E2E_PG_URL:-postgres://postgres@127.0.0.1:55432/postgres}"
DB_NAME="${E2E_DB:-studio_e2e_c_website}"
PORT="${E2E_PORT:-3900}"
WORK="${E2E_WORK_DIR:-$(mktemp -d -t studio-e2e-c-website-XXXXXX)}"
DB_URL="${PG_URL%/*}/${DB_NAME}"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  printf 'E2E_DB must be a plain lower-case database name.\n' >&2
  exit 2
fi
for tool in psql node pnpm curl setsid; do
  command -v "$tool" >/dev/null || { printf 'Missing %s on PATH.\n' "$tool" >&2; exit 2; }
done

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
SITE_PORT="${E2E_FAKE_SITE_PORT:-$(free_port)}"
GOOGLE_PORT="${E2E_FAKE_GOOGLE_PORT:-$(free_port)}"
FIXTURE_HOST="ivanhoe-studio.test"
GOOGLE_URL="http://127.0.0.1:$GOOGLE_PORT"
WP_PASSWORD="e2e$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n') wp app pass"

mkdir -p "$WORK/storage" "$WORK/tmp" "$WORK/logs" "$WORK/out"
export LOG_LEVEL=info NEXT_TELEMETRY_DISABLED=1
export APP_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL"
APP_SECRET="e2e-only-secret-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export APP_SECRET
export STORAGE_DRIVER=local STORAGE_LOCAL_ROOT="$WORK/storage" WORKER_TMP_DIR="$WORK/tmp" WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-2}"
export AI_PROVIDER=none TRANSCRIPTION_PROVIDER=none EMAIL_PROVIDER=none
# Google sign-in, Search Console and Business Profile against the local fake only.
export GOOGLE_CLIENT_ID=e2e-client.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=e2e-client-secret
export GOOGLE_API_BASE_URL="$GOOGLE_URL"
# The fixture website (and its WordPress) as http://ivanhoe-studio.test/, served on 127.0.0.1:$SITE_PORT.
export WEBSITE_FIXTURE_BASE_URL="http://$FIXTURE_HOST:$SITE_PORT"
# Nothing else is configured: no Meta, Square, Postmark, Places or YouTube.
unset META_APP_ID META_APP_SECRET META_LOGIN_CONFIG_ID SQUARE_APPLICATION_ID SQUARE_APPLICATION_SECRET POSTMARK_SERVER_TOKEN GOOGLE_MAPS_API_KEY YOUTUBE_API_KEY ANTHROPIC_API_KEY

FAKE_PID=""
WEB_PID=""
WORKER_PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  local pid
  for pid in "$WEB_PID" "$WORKER_PID" "$FAKE_PID"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  for pid in "$WEB_PID" "$WORKER_PID" "$FAKE_PID"; do
    [[ -n "$pid" ]] || continue
    for _ in $(seq 1 60); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
  psql "$PG_URL" -qX -c "drop database if exists $DB_NAME with (force)" >/dev/null || true
  if [[ "${E2E_KEEP:-0}" == "1" || $code -ne 0 ]]; then
    printf 'Logs and screenshots kept in %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

printf 'Database %s, scratch folder %s, fake website on 127.0.0.1:%s (%s), fake Google on %s\n' "$DB_NAME" "$WORK" "$SITE_PORT" "$FIXTURE_HOST" "$GOOGLE_URL"
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
FAKE_SITE_PORT="$SITE_PORT" FAKE_GOOGLE_PORT="$GOOGLE_PORT" FAKE_WP_PASSWORD="$WP_PASSWORD" FAKE_GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" FAKE_GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  start_detached "$REPO_ROOT/apps/web" "$WORK/fake.pid" "$WORK/logs/fakes.log" ./node_modules/.bin/tsx e2e/fake-stage-c-website.ts
FAKE_PID="$(cat "$WORK/fake.pid")"
for _ in $(seq 1 30); do
  curl -fsS "$GOOGLE_URL/__fake/state" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$GOOGLE_URL/__fake/state" >/dev/null || { printf 'The fakes did not start; see %s\n' "$WORK/logs/fakes.log" >&2; exit 1; }

start_detached "$REPO_ROOT/apps/web" "$WORK/web.pid" "$WORK/logs/web.log" ./node_modules/.bin/next start -p "$PORT"
WEB_PID="$(cat "$WORK/web.pid")"
start_detached "$REPO_ROOT/apps/worker" "$WORK/worker.pid" "$WORK/logs/worker.log" ./node_modules/.bin/tsx src/main.ts
WORKER_PID="$(cat "$WORK/worker.pid")"

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && grep -q '"worker started"' "$WORK/logs/worker.log"; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$PORT/api/health" >/dev/null || { printf 'The web app did not start; see %s\n' "$WORK/logs/web.log" >&2; exit 1; }
grep -q '"worker started"' "$WORK/logs/worker.log" || { printf 'The worker did not start; see %s\n' "$WORK/logs/worker.log" >&2; exit 1; }

E2E_BASE_URL="http://localhost:$PORT" E2E_OUT_DIR="$WORK/out" E2E_FAKE_GOOGLE_URL="$GOOGLE_URL" E2E_FIXTURE_SITE="http://$FIXTURE_HOST" E2E_FIXTURE_PORT="$SITE_PORT" \
  E2E_WP_USER=studio-assistant E2E_WP_PASSWORD="$WP_PASSWORD" E2E_DATABASE_URL="$DB_URL" E2E_LOG_DIR="$WORK/logs" \
  node "$REPO_ROOT/apps/web/e2e/stage-c-website.e2e.mjs"
