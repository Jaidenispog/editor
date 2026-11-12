# @studio/media

FFmpeg/ffprobe wrappers, footage analysis and the plan → filtergraph renderer used by the worker.

## Renderer

`renderEditPlan(inputs, outputPath)` turns a validated `EditPlan` into a vertical MP4 from the real
footage. Everything is one FFmpeg process; the command is built by the pure `buildRenderCommand`
so it can be unit-tested and printed.

Flow:

1. `validateEditPlan` runs again against the probes handed in (clip lengths, audio presence, music
   length, transcript for captions). A plan that fails throws `AppError('VALIDATION')` with the
   issues in `details` and FFmpeg never starts.
2. If the plan has text (overlays, captions or the brand handle), `buildAssDocument` writes an ASS
   file into `tmpDir`. Styles: `Headline` (headline font, ~5.2% of the height), `Subtitle`,
   `Label` (upper-case, letter-spaced), `Caption` (bottom of the safe area, two lines at most) and
   `Handle`, each with an `Accent` variant in the brand colour. `videoTextStyle` picks the
   treatment: `bold` is larger and heavier, `editorial` lighter with more tracking, `minimal` the
   defaults. Every line is placed with `\an` + `\pos` inside the Reels/TikTok safe zone and
   horizontally centred on the safe area (not the frame), and the style margins equal the safe-zone
   margins so libass wraps long lines inside them.
3. `buildRenderCommand` produces the graph below and `runFfmpeg` executes it with progress
   (`outTimeSec / total`). A cancelled render (`AbortSignal`) rethrows `CancelledError`; an FFmpeg
   failure becomes `AppError('PROCESSING_FAILED')`. In both cases the partial file is removed.
4. The output is probed and returned (`durationSec`, `byteSize`, `probe`, `ffmpegArgs`, `assPath`).

Graph shape (one input per segment, music last):

```
-ss <in> -t <out-in> -i clip.mov            (accurate input seeking, auto-rotation left on)
[k:v] setpts=PTS-STARTPTS, setpts=PTS/speed, fps=F, trim=end_frame=N,
      scale=W:H:force_original_aspect_ratio=increase:force_divisible_by=2, crop=W:H (focus),
      [HDR: zscale linear → tonemap=hable → bt709], format=yuv420p,
      [zoom: zoompan easing from→to over the segment], [eq colour preset],
      setsar=1, settb=1/F                                         → [v_k]
[v_0][v_1] xfade=transition=T:duration=d:offset=<timeline start>   → [x_1]   (or concat for a hard cut)
[x_n] ass=filename=…:fontsdir=…                                     → [vout]
[m:a] atrim=start=offset:end=offset+total, volume, afade in/out, volume=0.25:enable=between(...) ducking
[k:a] asetpts, aformat 48k stereo, atempo stages, afade over transitions, adelay=<start ms>, apad
      amix=normalize=0 → loudnorm=I=<target>:TP=-1.5:LRA=11 → aresample=48000 → [aout]   (or -an)
-c:v libx264 (preview: veryfast/crf 27; export: slow/crf 18/level 4.2) -r F -g 2F -bf 2 bt709 tags
-c:a aac 192k 48 kHz stereo -movflags +faststart -t <total>
```

Timing: every segment chain is quantised to whole frames at a `1/F` timebase and `xfade` offsets
are `computeTimeline`'s start times, so the file length equals the timeline total within a frame.
Zoom uses `zoompan` because FFmpeg's `crop` cannot change its size per frame. Loudness is a single
`loudnorm` pass; a two-pass variant would measure first and feed the `measured_*` values back.

Original sound: a segment's own audio is mixed in when the segment sets `keepOriginalSound` or the
plan sets `audio.originalSound.enabled`, provided the clip has an audio track; music ducks to 25%
under those windows when `duckUnderOriginal` is on.

### Debugging a render

- `RenderResult.ffmpegArgs` (or `buildRenderCommand(...).args`) is the exact argument list; run
  `ffmpeg <args>` by hand to reproduce. `buildRenderCommand(...).filterComplex` is the graph alone,
  and splitting it on `;` gives one chain per line.
- The ASS file stays in `tmpDir` (`RenderResult.assPath`) so text placement can be checked with
  `ffmpeg -i out.mp4 -vf ass=overlay.ass`.
- `AppError('PROCESSING_FAILED').details.stderrTail` carries FFmpeg's last lines.
- Tests under `test/render*.test.ts` render the synthetic samples in `data/samples`
  (regenerate with `scripts/make-sample-footage.sh`).
