# @studio/media

FFmpeg/ffprobe wrappers, footage analysis and the plan → filtergraph renderer used by the worker.

## Renderer

`renderEditPlan(inputs, outputPath)` turns a validated `EditPlan` into a vertical MP4 from the real
footage. Everything is one FFmpeg process; the command is built by the pure `buildRenderCommand`
so it can be unit-tested and printed.

Flow:

1. `validateEditPlan` runs again against the probes handed in (clip lengths, audio presence, music
   length, transcript for captions). A plan that fails throws `AppError('VALIDATION')` with the
   issues in `details` and FFmpeg never starts. An edit longer than `MAX_RENDER_DURATION_SEC`
   (180 s) is refused the same way (`assertRenderableDuration`; `buildRenderCommand` checks too).
2. If the plan has text (overlays, captions or the brand handle), `layoutAssDocument` /
   `buildAssDocument` writes an ASS file into `tmpDir`. Styles: `Headline` (headline font, ~5.2% of
   the height), `Subtitle`, `Label` (upper-case, letter-spaced), `Caption` and `Handle`, each with
   an `Accent` variant in the brand colour. `videoTextStyle` picks the treatment: `bold` is larger
   and heavier, `editorial` lighter with more tracking, `minimal` the defaults. Placement follows the
   safe zone below.
3. `buildRenderCommand` produces the graph below and `runFfmpeg` executes it with progress
   (`outTimeSec / total`). A cancelled render (`AbortSignal`) rethrows `CancelledError`; an FFmpeg
   failure becomes `AppError('PROCESSING_FAILED')`. In both cases the partial file is removed.
4. Exports only: `verifyExport` runs ffprobe on the file and checks it against the export preset
   (H.264 High at the expected level, yuv420p, progressive, constant frame rate, the output size,
   BT.709 tags, AAC-LC 48 kHz stereo when the edit has sound and no audio stream when it has none,
   container and video durations within one frame of the timeline). A mismatch deletes the file and
   throws `AppError('PROCESSING_FAILED')` with a plain message and the list of problems in
   `details.problems`. `checkExportProbe` is the same check on an ffprobe report, without FFmpeg.
5. The output is probed and returned (`durationSec`, `byteSize`, `probe`, `ffmpegArgs`, `assPath`,
   `exportCheck`).

### Safe zone and text layout

The model lives in `@studio/core` (`safe-zones.ts`, origin top-left, half-open rectangles) and is
the conservative union of Meta's Reels guidance and TikTok's in-feed template
(`docs/research/platform-constraints.md` section 5). At 1080x1920:

| Region | Area | Used for |
| --- | --- | --- |
| `strict` (R_strict) | x 120–780, y 270–1248 | default for all text |
| `head` (R_head) | x 120–960, y 270–840 | boxes whose bottom edge is at y ≤ 840 |
| `subtitle` | centred on x 540, ≤ 480 px wide, bottom ≤ 1248, type ≥ 56 px (em) | captions |
| forbidden | y < 270, y ≥ 1248, x < 120, x ≥ 960, and x ≥ 780 where y ≥ 840 | nothing, ever |

`safeZoneFor(width, height)` scales it (540x960 previews halve every number exactly); allowed
regions round inwards and forbidden areas outwards. Helpers: `regionForBox`, `isTextBoxSafe`,
`isSubtitleBoxSafe`, `forbiddenAreasTouched`, `rectContains`, `rectsIntersect`.

`layoutAssDocument` places text as follows:

- `top` overlays use R_head (centred on it) when the whole box, rise included, ends above y 840;
  otherwise R_strict.
- `centre` and `lower` overlays and the end-of-video brand handle use R_strict, centred on it. A
  lower overlay that shares its time with a caption sits above the caption box.
- Captions are centred on x 540, wrapped to the 480 px width (240 px in previews), at least 56 px
  type (em size; `\fs` is larger because libass sizes by the font's Windows ascent + descent), two
  lines preferred and more only when the text cannot fit otherwise.

Text is wrapped by the layout itself (explicit `\N`, `WrapStyle: 2`) using conservative glyph
widths: `text-metrics-data.ts` holds, per family and character, the widest advance over every
weight the styles can request, read from the real font files (regenerate with
`STUDIO_WRITE_TEXT_METRICS=1 pnpm --filter @studio/media exec vitest run test/text-metrics.test.ts`;
the same test fails if the table drifts from the fonts). Each box adds the outline, shadow, the
`pop` scale (108%), the `rise` travel (40 px at 1920 tall) and `CODEC_GUARD_PX` (12 px, so H.264
ringing at text edges also stays inside). The type shrinks (to 45% for overlays, never below the
caption minimum) until the box fits; a word too long even then is split between characters, and
text that still cannot fit throws `AppError('VALIDATION')`. `layoutAssDocument` returns the boxes
it used (`AssLayout.boxes`) so tests can check them.

`test/render.test.ts` proves it two ways: libass alone over flat grey, every frame of an edit with
every animation at both sizes, must draw nothing in a forbidden area and nothing outside the
returned boxes; and a real preview compared with the same edit without text must show no changed
pixels in any forbidden area (threshold 64 grey levels, above encoder noise) and changes inside
the top, centre, lower and caption boxes.

### Encoder preset

| | Preview (540x960) | Export (1080x1920) |
| --- | --- | --- |
| Video | libx264 veryfast, CRF 27, High | libx264 slow, CRF 18, High, level 4.1 (≤ 30 fps) or 4.2 (60 fps), `-maxrate 20M -bufsize 40M` (24M/48M at 60 fps, 12M/24M over 90 s) |
| Both | yuv420p, progressive, `-r F -fps_mode cfr`, closed 2 s GOP (`-g 2F -keyint_min 2F -sc_threshold 0 -flags +cgop`), `-bf 2`, BT.709 primaries/transfer/matrix, TV range | |
| Audio | AAC-LC 192 kbit/s, 48 kHz, stereo (or `-an` when nothing makes a sound) | same |
| Container | MP4, `-movflags +faststart` | same, then `verifyExport` |

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
-c:v libx264 (preview: veryfast/crf 27; export: slow/crf 18/maxrate/level 4.1 or 4.2) -pix_fmt yuv420p
      -field_order progressive -r F -fps_mode cfr -g 2F -keyint_min 2F -sc_threshold 0 -flags +cgop
      -bf 2 bt709 tags -color_range tv
-c:a aac -profile:a aac_low 192k 48 kHz stereo -movflags +faststart -t <total>
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
