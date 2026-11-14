#!/usr/bin/env bash
# Checks that the tools Studio Assistant needs are installed, and says how to fix anything missing.
#
#   bash scripts/check-tools.sh            # everything for local development (Node, pnpm, FFmpeg, psql)
#   bash scripts/check-tools.sh --worker   # only what the worker needs at run time (Node, FFmpeg); used in Dockerfile.worker
#   bash scripts/check-tools.sh --quiet    # print problems only
#
# Exit status: 0 when every required tool is present, 1 otherwise. Missing optional tools only print a warning.
# FFMPEG_PATH and FFPROBE_PATH are honoured, like in the app.
set -uo pipefail

MODE="dev"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --worker) MODE="worker" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12
MIN_PNPM_MAJOR=10
MIN_FFMPEG_MAJOR=6
FFMPEG="${FFMPEG_PATH:-ffmpeg}"
FFPROBE="${FFPROBE_PATH:-ffprobe}"

errors=0
warnings=0

ok() { (( QUIET )) || printf '  ok    %s\n' "$*"; }
bad() { printf '  MISSING  %s\n' "$1"; printf '           -> %s\n' "$2"; errors=$((errors + 1)); }
warn() { printf '  warning  %s\n' "$1"; printf '           -> %s\n' "$2"; warnings=$((warnings + 1)); }

os_hint() {
  # $1 = Debian/Ubuntu install command, $2 = macOS (Homebrew) install command
  if [[ "$(uname -s)" == "Darwin" ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    bad "Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer" "Install Node $MIN_NODE_MAJOR LTS from https://nodejs.org or with a version manager (fnm/nvm: 'fnm use' reads .nvmrc)."
    return
  fi
  local version major minor
  version="$(node --version 2>/dev/null)"
  version="${version#v}"
  major="${version%%.*}"
  minor="${version#*.}"; minor="${minor%%.*}"
  if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ ]]; then
    bad "Node.js (could not read the version: '$version')" "Reinstall Node $MIN_NODE_MAJOR LTS."
  elif (( major < MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor < MIN_NODE_MINOR) )); then
    bad "Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer (found $version)" "Upgrade to Node $MIN_NODE_MAJOR LTS (fnm install 22 / nvm install 22)."
  else
    ok "Node.js $version"
  fi
}

check_pnpm() {
  if ! command -v pnpm >/dev/null 2>&1; then
    bad "pnpm $MIN_PNPM_MAJOR" "Run 'corepack enable' (ships with Node) in this folder; it picks up pnpm 10.28.0 from package.json."
    return
  fi
  local version major
  version="$(pnpm --version 2>/dev/null)"
  major="${version%%.*}"
  if [[ ! "$major" =~ ^[0-9]+$ ]] || (( major < MIN_PNPM_MAJOR )); then
    bad "pnpm $MIN_PNPM_MAJOR or newer (found '$version')" "Run 'corepack enable' so the version pinned in package.json (pnpm@10.28.0) is used."
  else
    ok "pnpm $version"
  fi
}

