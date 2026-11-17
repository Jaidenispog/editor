# Testing Studio Assistant

Automated tests cover most of the system. They run on **synthetic footage**: generated colour bars, test
patterns and tones, built to exercise rotation, HDR, missing audio and scene changes. **Passing them does not
show that the app works on real haircut footage.** Only the owner's real clips can show that. See the
acceptance checklist in section 5.

## 1. Prerequisites

```bash
bash scripts/check-tools.sh          # Node 22.12+, pnpm 10, FFmpeg 6+ with libx264/libass/zscale, psql
pnpm install
bash scripts/local-postgres.sh start # PostgreSQL 16 on 127.0.0.1:5433 (no Docker needed)
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres
```

`TEST_DATABASE_URL` is an **admin** connection. Every database-backed test file creates its own throwaway
database (`sa_test_*`) and drops it afterwards, so it never touches `studio_assistant`. Tests that need a
database are skipped when the variable is not set.

## 2. Unit tests and type checks

```bash
pnpm -r typecheck                    # strict TypeScript across every package and app
pnpm -r --no-bail test               # unit tests (+ DB-backed suites when TEST_DATABASE_URL is set)
pnpm --filter @studio/core test      # one package at a time
```

Last full run (14 Nov 2026, sandbox, `TEST_DATABASE_URL` set): typecheck clean. All 276 tests passed:

| Package | Tests | Covers |
| --- | ---: | --- |
| `packages/config` | 4 | environment validation (Deepgram key check, optional pool sizes) |
| `packages/core` | 35 | EditPlan validation, revision parsing (incl. natural phrasings), style support, manual labels |
| `packages/db` | 3 | token encryption |
| `packages/queue` | 2 | queue durability settings (30 s heartbeat), default pool sizes |
| `packages/storage` | 5 | local store, signed links |
| `packages/ai` | 72 | rules planner (five distinct valid plans), providers, Anthropic adapter with a stubbed client, Deepgram adapter with a fake fetch (caption-sized segments) |
| `packages/media` | 64 | analysis on the synthetic clips, beat detection, ASS text, filtergraph, real renders |
| `apps/worker` | 12 | job tracker: cancel vs interruption, retries, stale-job recovery; queue settings on a real database |
| `apps/web` | 79 | auth, CSRF, HTTP ranges, upload maths, status payload, integration statuses; route handlers against a throwaway database |

## 3. Worker integration test (Stage A pipeline)

```bash
bash scripts/make-sample-footage.sh data/samples      # also generated on demand by the test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres pnpm --filter @studio/worker test:integration
```

Runs the real handlers, FFmpeg and storage against a throwaway database (about 60 s):

- Ingest: the rotated HEVC HLG clip comes out upright and SDR, and the silent clip is accepted.
- Manual tags unlock the styles that need labelled shots.
- Five genuinely different plans are made, and every preview renders.
- Revising one edit to 15 s leaves the other versions untouched.
- The 1080×1920 export uses compatible encoding.
- Interrupted renders abort cleanly, and an export interrupted by a shutdown resumes.
- An owner-uploaded music track is analysed: 120 BPM detected, beat-montage cuts land on beats, and previews
  have a stereo soundtrack.
- Incomplete footage gets an explanation instead of invented shots.

Last run: 12/12 passed. The synthetic samples (`data/samples`, gitignored):

| File | What it tests |
| --- | --- |
| `sample_a_portrait_sdr.mp4` | 1080×1920 H.264 with an audio tone, 12 s |
| `sample_b_rotated_hevc_hlg.mov` | 1920×1080 HEVC 10-bit HLG with a −90° display rotation (shows as portrait), 10 s |
| `sample_c_noaudio_scenes.mp4` | no audio, hard scene changes at 2 s and 4 s, 6 s |
| `sample_d_tiny.mp4` | 1.2 s (too short to use on its own) |
| `sample_music_120bpm.mp3` | 40 s click track, beat every 0.5 s |

## 4. Running the app against local Postgres

```bash
cp .env.example .env                                  # set APP_SECRET (openssl rand -base64 48)
bash scripts/dev.sh migrate                           # applies migrations using DATABASE_URL from .env
bash scripts/dev.sh                                   # web on :3000 and worker, logs prefixed [web] / [worker]
```

Then open http://localhost:3000/setup and create the owner account. Upload the synthetic clips or real ones.
`pnpm db:migrate` on its own does not read the root `.env` (it runs inside `packages/db`). Use
`bash scripts/dev.sh migrate`, or export `DATABASE_URL` first.

To run the worker alone: `pnpm --filter @studio/worker dev` (watch mode) or `pnpm --filter @studio/worker start`.
`dev.sh` runs the worker without watch mode and restarts it when it stops; `bash scripts/dev.sh --watch` uses
watch mode instead (a crash then waits for the next code change, and only the app's notice shows it).
The `start` script uses `exec`, so Ctrl+C or SIGTERM reaches the worker itself.

Useful checks while it runs:

```bash
curl -s http://localhost:3000/api/health                       # {"ok":true,"db":true,"queue":true,"storage":"local"}
psql postgres://postgres@127.0.0.1:5433/studio_assistant -c \
  "select type, status, progress, message from jobs order by created_at desc limit 10"
ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,sample_rate,channels \
  -of compact <downloaded export>.mp4
```

## 5. Stage A acceptance checklist (with the owner's real footage)

Run this on the deployed app, or locally, with **real haircut clips filmed on the owner's phone**: at least
one 4K HEVC (HDR on) clip, one clip filmed sideways, and one with talking. Tick each line only after
seeing it work.

**Core flow**

- [ ] Several real clips upload from the owner's phone and computer, including a file over 1 GB. A page reload
      mid-upload resumes instead of starting again.
- [ ] Each clip shows a thumbnail, duration and "ready" within a few minutes. HDR and rotation badges are correct.
- [ ] **Generate 5 edits** produces five previews that are clearly different: different structure, pace and
      text, not the same cut five times.
- [ ] Revising one edit ("make it 15 seconds", "less text") creates a new version. The other four edits and
      the older versions of this edit are unchanged and can still be switched back to.
- [ ] Regenerate works on one edit without touching the others.
- [ ] **Export full quality** produces an MP4 that downloads, plays on the owner's phone, and imports into
      Instagram and TikTok as 1080×1920.

**Picture and sound**

- [ ] Colour: HDR (iPhone HLG/Dolby Vision) clips look natural in previews and exports. Nothing is washed out,
      grey or over-saturated, and skin tones look right.
- [ ] Orientation: sideways and upside-down clips come out upright. No black bars from a wrong rotation.
- [ ] Crop: the 9:16 crop keeps the haircut and the client's head in frame, with no important detail cut off.
- [ ] Text placement: titles and captions sit inside the safe area, clear of the Instagram/TikTok buttons and
      caption area. Text is readable on a phone, and the spelling and business name are correct.
- [ ] Sound sync: speech and clipper sound line up with the picture, including after speed changes.
      Music cuts land on beats where the style promises it.
- [ ] Captions only show words that were actually said. No invented dialogue, reactions or before shots.

**Honest behaviour**

- [ ] Incomplete footage: with no "before" shot (or no reaction), the styles that need it are disabled or
      explained in plain words. Nothing is invented.
- [ ] A clip without sound, a very short clip and an unsupported file each give a clear, non-technical message.
- [ ] Interrupted job: restart the worker (or the server) during a render. The job shows "will resume
      automatically" within about a minute and finishes without a second click (pg-boss heartbeat 30 s,
      supervisor every 30 s, plus the retry delay). Cancelling a job stops it and says "Cancelled".
- [ ] With no AI key configured, Settings says so and edits still generate (rules planner).
- [ ] Deleting a project removes its clips, previews and exports (the storage folder or bucket prefix is gone).

**Sign-off notes**

Record the phone model, iOS version, camera settings (resolution, frame rate, HDR on or off), clip lengths and
any problems seen. Synthetic-footage results go in the "Verified with synthetic footage" column of the README.
This checklist is the only evidence for "Verified with real footage".

## Music controls and licence passport (Stage B, WP1)

- Unit: `packages/core/test/{music-clearance,audio-patch,music-ranking,spotify-link,revision-music}.test.ts`,
  `packages/ai/test/rules-music-options.test.ts` (beat sync off, reveal on a beat within ±0.25 s, AI prompt fields),
  `apps/web/test/music.test.ts` (status cards, Spotify embed rules, request schemas, Sound panel patch, import guard).
- Database + ffmpeg (`TEST_DATABASE_URL`): `apps/worker/test/music-db.test.ts` (fast-path and re-cut revisions,
  `no_music` export without a music stream, blocked export without retry, one `music_usage` row, no Spotify data in the
  planner input) and `apps/web/test/music-routes.integration.test.ts` (CC BY-NC refused, Meta lock, owner-only
  licence changes, export 409 and the music-free variant, Sound panel routing, Spotify references and the embed switch).
  Both run with `pnpm -r test` when `TEST_DATABASE_URL` is set.
- Only with the owner's real accounts: whether the library plan covers organic posts, website and boosts (written
  confirmation); how the Sound panel feels on real tracks.

## Trends (Stage B, WP3)

No real YouTube call is made by any test (an injected fake `fetch`):

- `packages/core/test/trend-label.test.ts`: exact labels in Melbourne time (both sides of daylight saving), no label
  ever matches `/trending|viral/i` (including typed text that does), stale/review/refresh timing rules.
