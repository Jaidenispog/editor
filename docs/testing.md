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
