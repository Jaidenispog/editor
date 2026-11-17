#!/usr/bin/env bash
# Runs the Stage C browser test for TikTok via Zernio against a throwaway stack and removes it again:
#   1. creates a fresh database (default studio_e2e_c3) and applies the migrations,
#   2. builds the web app (skip with E2E_SKIP_BUILD=1),
#   3. starts WP10's local fake of Zernio as its own process (apps/web/e2e/fake-zernio.ts: the API and the presigned
#      upload storage on one port, plus a control port for the test),
#   4. phase "setup": `next start` and the worker with NODE_ENV=test and TIKTOK_PUBLISH_PROVIDER=zernio but no
#      ZERNIO_API_BASE_URL, and runs apps/web/e2e/stage-c-tiktok.e2e.mjs (owner account, the honest "needs setup"),
#   5. phase "on": restarts both with ZERNIO_API_BASE_URL pointing at the fake and ZERNIO_WEBHOOK_SECRET set, and runs
#      the main part (key, account, consent, upload, one create, processing → published → link, webhooks, draft,
#      retry),
#   6. phase "off": restarts both with TIKTOK_PUBLISH_PROVIDER=none (the fake keeps running and counts any request)
#      and runs the last part, which adds its checks to the earlier phases' and prints the total,
#   7. stops every process, drops the database and deletes the scratch folder (kept with E2E_KEEP=1 or on failure).
#
#   bash apps/web/e2e/run-stage-c-tiktok.sh
#
# Settings: E2E_PG_URL (server admin URL, default postgres://postgres@127.0.0.1:55432/postgres), E2E_DB (database
# name, default studio_e2e_c3), E2E_PORT (default 4300), E2E_WORK_DIR (scratch folder, default a new temp folder).
# Needs ffmpeg/ffprobe, psql, curl, setsid and Playwright with Chromium.
#
# NODE_ENV=test is what lets the worker upload to the fake over plain http on 127.0.0.1 (`uploadTestOrigin` in
# apps/worker/src/publishing/zernio.ts); a deployment runs with NODE_ENV=production, where the upload address must be
# https and public. The Zernio key the test pastes is the fake's own dummy key; nothing here reaches Zernio.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG_URL="${E2E_PG_URL:-postgres://postgres@127.0.0.1:55432/postgres}"
DB_NAME="${E2E_DB:-studio_e2e_c3}"
PORT="${E2E_PORT:-4300}"
WORK="${E2E_WORK_DIR:-$(mktemp -d -t studio-e2e-c-tiktok-XXXXXX)}"
DB_URL="${PG_URL%/*}/${DB_NAME}"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  printf 'E2E_DB must be a plain lower-case database name.\n' >&2
  exit 2
fi
for tool in psql ffmpeg ffprobe node pnpm curl setsid od; do
  command -v "$tool" >/dev/null || { printf 'Missing %s on PATH.\n' "$tool" >&2; exit 2; }
done
for sample in sample_a_portrait_sdr.mp4 sample_b_rotated_hevc_hlg.mov sample_c_noaudio_scenes.mp4; do
  if [[ ! -f "$REPO_ROOT/data/samples/$sample" ]]; then
    bash "$REPO_ROOT/scripts/make-sample-footage.sh" "$REPO_ROOT/data/samples"
    break
  fi
done

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
ZERNIO_PORT="$(free_port)"
CONTROL_PORT="$(free_port)"
FAKE_ZERNIO_URL="http://127.0.0.1:$ZERNIO_PORT"
FAKE_CONTROL_URL="http://127.0.0.1:$CONTROL_PORT"
HOOK_SECRET="e2e-zernio-webhook-$(random_hex 32)"

mkdir -p "$WORK/storage" "$WORK/tmp" "$WORK/logs" "$WORK/out"
export LOG_LEVEL=info NEXT_TELEMETRY_DISABLED=1
export APP_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL"
APP_SECRET="e2e-only-secret-$(random_hex 24)"
export APP_SECRET
export STORAGE_DRIVER=local STORAGE_LOCAL_ROOT="$WORK/storage" WORKER_TMP_DIR="$WORK/tmp" WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-2}"
export AI_PROVIDER=none TRANSCRIPTION_PROVIDER=none EMAIL_PROVIDER=none
# Nothing else is configured: no Meta, Square, Postmark, Google, Places or YouTube. TikTok settings are set per phase.
unset META_APP_ID META_APP_SECRET META_LOGIN_CONFIG_ID SQUARE_APPLICATION_ID SQUARE_APPLICATION_SECRET POSTMARK_SERVER_TOKEN \
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_MAPS_API_KEY YOUTUBE_API_KEY ANTHROPIC_API_KEY \
  TIKTOK_PUBLISH_PROVIDER ZERNIO_API_BASE_URL ZERNIO_WEBHOOK_SECRET

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