- `packages/core/test/trend-claims.test.ts`: `TEXT_UNSUPPORTED_CLAIM` for claim text in overlays, plain text accepted.
- `apps/worker/test/trends.test.ts`: the YouTube client's error mapping and parsing; with `TEST_DATABASE_URL`,
  `trends.refresh` for a 200 chart (upsert and removal of missing items), `quotaExceeded`, `keyInvalid` /
  `API_KEY_INVALID`, `accessNotConfigured`, a 503 retried then failed, the daily fan-out, cleanup after 7 days, the
  key never appearing in logs, and no trend text in `buildPlannerInput` (plus a source scan of the worker and
  `packages/ai`).
- `apps/web/test/trends.test.ts` (status builder states, item labels, schemas) and
  `apps/web/test/trends-routes.integration.test.ts` (staff can note and delete only their own notes, only the owner
  adds/refreshes/removes watches, the 6-hour limit, the curated re-sourcing touching only original seed rows).

The first real fetch needs `YOUTUBE_API_KEY` (1 quota unit): Settings → Trends → **Show the chart** is that smoke test.
Record its result and date in `docs/HANDOVER.md`.

## Instagram hashtag watch (Stage B, WP5)

No Meta endpoint is called by any test (an injected fake `fetch` on a test-only Graph base URL):

- `packages/core/test/hashtag-watch.test.ts`: the 7-day count (turned-off hashtags included), the 31st hashtag waiting
  until the oldest query is a week old while a counted one may be read again, hashtag rules, Instagram-only
  permalinks, post titles and labels without popularity words.
