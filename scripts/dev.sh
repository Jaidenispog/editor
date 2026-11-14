#!/usr/bin/env bash
# Runs Studio Assistant on this computer: the web app and the background worker together, with each line of
# output prefixed [web] or [worker]. Ctrl+C stops both. If the website stops, the worker is stopped too. If the
# worker stops or crashes, this script says so in plain words and starts it again (it waits for the database by
# itself); it gives up and stops both, with the reason, after a setting problem or five crashes in five minutes.
#
#   bash scripts/dev.sh             # check tools, then start web (http://localhost:3000) and worker
#   bash scripts/dev.sh migrate     # apply database migrations using DATABASE_URL from the root .env
#   bash scripts/dev.sh --no-check  # skip the tool check
#   bash scripts/dev.sh --watch     # developers: restart the worker on code changes (tsx watch, see below)
#
# The worker runs WITHOUT watch mode by default. `tsx watch` keeps its process alive after the worker crashes
# (it waits for a file to change), so this script could not notice the crash and nothing would restart it. The
# owner does not edit code, so watch mode brings nothing but that risk. With --watch, a crash is only reported by
# tsx itself and by the app's "background worker isn't running" notice. `pnpm dev:worker` stays in watch mode.
#
# Settings come from the .env at the repository root (copy .env.example to start). Every line of it is exported
# to both processes. The website listens on 127.0.0.1 only, unless WEB_HOST (e.g. 0.0.0.0) is set in .env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMMAND="run"
CHECK=1
WATCH=0
for arg in "$@"; do
  case "$arg" in
    migrate) COMMAND="migrate" ;;
    --no-check) CHECK=0 ;;
    --watch) WATCH=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f .env ]]; then
  printf 'No .env file at %s.\n' "$REPO_ROOT"
  printf 'Create one with:  cp .env.example .env   then set DATABASE_URL and APP_SECRET (see the comments in it).\n'
  exit 1
fi

# Export the root .env for child processes. The web app and worker read it themselves as well, but some
# package scripts (e.g. migrations, which run inside packages/db) do not look at the repository root.
# Variables already set in this shell win, matching the app's own rule.
load_env() {
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    [[ -n "${!key+x}" ]] || export "$key=$value"
  done < .env
}
load_env

if [[ -z "${DATABASE_URL:-}" ]]; then
  printf 'DATABASE_URL is empty in .env. Start a local database with:  bash scripts/local-postgres.sh start\n'
  exit 1
fi

if [[ "$COMMAND" == "migrate" ]]; then
  exec pnpm --filter @studio/db migrate
fi

if (( CHECK )); then
  bash scripts/check-tools.sh --quiet || {
    printf '\nFix the missing tools above (or run with --no-check to start anyway).\n'
    exit 1
  }
fi

if [[ ! -d node_modules ]]; then
  printf 'Dependencies are not installed. Run:  pnpm install\n'
  exit 1
fi

if [[ -t 1 ]]; then
  WEB_TAG=$'\033[36m[web]\033[0m   '
  WORKER_TAG=$'\033[35m[worker]\033[0m '
else
  WEB_TAG='[web]    '
  WORKER_TAG='[worker] '
fi

# Prefixes each line of a stream; `read` is line-buffered, so output appears as it happens.
prefix() {
  local tag="$1" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s%s\n' "$tag" "$line"
  done
}

# The worker's exit status for a setting problem (sysexits EX_CONFIG, see apps/worker/src/lib/startup.ts).
# Restarting cannot fix that, so the script stops instead.
EXIT_CONFIG=78
# Give up after this many worker crashes within CRASH_WINDOW seconds.
MAX_CRASHES=5
CRASH_WINDOW=300

