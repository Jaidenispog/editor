# HANDOVER — read this first (written 2026-11-12 by the previous Claude session)

This file exists so a new model/session can continue **exactly** where the last one stopped. Read it top to
bottom before touching code. Then read `CLAUDE.md`, `docs/architecture.md`, `docs/api.md`,
`docs/research/decisions-summary.md`.

## Continuing in the SAME Claude Code session?

History of the background runs:
1. The first implementation run (`docs/handover/phase1-implementation-workflow.js`) finished the media analysis and
   renderer, then stopped on 2026-11-13 when the account hit its 5-hour usage limit. The AI package, web foundation
   and dev-ops agents never wrote anything.
2. On 2026-11-14 the work was relaunched as `docs/handover/stage-a-retry-workflow.js`: AI package → worker
   integrator (typecheck, unit + integration tests, music case, real boot and kill -9 recovery test) → dev-ops/docs,
   in parallel with web foundation → Video Studio UI, then an end-to-end browser test. The research run was resumed
   for its three missing topics plus critique and synthesis.

3. Also on 2026-11-14, `docs/handover/stage-a-hardening-workflow.js` started three agents in **separate git worktrees**
   (safe zone + export preset; Studio gaps + music start point; Deepgram transcription + queue/db tuning). Each
   commits on its own worktree branch and reports the branch and SHA; the lead session merges them into
   `claude/blissful-lamport-f1lndn` after the end-to-end browser test agent (main checkout) has finished.

4. Also on 2026-11-14, `docs/handover/stage-bc-design-workflow.js` started five design agents (publishing,
   preferences/music/trends, Square, email + reviews, website/local search) writing `docs/design/*.md`, then a lead
   architect writing `docs/design/stage-bc-plan.md` (ordered, conflict-free work packages). Design only: no code.
   Stage B/C implementation starts from that plan after the Stage A merges.

Check the task list or `/workflows` first. **While a run is alive, do not edit `packages/ai`, `apps/web`,
`apps/worker` or the root dev-ops files yourself**: its agents are writing them. Agents never commit; the lead
session reviews and commits their output. If no run is alive, compare the repo with the run's goals (each agent
returns a structured report in the workflow journal) and re-launch only the missing pieces from `docs/handover/`.

## 0. First commands in a fresh session

```bash
cd /home/user/editor
git status                      # agent processes may have written files after the handover commit — keep them, review them
pnpm install                    # node_modules were present in the sandbox; a fresh clone needs this
bash scripts/make-sample-footage.sh data/samples   # synthetic test clips (data/ is gitignored)
pnpm -r typecheck               # expect: everything passes EXCEPT apps/worker (needs @studio/ai) and apps/web (not started)
pnpm -r --no-bail test          # core 21, db 3, storage 5, media 63, worker 3 (+5 skipped unless TEST_DATABASE_URL is set)
```

Local Postgres used in the sandbox (no Docker daemon available there). In a fresh container run the `initdb`
block once; afterwards only `pg_ctl … start`:
```bash
mkdir -p /var/lib/postgresql/sa-test && chown postgres:postgres /var/lib/postgresql/sa-test
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/sa-test/data -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/sa-test/data -o '-p 55432 -k /tmp -c listen_addresses=127.0.0.1' -l /var/lib/postgresql/sa-test/log start"
export DATABASE_URL=postgres://postgres@127.0.0.1:55432/studio_assistant
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres
psql -h 127.0.0.1 -p 55432 -U postgres -c "create database studio_assistant"   # first time only
pnpm db:migrate
```
A `.env` (gitignored) with these values existed at the repo root; recreate it from the list in section 6 if missing.
The dev-ops agent was meant to write `scripts/local-postgres.sh` and `.env.example` — **they do not exist yet**.

## 1. What the product is (unchanged spec)

Private web app "Studio Assistant" for a barber in Ivanhoe VIC (Australian English, AUD, Australia/Melbourne).
Highest priority: drop phone haircut videos into a project → choose length/style/music → "Generate 5 edits" →
five genuinely different 9:16 previews → revise/regenerate each independently with version history → export real
1080×1920 MP4. Later stages: music licensing/controls, Instagram/TikTok publishing, Square appointments, email,
Google review requests, website/local-search tools. The owner's full specification is reproduced in section 9.

