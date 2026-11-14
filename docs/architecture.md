# Studio Assistant — architecture

Private web app for a barber studio in Ivanhoe, VIC. Australian English, AUD, `Australia/Melbourne`.

## Shape

```
apps/web        Next.js 16 (App Router, React 19, Tailwind v4). UI + JSON API + signed media serving. Never renders video.
apps/worker     Node 22 process. Consumes pg-boss jobs: ingest → analyse → plan → render (FFmpeg + libass). Long work lives here.
packages/core   Pure TypeScript contracts: Zod schemas (EditPlan, analysis, settings, jobs), validator, timeline maths, styles, safe zones.
packages/db     Drizzle ORM schema + SQL migrations (PostgreSQL; identical on local Postgres and Supabase).
packages/queue  Thin wrapper over pg-boss (durable queue in Postgres: retries, expiry, heartbeats, cancellation).
packages/storage BlobStore interface: LocalDiskStore (dev / single server) and S3Store (Supabase Storage S3, R2, S3). Expiring links only.
packages/media  FFmpeg/ffprobe wrappers, footage analysis (scenes, quality, audio, beats) and the plan → filtergraph renderer.
packages/ai     Provider abstraction: vision labelling, edit planning, transcription. Anthropic implementation + deterministic rules fallback; Deepgram (recommended) or OpenAI whisper-1 speech-to-text.
packages/config Typed environment (Zod). Secrets never leave the server.
```

## Data flow (Stage A)

1. Browser uploads originals in 8 MiB parts (`upload_sessions`) → `media_assets` row → `ingest.asset` job.
2. Worker ingest: `ffprobe` (rotation, HDR, HEVC, audio) → proxy (960p SDR, auto-rotated, tonemapped) → thumbnail → scene detection → quality metrics → audio analysis → sampled frames → vision labelling (if configured) → optional transcription when speech is likely → `media_assets.analysis`.
3. Owner presses **Generate 5 edits** → `generations` row + `edits` (one per chosen style) + `edit_versions` v1 → `edits.generate` job.
4. Worker planning: builds the planner input (analyses, manual tags, music beats, preferences, brand) → planner (Anthropic structured output, or rules planner) → `validateEditPlan` against real footage bounds → repair loop → stores plan → enqueues `render.preview` per version.
5. Worker render: compiles the validated plan to one FFmpeg filtergraph (trim/speed/crop/zoom/colour/transitions + ASS text overlay + music/original sound mix + loudness) → 540×960 preview → uploaded to storage → `preview_ready`.
6. Revise/regenerate creates a **new version** (old versions stay). Export renders 1080×1920 H.264/AAC MP4 only for the versions the owner asks for.

## Durability

- pg-boss queues per job type with `retryLimit`, `expireInSeconds` and `heartbeatSeconds` (30 s). A worker that dies stops heart-beating; the worker's pg-boss supervisor (every 30 s) fails the attempt and it is retried → restart recovery.
- `jobs` table mirrors every job for the UI (progress, message, cancel flag). Cancel = flag + `boss.cancel` → the worker's `AbortSignal` kills FFmpeg.
- Handlers are idempotent: re-running ingest or render overwrites the same storage keys; planning skips versions that already have a plan.
- Per-job temp dirs under `WORKER_TMP_DIR`, removed in `finally`; an hourly cleanup job removes orphans.

## Security

- Owner/staff accounts, Argon2id password hashes, opaque session cookies (hash stored), sliding 30-day expiry, login rate limiting.
- All media behind authentication; browsers only receive expiring links (S3 presigned or HMAC-signed `/api/media/<token>` for the local driver).
- Uploaded content and model output are data: plans are validated, captions must exist in the transcript, text is length-limited.
- OAuth tokens for integrations encrypted at rest (AES-256-GCM, key derived from `APP_SECRET` unless `APP_ENCRYPTION_KEY` is set).
- Webhooks (Square) verified by signature before processing; events stored idempotently.

## Stages

- **A** (this milestone): upload, analysis, five previews, revise/regenerate with history, full-quality export.
- **B**: music controls and licensing model, saved preferences/feedback, publishing (Instagram/TikTok) with honest fallbacks.
- **C**: Square appointments, email, review requests, website/local search tools.