WEB_PID=""
WORKER_PID=""
STOPPING=0
cleanup() {
  trap - INT TERM EXIT
  STOPPING=1
  local pid
  for pid in $WEB_PID $WORKER_PID; do
    # Each service runs in its own process group (set -m below), so signal the whole group.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  # The worker may need a while to let a running job finish or record its state (it gives up after 45 s).
  local waited=0
  while (( waited < 250 )); do
    local alive=0
    for pid in $WEB_PID $WORKER_PID; do kill -0 "$pid" 2>/dev/null && alive=1; done
    (( alive )) || break
    sleep 0.2
    waited=$((waited + 1))
  done
  for pid in $WEB_PID $WORKER_PID; do kill -KILL -- "-$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'printf "\nStopping web and worker...\n"; cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# `start` runs the worker once (tsx src/main.ts) so a crash ends the process and this script sees it; `dev` is
# tsx watch (developers, --watch).
WORKER_SCRIPT="start"
(( WATCH )) && WORKER_SCRIPT="dev"

start_web() {
  set -m
  ( pnpm --filter @studio/web dev 2>&1 | prefix "$WEB_TAG" ) &
  WEB_PID=$!
  set +m
}
start_worker() {
  set -m
  ( pnpm --silent --filter @studio/worker "$WORKER_SCRIPT" 2>&1 | prefix "$WORKER_TAG" ) &
  WORKER_PID=$!
  set +m
}

start_web
start_worker

printf 'Starting web (http://localhost:%s) and worker. Press Ctrl+C to stop both.\n' "${PORT:-3000}"
case "${WEB_HOST:-127.0.0.1}" in
  127.0.0.1|localhost|::1)
    printf 'Only this computer can open the app. (To try it on a phone on the same Wi-Fi, see WEB_HOST in .env.example.)\n'
    ;;
  *)
    printf 'WEB_HOST=%s: other devices on this network can open the app too, including /setup until an owner exists.\n' "$WEB_HOST"
    ;;
esac
printf 'First run? Open http://localhost:%s/setup straight away to create the owner account.\n' "${PORT:-3000}"
if (( WATCH )); then
  printf 'Watch mode: the worker restarts when you change its code. If it crashes, tsx waits for the next change;\n'
  printf 'the app then shows that the background worker is not running.\n'
fi

# Seconds (since this script started) of recent worker crashes, oldest first.
CRASHES=()
# Drops crashes older than CRASH_WINDOW (runs in this shell, not a $(...) subshell, so CRASHES really shrinks).
forget_old_crashes() {
  local t kept=()
  for t in ${CRASHES[@]+"${CRASHES[@]}"}; do
    if (( SECONDS - t < CRASH_WINDOW )); then kept+=("$t"); fi
  done
  CRASHES=(${kept[@]+"${kept[@]}"})
}

# Wait until a service exits. (Polling instead of `wait -n`, which the bash 3.2 that ships with macOS does not
# have.) The website stopping stops everything; the worker stopping is reported and, unless restarting cannot
# help, the worker is started again.
while :; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    status=0
    wait "$WEB_PID" || status=$?
    printf '\nThe website stopped (exit status %s), so the worker is being stopped too.\n' "$status"
    exit "$status"
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    status=0
    wait "$WORKER_PID" || status=$?
    (( STOPPING )) && exit 0
    if (( status == EXIT_CONFIG )); then
      printf '\nThe background worker could not start because of a setting (the [worker] lines above say which).\n'
      printf 'Fix it (usually in .env), then run bash scripts/dev.sh again. Stopping the website too.\n'
      exit "$status"
    fi
    CRASHES+=("$SECONDS")
    forget_old_crashes
    count=${#CRASHES[@]}
    if (( count >= MAX_CRASHES )); then
      printf '\nThe background worker stopped %s times in the last %s minutes, so it is not being restarted again.\n' "$count" "$((CRASH_WINDOW / 60))"
      printf 'Stopping the website too. The [worker] lines above show why it stopped.\n'
      exit 1
    fi
    delay=$((2 ** count))
    (( delay > 30 )) && delay=30
    printf '\nThe background worker stopped unexpectedly (exit status %s). Clips and edits wait while it is stopped.\n' "$status"
    printf 'Starting it again in %s seconds; waiting work carries on by itself once it is back.\n' "$delay"
    sleep "$delay"
    start_worker
  fi
  sleep 1
done
