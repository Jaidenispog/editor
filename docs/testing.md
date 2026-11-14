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
`E2E_PORT`, `E2E_WORK_DIR`.

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
  "Export full quality" is refused with the licence message (a deliberate 409) and starts nothing; "Make a music-free
  version" exports a 1080×1920 file without a music stream (ffprobe); no `music_usage` row. After "Licence details" →
  "I made it, or I own the recording" with the rights confirmation, the standard export works (AAC stereo music) and
  exactly one `music_usage` row (`export`, owner_upload snapshot) exists.
- Meta-only music: a Meta Sound Collection track is locked to Instagram/Facebook; after the Sound panel switches one
  edit to it, the composer offers TikTok only "Without music" ("With music" disabled) and labels Instagram "For
  Instagram/Facebook upload only".
- Manual posting: the composer starts empty ("Nothing is picked for you"), no edit is ticked in the picker, and both
  platform switches start off. One exported edit goes to Instagram as "Post it yourself": the destination is "Your
  turn" (not posted, no `publish` feedback and no ledger row) until "I've posted it"; the download is the 1080×1920
  file with music and the caption to copy is the one written. After confirming it reads "Posted (you confirmed)" and
  one `publish` feedback event and one `music_usage` (`publish`, instagram) row exist.
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
- No page errors or console errors except the two deliberate 409s above (each must actually appear).

**Not verified without real accounts.** Everything Meta-specific stays unproven until the owner's own accounts are
used (publishing design §11.4 and the WP5 notes above): whether a Unified Login system-user configuration may publish
in Development mode and search hashtags, the real permission names, the resumable size limit, quota and token expiry,
`thumb_offset`, Sound Collection copyright matching, real container processing times and errors, and how Instagram
renders the reel. The fake answers the documented happy path immediately. Manual posting in the real Instagram and
TikTok apps, Web Share on iOS, the YouTube chart (no key), and how learned defaults feel after weeks of real use are not
covered either; all footage and music are synthetic.