- `apps/worker/test/trends-instagram.test.ts`: parsing keeps only the allowed fields (at most 9, Instagram's order);
  the Graph error mapping; with `TEST_DATABASE_URL`, `trends.refresh` for a first read (search, then `top_media`,
  hashtag id stored, upsert and removal of posts no longer listed), codes 190, 10 and 4, an empty search, the
  30-hashtag budget (nothing called when it is used up), two hashtags racing for the last place, a 5xx retried then
  failed, no usable connection, and the token never in a URL, log line, job payload or audit row.
- `apps/web/test/hashtag-watch.test.ts` (status card states, source card data and budget, item label) and
  `apps/web/test/hashtag-routes.integration.test.ts` (owner only, Meta settings and a connected account needed,
  hashtag rules, at most 10 watched, the weekly limit with `nextFreeAt`, turning a counted one back on, the overview
  in Instagram's order, no token in any response).

Only the owner's real account can show whether hashtag search is allowed for a Unified Login system-user
configuration, the permission's exact name, and whether `top_media` counts towards the 30. The first real read is the
owner adding one hashtag they genuinely want to watch (it uses 1 of the 30 weekly places); `ok` and `unavailable` are
both valid outcomes. Record the result and date in `docs/HANDOVER.md`.

## Saved preferences, reference video and brand (Stage B, WP2)

No AI service is called by any test (a fake Anthropic client and a fake text estimator):

- Unit: `packages/core/test/preference-learning.test.ts` (no events, 20 s from three favourites, unfavourite cancels,
  downloads once per version, `resetAt` and the 180-day window, 60-day half-life, favourite + download = 5, style
  order and regenerations, colour only across two styles, thresholds, relative length requests, determinism,
  `effectivePreferences` precedence, the pin-on-upgrade normaliser), `packages/core/test/reference.test.ts` (pacing
  1.0/2.2 s boundaries, colour rules, duration rounding and limits, text density unmeasured, brand snapshot),
  `packages/ai/test/text-estimate.test.ts` (≤ 8 frames with `oversized_image: 'error'`, refusal / max tokens / bad
  answer → not measured, `medium` text → more overlays than `light`, learned values unless pinned),
  `packages/media/test/{look,logo}.test.ts` (signalstats parser; logo rectangles inside R_head at 1080×1920 and 540×960,
  corner `enable` windows, end card skipped on overlap, overlay chain before `ass`, font fallback; with ffmpeg: logo
  pixels only inside the expected rectangles at both sizes, and real preview and export renders that leave every
  forbidden area untouched), `apps/web/test/preferences.test.ts` (patch refusals, auto-pin, field view).
- Database + ffmpeg (`TEST_DATABASE_URL`): `apps/worker/test/preferences-db.test.ts` (reference ingest and measuring:
  profile stored, original/proxy/frames deleted, thumbnail kept, never in footage, style support or planner input,
  retry is a no-op, under-3-second refusal; recompute keeps an owner save made meanwhile and honours a reset made
  meanwhile; the export uses its preview's brand snapshot and logo after the branding changed, and a missing logo
  renders without it) and `apps/web/test/preferences-routes.integration.test.ts` (owner-only routes, CSRF, favourite
  and hide feedback with plan facts and the recompute job, Settings pins and refusals, the learned subtree surviving an
  owner save, reset, reference upload → asset of kind `reference_video` that never becomes a clip, suggestion
  decisions pinning fields).
- Only with the owner's real use: whether learned defaults feel right after a few weeks, logo legibility on the real
  logo, and colour, pacing and text estimates on real reference videos.

### Reference style v2 (transitions, beat sync, music from the owner's videos)

- Synthetic fixtures with known ground truth: `packages/media/test/fixtures/make-reference-fixtures.ts` builds them at
  test time with FFmpeg `lavfi` sources only (540 × 960, 30 fps, 48 kHz, "SYNTHETIC TEST CLIP" on every frame, named
  `synthetic-*.mp4` with a ground-truth JSON beside each, in a temp folder that is deleted afterwards; nothing is
  committed or seeded into a database). `packages/media/test/reference-style.test.ts` (needs ffmpeg) runs every row of
  design §4.3.1.10: R1 hard cuts at 120 BPM (15 ± 1 joins, tempo ± 1.5, ≥ 13 cuts within a frame, beats per cut 2),
  R2 a white flash every 4th beat (7 ± 1 flashes peaking on beats, palette accent every 4 beats), R3/R3b cross-fades
  and pixel dissolves (both map to `fade`, 0.5 ± 0.1 s, no beat in pink noise), R4 a push-in (scale ± 0.03 of the
  zoompan truth) and a 1.25× punch-in jump (± 0.04, not a transition), R5/R5b a drop at 8 s (± 0.15 s, ≥ 10 dB) with
  and without a cut there, R6 slides and wipes (axis and direction, no cross-fades), R7 a busy single shot (no joins),
  R8 a 3 s dark end screen skipped (± 0.2 s), R9 talking (beat not measured, never "off the beat"), R10 a cut on every
  beat at 124 BPM, R11 random cuts (not reportable), the review edge cases X1–X11 (bright and dark shots, bright
  inserts, dips, zooms, blurs, soft wipes, 60 and 25 fps, a cut into a smooth shot, a white end card), a proxy without
  sound, numbers only (no array longer than 8) and the AbortSignal. Fixture builds are reproducible (every random
  input pinned, x264 on fixed slice threads), so a failure repeats on the next run. The frame maths also has
  FFmpeg-free unit tests (parser, scale fit on known zooms, cross-fade vs wipe, band direction, shifts and whether the
  shifted frames really look alike).
- Unit: `packages/core/test/reference-style.test.ts` (binomial kMin table 15 → 10, 30 → 17, 8 → 7; reasons the beat was
  not measured; drop on a step, single knock rejected, click windows smoothed; every palette family and the worked
  example; v1 → v2 reads; summary 1 of 1, 1 of 2 differs, 3 of 4 pooled, octave-folded tempos, older profiles only for
  v1 rows, profiles from an older measuring version (a simulated bump to version 2) combined into no row, the pace
  included, and counted with the "measured with an older version of the measuring" wording, still counted after the
  same videos are uploaded again (so the wording says to remove the old copies); a transitions value accepted from
  three videos stays in use, with the "still in use" line and stoppable, after a version bump and with no videos;
  stopping "Cutting to the beat" (`resetEditingStyle(prefs, row)`) also takes back the beats per cut accepted with it,
  with their sources and the row's decision, leaves the other rows as they were (each row resets only its own values),
  and beats per cut left from the videos keep the row in use until then; transitions and a pace accepted from three
  videos stay in use, with the line, next to the different values the same videos give when measured again (also
  after "No thanks", not after using the new one or stopping the row);
  `alsoChanges`,
  `valueKey` stability and conflicts; no "exact/precise/detected/trending/viral" wording),
  `packages/core/test/editing-style.test.ts` (an accepted music fit alone is not a planning value; `MusicFitSchema`
  accepts an ordered range and a single tempo and refuses `bpmLow` above `bpmHigh`, nested too),
  `packages/core/test/music-ranking.test.ts` (fit: in-range above out-of-range, half time +1, drop +1, unusable last,
  no fit = unchanged order; a 40 s track for a 45 s edit is suggested with "Trims the edit to 39.8 s", 39.4 s from a
  first beat at 0.45 s), `packages/ai/test/rules-editing-style.test.ts` (defaults: 40 plans equal to the commit before
  this feature apart from the cut times listed as on the beat, which now come from each plan as it plays (one hash
  with those times emptied, one of the whole plans); accepted style: all five plans valid with no errors and still
  different, beat montage accents on every 4th beat within ±40 ms, 2-beat shots, process story ≥ 70 % of cuts on the
  beat, the reveal on the strongest beat within ±0.1 s, punch-ins continuing the same shot at 1.2× and never above
  1.25, clean promo calm, "remove the flashy transitions" removes every accent, dismissed = defaults, a music fit
  alone = defaults in every style and take with no `editingStyle` in the AI brief, deterministic; AI brief and
  `extraStyleTransitions`).
- Planner step-down and plan notes: `packages/ai/test/rules-editing-style-sweep.test.ts` (design §4.3.1.6 "Never
  worse than the defaults"): every N, cross-fades of 0.3–1 s alone and with the beat, the reveal and punch-ins, at
  15/30/45/60 s × five styles × four music cases (70 s tracks at 60 s) × three takes, each judged by the worker's
  window around the planned length, with the default plan judged the same way; pinned per-step counts at 60 s; every
  keep-rest plan differs from the plan without the editing style and every other fallback plan is that plan; no
  fallback plan mentions the transitions from the owner's videos; fake builds that write a note before failing never
  leak it into a later step; the comparison build (kept on failure, cancellations passed on); and a revision (before &
  after 30 s → "Make it 60 seconds.") with the revision wording, every kept join unchanged, and the wording for a new
  edit when the earlier clips are gone.
- Edit length and the chosen track (design §4.7 item 5): `packages/core/test/edit-length.test.ts` (`durationBoundsFor`
  and `editLengthForTrack`: kept, trimmed to 39.8 s for 45 s with a 40 s track, the 88 % and 5 s limits, the refusal
  message; no tenth lost to binary rounding (16 s with 16.15 s kept, 74/65.35, 90/79.35 and 10/8.95 trimmed); the
  music measured from the first beat (45/40 → 39.5 s from 0.3 s, 39.4 s from 0.45 s; 30/30 → 29.5 s from 0.3 s),
  whether a track is long enough judged on its length alone; `earliestMusicStartSec`, `usableBeats` and `hasBeatGrid`,
  which tells a track with a beat from one with no clear beat),
  `packages/ai/test/planned-length.test.ts` (the rules plan, the AI brief's `target` and the AI plan's
  `targetDurationSec` all 39.8 s; music switched off by an instruction keeps 45 s; a revised length is trimmed too; a
  30 s track is refused with the shared message; the AI brief's reveal on the biggest lift worked out for the trimmed
  length, with the music where the rules planner starts it), `packages/ai/test/rules-music-start.test.ts` (first beats
  at 0.3 and 0.45 s with a 40 s track for 45 s, and 30 s and 30.2 s tracks for 30 s, every style, default and every
  2 beats, two takes: the music starts on a beat, every cut listed as on the beat is within 40 ms of one as the plan
  plays, the music lasts 0.1 s past the edit, the montage's cuts are all on beats, the trimmed note; an AI plan built
  from the same cuts reports exactly the same beats, and its list follows where its music actually starts, not the
  model's own list; the AI brief's target and fixed start leave room from the first beat),
  `packages/ai/test/rules-no-clear-beat.test.ts` (a SYNTHETIC 40 s track with no beat, and one with 3 beats: across
  every style, the default and an accepted style, with and without "Cut to the beat" and "Land the reveal on a beat",
  two takes, neither planner reports `beatAlignment`, plan facts say `beatAligned: false` (and
  `packages/core/test/foundations.test.ts` checks `planCutsOnTheBeat`: a listed cut counts only when the track, when
  known, has a beat) and no plan note claims a
  beat; the fitted styles' cuts are exactly those of the same edit without music; the beat montage keeps its 120 BPM
  (or 60 BPM from the 3 beats) stand-in from where the music starts and says the track has no clear beat; the notes
  for beat options with nothing to work with, one sentence when both apply; with the start chosen, the reveal still
  lands on the track's biggest lift where the footage reaches it, and never falls back to a downbeat),
  `apps/worker/test/plan-length.test.ts` (no database: the worker's own `planWithFallback` + `planningContextFor` on
  the planner fixtures with 40 s tracks; 0 of 315 edits fail across the default and six accepted styles × five styles
  × three tracks × three takes, where the window around the requested 45 s refuses 15 default-style plans (9 before
  the beat montage stopped running to the end of the music); the step-down still runs; a revision asking for 45 s; a
  30 s track refused, and refused before the AI planner is asked, for a first plan and a revision; first beats at 0.3
  and 0.45 s through the worker: music on a beat, no false beat claims, music to the end),
  `apps/web/test/music-curve.test.ts` (what the music start picker says when the edit is trimmed, also with a start
  that can be chosen, when the track is as long as the edit or its first beat is late, or the track is too short;
  `latestMusicStart` without the binary rounding loss).
- Database + ffmpeg: `apps/worker/test/preferences-db.test.ts` ingests a SYNTHETIC R2 reference: a version 2 profile
  with flashes on the beat, no array longer than 8 numbers, no AI call, and only the thumbnail left under the asset's
  storage prefix. `apps/web/test/preferences-routes.integration.test.ts` covers `GET /api/references/summary` (staff
  read-only), `POST …/summary/decide` (owner-only, CSRF, stale `valueKey` → 409 with nothing written, accept writes
  `editingStyle` + `sources` + `summaryDecisions` and the audit rows), Settings refusing `sources`/`summaryDecisions`
  and recording owner changes, `…/summary/reset`, a SYNTHETIC profile from another measuring version (listed with
  `olderVersion`, rows exactly as without it, its own suggestions refused with 409 and nothing written, still counted
  after the same video is uploaded again, until the old copy is removed), a transitions value accepted from the
  videos that stays in use and stoppable once the stored profiles are moved to another measuring version,
  `PUT /api/settings` refusing a reversed `musicFit` tempo range (400 on
  `preferences.editingStyle.musicFit.bpmLow`, nothing stored), and "Change: use each style's own" on "Cutting to the
  beat" (`…/summary/reset` with `{ field: 'beatSync' }`: owner only, other fields 400 with nothing written, beat sync
  and the beats per cut accepted with it back to the defaults with no sources or decision, the transitions accepted with
  them still in use, the audit row), and transitions accepted earlier that stay in use, with the line and stoppable,
  once the stored videos are measured again as cross-fades. `apps/web/test/your-style.test.ts` checks what the card
  sends for that button (the whole row) and which rows offer it, next to a new suggestion too. `apps/web/test/studio-access.integration.test.ts`
  checks generation start with the music start on automatic: a 50 s edit with a 40 s track is refused with the
  planners' message, a 45 s edit is accepted, and the track's music option carries its first beat (`firstBeatSec`).
  `apps/web/test/music-routes.integration.test.ts` checks that "Suggested for you" offers that 40 s track for a 45 s
  edit with "Trims the edit to 39.8 s", and that the Sound panel's "Cut to the beat" starts as on only when the
  version's track has a beat (a stored plan listing cuts on the beat of a track with no clear beat starts it as off).
- Only with the owner's real videos (design §4.3.1.10): 3–5 of their own posted videos, cuts and flashes counted by a
  person on a 15 s excerpt of each (cut count ± 10 %, flash count ± 1, tempo ± 2 BPM or an octave). Thresholds are
  starting values from synthetic clips until then.

## Publishing (Stage B, WP4)

- Unit: `packages/core/test/publishing.test.ts` (eligibility matrix incl. Meta Sound Collection and CC BY, removing
  music keeps a valid plan, Melbourne scheduling incl. 2026-10-04 02:30 nonexistent and 2027-04-04 02:30 ambiguous,
  `checkMediaForPlatform` boundaries, captions in graphemes, `derivePostStatus`, target actions, link validation,
  request schemas, poll schedule); `apps/worker/test/publishing.test.ts` (`mapGraphError`, `appsecret_proof`, module
  registration); `apps/web/test/publishing.test.ts` (integration cards, ref ids, composer logic: nothing preselected,
  five at most).
- Database + ffmpeg + a local fake of Meta's Graph and rupload hosts (`apps/worker/test/fakes/graph-server.ts`):
  `apps/worker/test/publishing-db.test.ts` (read-only check and discovery, happy path, crash after `media_publish`,
  container ERROR and Retry, copyright match → post without music (real `no_music` render), quota requeue, error 190,
  partial post, scheduling and cancel, licence changed, Meta-only music to TikTok, an interrupted upload resuming on the
  same container, two claimers, `stately` queues on pg-boss 12.38.1). Runs in `pnpm -r test` when `TEST_DATABASE_URL`
  is set.
- Database-backed routes: `apps/web/test/publishing-routes.integration.test.ts` (drafts and refusals, owner-only
  approval with no feedback or ledger row, consent tick, manual confirmation with link validation, feedback and ledger
  once, undo, duplicate rule, reschedule and cancel, staff visibility, Instagram connect/callback against a local fake
  token exchange, disconnect).
- Only verifiable with the owner's accounts (publishing design §11.4): Unified Login publishing in Development mode,
  whether `business_management` is needed, the resumable size limit, quota and token expiry, `thumb_offset` with
  resumable upload, Sound Collection copyright matching, Web Share on iOS. The first verification post is a real public
  reel the owner chooses.

### TikTok through Zernio (Stage C, WP10)

- Unit: `packages/core/test/zernio.test.ts` (strict create body, consent binding, interaction seeds, poll and lookup
  schedules, webhook envelope); `apps/worker/test/zernio.test.ts` (`mapZernioError`, `mapZernioPost` incl. the three
  draft markers, the upload transport refusing http, odd ports, credentials and private addresses, the test-only
  origin rule); `apps/web/test/zernio.test.ts` (TikTok card states, composer choices, webhook signature).
- Database + ffmpeg + a local fake of Zernio (`apps/worker/test/fakes/zernio-server.ts`, which checks every create
  body against the strict contract) and of Meta: `apps/worker/test/zernio-db.test.ts` (read-only check, lane, refused
  key, missing group, vanished account id; publishing design §11.2 cases 7–11: happy path with the exact body and
  upload headers, no consent, 207 `scheduled`, the three draft markers, 409 adopted or refused, any 402, 409
  `ads_connection_required`, 400 then Retry re-uploading, a changed account id, a cooldown, a crash after the create
  adopted by the metadata lookup, "check before retry" then one create with the same key, `/retry`, a partial post with
  Instagram, webhooks as hints, a reversal, flag off).
- Database-backed routes: `apps/web/test/zernio-routes.integration.test.ts` (key connect and hint, account choice,
  composer options, consent-tick approval and binding, drafts switch and draft verification, the webhook route's
  signed, unsigned and repeated deliveries, disconnect). No test ever contacts Zernio.
- Only verifiable with the owner's accounts: the audited lane end to end, held-over-cap behaviour, URL resolution
  delay, the draft body and the key that marks a delivered draft, webhook `post.id` = `_id`, the account id after a
  reconnect, and whether the first two accounts are still free. The first verification post is a real public TikTok.

## Stage B browser test

`apps/web/e2e/stage-b.e2e.mjs` is the Stage B acceptance check from `docs/design/stage-bc-plan.md` ("music licence →
export gates → publish manually and (with fakes) to Instagram → learned preferences visible → trends labelled"). Like
the Stage A test it is plain Node + Playwright (Chromium), drives the real UI as the owner would and prints
`N checks passed, 0 failed`.

```bash
bash apps/web/e2e/run-stage-b.sh                       # fresh database studio_e2e_b, build, port 3500
E2E_SKIP_BUILD=1 bash apps/web/e2e/run-stage-b.sh      # reuse the last build
```

The runner creates and migrates a throwaway database, builds the web app (with `NODE_ENV=production`), then starts
three detached processes: the local fake of Meta (`apps/web/e2e/fake-meta.ts`, on a free port or
`E2E_FAKE_META_PORT`), `next start` and the worker. The web app and worker run with `NODE_ENV=test`, dummy
`META_APP_ID` / `META_APP_SECRET` / `META_LOGIN_CONFIG_ID`, and `META_GRAPH_BASE_URL`, `META_RUPLOAD_BASE_URL` and
`META_DIALOG_BASE_URL` all pointing at the fake; no `YOUTUBE_API_KEY`. Everything is stopped and the database dropped
afterwards (logs and downloads are kept on failure or with `E2E_KEEP=1`). Other settings: `E2E_PG_URL`, `E2E_DB`,
`E2E_PORT`, `E2E_WORK_DIR`. A passing run prints `77 checks passed, 0 failed` after five to six and a half minutes
(plus the build; 383, 309 and 337 s in three consecutive runs on 2026-11-14); most of that is FFmpeg rendering and the
worker's publishing run against the fake. Every wait is on a real state (a job or file reported ready through the
API, a button enabled), not on a fixed delay.

**What the fake replaces.** One process plays the three Meta hosts the app talks to, using WP4's Graph model
(`apps/worker/test/fakes/graph-server.ts`, shared with the worker's tests): the Unified Login dialog on
`www.facebook.com` (it "approves" at once and redirects back with a code), the code exchange
(`oauth/access_token`), `debug_token`, account discovery, the publishing quota, the Reels container, the resumable
upload on `rupload.facebook.com`, status and copyright polling, `media_publish` and the permalink, and the hashtag
reads (`ig_hashtag_search`, `top_media`, three scripted posts). `GET /__fake/state` reports what was published and how
often each endpoint was called. `META_DIALOG_BASE_URL` is the one configuration hook added for this test: like the
other base URLs it is ignored unless `NODE_ENV=test`, so a deployment always sends the owner to
`https://www.facebook.com` (unit tests in `apps/web/test/publishing.test.ts` and `packages/config/test/env.test.ts`).

**What it covers** (database rows are read only where the UI cannot show them):

- Honest states first: Instagram shows "Connect Instagram", the YouTube chart "Needs setup", the hashtag watch asks
  for Instagram to be connected.
- Music library: with no project yet, an upload explains that a project is needed (a deliberate 409). The synthetic
  click track is uploaded through the licence passport as "I'm not sure" (rights box ticked): it is listed as "Not
  confirmed" and "Origin not recorded", analysed at 120 BPM. CC BY-NC shows the refusal and cannot continue; nothing is
  stored.
- Export gates: five edits generated with that track; the card says "Music licence not confirmed — previews only";
  "Export full quality" is refused with the licence message (a deliberate 409) and starts nothing. "Make a music-free
  version" is clicked, the test waits until `GET /api/music/versions/:id` reports the `no_music` export `ready` and the
  card's exact "Music-free version" button is enabled (the two button names overlap, so both locators are exact), and
  downloads it: 1080×1920; when the plan keeps no clip sound (`originalSound` off and no segment with
  `keepOriginalSound`, as packages/core decides it) the file must have no audio stream at all, otherwise at most one;
  no `music_usage` row. After "Licence details" → "I made it, or I own the recording" with the rights confirmation, the
  standard export works (1080×1920 H.264, AAC stereo) and exactly one `music_usage` row (`export`, owner_upload
  snapshot) exists. The music itself is detected by its 1 kHz click (ffmpeg band-pass + `volumedetect`; the clips'
  own sound is a 440 Hz tone, pink noise or silence): it must be above −50 dB in the standard export, and the
  music-free file must have no audio or at least 20 dB less in that band. Both renders are loudness-normalised to the
  same target, so the levels compare directly.
- Meta-only music: a Meta Sound Collection track is locked to Instagram/Facebook; after the Sound panel switches one
  edit to it, the composer offers TikTok only "Without music" ("With music" disabled) and labels Instagram "For
  Instagram/Facebook upload only".
- Manual posting: the composer starts empty ("Nothing is picked for you"), no edit is ticked in the picker, and both
  platform switches start off. One exported edit goes to Instagram as "Post it yourself": the destination is "Your
  turn" (not posted, no `publish` feedback and no ledger row) until "I've posted it"; the download is the 1080×1920
  file with the music (its 1 kHz click within 3 dB of the standard export) and the caption to copy is the one written.
  After confirming it reads "Posted (you confirmed)", still does after a reload, and one `publish` feedback event and
  one `music_usage` (`publish`, instagram) row exist.
- Instagram direct: "Connect Instagram" goes through the real connect route, the fake login dialog and the callback;
  the read-only check finds `@ivanhoe_studio_test`; the token is stored encrypted. A first verification post is
  approved; the worker uploads to the fake and publishes once; the destination is published with the fake's media id
  and permalink; one `music_usage` row (`publish`, instagram). A second `publish.target` job for the same destination
  (sent through `@studio/queue` by `apps/web/e2e/requeue-job.ts`) claims nothing and the fake still has one post. The
  owner answers "Yes, it's there".
- Trends: every curated reference shows its source and "last reviewed" date; a note is listed under "Noted by staff"
  as "Noted by E2E Owner on …"; the hashtag `skinfade` is watched and its three posts are labelled "Top posts under
  #skinfade — Instagram, fetched …" with counts "as Instagram reported them" and Instagram permalinks; one search and
  one `top_media` read at the fake; no popularity words (trending, viral, popular …) on any of these.
- Learned preferences: three favourites and a download give a learned "Default length" (10 seconds) with its evidence
  ("From 3 favourites …"); "Keep this" makes it "Set by you"; "Reset what it learned" leaves nothing marked "Learned".
- No page errors or console errors except the two deliberate 409s above (each must actually appear). The only failed
  loads tolerated are ones the browser cancels itself (`net::ERR_ABORTED` / `ERR_FAILED`) on this app's signed
  `/api/media/…` links or on Next.js route prefetches (`?_rsc=`); the run logs how many it ignored.

**Not verified without real accounts.** Everything Meta-specific stays unproven until the owner's own accounts are
used (publishing design §11.4 and the WP5 notes above): whether a Unified Login system-user configuration may publish
in Development mode and search hashtags, the real permission names, the resumable size limit, quota and token expiry,
`thumb_offset`, Sound Collection copyright matching, real container processing times and errors, and how Instagram
renders the reel. The fake answers the documented happy path immediately. Manual posting in the real Instagram and
TikTok apps, Web Share on iOS, the YouTube chart (no key), Spotify references (links only; not exercised here, covered
by the WP1 unit and route tests), and how learned defaults feel after weeks of real use are not covered either; all
footage and music are synthetic.

## Stage C browser test: bookings, email and reviews

`apps/web/e2e/stage-c-bookings.e2e.mjs` checks Square appointments (WP6, with WP6b's booking changes switched off),
email and review requests (WP7) in Chromium, against local fakes of Square and Postmark. Like the Stage B test it is
plain Node + Playwright, drives the real UI as the owner (and, where it matters, a barber) would, and prints
`N checks passed, 0 failed`.

```bash
bash apps/web/e2e/run-stage-c-bookings.sh                    # fresh database studio_e2e_c1, build, port 3800
E2E_SKIP_BUILD=1 bash apps/web/e2e/run-stage-c-bookings.sh   # reuse the last build
```

The runner creates and migrates a throwaway database, builds the web app, then starts one fake process
(`apps/web/e2e/fake-stage-c.ts`, three free ports: Square, Postmark and a control port the test uses to change the
Square scenario, hold Postmark sends and read what each fake recorded), `next start` and the worker, all with
`NODE_ENV=test`. It runs the test file twice: phase `sandbox` with `SQUARE_ENVIRONMENT=sandbox`, then it stops the web
app and the worker, starts both again with `SQUARE_ENVIRONMENT=production` (still the fake; the fakes keep running and
keep what they recorded) and runs phase `production`, which loads the first phase's results from a state file and
prints the total. Everything is stopped and the database dropped afterwards (logs and failure screenshots are kept on
failure or with `E2E_KEEP=1`). Other settings: `E2E_PG_URL`, `E2E_DB`, `E2E_PORT`, `E2E_WORK_DIR`. A staff (barber)
account is added with `apps/web/e2e/add-staff-user.ts` (the app has no screen for that yet), and scheduled jobs the
test does not want to wait for (`email.automation.sweep`, `email.dispatch`, a repeated `email.send`) are sent through
the app's own queue by `apps/web/e2e/enqueue-job.ts`. Every wait is on a real state (a job row finished, a status in
the API, a send held at the fake), never on a fixed delay. A passing run prints `124 checks passed, 0 failed` (59 in
the sandbox phase); three consecutive runs on 2026-11-14 reported 79, 86 and 78 s of test time (plus the build and
the restart).

**What the fakes replace.**
- Square (`apps/worker/test/fakes/square-server.ts`, the same model the worker's database tests use): the authorise
  page (it "approves" at once and redirects back with a code), the code exchange, token status, merchant, locations,
  booking profiles, catalogue, bookings, customers, payments and orders, in Square's own JSON through the real
  `square` SDK. Every write is refused and recorded. Reached through `SQUARE_API_BASE_URL`.
- Postmark (`apps/worker/test/fakes/postmark-server.ts`): `GET /server`, `/message-streams`, `/webhooks` (the webhook
  registered on both streams), `POST /email` (recorded, never delivered; it can hold a send until the test releases
  it), the outbound message search and suppressions. Reached through `POSTMARK_API_BASE_URL`, the one configuration
  hook added for this test: like the other base URLs it is read through `testOnlyBaseUrl` and ignored unless
  `NODE_ENV=test`, so a deployment always calls `https://api.postmarkapp.com` (unit tests in
  `apps/worker/test/email.test.ts` and `packages/config/test/env.test.ts`). A unit test in `email.test.ts` also runs
  `PostmarkProvider` (check, send, findSent, suppress) against this HTTP fake, so its answers cannot drift from what
  the provider parses.
- Google Places is not faked: without `GOOGLE_MAPS_API_KEY` the rating card must show its setup state and no number.

**What it covers** (database rows are read only where the UI cannot show them):

- Square sandbox: Settings → Integrations shows Square "Not connected" and Appointments the "nothing here is
  simulated" overview; Connect Square goes through the real connect route, the fake authorise page and the callback,
  asking for read scopes only (`session=false`, the registered callback); tokens are stored encrypted and never reach
  the page or the status APIs (`/api/integrations/square`, `/api/email/status`, read as the owner and as a barber:
  no token value and no encrypted or secret field). With two Square locations no booking is copied (none stored, none
  listed by `/api/appointments`; clients are Square's merchant-wide directory and are copied on connect) until the
  owner chooses one; the first sync then lists
  tomorrow's booking as "10:00 am – 10:45 am" under tomorrow's Melbourne date, with "Sandbox — these are Square test
  bookings and test clients, not real ones." and the "Sandbox (test)" pill; the other location's booking is not
  shown. The owner sees a client's email and phone; a barber sees names only (Clients tab, booking dialog and both
  APIs).
- Booking changes stay off: no "New booking", no Move or Cancel, the header says changes are made in Square,
  `POST /api/appointments/changes` is refused with "Booking changes from Studio Assistant aren’t available yet. Make
  changes in Square." and nothing is recorded, write permission is never requested, and the fake records zero write
  calls over the whole run.
- Email set-up: business name, address, phone and email saved; "Check connection" reads Postmark's server, streams
  and webhooks and the fake records zero sends; the card then says Live and that every email waits for approval. An
  invalid review link is refused with the reason (a deliberate 400) and nothing is saved; a `g.page` link is saved and
  still shown after a reload. The sending window is set to 00:00–23:59 (so the run does not depend on the hour; the
  window rule itself is unit-tested; a send attempted in the last minute before midnight Melbourne time would wait for
  the window and time out), and the follow-up and review automations are switched on in "Ask me to approve
  each one" mode.
- A past sandbox booking marked "Attended" shows "Attended — marked by E2E Owner" after a reload, but is not stored as
  a completed visit, and an automation sweep creates no follow-up and no review request for it.
- A correctly signed Square webhook (HMAC over the notification URL and body) is accepted, the worker re-reads the
  booking from the fake, only the envelope is stored (not the client's note), and the booking shows "Cancelled by
  client" after a reload; a webhook with a wrong or made-up signature gets 401 and nothing is stored.
- Production (after the restart): Square shows "Reconnect needed" with "Studio Assistant is now set to live Square.
  Reconnect to load your real bookings; the test data will be removed." and Appointments keeps the sandbox label and
  "May be out of date". Reconnecting removes the sandbox bookings and scrubs the sandbox clients; after choosing the
  location the live bookings appear with "Live Square" and no sandbox label.
- Consent: a barber records Riley's permission at the counter ("Client ticks on this device", with the consent wording
  shown) and the owner records three more; Emails → Clients shows "Permission recorded" for those four and "No
  permission" for the fifth; the ledger keeps the method.
- Review request: the owner marks the live booking attended (stored as `owner_marked`); the sweep prepares a review
  request, listed in Reviews as "Waiting for approval" (and the follow-up waits in Emails → To approve; Emails' own
  queue leaves review requests to the Reviews page by design); after an `email.dispatch` and every queued send has
  finished, the fake has still received nothing and both messages are drafts with no approval. After "Approve and
  send" the fake receives exactly one email for Riley, on the Broadcast stream, with the sender identification footer
  (business name, street address, phone and email), an unsubscribe link to `/u/…` and the review link through the
  app's `/r/…` redirect, and no incentive or selective wording. Opened without a session and without following the
  redirect, that `/r/…` link answers 302 to exactly the saved review link and counts one open; an unknown token goes to
  the same link (every token does, so nothing branches on who clicked) and counts for nobody. Reviews then shows "Sent"
  and Emails → Sent lists it.
  Running `email.send` for the same message and `email.dispatch` again sends nothing more.
- Unsubscribe: opening and reloading `/u/<token>` only asks ("Unsubscribe r•••@example.com …?") and records nothing;
  the button confirms "You’re unsubscribed", which stays after a reload, and Emails → Clients shows "Unsubscribed".
- Campaign: three clients are included and Riley (unsubscribed) and Noah (no permission) are left out. With the fake
  holding sends, the first email is in flight when the owner presses Pause; after it is released nothing more goes out
  (one send, "Paused", "1 of 3 sent" after a reload). After Resume, while the second email is in flight, a Postmark
  `SpamComplaint` for the first recipient with the right Basic credentials pauses the campaign by itself ("Paused
  automatically: 1 spam complaint out of 1 sent. …") and suppresses that address for all email ("Bounced or spam");
  the in-flight email is the last one. A hard bounce suppresses the second address. The same complaint with a wrong or
  missing password gets 401 and nothing is stored. "Cancel remaining" leaves nothing to send. Over the whole run Riley
  received only the review request and Noah nothing.
- Appointments, Appointments → Past, every Emails tab and Reviews have no horizontal overflow at 390 px (sandbox
  Appointments too); no page or console errors in either phase except the deliberate 400 for the invalid review link
  (it must actually appear).

**Not verified without the owner's real accounts.** Square: the real authorise page and its `session=false`
behaviour, the code lifetime, which scopes Square really grants, webhook delivery to the production address and
Square's real signature header, real booking shapes and statuses, payment matching on real payments, the location's
time zone, Dashboard deep links, and everything about booking changes (they stay switched off until the sandbox write
checks are recorded). Postmark: account approval, DKIM and Return-Path, real delivery to Gmail and Outlook with the
one-click unsubscribe button and Postmark's own unsubscribe handling, the real webhook payloads and Basic credentials,
the message search after a lost answer, and the first live send to a consenting client. Google: the Places rating and
attribution (no key here) and whether the owner's review link opens the review form. The fakes answer the documented
happy path immediately.

## Worker start-up and liveness (14 Nov 2026 incident)

The owner started `bash scripts/dev.sh` before the database. The worker died in `pg-boss` start, `tsx watch` kept
its process alive, and five clips sat on "Waiting to be analysed" with no hint why. What now covers it:

- Unit, no database and no real sleeps: `apps/worker/test/startup.test.ts`. `classifyStartupError` retries
  `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, 57P03 "starting up" and connection timeouts (also wrapped in
  `AggregateError` or `cause`, and the real error `pg` throws for a closed local port), and fails fast on a wrong
  password (28P01/28000), a missing database (3D000), an invalid URL, a missing handler or anything unknown. Only real
  configuration problems become exit 78 (`isConfigurationError`/`startupFailure`); an unknown error such as pg's
  codeless "Client has encountered a connection error" exits 1, which dev.sh restarts. The 3D000 message suggests
  `local-postgres.sh start` only for the database that script creates (`LOCAL_PG_DB`, default `studio_assistant`).
  `backoffDelayMs` is 1 → 2 → 4 → 8 → 15 s (capped). `waitForDatabase` runs with an injected `sleep`: one plain
  waiting line however many attempts fail, no retry of configuration errors, and SIGINT/SIGTERM (an aborted
  signal) stops the wait. `reportStartupFailure` never prints the connection password and exits 78 for configuration
  problems, the status `scripts/dev.sh` does not restart.
- Database-backed (`TEST_DATABASE_URL`): `apps/worker/test/worker-heartbeat-db.test.ts`. Writing and refreshing a
  heartbeat row, the 60 s staleness rule against the database clock (59 s alive, 61 s not), one live worker being
  enough when another died, pruning rows older than a day, `startWorkerHeartbeat` beating on its interval and
  deleting its row on stop, pausing while the queue health check fails, never overlapping a slow beat, and the
  start-up check that the table exists (a database that was not migrated).
- Web: `apps/web/test/worker-notice.test.ts` (the notice only when no worker is alive **and** something is waiting;
  nothing when the worker runs or when the status was not checked; the dashboard's quieter wording; a hosted server
  pointed at its worker service instead of `dev.sh`; a heartbeat that cannot be read counts as "not running") and
  `apps/web/test/studio-status-shape.test.ts` (the status payload carries `worker`).
- Live check (by hand, on a throwaway cluster, e.g. `LOCAL_PG_PORT=55891 LOCAL_PG_DIR=/var/tmp/wl/pg`):
  1. Prepare the database first: `bash scripts/local-postgres.sh start`, `bash scripts/dev.sh migrate` and
     `pnpm db:seed`, then `bash scripts/local-postgres.sh stop`. (Migrate before the next step: a waiting worker
     reaches a fresh, unmigrated database within 15 s and stops with "Run: bash scripts/dev.sh migrate".)
  2. With the database stopped, run `bash scripts/dev.sh --no-check`. The `[worker]` lines show
     `Waiting for the database at 127.0.0.1:55891. Start it with: bash scripts/local-postgres.sh start` once, and
     `GET /api/health` is 503 with `worker.alive` false.
  3. Start the database again (`bash scripts/local-postgres.sh start`). The worker logs `The database is reachable
     now` and `worker started` without being restarted; an uploaded clip is analysed.
  4. `kill -9` the worker's node process. `dev.sh` says `The background worker stopped unexpectedly` and starts it
     again. To see the notice, run the web app and `pnpm --filter @studio/worker start` separately and `kill -9` the
     worker: within about 60 s `GET /api/health` reports `"worker":{"alive":false,…}` (still 200) and a project with
     a waiting clip shows "The background worker isn't running" above the clips.

## Square appointments (Stage C, WP6 and WP6b)

- Unit: `packages/core/test/square.test.ts` (scopes, every card state incl. environment switch and stale sync,
  `classifyVariation` incl. passthrough `no_show_fee`, the Tier 1 checklist, the six statuses, attendance and
  completion: time passing alone is never completion, owner marks, Square NO_SHOW wins, refunds, missing bookings;
  `matchPayments` window edges, refunds, ties; DST availability ranges; 31-day windows; `mapSquareError`);
  `apps/web/test/square.test.ts` (webhook signature vector, trailing slash, tampering; authorise URL; state cookie;
  card wording; attendance rule; ref ids).
- Database + a local fake of Square (`apps/worker/test/fakes/square-server.ts`, Square's own JSON, used through the
  real SDK via `SQUARE_API_BASE_URL`, honoured only when `NODE_ENV=test`): `apps/worker/test/square-db.test.ts` (connect
  sync and idempotent second run, three ≤ 31-day windows, six statuses verbatim, stale versions, webhook processing and
  merchant mismatch, missed `booking.created`, reconcile, payment match and refund, 23-hour DST availability,
  deleted customer scrubbed, token refresh and revoked token, revoke, environment purge, cleanup, no writes to Square;
  a revoke for a connection made in the other environment makes no call and is audited `environment_changed`;
  a sandbox payment match is labelled but never completes, live completion runs as a production connection; an
  "attended" mark made while the appointment runs completes once it ends; two locations with none chosen copy no
  bookings and another location's booking is ignored; a disconnect with purge during a sync leaves no bookings or
  active clients; a refused token refresh fails the availability search and reaches the card; a late revoke after a
  reconnect is skipped; old Square webhook deliveries are cleaned up).
- Database-backed routes: `apps/web/test/square-routes.integration.test.ts` (connect/callback against the fake token
  endpoint, verified webhook stored once with one job, lists, attendance refused on NO_SHOW, contact details for the
  owner only, service confirmation, `writesEnabled` refused, availability validation, disconnect with purge and revoke,
  reconnecting in the other environment purges; the webhook stores only the minimal envelope; nothing listed until a
  location is chosen and choosing removes the other location's bookings and queues a sync over the connect range (so
  the location's past bookings are copied at once); a sandbox mark never completes; the
  review-request badge on past bookings, including "Sent before the booking changed"; a signed delivery for another
  merchant or after a disconnect does not update "last update received"; the revoke outcome on the card: waiting,
  failed with the App integrations instruction, revoked; owner only). `apps/worker/test/square-map.test.ts`: a booking
  whose `start_at` is not an RFC 3339 instant is skipped and its id reported.
- Sandbox smoke test (developer, read-only, needs the owner's Square developer application):
  `pnpm --filter @studio/worker square:smoke` refuses to run unless `SQUARE_ENVIRONMENT=sandbox`; record its output in
  `docs/research/square-sandbox-results.md`. It searches tomorrow's availability (one Melbourne day, 24 hours); the
  23-hour daylight-saving day cannot be checked live once its date has passed, so the summary says
  "not verifiable live" and that case rests on the unit and fake-Square tests. `customers.allPages` is the count over
  every page. The write checks belong to WP6b.
- Only verifiable with the owner's accounts: `session=false` and the code lifetime, webhook delivery to the production
  URL, payment-match quality, the location time zone and the Dashboard deep links.
- Booking changes (WP6b; Tier 1 is switched on in these tests only through the test-only `tier1Available` option):
  `packages/core/test/square-changes.test.ts` (the gate both sides apply, the self-test needing lines 1–3 only,
  `bookingActions` per role and state, stable idempotency keys, nothing "done" before Square confirmed, the notification
  sentence, nearest alternatives); `apps/worker/test/square-changes-db.test.ts` against the fake of Square, which
  accepts writes only when a test sets `acceptWrites`, honours idempotency keys and versions, and can drop a response
  after applying a write (a time-out after Square made it): off by default with nothing sent; the gate (plan flag,
  permissions, a fee-bearing service, an unconfirmed service, the plan flag gone at write time pauses changes); create
  happy path (one write with the stored key, mirrored, audited); slot taken → `slot_unavailable` with alternatives;
  version changed → `changed_in_square`; a time-out retried with the same key → one booking; a crash after
  `submitted_at`; every attempt timing out → `unknown`, then the next sync confirms it; "probably not made" after 24 h;
  a 4xx stored verbatim with the service becoming "Book in Square"; a 403 plan refusal pausing changes; the
  double-booking warning; refusal after a disconnect or another account; the self-test resuming after a crash without
  booking twice, a failed move still cancelling, and a failed cancel naming the test booking left in Square.
  `apps/web/test/square-changes-routes.integration.test.ts` (every Tier 1 route refused while off; staff refused; the
  recorded request and job; stale search, slot not offered, unconfirmed service, client from the other environment,
  past time, version mismatch, PENDING booking, one change at a time, pause and switch-off; booking detail actions;
  self-test refusals, three fixed step rows, live acknowledgement; the switch needing lines 1–4 and clearing a pause;
  the notification answer; a cancelled job closing its change; disconnect withdrawing queued changes) and
  `apps/web/test/square-changes.test.ts` (the change DTO never shows the key or Square ids, AEDT/AEST labels, the
  switch rule, ref ids and job labels, `verified` only after a live self-test).
- Still to run with a Square sandbox account before Tier 1 is switched on (design §11.3 steps 3–4, developer-run): the
  three no-show set-ups with create, reschedule and cancel of a fee-free and a fee-bearing service, a seller-level
  cancel of a PENDING booking, and the Free-plan write error; record them in `docs/research/square-sandbox-results.md`
  and update `mapSquareError` before setting `SQUARE_TIER1_AVAILABLE = true`.

## Email and review requests (Stage C, WP7)

- Unit: `packages/core/test/email-render.test.ts` (escaping, Markdown subset, footer, commercial footer, markers in
  stored copies, `{{booking_link}}` linked only when https, the state required in the sender address),
  `email-lint.test.ts` (every word list, whole words only, built-in templates pass),
  `email-policy.test.ts` (one case per gate reason, window and caps across Melbourne days, preview only to the owner,
  sandbox label, consent fold incl. inferred rule and ties, auto-pause, spread by daily cap, audience reasons),
  `reviews.test.ts` (parameter-key pin test, completion evidence, `enabledAt`/`maxAgeDays` boundaries, link
  validation); `apps/worker/test/email.test.ts` (Postmark response mapping, webhook parsing of the fixtures in
  `test/fixtures/postmark/`, the provider against a fake fetch, DNS hints, Places errors, module registration);
  `apps/web/test/email.test.ts` (webhook ids and Basic auth, every Postmark and Places card state, ref ids, public
  paths).
- Database with a fake provider (`apps/worker/test/helpers/fake-email.ts`) and a fake fetch for Google:
  `apps/worker/test/email-db.test.ts` — `email.send` twice → one provider call; unknown outcome → `findSent` → sent or
  `check_before_retry` with no second send; 429 → re-queued and sent; 406 → suppressed + suppression row; 412 →
  `approved=false`; no consent and Square's opt-out block marketing; the sweep run twice at once → one request;
  completed before `enabledAt` ignored; cancelled after creation → cancelled; 12 eligible with a cap of 10 → 10 today,
  2 at 9:00 am tomorrow (Melbourne); campaign expanded twice → no duplicates; a spam complaint on a campaign of 42 →
  auto-pause; `SuppressSending=false` never lifts a suppression; provider check and Places snapshot (404 → error);
  a completed sandbox booking gets no follow-up or review request and is never sent; more than 200 completions in the
  window still reach the newest; a cancel during expansion leaves nothing approved; queued campaign messages are not
  sent after a pause, a cancel or an automatic pause; with webhooks missing, dispatch creates no job for commercial
  email and a held message is pushed forward; a live send outside the sender's domain clears "pending approval"; the
  start-up provider check is queued once and only when email is configured; "Send again" after an owner check keeps
  the first attempt's unsubscribe and review-link token hashes (`email_link_tokens`); a cancel that arrives after the
  claim releases it (no provider call, no owner check); a 406 caused by the app's own earlier unsubscribe push to a
  re-consented address says so and adds no block.
- Database-backed routes: `apps/web/test/email-routes.integration.test.ts` — webhook with wrong credentials → 401 and
  nothing stored, replayed delivery → one row and one job; unsubscribe POST idempotent (form and one-click), GET
  changes nothing; staff 403 and the CSRF guard; approval refused by the gate (422); stale campaign preview → 409;
  consent with the wording hash; review link validation and the `/r` redirect; manual review requests; the review
  automation blocked while Square sends feedback, and ticking "Square sends feedback" refused while the automation is
  on; the automation needs a review link that passes `validateReviewLink`; Places refresh limit; pause hands queued
  messages back, resume re-expands, cancel cancels them; `/u/[token]` shows "You're unsubscribed" only when an
  unsubscribe or withdrawal is recorded (never from `?done=1`); earlier tokens of a message sent again still
  unsubscribe and still count review-link opens; the client page flags an address Postmark still blocks after new
  consent; `/api/email/status` leaves "Waiting for approval" once `approved: true` is stored.
  `apps/web/test/preferences.test.ts`: the booking link must be https. `packages/config/test/env.test.ts`: a webhook
  password shorter than 32 characters, or only one of the two webhook credentials, refuses to start.
- Sandbox smoke test (owner present, Postmark **Sandbox** server, never a client):
  `pnpm --filter @studio/worker exec tsx scripts/email-smoke.ts` runs the read-only check; add
  `--send-to-self <your address>` to send one Transactional and one Broadcast message to yourself and look both up by
  metadata (it refuses unless the server is a Sandbox server). Record the response shapes (addresses removed) in
  `docs/research/email-smoke-YYYY-MM-DD.md`, then send Postmark's test webhooks and use both unsubscribe links.
- Only verifiable with the owner's accounts: Postmark approval, DKIM/Return-Path, real Gmail/Outlook delivery with the
  one-click button, Postmark's unsubscribe links after 30 days, the Places billing SKU and attribution text, the first
  live send (a one-off email to a consenting client, approved by the owner), and real Square completions.

## Website and local search (Stage C, WP8)

All with fakes; nothing contacts a real website, WordPress or Google.

- **Unit** (`pnpm -r test`): `packages/core/test/{robots,website-scope,website-checks,classify-query,
  website-suggestions,change-lifecycle}.test.ts` (RFC 9309 cases, scope/normalisation, one fixture per check plus a
  clean fixture, prioritisation, query groups, suggestions, `checkCopyClaims`, instructions, dedupe/refresh/supersede);
  `packages/ai/test/website-copy.test.ts` (fake Anthropic client; options with numbers the AI was not given are
  dropped); `packages/core/test/address-ranges.test.ts` (names that resolve to private addresses refused on save);
  `apps/worker/test/{website-ssrf,website-crawl,extract,wordpress-adapter,search-console}.test.ts` (blocked ranges incl.
  IPv4-mapped IPv6 and the IPv6 ranges that embed IPv4 (NAT64, 6to4, Teredo, ::/96), redirect to a private address,
  pinned DNS, polite spacing; a fake-clock crawl with `Crawl-delay: 300` and `600` that ends partial with the home
  page read (never a thrown budget error), a redirect to a robots-disallowed address never followed, the www. twin's
  own robots.txt, a home page forwarding to a disallowed address; HTML fixtures incl. a hostile page; fake WordPress
  REST API; recorded-shape Search Console responses); `apps/web/test/website.test.ts` (card states, apply availability, read-time grouping, settings).
- **Database** (`TEST_DATABASE_URL`): `apps/worker/test/website-db.test.ts` runs `website.audit` against a local
  fixture site (`apps/worker/test/helpers/fixture-site.ts`: robots.txt with a disallowed folder, `Crawl-delay: 1`, a
  gzip sitemap behind an index, a 404 and a redirect in the sitemap, `noindex`, a redirect chain, a redirect off the
  site, a soft 404, duplicate titles, invalid JSON-LD, a wrong phone number, a 900 KB image without dimensions, a
  broken link and 30 extra pages): result validates, disallowed pages are never requested, ≤ 400 requests, 25-page
  limit, changes created once and refreshed on a second run, cancel → `cancelled`, an interrupted attempt is
  overwritten cleanly by the retry. Fake WordPress through the injected fetch: staging label, exactly-once apply,
  crash between write and status update → `already_applied` with one write, conflict, 401 → `needs_reauth`, undo,
  no apply without approval; an unreachable site (refused, unresolvable) → complete check with one critical
  `site_unreachable`; robots.txt 503 → `robots_unreachable` and nothing else read; a long Crawl-delay keeps the total
  wait under 12 minutes. `apps/worker/test/wordpress-adapter.test.ts` adds the durable apply marker (a deletion whose
  write landed is `already_applied` on the retry; a first attempt never short-circuits on the new text; a marker never
  counts for re-worded text; a refused write is flagged and a page edited later never leaves the change stuck; the
  page is re-read right before the write and nothing is written when it changed; image descriptions with `<`, `>`, `&`
  and quotes read back as applied). The database suite also covers the worker side: a refused write leaves no
  marker, a landed write's marker never turns re-worded text into "applied", and the worker refuses an approval whose
  change or WordPress destination changed;
  `wordpress-transport.test.ts` the guarded WordPress transport (private/metadata addresses refused, https on 443
  only, redirects never followed, a redirecting REST API refused). Fake Google: token refresh, `sites.list` auto-select, 16-month backfill, idempotent
  upsert, `invalid_grant` → `needs_reauth`. `apps/web/test/website.integration.test.ts` covers the routes, including
  the approval bound to the old text and the destination, audit text trimmed to 200 characters, new wording dropping
  a write marker, a deterministic lock-interleaving test (a second connection holds the row as the apply does) proving
  an edit or AI option never overwrites the wording once the change is `approved`/`applying`, and "Also delete stored
  search data" removing every property's rows.
- **Smoke test on a real site you own** (never in CI): `pnpm --filter @studio/worker exec tsx
  scripts/website-smoke.ts --audit https://your-site/ --i-own-this-site` prints the request log and findings and
  writes nothing. Then, with the owner present: connect Search Console and compare one 28-day total with the Search
  Console web report; run the WordPress check and one `text_replace` plus its undo on a staging copy first.

## Google Business Profile (Stage C, WP9)

All with fakes; nothing contacts Google.

- **Unit** (`pnpm -r test`): `packages/core/test/business-profile.test.ts` (star ratings, Google words, tile totals that
  stay null without data, the extended website payloads); `apps/worker/test/business-profile.test.ts` (quota 0 →
  awaiting approval, `SERVICE_DISABLED` names the API, recorded-shape parsers for discovery, reviews and Performance,
  a missing value → null, int64 strings, thresholds, unknown shapes → the plain "wasn't recognised" message, request
  URLs never naming `BUSINESS_CONVERSATIONS`, backfill windows, valid cron payloads); `apps/web/test/business-profile.test.ts`
  (every card state incl. "Waiting for Google", Performance states, sums of only what Google returned, "—" for a
  missing number).
- **Database** (`TEST_DATABASE_URL`): `apps/worker/test/business-profile-db.test.ts` against an in-memory fake of the
  Business Profile APIs (`apps/worker/test/fakes/google-business-profile.ts`, injected fetch, page size 2): quota-0 429
  → `awaiting_approval` with the job ending normally; discovery auto-selects one location and the first sync reads
  every page and queues the Performance probe; the incremental watermark stops after the first page at or before it;
  a review hidden by the page-2 issue is picked up only by `weekly_full`; several locations wait for the owner;
  Performance probe quota 0 → waiting (reviews untouched), then 200 → available and the first sync queued; a missing
  value stored as NULL, thresholds kept, re-runs identical; an unknown shape fails with the plain message;
  `invalid_grant` → `needs_reauth` on the shared row and Performance stops without calling Google.
  `apps/web/test/business-profile-routes.integration.test.ts` covers the routes: owner-only and CSRF, no reviews or
  numbers while waiting for approval, the location limited to what Google listed (other listings' reviews removed),
  the refresh limits, and disconnect with "delete stored data".
- **Smoke test with the owner** (read-only, once Google has approved the project): connect in Settings →
  Integrations, choose the location, compare the review list with Google Maps, then on the Website page compare 7 days
  of calls with the Business Profile dashboard and confirm the Performance request parameter names, response nesting
  and keyword threshold format (website design §12.3, step 3). Record differences in `docs/research/`.

## Stage C browser test: website and search

`apps/web/e2e/stage-c-website.e2e.mjs` drives the Stage C website and search flow (WP8 and WP9) in Chromium the way
the owner would, against local fakes only, and prints `N checks passed, 0 failed`. Like the Stage A and B tests it is
plain Node + Playwright.

```bash
bash apps/web/e2e/run-stage-c-website.sh                                  # fresh database studio_e2e_c_website, build, port 3900
E2E_SKIP_BUILD=1 E2E_PORT=3900 E2E_DB=studio_e2e_c2 bash apps/web/e2e/run-stage-c-website.sh
```

The runner creates and migrates a throwaway database, builds the web app (with `NODE_ENV=production`), then starts
three detached processes: the fakes (`apps/web/e2e/fake-stage-c-website.ts`, on two free ports or
`E2E_FAKE_SITE_PORT` / `E2E_FAKE_GOOGLE_PORT`), `next start` and the worker. The web app and worker run with
`NODE_ENV=test`, dummy `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GOOGLE_API_BASE_URL` pointing at the Google fake
and `WEBSITE_FIXTURE_BASE_URL=http://ivanhoe-studio.test:<site port>`; no AI, email, Square, Meta or Places settings.
Everything is stopped and the database dropped afterwards (logs are kept on failure or with `E2E_KEEP=1`). Other
settings: `E2E_PG_URL`, `E2E_WORK_DIR`. A passing run prints `114 checks passed, 0 failed` after about two minutes plus
the build (118, 131 and 132 s in three consecutive runs on 2026-11-14); most of it is the crawl, which honours the
fixture's `Crawl-delay: 1`, and the Search Console backfill (one request a second). Every wait is on a real state (a
check, job, change or connection reported through the API or the database, a button enabled), never a fixed delay.

**What the fakes replace.**

- *The owner's website*: the worker's fixture site (`apps/worker/test/helpers/fixture-site.ts`, unchanged, with its
  known issues) behind a small front server that also answers the WordPress REST API for the same host
  (`apps/worker/test/fakes/wordpress.ts`: Basic auth with the Application Password, `users/me`, pages by slug, single
  reads and updates) and shows the WordPress text of the home and contact pages on the public pages. The app reaches
  it as `http://ivanhoe-studio.test/`.
- *Google*: one server for every Google host, addressed as `/<google host>/<path>`: the consent screen (approves at once
  and redirects back, checking the client id, `S256` PKCE and the redirect address), the token endpoint (code
  exchange with the verifier, refresh), Search Console (`sites` with three properties, one unreadable, and
  `searchAnalytics.query` over a fixed ten-day data set) and the Business Profile APIs through WP9's in-memory fake
  (`apps/worker/test/fakes/google-business-profile.ts`: accounts, locations, reviews, Performance; quota 0 switchable).
- `GET /__fake/state` on the Google port reports every website request, every WordPress call and write, every Google
  call and the data sets; `POST /__fake/wordpress/edit-on-next-read` edits a page "in WordPress" just before the
  worker's next single-page read; `POST /__fake/business-profile` switches quota 0 off.

**Test hooks** (both in `packages/config`, both ignored unless `NODE_ENV=test`; `.env.example`, `docs/deployment.md`):

- `GOOGLE_API_BASE_URL` (`googleApiUrl`): the consent screen address in the connect route, the token exchange in the
  callback, and the worker's Google calls (`apps/worker/src/lib/google/address.ts`) go to the fake. Unit tests:
  `packages/config/test/env.test.ts`, `apps/worker/test/google-address.test.ts`.
- `WEBSITE_FIXTURE_BASE_URL` (`testOnlyWebsiteFixture`): must be a plain `http://<dotted name>:<port>` (never an IP,
  `localhost`, https or a path). The worker's crawler and WordPress transport (`websiteFetchPolicy` in
  `apps/worker/src/website/deps.ts`) then map exactly that host name to 127.0.0.1 at that port without a DNS look-up;
  loopback in general and every other private address stay refused. The web app accepts `http://` for exactly that
  WordPress host (`checkedWordPressBaseUrl`, called by `saveWordPress`; the route's schema no longer refuses http by
  itself, so this one rule decides). `apps/web/test/website.test.ts` proves that with the variable set but NODE_ENV
  production or development the fixture name over http is refused with the https message (and over https is looked up
  and refused as private), and that under test only that exact name, without a port, skips the rule;
  `apps/web/test/website.integration.test.ts` still sees `http://`, `ftp://` and the fixture name refused without the
  setting. `apps/worker/test/website-fixture-policy.test.ts` proves it is inert in production and development
  (the strict default policy, the fixture name refused even when it resolves to the local server, nothing sent) and
  that under test `127.0.0.1`, `::1`, `10.x`, `169.254.169.254`, `localhost`, the www twin, a look-alike name and the
  fixture's own port in the address are all still refused before connecting.

**What it covers** (database rows are read only where the UI cannot show them):

- *Before setup*: the checklist asks for the website address; "This is my business's own website" cannot be ticked and
  "Check my website" is disabled (with the reason) until the address is saved in Settings → Business and the box is
  ticked; a new address needs the box ticked again. The Search Console and Business Profile performance cards show no
  number, zero or "—" before connecting, nothing is stored, and "Reviews on Google" says "Not connected".
- *Refused addresses*: first the fixture's own loopback address and port, `http://127.0.0.1:<fixture port>/`, where it
  really answers: the checklist says it isn't a plain web address, the ownership box and "Check my website" stay
  disabled, the server refuses both the ownership confirmation and a check started through the API (400, two
  deliberate console errors), no check is stored and the fixture (front and inner server) receives nothing. Then
  `http://127.0.0.1/`, a private address on a standard port, so the crawler's own private-address guard decides:
  the check finishes with "site unreachable … private or reserved address", reads no page, records a request count
  of 0 and the page says the pages could not be checked. (Nothing listens on 127.0.0.1:80 here, so for this one the
  proof is the guard's reason and the request count, not the fixture's request log.) The five-minute pause between
  checks is then skipped by moving that check's finish time back in the database (the only write).
- *The fixture check*: progress reads "Checking your website" and no raw job type name appears anywhere; the
  fixture's known issues are all found (noindex, duplicate and long titles, invalid JSON-LD, wrong phone number, large
  and oversized images without dimensions, broken internal link, soft 404, bad sitemap URLs, redirect chain, no https,
  missing descriptions) and listed by title; "Everything we found" runs from most to least urgent and "Do these first"
  starts with the most urgent; at most 25 pages are read ("We stopped at 25 pages"), `/private/` (robots.txt) is
  never requested and the 400-request budget holds.
- *Without WordPress*: the phone-number correction shows exactly `(03) 9876 5432` → `03 9499 1234`; "Apply to website"
  is disabled with the reason; "Copy steps" names the page and the exact text; nothing contacts WordPress.
- *WordPress*: connected in Settings → Integrations → Website editing; the read-only check only reads (live site);
  the Application Password is not in the page, the field is empty after saving, and no app response afterwards
  (pages, API, server components; bodies read within 10 s, about 170 of 390 per run, the rest being cancelled
  prefetches or streams the browser dropped) contains it or a Google token. The change is edited ("Written by you"), the
  confirmation shows the destination, the page and exactly the edited before/after, nothing is written before
  "Apply now", the worker writes once, the fake's page and the public page show the new text ("confirmed on the
  public page"), and the change moves to Done. A second apply is refused (409) and a re-delivered
  `website.edit_apply` job (`apps/web/e2e/enqueue-job.ts`) claims nothing: still one write. For the home page change,
  the page is edited in WordPress after approval and before the write: the change is "Not applied" because the page
  changed, and nothing is written.
- *Search Console*: "Connect Search Console" goes through the real connect route, the fake consent screen and the
  callback (read-only scope only, offline, PKCE); the owner chooses between the two readable properties; the sync
  stores exactly the fake's rows; the card is labelled "Source: Google Search Console (property). Data up to <last
  day>" with "Last 28 days" selected, and the local searches tile and the "barber ivanhoe" row show the fake's sums.
- *Business Profile*: connected from Reviews → Reviews on Google with the Business Profile scope only. With quota 0
  the sync ends normally, the tab says "Waiting for Google" with the approval message (no error), Google was called
  once (one 429) and nothing is queued to retry; the Performance card shows no numbers. After "approval" and "Check
  again", the three reviews show as written (reviewer, stars, text, date, the reply on Google), labelled as from
  Google Business Profile, without review-request status words, and absent from the Requests tab. Over the whole
  run Google answers quota 0 exactly once. Performance tiles
  show the fake's sums; bookings (listed without values) and message clicks (not sent) show "—", are stored as NULL
  or not at all, and never as 0.
- *Layout*: Website and Reviews at 390 and 1440 px have no horizontal overflow, no cut-off card titles, and the
  two connection cards (Google Search Console, Website editing) are both there with their titles on one line.
- No page or console errors except the deliberate ones: the ownership confirmation and the check start refused for the
  fixture's loopback address (400, see above) and the second "Apply" of an applied change (409).

**Not verified without the owner's real accounts.** The fakes answer the documented happy path at once. Unproven
until the owner's own site and accounts are used: how the real site behaves under the crawler (false positives,
caching, a real robots.txt, https), which builder it uses and whether WordPress Application Passwords work on its host
(security plugins, the REST API, Basic auth headers, revisions), the real Google consent screen (unverified-app
warning, Testing vs Production), the Search Console property type and the share of anonymised queries, Google's Basic
API Access approval for Business Profile (not guaranteed), real review shapes and the page-2 issue, and the Performance
request parameters, response nesting and retention (website design §12.3, email design §11). See the WP8 and WP9
smoke tests above.