Build order agreed: **Stage A** (upload → analysis → five previews → revise → export) must pass the acceptance
test before Stages B/C. Never present simulated data as real; show honest "needs setup" states.

## 2. State of the repository at handover (commit history on `claude/blissful-lamport-f1lndn`)

| Area | Status | Evidence |
| --- | --- | --- |
| `packages/core` — contracts (EditPlan schema, validator, timeline maths, 5 styles, analysis types, jobs, revision parser, music licence, settings, safe zones) | **Done, tested** | 21 unit tests pass |
| `packages/config` — typed env (Zod) | Done | typechecks |
| `packages/db` — Drizzle schema (29 tables incl. Stage B/C), `drizzle/0000_init.sql`, client, migrate, seed, AES-GCM token crypto | **Done, tested** | migration applied to local PG; 3 tests |
| `packages/storage` — BlobStore: LocalDiskStore + S3Store (Supabase/R2/S3), HMAC signed links, multipart | **Done, tested** | 5 tests |
| `packages/queue` — pg-boss 12 wrapper (per-type retry/expiry/heartbeat) | Done | typechecks; verified against installed types |
| `packages/media` — ffmpeg/ffprobe, analysis, renderer | **Done, tested** | 64 tests; cut-then-transition fix |
| `apps/worker` — job tracker, handlers, recovery | **Done, tested** | 11 unit + 12 integration tests (synthetic footage, incl. music beat alignment); kill -9 recovery verified |
| `packages/ai` — rules planner, Anthropic planner/labeller, transcription | **Done, tested** | 60 tests; real Anthropic/OpenAI APIs not yet called (no keys) |
| `apps/web` — shell, auth, settings, Video Studio, API | **Done, tested** | 77 tests; build passes; end-to-end browser test 51/51 (`apps/web/e2e/run-stage-a.sh`) |
| Dev-ops/docs — compose, Dockerfiles, scripts, docs | Done | scripts tested; Docker images not built (no daemon here) |
| Research | **Complete** (12 topics, critique, 8 follow-ups). Read `docs/research/platform-constraints.md` (supersedes `decisions-summary.md` where they differ) | memo + raw findings in `docs/research/` |
| CI | `.github/workflows/ci.yml` written (untested in GitHub) | |

**Stage A status (2026-11-14): passes its acceptance checks on synthetic footage only. It has NOT been validated on the owner's real haircut clips, and no AI key has been used yet.** Screenshots: `docs/screenshots/`.

## 3. Background agents that were running when the session ended

Two workflows (Claude Code `Workflow` tool) were in flight. Their scripts are saved verbatim in `docs/handover/`.

1. `phase1-implementation-workflow.js` — five parallel implementation agents. Only **media-analysis** and
   **media-render** had started (sandbox allowed 2 concurrent agents); both had produced working code when this
   file was written (typecheck + 63 tests green). **ai-package, web-foundation, devops-docs never started.**
   To continue: either re-run the script with the `Workflow` tool (edit it to drop the two media agents if their
   work is complete) or implement those three prompts directly. The prompts are complete specifications —
   follow them literally; they encode decisions already made (SDK usage, routes, design, safety rules).
2. `platform-research-workflow.js` — 12 research topics + critique + follow-up + synthesis into
   `docs/research/platform-constraints.md`. 9 topics finished and are saved in `docs/research/`. Missing: **transcription, trend sources, Anthropic vision limits**, plus the
   critique/synthesis stages (they write `docs/research/platform-constraints.md`).
   Re-run the script (the journal cache does not survive a new session) or run only the missing topics by hand.

Agents may have kept writing to `packages/media/**` after the last commit; `git status` shows whether. Review
any such files before committing (they are agent-generated).

## 4. Contracts the worker assumes from `@studio/ai` (implement exactly, or adjust the worker)

`apps/worker` imports these from `@studio/ai` (see `src/handlers/ingest.ts`, `generate.ts`, `lib/planning.ts`,
`lib/plan-context.ts`, `main.ts`, `test/pipeline.integration.test.ts`):

