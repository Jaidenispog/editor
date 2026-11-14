#!/usr/bin/env bash
# Runs the Stage B browser test against a throwaway stack and removes it again:
#   1. creates a fresh database (default studio_e2e_b) and applies the migrations,
#   2. builds the web app (skip with E2E_SKIP_BUILD=1),
#   3. starts the local fake of Meta (apps/web/e2e/fake-meta.ts: Graph API, rupload and the login dialog on one free
#      port), then `next start` and the worker with NODE_ENV=test and META_*_BASE_URL pointing at the fake,
#   4. runs apps/web/e2e/stage-b.e2e.mjs,
#   5. stops all three processes, drops the database and deletes the scratch folder (kept with E2E_KEEP=1 or on
#      failure).
#
#   bash apps/web/e2e/run-stage-b.sh
#
# Settings: E2E_PG_URL (server admin URL, default postgres://postgres@127.0.0.1:55432/postgres), E2E_DB (database
# name, default studio_e2e_b), E2E_PORT (default 3500), E2E_FAKE_META_PORT (default: a free port), E2E_WORK_DIR
# (scratch folder, default a new temp folder). Needs ffmpeg/ffprobe, psql, curl and Playwright with Chromium.
#
# NODE_ENV=test is what lets the app use the fake hosts (packages/config `testOnlyBaseUrl`); a deployment runs with
# NODE_ENV=production and always calls Meta itself. The META_APP_* values below are dummies the fake accepts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG_URL="${E2E_PG_URL:-postgres://postgres@127.0.0.1:55432/postgres}"
DB_NAME="${E2E_DB:-studio_e2e_b}"
PORT="${E2E_PORT:-3500}"
WORK="${E2E_WORK_DIR:-$(mktemp -d -t studio-e2e-b-XXXXXX)}"
DB_URL="${PG_URL%/*}/${DB_NAME}"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  printf 'E2E_DB must be a plain lower-case database name.\n' >&2
  exit 2
fi
for tool in psql ffmpeg ffprobe node pnpm curl setsid; do
  command -v "$tool" >/dev/null || { printf 'Missing %s on PATH.\n' "$tool" >&2; exit 2; }
done
for sample in sample_a_portrait_sdr.mp4 sample_b_rotated_hevc_hlg.mov sample_c_noaudio_scenes.mp4 sample_music_120bpm.mp3; do
  if [[ ! -f "$REPO_ROOT/data/samples/$sample" ]]; then
    bash "$REPO_ROOT/scripts/make-sample-footage.sh" "$REPO_ROOT/data/samples"
    break
  fi
done

FAKE_PORT="${E2E_FAKE_META_PORT:-$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"
FAKE_URL="http://127.0.0.1:$FAKE_PORT"

mkdir -p "$WORK/storage" "$WORK/tmp" "$WORK/logs" "$WORK/out"
export LOG_LEVEL=info NEXT_TELEMETRY_DISABLED=1
export APP_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL"
APP_SECRET="e2e-only-secret-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export APP_SECRET
export STORAGE_DRIVER=local STORAGE_LOCAL_ROOT="$WORK/storage" WORKER_TMP_DIR="$WORK/tmp" WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-2}"
export AI_PROVIDER=none TRANSCRIPTION_PROVIDER=none
# Instagram direct publishing and the hashtag watch, against the local fake only.
export META_APP_ID=e2e-fake-app META_APP_SECRET=e2e-fake-app-secret META_LOGIN_CONFIG_ID=e2e-fake-config
export META_GRAPH_BASE_URL="$FAKE_URL" META_RUPLOAD_BASE_URL="$FAKE_URL" META_DIALOG_BASE_URL="$FAKE_URL"
# No YouTube key: the chart must show its honest "needs setup" state.
unset YOUTUBE_API_KEY

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
    printf 'Logs and downloads kept in %s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

printf 'Database %s, scratch folder %s, fake Meta on %s\n' "$DB_NAME" "$WORK" "$FAKE_URL"
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
FAKE_META_PORT="$FAKE_PORT" start_detached "$REPO_ROOT/apps/web" "$WORK/fake.pid" "$WORK/logs/fake-meta.log" ./node_modules/.bin/tsx e2e/fake-meta.ts
FAKE_PID="$(cat "$WORK/fake.pid")"
for _ in $(seq 1 30); do
  curl -fsS "$FAKE_URL/__fake/state" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$FAKE_URL/__fake/state" >/dev/null || { printf 'The fake Meta server did not start; see %s\n' "$WORK/logs/fake-meta.log" >&2; exit 1; }

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

E2E_BASE_URL="http://localhost:$PORT" E2E_OUT_DIR="$WORK/out" E2E_FAKE_META_URL="$FAKE_URL" E2E_DATABASE_URL="$DB_URL" \
  E2E_LOG_DIR="$WORK/logs" node "$REPO_ROOT/apps/web/e2e/stage-b.e2e.mjs"
