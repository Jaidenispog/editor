#!/usr/bin/env bash
# Generates clearly-labelled SYNTHETIC test footage (no real haircut video) for development and tests.
#
#   bash scripts/make-sample-footage.sh [--force] [out_dir]        (out_dir defaults to ./data/samples)
#
# A folder is complete when it holds every sample and the marker .samples-complete, which is written last and records
# each file's size. A complete folder is left as it is unless --force is given. Safe to run many times at once
# (parallel test files, checkouts sharing one data/ folder): a lock directory in out_dir lets one run generate while
# the others wait and then find the footage complete. The lock records its owner (pid, computer, start time); a lock
# whose owner has exited, or that is older than SAMPLES_LOCK_STALE_SECONDS (default 600), is taken over. Each run
# writes into its own temporary folder inside the lock and moves every finished file into place, so a file in out_dir
# is never half-written. Works with macOS's bash 3.2; needs no flock.
set -euo pipefail

FORCE=0
case "${1:-}" in
  --force) FORCE=1; shift ;;
  -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  -*) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
OUT="${1:-./data/samples}"

SAMPLE_FILES=(sample_a_portrait_sdr.mp4 sample_b_rotated_hevc_hlg.mov sample_c_noaudio_scenes.mp4 sample_d_tiny.mp4 sample_music_120bpm.mp3)
# Bump the version whenever the footage changes, so folders completed by an older version are regenerated.
# packages/media/test/sample-footage.ts reads the same marker and must expect the same version line.
MARKER_HEADER='studio-assistant synthetic samples v1'
MARKER="$OUT/.samples-complete"
LOCK="$OUT/.generating.lock"
STALE_AFTER="${SAMPLES_LOCK_STALE_SECONDS:-600}"
case "$STALE_AFTER" in ''|0*|*[!0-9]*) printf 'SAMPLES_LOCK_STALE_SECONDS must be a whole number of seconds\n' >&2; exit 2 ;; esac
HOST="$(uname -n)"

HAVE_LOCK=0     # 1 once this run created the lock
OWNER_LINE=''   # what this run wrote as the lock's owner: "pid computer start-epoch"
OWNER_SEEN=''   # the owner line of another run's lock, as last read
STALE_REASON='' # why that lock may be taken over
MKDIR_ERROR=''  # why the lock could not be created
WORK=''         # this run's temporary folder (inside the lock)
CHILD=''        # the ffmpeg process running now

say() { printf 'make-sample-footage: %s\n' "$*" >&2; }

# Prints the marker for the samples in folder $1: the version line, then "name size" per sample.
# Fails when a sample is missing or empty.
marker_for() {
  local f size
  printf '%s\n' "$MARKER_HEADER"
  for f in "${SAMPLE_FILES[@]}"; do
    [ -f "$1/$f" ] && [ -s "$1/$f" ] || return 1
    size="$(wc -c < "$1/$f")" || return 1
    printf '%s %s\n' "$f" "$((size))"
  done
}

# True when out_dir holds every sample with the size its marker recorded (the marker is written last).
is_complete() {
  local want
  [ -f "$MARKER" ] || return 1
  want="$(marker_for "$OUT")" || return 1
  [ "$(cat "$MARKER" 2>/dev/null)" = "$want" ]
}

# Tries to create the lock. 0: it is ours; 1: another run holds it; 2: it cannot be created (MKDIR_ERROR says why).
# Only "it already exists" means held: any other mkdir failure is an error, not a reason to wait.
try_lock() {
  if MKDIR_ERROR="$(mkdir "$LOCK" 2>&1)"; then
    HAVE_LOCK=1
    OWNER_LINE="$$ $HOST $(date +%s)"
    # Written beside the lock's final name and renamed, so a waiter never reads half a line.
    if printf '%s\n' "$OWNER_LINE" > "$LOCK/owner.$$" && mv -f "$LOCK/owner.$$" "$LOCK/owner"; then return 0; fi
    MKDIR_ERROR="could not record the lock's owner in $LOCK"
    return 2
  fi
  if [ -d "$LOCK" ]; then return 1; fi
  return 2
}

pid_alive() { kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1; }