```ts
createAiProviders(env: Env, logger?: Logger): {
  planner: EditPlanner;            // AnthropicPlanner when AI_PROVIDER=anthropic, else RulesPlanner
  rulesPlanner: EditPlanner;       // always the deterministic RulesPlanner
  labeler: VisionLabeler | null;   // AnthropicVisionLabeler or null
  transcriber: Transcriber | null;
  describe(): { plannerName: string; plannerModel: string | null; labelerModel: string | null; transcriberName: string };
}
class HeuristicLabeler implements VisionLabeler  // model: null; returns 'unknown' labels
interface VisionLabeler { name: string; model: string | null;
  labelShots(input: { frames: FrameForLabelling[]; context: { clipName; clipDurationSec; projectNotes; clipIndex; clipCount } }, opts?: { signal?: AbortSignal })
    : Promise<{ results: ShotLabelResult[]; usage: AiUsage | null }> }
interface FrameForLabelling { assetId; shotId; timeSec; jpegPath; width; height }
interface ShotLabelResult { shotId; label: SegmentLabel; confidence; description; framing: 'closeup'|'medium'|'wide'|'unknown'; focus: {x,y}|null; issues: string[] }
interface EditPlanner { name: string; model: string | null;
  planEdit(input: PlannerInput, opts?: { signal? }): Promise<{ plan: unknown; usage: AiUsage | null; source: 'ai' | 'rules' }> }
interface PlannerInput { styleId; targetDurationSec; analyses: AssetAnalysis[]; assets: PlanAssetInfo[];
  music: { trackId; durationSec; bpm: number|null; beatTimesSec: number[]; title } | null; preferences: EditingPreferences;
  brand: BrandConfig; businessName; instructions; keepOriginalSound: 'auto'|'always'|'never'; captions: 'auto'|'never';
  attempt: number; previousPlan?: EditPlan; revisionInstruction?: string; revisionHints?: RevisionHints; previousErrors?: PlanIssue[] }
interface Transcriber { name; transcribe(audioPath, opts?: { language?; signal? }): Promise<{ provider; language: string|null; segments: TranscriptSegment[] }> }
interface AiUsage { provider; model; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; durationMs; estimatedCostUsdCents }
```
The worker does its own validate→repair→fallback loop (`apps/worker/src/lib/planning.ts`), so the AI package's
optional `planWithRepair` helper is not required.

Anthropic SDK facts verified against the installed `@anthropic-ai/sdk@1.6.0`: `client.messages.parse({ model,
max_tokens, system: [{type:'text', text, cache_control:{type:'ephemeral'}}], messages, output_config: { format:
zodOutputFormat(Schema), effort } })` → `response.parsed_output`; `zodOutputFormat` from
`@anthropic-ai/sdk/helpers/zod`; zod peer `^3.25 || ^4`. Models: planner default `claude-opus-5-5`, vision
default `claude-haiku-5-5` (cheap bulk labelling), configurable via env. Never send temperature/thinking/tool_choice forcing.

## 5. Media package API the worker uses (already implemented by the agents — names verified)

`makeProxy(input, output, { probe, maxHeight, ffmpegPath, signal, onProgress })`, `makeThumbnail`,
`extractFrames(input, times, outDir, { probe, longEdge, ffmpegPath, signal })`, `detectScenes(input, { probe, … })`,
`measureQuality(input, shots, { probe, … })`, `analyseAudio(input, { probe, … })`, `analyseMusic(input, { probe, … })`,
`assembleShots(assetId, scenes, qualities)`, `chooseFrameTimes(shots, { maxFrames })`,
`renderEditPlan(inputs: RenderInputs, outputPath)` with `RenderInputs = { plan, assets: Record<id,{path,probe}>, music,
transcripts?, quality: 'preview'|'export', output?, brand, fontsDir, tmpDir, ffmpegPath?, threads?, signal?, onProgress? }`.
Previews render from the 540×960 SDR proxies; exports from the originals (HDR tonemap + autorotate handled in the graph).