check_ffmpeg() {
  if ! command -v "$FFMPEG" >/dev/null 2>&1; then
    bad "FFmpeg $MIN_FFMPEG_MAJOR or newer ($FFMPEG)" "$(os_hint 'sudo apt-get install ffmpeg (Ubuntu 24.04 / Debian 13 ship 6.1 / 7.1)' 'brew install ffmpeg') or set FFMPEG_PATH."
    return
  fi
  local first version major
  first="$("$FFMPEG" -hide_banner -version 2>/dev/null | head -n 1)"
  version="$(awk '{print $3}' <<<"$first")"
  version="${version#n}"
  major="${version%%.*}"
  if [[ "$major" =~ ^[0-9]+$ ]]; then
    if (( major < MIN_FFMPEG_MAJOR )); then
      bad "FFmpeg $MIN_FFMPEG_MAJOR or newer (found $version)" "Older distributions (e.g. Debian 12) ship FFmpeg 5. Use Ubuntu 24.04, Debian 13, Homebrew, or a static build, and point FFMPEG_PATH/FFPROBE_PATH at it."
    else
      ok "FFmpeg $version"
    fi
  else
    # Git builds report e.g. "N-112345-g…"; accept them but say we could not confirm the version.
    warn "FFmpeg version could not be read ('$first')" "Make sure it is FFmpeg $MIN_FFMPEG_MAJOR or newer."
  fi

  local encoders filters decoders
  encoders="$("$FFMPEG" -hide_banner -encoders 2>/dev/null)"
  filters="$("$FFMPEG" -hide_banner -filters 2>/dev/null)"
  decoders="$("$FFMPEG" -hide_banner -decoders 2>/dev/null)"

  local name
  for name in libx264 aac mjpeg; do
    if grep -Eq "^ [A-Z.]{6} $name " <<<"$encoders"; then ok "encoder $name"
    else bad "FFmpeg encoder '$name'" "Install an FFmpeg build with $name (the Ubuntu/Debian/Homebrew packages include it)."; fi
  done
  for name in hevc h264; do
    if grep -Eq "^ [A-Z.]{6} $name " <<<"$decoders"; then ok "decoder $name"
    else bad "FFmpeg decoder '$name'" "iPhone clips are HEVC; install a full FFmpeg build."; fi
  done
  # Filters used by packages/media: libass text (ass), HDR tone-mapping (zscale + tonemap), transitions (xfade),
  # scene detection (scdet), loudness (loudnorm, ebur128), silence detection, zoom-in punch (zoompan).
  for name in ass zscale tonemap xfade scdet loudnorm ebur128 silencedetect zoompan amix atempo afade; do
    if grep -Eq "^ [A-Z.]{2,3} $name " <<<"$filters"; then ok "filter $name"
    else
      case "$name" in
        ass) bad "FFmpeg filter 'ass' (libass, used for on-video text)" "Install an FFmpeg build with --enable-libass (the Ubuntu/Debian/Homebrew packages include it)." ;;
        zscale) bad "FFmpeg filter 'zscale' (libzimg, used to convert iPhone HDR to SDR)" "Install an FFmpeg build with --enable-libzimg (Ubuntu/Debian packages and 'brew install ffmpeg' include it)." ;;
        *) bad "FFmpeg filter '$name'" "Install FFmpeg $MIN_FFMPEG_MAJOR or newer from your package manager." ;;
      esac
    fi
  done

  if command -v "$FFPROBE" >/dev/null 2>&1; then ok "ffprobe"
  else bad "ffprobe ($FFPROBE)" "It ships with FFmpeg; reinstall FFmpeg or set FFPROBE_PATH."; fi
}

check_psql() {
  if command -v psql >/dev/null 2>&1; then
    ok "psql $(psql --version | awk '{print $3}')"
  else
    warn "psql (PostgreSQL client)" "Needed for scripts/local-postgres.sh and backups: $(os_hint 'sudo apt-get install postgresql-16 (server) or postgresql-client-16' 'brew install postgresql@16'). Not needed if you only use Docker Compose or Supabase."
  fi
  local found=0 dir
  if command -v initdb >/dev/null 2>&1; then found=1; fi
  for dir in /usr/lib/postgresql/{19,18,17,16}/bin /opt/homebrew/opt/postgresql@{19,18,17,16}/bin /usr/local/opt/postgresql@{19,18,17,16}/bin; do
    [[ -x "$dir/initdb" ]] && found=1
  done
  if (( found )); then ok "PostgreSQL server binaries (for scripts/local-postgres.sh)"
  else warn "PostgreSQL 16 server" "Only needed for a local database without Docker: $(os_hint 'sudo apt-get install postgresql-16' 'brew install postgresql@16')."; fi
}

check_fonts() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if ls "$root"/assets/fonts/Inter-*.otf >/dev/null 2>&1; then ok "video fonts in assets/fonts"
  else bad "Inter fonts in assets/fonts" "They are part of the repository; restore them with 'git checkout -- assets/fonts'."; fi
}

(( QUIET )) || printf 'Checking tools (%s)\n' "$MODE"
check_node
if [[ "$MODE" == "dev" ]]; then
  check_pnpm
fi
check_ffmpeg
check_fonts
if [[ "$MODE" == "dev" ]]; then
  check_psql
fi

if (( errors > 0 )); then
  printf '\n%d required tool(s) missing or too old. Fix the items marked MISSING and run this again.\n' "$errors"
  exit 1
fi
if (( QUIET == 0 )); then
  if (( warnings > 0 )); then printf '\nAll required tools found (%d optional warning(s) above).\n' "$warnings"
  else printf '\nAll tools found.\n'; fi
fi
exit 0