printf 'Database %s, scratch folder %s, fake Zernio %s, control %s\n' "$DB_NAME" "$WORK" "$FAKE_ZERNIO_URL" "$FAKE_CONTROL_URL"
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

FAKE_ZERNIO_PORT="$ZERNIO_PORT" FAKE_CONTROL_PORT="$CONTROL_PORT" \
  start_detached "$REPO_ROOT/apps/web" "$WORK/fake.pid" "$WORK/logs/fake-zernio.log" ./node_modules/.bin/tsx e2e/fake-zernio.ts
FAKE_PID="$(cat "$WORK/fake.pid")"
for _ in $(seq 1 30); do
  curl -fsS "$FAKE_CONTROL_URL/state" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$FAKE_CONTROL_URL/state" >/dev/null || { printf 'The fake Zernio did not start; see %s\n' "$WORK/logs/fake-zernio.log" >&2; exit 1; }

# Starts the web app and the worker for one phase (its TikTok settings are passed in the environment) and waits for both.
start_app() {
  local phase="$1"
  shift
  # The phase's settings are exported only inside these subshells, so each phase starts from the same base.
  (export "$@"; start_detached "$REPO_ROOT/apps/web" "$WORK/web.pid" "$WORK/logs/web-$phase.log" ./node_modules/.bin/next start -p "$PORT")
  WEB_PID="$(cat "$WORK/web.pid")"
  (export "$@"; start_detached "$REPO_ROOT/apps/worker" "$WORK/worker.pid" "$WORK/logs/worker-$phase.log" ./node_modules/.bin/tsx src/main.ts)
  WORKER_PID="$(cat "$WORK/worker.pid")"
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && grep -q '"worker started"' "$WORK/logs/worker-$phase.log"; then break; fi
    sleep 1
  done
  curl -fsS "http://localhost:$PORT/api/health" >/dev/null || { printf 'The web app did not start; see %s\n' "$WORK/logs/web-$phase.log" >&2; exit 1; }
  grep -q '"worker started"' "$WORK/logs/worker-$phase.log" || { printf 'The worker did not start; see %s\n' "$WORK/logs/worker-$phase.log" >&2; exit 1; }
}

stop_app() {
  stop_group "$WEB_PID"; WEB_PID=""
  stop_group "$WORKER_PID"; WORKER_PID=""
}

run_phase() {
  E2E_PHASE="$1" E2E_BASE_URL="http://localhost:$PORT" E2E_OUT_DIR="$WORK/out" E2E_FAKE_CONTROL_URL="$FAKE_CONTROL_URL" E2E_FAKE_ZERNIO_URL="$FAKE_ZERNIO_URL" \
    E2E_DATABASE_URL="$DB_URL" E2E_STATE_FILE="$WORK/out/phase-state.json" E2E_LOG_DIR="$WORK/logs" E2E_ZERNIO_WEBHOOK_SECRET="$HOOK_SECRET" \
    node "$REPO_ROOT/apps/web/e2e/stage-c-tiktok.e2e.mjs"
}

printf 'Phase 1: TIKTOK_PUBLISH_PROVIDER=zernio without ZERNIO_API_BASE_URL (needs setup)\n'
start_app setup TIKTOK_PUBLISH_PROVIDER=zernio
run_phase setup

printf 'Phase 2: restarting with ZERNIO_API_BASE_URL=%s/api and a webhook secret\n' "$FAKE_ZERNIO_URL"
stop_app
start_app on TIKTOK_PUBLISH_PROVIDER=zernio ZERNIO_API_BASE_URL="$FAKE_ZERNIO_URL/api" ZERNIO_WEBHOOK_SECRET="$HOOK_SECRET"
run_phase on

printf 'Phase 3: restarting with TIKTOK_PUBLISH_PROVIDER=none (the fake keeps counting requests)\n'
stop_app
curl -fsS -X POST "$FAKE_CONTROL_URL/calls/reset" >/dev/null
start_app off TIKTOK_PUBLISH_PROVIDER=none ZERNIO_API_BASE_URL="$FAKE_ZERNIO_URL/api" ZERNIO_WEBHOOK_SECRET="$HOOK_SECRET"
run_phase off