# True when the lock can be taken over: its owner process has exited (checked on this computer only), or it has been
# held for longer than a generation can take. Sets OWNER_SEEN (the owner line judged) and STALE_REASON.
# A lock without an owner record is still being set up, unless it is more than a minute old.
lock_is_stale() {
  local pid host start rest now age
  OWNER_SEEN="$(cat "$LOCK/owner" 2>/dev/null || true)"
  if [ -z "$OWNER_SEEN" ]; then
    [ -d "$LOCK" ] || return 1
    STALE_REASON='it has no owner record and is more than a minute old'
    [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]
    return
  fi
  read -r pid host start rest <<< "$OWNER_SEEN" || true
  # Plain decimal numbers only (a leading 0 would be read as octal by $((...))).
  case "$pid" in ''|0*|*[!0-9]*) STALE_REASON="its owner record is unreadable ($OWNER_SEEN)"; return 0 ;; esac
  case "$start" in ''|0*|*[!0-9]*) STALE_REASON="its owner record is unreadable ($OWNER_SEEN)"; return 0 ;; esac
  now="$(date +%s)"
  age=$((now - start))
  if [ "$age" -gt "$STALE_AFTER" ] || [ "$age" -lt "$((0 - STALE_AFTER))" ]; then
    STALE_REASON="pid $pid on $host has held it for ${age}s, longer than ${STALE_AFTER}s"
    return 0
  fi
  if [ "$host" = "$HOST" ] && ! pid_alive "$pid"; then
    STALE_REASON="pid $pid on $host is no longer running"
    return 0
  fi
  STALE_REASON=''
  return 1
}

describe_owner() {
  local pid host start rest
  if [ -z "$OWNER_SEEN" ]; then printf 'just starting'; return 0; fi
  read -r pid host start rest <<< "$OWNER_SEEN" || true
  printf 'pid %s on %s, started %ss ago' "$pid" "$host" "$(( $(date +%s) - start ))"
}

# Removes a stale lock, but only if it still has the owner that was judged stale (another waiter may have replaced it).
break_lock() {
  if [ "$(cat "$LOCK/owner" 2>/dev/null || true)" != "$OWNER_SEEN" ]; then return 0; fi
  say "taking over a stale lock in $OUT: $STALE_REASON"
  rm -rf "$LOCK"
}

acquire_lock() {
  local status errors=0 announced=0
  while :; do
    status=0
    try_lock || status=$?
    case "$status" in
      0) return 0 ;;
      2)
        # mkdir failed and there is no lock: a real error, unless the holder released it at that very moment.
        errors=$((errors + 1))
        if [ "$errors" -ge 3 ]; then say "cannot create the lock $LOCK: $MKDIR_ERROR"; exit 1; fi
        continue
        ;;
    esac
    errors=0
    if lock_is_stale; then
      break_lock
      continue
    fi
    if [ "$announced" = 0 ]; then
      say "another run ($(describe_owner)) is generating the samples in $OUT; waiting for it"
      announced=1
    fi
    sleep 1
  done
}

release_lock() {
  local line
  if [ "$HAVE_LOCK" != 1 ]; then return 0; fi
  HAVE_LOCK=0
  line="$(cat "$LOCK/owner" 2>/dev/null || true)"
  # A lock that names another owner was taken over (this run looked stale); it is not ours to remove.
  if [ -z "$line" ] || [ "$line" = "$OWNER_LINE" ]; then rm -rf "$LOCK"; fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ -n "$CHILD" ]; then
    kill "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  release_lock
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Runs a command in the background and waits for it: bash runs a trap only after a foreground command has finished,
# so this lets a signal stop the run at once, and the trap stops the command as well.
run() {
  local status=0
  "$@" &
  CHILD=$!
  wait "$CHILD" || status=$?
  CHILD=''
  return "$status"
}

# DejaVu on Debian/Ubuntu (unchanged output there); elsewhere (macOS) the Inter font that ships with the repository.
DEFAULT_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
[[ -f "$DEFAULT_FONT" ]] || DEFAULT_FONT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/assets/fonts/Inter-Bold.otf"
FONT="${SAMPLE_FONT:-$DEFAULT_FONT}"
label() { # $1 text
  echo "drawtext=fontfile=$FONT:text='$1':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=20"
}