## 6. Environment variables (from `packages/config/src/index.ts`)

NODE_ENV, LOG_LEVEL, APP_URL, DATABASE_URL, QUEUE_DATABASE_URL?, APP_SECRET (≥32 chars), APP_ENCRYPTION_KEY?,
STORAGE_DRIVER=local|s3, STORAGE_LOCAL_ROOT, S3_ENDPOINT/S3_REGION/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_FORCE_PATH_STYLE,
MEDIA_LINK_TTL_SECONDS, MAX_UPLOAD_BYTES, WORKER_TMP_DIR, WORKER_CONCURRENCY, FFMPEG_PATH, FFPROBE_PATH, FFMPEG_THREADS,
AI_PROVIDER=none|anthropic, ANTHROPIC_API_KEY, AI_PLANNER_MODEL, AI_PLANNER_EFFORT, AI_VISION_MODEL, AI_VISION_MAX_FRAMES_PER_CLIP,
DB_POOL_MAX?, QUEUE_POOL_MAX?, TRANSCRIPTION_PROVIDER=none|deepgram|openai, DEEPGRAM_API_KEY, DEEPGRAM_MODEL (nova-3),
OPENAI_API_KEY, OPENAI_TRANSCRIPTION_MODEL, META_APP_ID/SECRET, TIKTOK_CLIENT_KEY/SECRET,
SQUARE_APPLICATION_ID/SECRET, SQUARE_ENVIRONMENT, SQUARE_WEBHOOK_SIGNATURE_KEY, RESEND_API_KEY, EMAIL_FROM, GOOGLE_CLIENT_ID/SECRET.
Sandbox `.env` used: DATABASE_URL=postgres://postgres@127.0.0.1:55432/studio_assistant, APP_SECRET=dev-only-…,
STORAGE_DRIVER=local, STORAGE_LOCAL_ROOT=./data/storage, WORKER_TMP_DIR=./tmp/worker, AI_PROVIDER=none.

## 7. Exact next steps, in order

1. **Implement `packages/ai`** from the `AI` prompt (rules planner is the critical path: it must yield five valid,
   distinct plans with no API key). Then `pnpm --filter @studio/worker typecheck` must pass.
2. **Run the Stage A worker acceptance test**: `TEST_DATABASE_URL=… pnpm --filter @studio/worker test:integration`
   (`apps/worker/test/pipeline.integration.test.ts`: ingest incl. rotated HEVC HLG + silent clip → manual tags →
   five styles planned → previews → revise to 15 s without losing versions → 1080×1920 export → interrupted job →
   incomplete footage). Fix whatever fails. Synthetic footage only — say so in the README.
3. **Web foundation** (`WEB_FOUNDATION` prompt) then **Video Studio UI** (routes in `docs/api.md`): chunked resumable
   uploads (8 MiB parts, `upload_sessions`), status polling (`/api/projects/[id]/status` every 3 s), clip cards with
   thumbnails, manual tags (Before/Cutting/Fade detail/Result/Reaction), style support shown with reasons, duration
   slider (8–90, default 25), music picker (upload with licence form + offset slider over the `beats.energy` curve),
   "Generate 5 edits" (creates generation + 5 edits + v1 versions status `planning`, enqueues `edits.generate`), five
   preview cards (video player on a signed URL, style description, favourite, revise with instruction box,
   regenerate, version switcher, export → download), job progress with cancel/retry, honest empty/error states.
   Project delete must remove storage prefix. Keep Video Studio the main destination; charcoal/white + accent colour.
4. **Dev-ops/docs** (`DEVOPS_DOCS` prompt): compose, Dockerfiles, `.env.example`, `scripts/local-postgres.sh`,
   deployment/costs/testing/security docs, README with Completed / Verified on synthetic footage / Waiting on access.
5. **Playwright E2E** (Chromium preinstalled at /opt/pw-browsers/chromium in the sandbox): login → create project →
   upload sample → generate → five previews → export → download → ffprobe the file.
