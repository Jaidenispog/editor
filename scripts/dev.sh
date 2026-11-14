#!/usr/bin/env bash
# Runs Studio Assistant for local development: the web app and the background worker together, with each line
# of output prefixed [web] or [worker]. Ctrl+C stops both; if either one exits, the other is stopped too.
#
#   bash scripts/dev.sh             # check tools, then start web (http://localhost:3000) and worker in watch mode
#   bash scripts/dev.sh migrate     # apply database migrations using DATABASE_URL from the root .env
#   bash scripts/dev.sh --no-check  # skip the tool check
#
# Settings come from the .env at the repository root (copy .env.example to start). Every line of it is exported
# to both processes. The website listens on 127.0.0.1 only, unless WEB_HOST (e.g. 0.0.0.0) is set in .env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMMAND="run"
CHECK=1
for arg in "$@"; do
  case "$arg" in
    migrate) COMMAND="migrate" ;;
    --no-check) CHECK=0 ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  local pid
  # ${PIDS[@]+...}: an empty array under set -u is an error on bash before 4.4 (macOS ships bash 3.2).
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    # Each service runs in its own process group (set -m below), so signal the whole group.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  # The worker may need a while to let a running job finish or record its state (it gives up after 45 s).
  local waited=0
  while (( waited < 250 )); do
    local alive=0
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -0 "$pid" 2>/dev/null && alive=1; done
    (( alive )) || break
    sleep 0.2
    waited=$((waited + 1))
  done
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -KILL -- "-$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'printf "\nStopping web and worker...\n"; cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

set -m
( pnpm --filter @studio/web dev 2>&1 | prefix "$WEB_TAG" ) &
PIDS+=("$!")
( pnpm --filter @studio/worker dev 2>&1 | prefix "$WORKER_TAG" ) &
PIDS+=("$!")
set +m

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

# Wait until either service exits, then stop the other. (Polling instead of `wait -n`, which the bash 3.2
# that ships with macOS does not have.)
status=0
while :; do
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      wait "${PIDS[$i]}" || status=$?
      name="web"; (( i == 1 )) && name="worker"
      printf '\nThe %s process stopped (exit status %s); stopping the other one.\n' "$name" "$status"
      exit "$status"
    fi
  done
  sleep 1
done