# Writes every sample into folder $1. Every source is deterministic (FFmpeg's gradients and noise sources pick random
# colours, positions and noise unless told otherwise), so every run makes the same footage and test results reproduce.
generate() {
  local w="$1"
  # 1. Portrait H.264 1080x1920 with stereo audio tone (like an iPhone MP4), 12 s, moving pattern
  run ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1080x1920:rate=30:duration=12" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=12" \
    -vf "$(label 'SAMPLE A  portrait  SDR')" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$w/sample_a_portrait_sdr.mp4"
  # 2. Landscape 1920x1080 HEVC 10-bit HLG HDR, then remuxed with an iPhone-style display-matrix rotation (-90 = rotate
  #    90 degrees clockwise for display) so the clip must be auto-rotated to portrait, 10 s, mono audio
  run ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=1920x1080:rate=30:duration=10" \
    -f lavfi -i "anoisesrc=color=pink:sample_rate=48000:duration=10:amplitude=0.1:seed=1" \
    -vf "$(label 'SAMPLE B  rotated  HEVC HLG')" -c:v libx265 -preset ultrafast -crf 24 -pix_fmt yuv420p10le \
    -x265-params "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited" \
    -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -tag:v hvc1 \
    -c:a aac -ac 1 -b:a 96k -shortest "$w/sample_b_landscape.mov"
  run ffmpeg -nostdin -hide_banner -loglevel error -y -display_rotation -90 -i "$w/sample_b_landscape.mov" -c copy -map 0 "$w/sample_b_rotated_hevc_hlg.mov"
  rm -f "$w/sample_b_landscape.mov"
  # 3. Short portrait clip WITHOUT audio, with two obvious scene changes (colour bars -> smpte -> gradient), 6 s.
  #    The gradient is bright green (lime to green, corner to corner): logo.test.ts relies on that ending.
  run ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=0x224466:size=1080x1920:rate=30:duration=2" \
    -f lavfi -i "smptebars=size=1080x1920:rate=30:duration=2" \
    -f lavfi -i "gradients=size=1080x1920:rate=30:duration=2:speed=0.5:c0=0x76ff03:c1=0x00c853:x0=0:y0=0:x1=1079:y1=1919:seed=1" \
    -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,$(label 'SAMPLE C  no audio  3 scenes')[v]" -map "[v]" \
    -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p "$w/sample_c_noaudio_scenes.mp4"
  # 4. Very short clip (1.2 s) to exercise "incomplete footage" handling
  run ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1080x1920:rate=30:duration=1.2" \
    -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=1.2" \
    -vf "$(label 'SAMPLE D  1.2s')" -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -c:a aac -shortest "$w/sample_d_tiny.mp4"
  # 5. A 40 s click track at 120 BPM (beat every 0.5 s) with a bass pad, so beat detection can be verified
  #    (MP3 needs FFmpeg with libmp3lame, as the tests expect this exact file)
  run ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=1000:beep_factor=4:sample_rate=44100:duration=40" \
    -f lavfi -i "sine=frequency=110:sample_rate=44100:duration=40" \
    -filter_complex "[0:a]volume=0.9,apulsator=hz=2:mode=square:amount=1[c];[1:a]volume=0.2[b];[c][b]amix=inputs=2:normalize=0[a]" -map "[a]" \
    -c:a libmp3lame -q:a 4 "$w/sample_music_120bpm.mp3"
}

mkdir -p "$OUT"
if [ "$FORCE" = 0 ] && is_complete; then
  echo "Synthetic samples in $OUT are already complete (pass --force to regenerate)."
  exit 0
fi
acquire_lock
# Another run may have finished the footage while this one waited for the lock.
if [ "$FORCE" = 0 ] && is_complete; then
  echo "Synthetic samples in $OUT are already complete (pass --force to regenerate)."
  exit 0
fi
rm -f "$MARKER"
WORK="$(mktemp -d "$LOCK/work.XXXXXX")"
generate "$WORK"
marker_for "$WORK" > "$WORK/.samples-complete"
for f in "${SAMPLE_FILES[@]}"; do mv -f "$WORK/$f" "$OUT/$f"; done
mv -f "$WORK/.samples-complete" "$MARKER"
echo "Synthetic samples written to $OUT:"
(cd "$OUT" && ls -la "${SAMPLE_FILES[@]}")
