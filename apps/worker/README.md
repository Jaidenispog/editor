# @studio/worker

Background process that does all long-running work for Studio Assistant so the web app stays responsive.

```
pnpm --filter @studio/worker dev     # watch mode
pnpm --filter @studio/worker start   # production (tsx, no build step)
```

## Jobs

| Queue | Handler | What it does |
| --- | --- | --- |
| `ingest.asset` | `handlers/ingest.ts` | probe → upright SDR proxy → thumbnail → scenes → quality → audio → sampled frames → labelling → optional transcription |
| `edits.generate` | `handlers/generate.ts` | plans one edit per chosen style (AI planner with validation/repair, rules planner fallback) and queues previews |
| `edits.revise` | `handlers/generate.ts` | plans a new version from an instruction (revise) or a fresh take (regenerate); older versions untouched |
| `render.preview` | `handlers/render.ts` | 540×960 preview from the proxies |
| `render.export` | `handlers/render.ts` | 1080×1920 H.264/AAC export from the originals, only when asked |
| `music.analyse` | `handlers/music.ts` | duration, BPM and beat grid for uploaded music |
| `maintenance.cleanup` | `handlers/cleanup.ts` | hourly: orphaned temp folders, abandoned uploads |

## Reliability model

- `lib/job-tracker.ts` mirrors each attempt into the `jobs` table: attempts, progress, message, heartbeat every 10 s,
  and turns the owner's cancel flag into an `AbortSignal` (combined with pg-boss's own signal) that kills FFmpeg.
- pg-boss retries attempts (`retryLimit`, `expireInSeconds`, `heartbeatSeconds` in `@studio/queue`). On start-up
  `recoverStaleJobs` re-queues or fails rows that a dead worker left as "running".
- Handlers are idempotent (fixed storage keys per asset/version) and clean their temp directory in `finally`.

## Tests

```
pnpm --filter @studio/worker test                                   # unit tests (tracker needs TEST_DATABASE_URL)
TEST_DATABASE_URL=postgres://... pnpm --filter @studio/worker test:integration   # full pipeline on synthetic footage
```
