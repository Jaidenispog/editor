#!/usr/bin/env bash
# Local PostgreSQL 16 for development, without Docker.
#
#   bash scripts/local-postgres.sh start    # initialise (first time) and start; creates the studio_assistant database
#   bash scripts/local-postgres.sh status   # is it running? prints the connection strings
#   bash scripts/local-postgres.sh stop     # stop the server (data is kept)
#   bash scripts/local-postgres.sh reset    # stop, DELETE all local data, initialise and start again (asks first)
#   bash scripts/local-postgres.sh url      # print DATABASE_URL and TEST_DATABASE_URL only
#
# Data lives in ./.pg/data at the repository root (gitignored). The server listens on 127.0.0.1 only, with
# password-less "trust" authentication for the local "postgres" role: fine for a development machine, never for
# a server that other people can reach.
#
# Settings (environment variables):
#   LOCAL_PG_PORT   port to listen on (default 5433, so it does not clash with a system Postgres on 5432)
#   LOCAL_PG_DB     database to create (default studio_assistant)
#   LOCAL_PG_DIR    folder for data, socket and log (default <repo>/.pg)
#   PG_BIN          folder holding initdb/pg_ctl/postgres (found automatically when not set)
#
# When run as root (as in some containers), initdb and pg_ctl must run as the "postgres" operating-system user,
# because PostgreSQL refuses to run as root. The script does that automatically and makes the data folder
# belong to "postgres". Otherwise everything runs as the current user.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${LOCAL_PG_PORT:-5433}"
DB_NAME="${LOCAL_PG_DB:-studio_assistant}"
PG_DIR="${LOCAL_PG_DIR:-$REPO_ROOT/.pg}"
DATA_DIR="$PG_DIR/data"
RUN_DIR="$PG_DIR/run"
LOG_FILE="$PG_DIR/postgres.log"
MIN_MAJOR=16