6. Commit + push after each step (`git push -u origin claude/blissful-lamport-f1lndn`).
7. **Stage B/C** following `docs/research/decisions-summary.md` (TikTok = draft/export fallback only; Instagram = Meta
   container flow via unified/Facebook Login for Business with dev-mode owner account; Spotify = reference links only,
   never audio or AI input; Square = tiered capabilities gated at runtime; Google = link-based review requests first;
   Supabase Pro Sydney with S3 protocol storage; music = owner-uploaded "licence passport" + optional provider adapters).
   Finish the missing research topics first (transcription, trend sources, Anthropic vision limits).

### Research-driven changes still to apply (after the current agent run finishes)

1. **Safe zone. DONE.** `packages/core/src/safe-zones.ts` now holds the researched model at 1080x1920:
   R_strict x 120–780, y 270–1248 (all text by default); R_head x 120–960, y 270–840 (boxes ending at y ≤ 840);
   forbidden areas y < 270, y ≥ 1248, x < 120, x ≥ 960 and the action column x ≥ 780 where y ≥ 840; subtitles
   centred on x 540, ≤ 480 px wide, bottom ≤ 1248, ≥ 56 px type. `safeZoneFor`/`scaleSafeZone` scale it (previews
   halve exactly). `packages/media/src/render/ass.ts` (`layoutAssDocument`) wraps and sizes text itself from
   conservative font metrics so every box, outline, shadow, pop scale and rise travel included, stays in its region;
   `top` text uses R_head when it fits above y 840. Tests: `packages/core/test/safe-zones.test.ts` (region maths),
   `packages/media/test/render-ass.test.ts` (layout) and `render.test.ts` (libass every frame over grey at both sizes,
   plus a real preview pixel diff with zero changed pixels in every forbidden area). See `packages/media/README.md`.
   Consequence: captions at 56 px in 480 px hold about 10–16 characters per line, so a long caption takes 3+ lines;
   splitting long captions into timed pages is a possible follow-up.
