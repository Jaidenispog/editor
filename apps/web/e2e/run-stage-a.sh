#!/usr/bin/env bash
# Runs the Stage A browser test against a throwaway stack and removes it again:
#   1. creates a fresh database (default studio_e2e) and applies the migrations,
#   2. builds the web app (skip with E2E_SKIP_BUILD=1) and starts `next start` plus the worker, logs to files,
#   3. runs apps/web/e2e/stage-a.e2e.mjs,
#   4. stops both processes, drops the database and deletes the scratch folder (kept with E2E_KEEP=1 or on failure).
#
#   bash apps/web/e2e/run-stage-a.sh
#   E2E_SCREENSHOT_DIR="$PWD/docs/screenshots" bash apps/web/e2e/run-stage-a.sh   # also refresh the screenshots
#
# Settings: E2E_PG_URL (server admin URL, default postgres://postgres@127.0.0.1:55432/postgres), E2E_DB (database
# name), E2E_PORT (default 3100), E2E_WORK_DIR (scratch folder, default a new temp folder). Needs ffmpeg/ffprobe,
# psql, curl and Playwright with Chromium.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG_URL="${E2E_PG_URL:-postgres://postgres@127.0.0.1:55432/postgres}"
DB_NAME="${E2E_DB:-studio_e2e}"
PORT="${E2E_PORT:-3100}"
WORK="${E2E_WORK_DIR:-$(mktemp -d -t studio-e2e-XXXXXX)}"
DB_URL="${PG_URL%/*}/${DB_NAME}"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  printf 'E2E_DB must be a plain lower-case database name.\n' >&2
  exit 2
fi
for tool in psql ffmpeg ffprobe node pnpm curl setsid; do
  command -v "$tool" >/dev/null || { printf 'Missing %s on PATH.\n' "$tool" >&2; exit 2; }
done
if [[ ! -f "$REPO_ROOT/data/samples/sample_a_portrait_sdr.mp4" ]]; then
  bash "$REPO_ROOT/scripts/make-sample-footage.sh" "$REPO_ROOT/data/samples"
fi

mkdir -p "$WORK/storage" "$WORK/tmp" "$WORK/logs" "$WORK/out"
export NODE_ENV=production LOG_LEVEL=info NEXT_TELEMETRY_DISABLED=1
export APP_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL"
APP_SECRET="e2e-only-secret-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export APP_SECRET
export STORAGE_DRIVER=local STORAGE_LOCAL_ROOT="$WORK/storage" WORKER_TMP_DIR="$WORK/tmp" WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-2}"
export AI_PROVIDER=none TRANSCRIPTION_PROVIDER=none

WEB_PID=""
WORKER_PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  local pid
  for pid in "$WEB_PID" "$WORKER_PID"; do
    if [[ -n "$pid" ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  for pid in "$WEB_PID" "$WORKER_PID"; do
    [[ -n "$pid" ]] || continue
    for _ in $(seq 1 60); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
  psql "$PG_URL" -qX -c "drop database if exists $DB_NAME with (force)" >/dev/null || true
  if [[ "${E2E_KEEP:-0}" == "1" || $code -ne 0 ]]; then
    printf 'Logs and downloads kept in %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

printf 'Database %s, scratch folder %s\n' "$DB_NAME" "$WORK"
psql "$PG_URL" -qX -v ON_ERROR_STOP=1 -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME" >/dev/null
pnpm --dir "$REPO_ROOT" --silent db:migrate

if [[ "${E2E_SKIP_BUILD:-0}" != "1" ]]; then
  printf 'Building the web app (log: %s)\n' "$WORK/logs/build.log"
  pnpm --dir "$REPO_ROOT/apps/web" build >"$WORK/logs/build.log" 2>&1
fi

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

E2E_BASE_URL="http://localhost:$PORT" E2E_OUT_DIR="$WORK/out" node "$REPO_ROOT/apps/web/e2e/stage-a.e2e.mjs"
