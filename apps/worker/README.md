# @studio/worker

Background process that does all long-running work for Studio Assistant so the web app stays responsive.

```
pnpm --filter @studio/worker dev     # watch mode
pnpm --filter @studio/worker start   # production (tsx, no build step)
```

Configuration comes from the repository-root `.env` (shared with the web app); variables already set in the
process environment win. Relative `STORAGE_LOCAL_ROOT` and `WORKER_TMP_DIR` resolve against the repository root.
With `AI_PROVIDER=none` (or no `ANTHROPIC_API_KEY`) the deterministic rules planner from `@studio/ai` plans every
edit and shots keep heuristic labels (the owner's manual tags unlock the label-dependent styles).

On start the worker logs `worker started` with `queues` (every job type below), the AI set-up (`ai.plannerName`
etc.), the storage driver and the temp root. It refuses to start if any job type has no handler.

## Jobs

| Queue | Handler | What it does |
| --- | --- | --- |
| `ingest.asset` | `handlers/ingest.ts` | probe → upright SDR proxy → thumbnail → scenes → quality → audio → sampled frames → labelling → optional transcription |
| `edits.generate` | `handlers/generate.ts` | plans one edit per chosen style (AI planner with validation/repair, rules planner fallback) and queues previews |
| `edits.revise` | `handlers/generate.ts` | plans a new version from an instruction (revise) or a fresh take (regenerate); older versions untouched |
| `render.preview` | `handlers/render.ts` | 540×960 preview from the proxies |
| `render.export` | `handlers/render.ts` | 1080×1920 H.264/AAC export from the originals, only when asked |
| `music.analyse` | `handlers/music.ts` | duration, BPM and beat grid for uploaded music |
| `maintenance.cleanup` | `handlers/cleanup.ts` | hourly: temp folders older than 24 h (e.g. left by a crash), abandoned uploads |

## Reliability model

- `lib/job-tracker.ts` mirrors each attempt into the `jobs` table: attempts, progress, message, a heartbeat every
  10 s, and turns the owner's cancel flag into an `AbortSignal` (combined with pg-boss's own signal) that kills FFmpeg.
- **Owner cancel vs interruption.** When work stops, `stopOutcome(run)` tells handlers why:
  - the owner cancelled (cancel flag set, also when pg-boss's abort arrives first) → `cancelled` rows and
    "… cancelled" states;
  - the queue stopped the attempt (shutdown grace expired, `expireInSeconds` reached, claim lost) → the row goes
    back to `queued` with "Interrupted when the worker stopped; it will resume automatically", the asset/version
    keeps its in-progress state, and `JobInterruptedError` is rethrown so pg-boss retries the job. On the last
    attempt the row, asset or version is marked failed with a plain "please retry" message instead.
- **Crash recovery.** A worker killed outright stops heart-beating. Every 30 s (and at start-up) the worker sweeps
  `running` rows whose heartbeat is older than 45 s back to `queued` with the message above (or `failed` when
  pg-boss has already given up on the job). pg-boss itself fails the attempt once its own 60 s heartbeat lapses
  (checked by its supervisor every 60 s) and retries after `retryDelay × (1 + random)` (15–30 s for ingest). A
  live worker whose row was swept while the database was briefly unreachable puts its row back to `running` on
  its next heartbeat.
- **Graceful stop.** SIGTERM/SIGINT → pg-boss stops fetching and waits up to 30 s for active jobs; anything still
  running is failed (retried later) and aborted; interrupted handlers get up to 10 s to record their state; then
  the database pool closes and the process exits (hard exit after 45 s). The `start` script uses `exec` so a
  SIGTERM sent to `pnpm` reaches the worker; run the worker as the container's main process with an init (e.g.
  `docker run --init` / tini) so signals are forwarded.
- Handlers are idempotent (fixed storage keys per asset/version; planning only redoes versions still `planning`)
  and clean their temp directory in `finally`. A hard kill leaves the attempt's temp folder behind; the hourly
  cleanup removes it once it is 24 h old.

### Measured on this sandbox (synthetic footage, local Postgres, 2026-11-14)

- Boot: `worker started` with all seven queues; SIGTERM to `pnpm --filter @studio/worker start` → `worker stopping`
  → `worker stopped`, process group gone in ~1.3 s. Before the `exec` change the SIGTERM killed only pnpm and its
  shell, leaving the worker running as an orphan.
- Real queue: an ingest enqueued with `enqueueTracked` (jobs row + pg-boss job) ran to `succeeded` and the asset to
  `ready` in ~3 s.
- SIGTERM while an ingest was running: the worker waited, the job succeeded, the process exited after ~6 s.
- `kill -9` of the whole process group during an ingest (HEVC HLG clip, at ~15 %), restarted immediately:
  the row read `running` until the sweep at 63 s set it to `queued` ("will resume automatically"); pg-boss marked
  the attempt for retry at about the same time (60 s heartbeat + supervisor pass), started attempt 2 at 87 s
  (24 s backoff) and the job succeeded at 91 s (an earlier run without the sweep: 95 s). Expect roughly 75–150 s
  of recovery delay plus the job's own run time; shortening `heartbeatSeconds`/`superviseIntervalSeconds` in
  `@studio/queue` would shrink it.

## Tests

```
TEST_DATABASE_URL=postgres://... pnpm --filter @studio/worker test               # unit tests (tracker needs a database)
TEST_DATABASE_URL=postgres://... pnpm --filter @studio/worker test:integration   # full pipeline on synthetic footage
```

`TEST_DATABASE_URL` is an admin URL: each test file creates and drops its own throwaway database. The integration
test needs ffmpeg/ffprobe and the synthetic clips from `scripts/make-sample-footage.sh` (generated on demand). It
covers, at the handler level with a stub queue: ingest (rotated HEVC HLG → upright SDR proxy, a clip without
audio), manual clip tags unlocking label-dependent styles, five distinct plans, five previews whose length matches
the timeline, a revision to 15 s that leaves every other version untouched, a 1080×1920 export, an owner-cancelled
export, an export interrupted by a worker shutdown that waits to resume and then finishes, an owner-uploaded music
track (≈120 BPM detected, licence confirmed) driving a beat montage whose hard cuts all land within 60 ms of a beat
(also after frame quantisation) and a before/after edit, both previews with an AAC stereo soundtrack, and honest
refusals for footage that is too short or has no video.

Synthetic footage proves the pipeline mechanics only; it is not a substitute for real haircut clips.