2. **Transcription. Done (adapter); VAD gate still open.** OpenAI `whisper-1` is scheduled to shut down on 26 Feb
   2027 and newer OpenAI models give no documented timestamps. `packages/ai/src/transcription/deepgram.ts` now
   calls Deepgram's pre-recorded `POST /v1/listen` (Nova-3, `smart_format`, `punctuate`, `utterances`, header
   `Authorization: Token …`, raw audio bytes with their content type) and maps utterance words to caption-sized
   segments (≤ 42 characters per line, ≤ 2 lines, ≥ 0.7 s on screen, real word timings only; low-confidence
   segments dropped). `TRANSCRIPTION_PROVIDER=deepgram` + `DEEPGRAM_API_KEY` (+ optional `DEEPGRAM_MODEL`) select
   it; Settings → Integrations shows it as configured or missing. whisper-1 stays as the optional `openai`
   provider. Still to do: the Silero VAD gate (only the DSP heuristic gates today), caching results by asset +
   audio hash so retries do not pay twice, and checking the parser against a recorded live Deepgram response
   (the response nesting of `utterances` was not verified; both places are read).
   Also done in the same change: pg-boss `heartbeatSeconds` 30 on every queue and `superviseIntervalSeconds` 30
   for the worker (existing queues are updated at worker start); optional `DB_POOL_MAX`/`QUEUE_POOL_MAX` with a
   Supabase Micro budget in `docs/deployment.md`; more natural revision phrasings in `parseRevisionInstruction`
   ("turn the music down", "cut it to 15", "half a minute", "no wipes", "keep it simple", "linger on the
   reveal", "start with the finished cut").
3. **Vision requests.** At most 20 images per Claude request; frames at 768 px; no person identification.
4. **Export preset. DONE** (`packages/media/src/render/command.ts`, `verify.ts`): libx264 High, level 4.1 at ≤ 30 fps
   and 4.2 above, CRF 18 with `-maxrate 20M` (24M at 60 fps, 12M over 90 s), yuv420p, progressive, CFR, closed 2 s
   GOP (`-g`/`-keyint_min` 2×fps, `-sc_threshold 0`, `-flags +cgop`), BT.709 tags, AAC-LC 48 kHz stereo, faststart;
   previews keep veryfast/CRF 27 with the same GOP/CFR settings. Renders over 180 s are refused with a plain
   `AppError('VALIDATION')`. Every export is checked with `verifyExport` (ffprobe) and fails with a plain message if
   it does not match. Still open: the worker always exports `VERTICAL_1080` at 30 fps; choosing 60 fps when every
   source is ≥ 50 fps is not wired up (the 4.2 path is ready for it).
5. **Stage B/C approaches changed by the follow-ups:** Spotify links/embeds only (no Web API); TikTok export +
   manual post, optional Zernio provider later; Instagram direct publishing only after a live smoke test; Meta
   Sound Collection tracks locked to Instagram/Facebook renders; Square writes gated on plan, fee-free services and
   a self-test; Postmark (transactional + broadcast streams) for email with a consent ledger.

### Gaps reported by the Video Studio agent (to schedule)

- ~~Staff access~~ **Closed (2026-11-14).** `getAccessibleProject` / `projectVisibilityFilter` / `getAccessibleJob`
  (`apps/web/src/lib/studio-access.ts`) now apply to GET/POST `/api/projects`, GET/PATCH/DELETE `/api/projects/[id]`,
  `/api/projects/[id]/jobs`, `/api/jobs/[id]/cancel|retry`, the dashboard, the project list and the Content
  Library (owner sees all, staff only their own; project-less jobs are the owner's). Tests:
  `apps/web/test/studio-access.integration.test.ts`.
- ~~Music licence confirmation~~ **Closed.** Settings → Music library shows each track's licence status and has a
  "Licence details" form with the explicit rights checkbox (`PATCH /api/music/[id]` `confirmLicence`), plus
  "Upload licensed track" using the Studio uploader (`POST /api/music/uploads`). Remaining limitation: library
  uploads ride on the user's most recent project because `upload_sessions.project_id` is NOT NULL; making it
  nullable (migration) would let a user with no project upload music.
- ~~Not built yet: clip reordering, per-shot tagging, music start-offset picker~~ **Closed.** Move up/down
  (+ Alt + arrows) backed by `POST /api/projects/[id]/assets/order`; an expandable "Shots" panel per clip
  (`GET /api/assets/[id]/shots`, tags via `manualLabels`); `GenerationSettings.musicStartSec` (core) → worker
  `buildPlannerInput` → `PlannerInput.musicStartSec` → rules planner snaps to the first beat at or after it
  (`beatGrid(..., fixedStartSec)`, `snapMusicStart`), the Anthropic planner gets `music.fixedStartOffsetSec` and
  the plan's start is forced to it; the generate route checks it against the track length; the Studio shows BPM,
  the energy curve and an Automatic / slider (mm:ss) picker.
- Local-driver media links carry a readable (HMAC-signed, not encrypted) payload with the storage key; keys hold only
  ids. Encrypt or use opaque references if keys must never reach browsers.

## 8. Decisions already made (do not re-litigate without reason)

- FFmpeg + libass render text (vendored Inter fonts in `assets/fonts`); Remotion not used (licence is free ≤3
  employees, but it adds a Chromium dependency; noted as optional later upgrade).
- Postgres (local or Supabase) + S3-compatible private storage; auth is self-managed (Argon2id, opaque session
  cookies) rather than Supabase Auth so local dev works without Supabase.
- pg-boss 12 for durable jobs; `jobs` table mirrors progress; cancellation is cooperative via AbortSignal; restart
  recovery via heartbeats + `recoverStaleJobs`.
- Plans are validated against real footage (`validateEditPlan`) before rendering; captions must exist in the
  transcript; styles needing before/result/reaction shots are disabled unless the vision model or owner tags provide them.
- Previews from proxies, exports from originals; five previews rendered automatically, exports only on request.
- Default models: planner `claude-opus-5-5`, vision `claude-haiku-5-5`; `AI_PROVIDER=none` → rules planner.
- Sandbox quirks: no Docker daemon; most documentation hosts blocked (use WebSearch); shell cwd resets between
  commands (use absolute paths); keep `.js` suffixes on relative imports.

## 9. Owner's specification

See `docs/spec.md` (faithful restatement of the full brief, sections 1–8).
