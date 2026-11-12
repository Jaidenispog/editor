#!/usr/bin/env bash
# Generates clearly-labelled SYNTHETIC test footage (no real haircut video) for development and tests.
# Usage: scripts/make-sample-footage.sh [out_dir]
set -euo pipefail
OUT="${1:-./data/samples}"
mkdir -p "$OUT"
FONT="${SAMPLE_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"
label() { # $1 text
  echo "drawtext=fontfile=$FONT:text='$1':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=20"
}
# 1. Portrait H.264 1080x1920 with stereo audio tone (like an iPhone MP4), 12 s, moving pattern
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1080x1920:rate=30:duration=12" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=12" \
  -vf "$(label 'SAMPLE A  portrait  SDR')" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$OUT/sample_a_portrait_sdr.mp4"
# 2. Landscape 1920x1080 HEVC 10-bit HLG HDR, then remuxed with an iPhone-style display-matrix rotation (-90 = rotate
#    90 degrees clockwise for display) so the clip must be auto-rotated to portrait, 10 s, mono audio
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=1920x1080:rate=30:duration=10" \
  -f lavfi -i "anoisesrc=color=pink:sample_rate=48000:duration=10:amplitude=0.1" \
  -vf "$(label 'SAMPLE B  rotated  HEVC HLG')" -c:v libx265 -preset ultrafast -crf 24 -pix_fmt yuv420p10le \
  -x265-params "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited" \
  -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -tag:v hvc1 \
  -c:a aac -ac 1 -b:a 96k -shortest "$OUT/.sample_b_landscape.mov"
ffmpeg -hide_banner -loglevel error -y -display_rotation -90 -i "$OUT/.sample_b_landscape.mov" -c copy -map 0 "$OUT/sample_b_rotated_hevc_hlg.mov"
rm -f "$OUT/.sample_b_landscape.mov"
# 3. Short portrait clip WITHOUT audio, with two obvious scene changes (colour bars -> smpte -> gradient), 6 s
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x224466:size=1080x1920:rate=30:duration=2" \
  -f lavfi -i "smptebars=size=1080x1920:rate=30:duration=2" \
  -f lavfi -i "gradients=size=1080x1920:rate=30:duration=2:speed=0.5" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,$(label 'SAMPLE C  no audio  3 scenes')[v]" -map "[v]" \
  -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p "$OUT/sample_c_noaudio_scenes.mp4"
# 4. Very short clip (1.2 s) to exercise "incomplete footage" handling
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1080x1920:rate=30:duration=1.2" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=1.2" \
  -vf "$(label 'SAMPLE D  1.2s')" -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -c:a aac -shortest "$OUT/sample_d_tiny.mp4"
# 5. A 40 s click track at 120 BPM (beat every 0.5 s) with a bass pad, so beat detection can be verified
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=1000:beep_factor=4:sample_rate=44100:duration=40" \
  -f lavfi -i "sine=frequency=110:sample_rate=44100:duration=40" \
  -filter_complex "[0:a]volume=0.9,apulsator=hz=2:mode=square:amount=1[c];[1:a]volume=0.2[b];[c][b]amix=inputs=2:normalize=0[a]" -map "[a]" \
  -c:a libmp3lame -q:a 4 "$OUT/sample_music_120bpm.mp3" 2>/dev/null || \
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=1000:beep_factor=4:sample_rate=44100:duration=40" -c:a aac -b:a 128k "$OUT/sample_music_120bpm.m4a"
echo "Synthetic samples written to $OUT:"; ls -la "$OUT"