say() { printf '%s\n' "$*"; }
fail() { printf 'local-postgres: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# Finds the PostgreSQL server binaries: $PG_BIN, then PATH, then the usual Debian/Ubuntu, Homebrew and
# Postgres.app locations (newest version first).
find_pg_bin() {
  if [[ -n "${PG_BIN:-}" ]]; then
    [[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" ]] || fail "PG_BIN=$PG_BIN does not contain initdb and pg_ctl."
    printf '%s\n' "$PG_BIN"
    return
  fi
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return
  fi
  local candidate
  for candidate in \
    /usr/lib/postgresql/{19,18,17,16}/bin \
    /usr/pgsql-{19,18,17,16}/bin \
    /opt/homebrew/opt/postgresql@{19,18,17,16}/bin \
    /usr/local/opt/postgresql@{19,18,17,16}/bin \
    /Applications/Postgres.app/Contents/Versions/latest/bin; do
    if [[ -x "$candidate/initdb" && -x "$candidate/pg_ctl" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  fail "PostgreSQL $MIN_MAJOR or newer was not found. Install it (Ubuntu/Debian: sudo apt-get install postgresql-16; macOS: brew install postgresql@16) or set PG_BIN to the folder that holds initdb and pg_ctl."
}

BIN="$(find_pg_bin)"

check_version() {
  local version major
  version="$("$BIN/initdb" --version | awk '{print $NF}')"
  major="${version%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || fail "Could not read the PostgreSQL version from: $("$BIN/initdb" --version)"
  (( major >= MIN_MAJOR )) || fail "PostgreSQL $version found in $BIN, but version $MIN_MAJOR or newer is required."
}

IS_ROOT=0
[[ "$(id -u)" -eq 0 ]] && IS_ROOT=1

# Runs a command as the database owner: the "postgres" OS user when we are root, otherwise the current user.
as_db_user() {
  if (( IS_ROOT )); then
    id postgres >/dev/null 2>&1 || fail "Running as root, but there is no \"postgres\" operating-system user to run the server as. Create one (useradd --system postgres) or run this script as a normal user."
    local quoted
    printf -v quoted '%q ' "$@"
    su postgres -s /bin/sh -c "$quoted"
  else
    "$@"
  fi
}

prepare_dirs() {
  mkdir -p "$PG_DIR" "$RUN_DIR"
  if (( IS_ROOT )); then
    chown postgres:postgres "$PG_DIR" "$RUN_DIR"
    [[ -d "$DATA_DIR" ]] && chown -R postgres:postgres "$DATA_DIR"
    touch "$LOG_FILE" && chown postgres:postgres "$LOG_FILE"
    # Every parent folder must be searchable by "postgres", or initdb fails with a bare "permission denied".
    as_db_user test -x "$PG_DIR" -a -w "$PG_DIR" \
      || fail "The \"postgres\" user cannot reach $PG_DIR because one of its parent folders is private. Make the parents readable (chmod o+x <folder>) or choose another place, e.g. LOCAL_PG_DIR=/var/tmp/studio-pg bash scripts/local-postgres.sh start"
  fi
  chmod 700 "$RUN_DIR"
}

is_initialised() { [[ -f "$DATA_DIR/PG_VERSION" ]]; }

is_running() {
  is_initialised || return 1
  as_db_user "$BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1
}

psql_bin() {
  if [[ -x "$BIN/psql" ]]; then printf '%s\n' "$BIN/psql"
  elif command -v psql >/dev/null 2>&1; then command -v psql
  else fail "psql was not found next to the server binaries or on PATH; install the PostgreSQL client tools."
  fi
}

print_urls() {
  say "DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/$DB_NAME"
  say "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/postgres"
}

init_cluster() {
  check_version
  say "Initialising a new database cluster in $DATA_DIR ..."
  mkdir -p "$DATA_DIR"
  (( IS_ROOT )) && chown postgres:postgres "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  as_db_user "$BIN/initdb" -D "$DATA_DIR" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >/dev/null 2>&1 \
    || as_db_user "$BIN/initdb" -D "$DATA_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null \
    || fail "initdb failed. See the messages above."
}

wait_until_ready() {
  local i
  for i in $(seq 1 30); do
    if "$(psql_bin)" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -Atqc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "The server did not accept connections on 127.0.0.1:$PORT within 30 seconds. Last log lines:
$(tail -n 20 "$LOG_FILE" 2>/dev/null)"
}

ensure_database() {
  local psql exists
  psql="$(psql_bin)"
  exists="$("$psql" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -Atqc "select 1 from pg_database where datname = '$DB_NAME'")"
  if [[ "$exists" != "1" ]]; then
    "$psql" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -qc "create database \"$DB_NAME\"" \
      || fail "Could not create the database $DB_NAME."
    say "Created database $DB_NAME."
  fi
}

port_in_use() {
  if command -v pg_isready >/dev/null 2>&1 || [[ -x "$BIN/pg_isready" ]]; then
    local isready="$BIN/pg_isready"
    [[ -x "$isready" ]] || isready="$(command -v pg_isready)"
    "$isready" -h 127.0.0.1 -p "$PORT" -t 2 >/dev/null 2>&1 && return 0
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1
}

cmd_start() {
  prepare_dirs
  if is_running; then
    say "Local PostgreSQL is already running on 127.0.0.1:$PORT."
  else
    if port_in_use; then
      fail "Port $PORT on 127.0.0.1 is already used by another program. Stop it or choose another port, e.g. LOCAL_PG_PORT=5434 bash scripts/local-postgres.sh start"
    fi
    is_initialised || init_cluster
    say "Starting PostgreSQL on 127.0.0.1:$PORT (log: $LOG_FILE) ..."
    as_db_user "$BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" -w -t 30 \
      -o "-p $PORT -k $RUN_DIR -c listen_addresses=127.0.0.1 -c max_connections=100" start >/dev/null \
      || fail "PostgreSQL did not start. Last log lines:
$(tail -n 20 "$LOG_FILE" 2>/dev/null)"
  fi
  wait_until_ready
  ensure_database
  say ""
  say "Ready. Put these in your .env (the second one is only for the test suites):"
  print_urls
}

cmd_stop() {
  if ! is_initialised; then
    say "Nothing to stop: no local cluster in $DATA_DIR."
    return 0
  fi
  if ! is_running; then
    say "Local PostgreSQL is not running."
    return 0
  fi
  as_db_user "$BIN/pg_ctl" -D "$DATA_DIR" -m fast -w -t 60 stop >/dev/null || fail "pg_ctl stop failed; see $LOG_FILE."
  say "Stopped local PostgreSQL (data kept in $DATA_DIR)."
}

cmd_status() {
  if ! is_initialised; then
    say "Not initialised: run 'bash scripts/local-postgres.sh start' to create $DATA_DIR."
    return 3
  fi
  if is_running; then
    say "Running on 127.0.0.1:$PORT (data: $DATA_DIR)."
    print_urls
    return 0
  fi
  say "Stopped (data: $DATA_DIR). Run 'bash scripts/local-postgres.sh start'."
  return 3
}

cmd_reset() {
  local assume_yes="${1:-}"
  if [[ "$assume_yes" != "--yes" && "$assume_yes" != "-y" ]]; then
    if [[ -t 0 ]]; then
      printf 'This permanently deletes every local database in %s. Type "reset" to continue: ' "$DATA_DIR"
      local answer
      read -r answer
      [[ "$answer" == "reset" ]] || { say "Cancelled; nothing was deleted."; return 1; }
    else
      fail "reset deletes all local data. Run it in a terminal to confirm, or pass --yes."
    fi
  fi
  cmd_stop
  rm -rf "$DATA_DIR"
  say "Deleted $DATA_DIR."
  cmd_start
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  reset) shift; cmd_reset "${1:-}" ;;
  url) print_urls ;;
  -h|--help|help|"") usage; [[ -n "${1:-}" ]] || exit 2 ;;
  *) printf 'Unknown command: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
esac
