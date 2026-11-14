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
5. Worker render: compiles the validated plan to one FFmpeg filtergraph (trim/speed/crop/zoom/colour/transitions + ASS text overlay + music/original sound mix + loudness) → 540×960 preview → uploaded to storage → `preview_ready`. Cut points, segment lengths and transition overlaps are snapped to the output frame grid cumulatively (`quantiseTimeline` in `packages/media/src/render/video-filters.ts`), so the file length and every cut stay within half a frame of the plan however many short or speed-changed shots it has; each segment is padded by a few cloned frames before its exact `trim`, so it never comes out a frame short.
6. Revise/regenerate creates a **new version** (old versions stay). Export renders 1080×1920 H.264/AAC MP4 only for the versions the owner asks for.

## Durability

- pg-boss queues per job type with `retryLimit`, `expireInSeconds` and `heartbeatSeconds` (30 s). A worker that dies stops heart-beating; the worker's pg-boss supervisor (every 30 s) fails the attempt and it is retried → restart recovery.
- `jobs` table mirrors every job for the UI (progress, message, cancel flag). Cancel = flag + `boss.cancel` → the worker's `AbortSignal` kills FFmpeg.
- A failure that another attempt cannot fix (a music licence that no longer clears, a token the owner must reconnect) is thrown as `NonRetryableError` (`packages/core/src/errors.ts`): the `jobs` row is marked failed with its plain message on the first attempt and the worker loop completes the pg-boss job instead of letting it retry.
- Handlers are idempotent: re-running ingest or render overwrites the same storage keys; planning skips versions that already have a plan.
- Per-job temp dirs under `WORKER_TMP_DIR`, removed in `finally`; an hourly cleanup job removes orphans.

## Security

- Owner/staff accounts, Argon2id password hashes, opaque session cookies (hash stored), sliding 30-day expiry, login rate limiting.
- All media behind authentication; browsers only receive expiring links (S3 presigned or HMAC-signed `/api/media/<token>` for the local driver).
- Uploaded content and model output are data: plans are validated, captions must exist in the transcript, text is length-limited.
- OAuth tokens for integrations encrypted at rest (AES-256-GCM, key derived from `APP_SECRET` unless `APP_ENCRYPTION_KEY` is set).
- Webhooks (Square) verified by signature before processing; events stored idempotently.

## Integrations framework (Stage B/C foundations, WP0)

Built once so every Stage B/C module integrates the same way and parallel work packages edit only their own files
(`docs/design/stage-bc-plan.md` §2).

- **Registries (one file per module).** Modules: `music`, `preferences`, `trends`, `publishing`, `square`, `email`,
  `website`, `business_profile`. Each aggregator imports every module file in a fixed order:
  - job types and payload schemas: `packages/core/src/jobs.ts` ← `src/jobs/<module>.ts` (Stage A in `jobs/studio.ts`,
    `webhook.process` and `google.disconnect` in `jobs/shared.ts`). A later module may extend an earlier payload only
    backwards-compatibly.
  - queue settings: `packages/queue/src/index.ts` ← `src/settings/<module>.ts` (retries, expiry, heartbeat, `policy`).
    The queue refuses to start when a registered job type has no settings.
  - worker: `apps/worker/src/modules/index.ts` ← `src/modules/<module>/index.ts` (`handlers`, keyed `crons`,
    `webhookHandlers`, `cleanupTasks`, `exportReadyHooks`, `refIdFor`). The worker refuses to start unless every
    registered job type has exactly one handler.
  - web: `src/lib/integrations.ts` ← `src/lib/integrations/<module>.ts` (pure status builders),
    `src/lib/jobs.ts` ← `src/lib/jobs/<module>.ts` (ref ids), Settings → Integrations cards
    (`settings/_components/integrations/<module>.tsx`), Studio card slots (`components/studio/extensions/<module>.tsx`:
    badges, banner, menu items).
  - settings: `packages/core/src/settings.ts` ← `src/settings/<module>.ts` (new top-level sections, each with a full
    default); database tables: `packages/db/src/schema.ts` re-exports `src/schema/<module>.ts` (drizzle-kit reads both).
- **Integration states.** One contract (`packages/core/src/integrations.ts`, `IntegrationStatus` in
  `apps/web/src/lib/shared/integration-types.ts`): `state` (`not_configured`, `not_connected`, `connected`,
  `awaiting_approval`, `unavailable`, `needs_reauth`, `error`), `liveMode` (`live`, `development_live`, `sandbox`,
  `staging`, `read_only`) and `verified` (only an explicit owner verification sets it). Status words and tones for
  every module live in `components/ui/status-words.ts`.
- **Connections.** One `integration_connections` row per provider (`meta`, `zernio`, `postmark`, `google_places`,
  `square`, `google_business_profile`, `google_search_console`, `website`, …; status adds `disconnected`).
  Credentials are AES-256-GCM encrypted, decrypted only in the worker (`lib/credentials.ts`) and once in an OAuth
  callback for the code exchange; never in payloads, logs, the audit log or DTOs.
  `withConnectionLock` (`SELECT … FOR UPDATE`) serialises token refreshes; `refreshIfExpiring` stores new tokens;
  `recordConnectionCheck` records the outcome of a read-only capability check (merging `capabilities`).
- **OAuth.** `apps/web/src/lib/oauth-state.ts`: an encrypted, HttpOnly, SameSite=Lax, 10-minute cookie holding
  `sha256(state)`, the session id, the PKCE verifier and small extras; the callback checks it in constant time and
  always clears it. Google (`/api/integrations/google/{connect,callback}`) uses a product table:
  `business_profile` → `business.manage` → row `google_business_profile` → `reviews.gbp.sync`;
  `search_console` → `webmasters.readonly` → row `google_search_console` → `website.connection_check`. A follow-up job
  is queued only once its module registers it. Worker: `lib/google/oauth.ts` refreshes on demand (`invalid_grant` →
  `needs_reauth`); `google.disconnect` revokes and wipes tokens, never touching a connection the owner reconnected.
- **Webhooks.** Web: `readRawBody` (256 KiB) → provider verification in the module's route → `storeWebhookEvent`
  (`ON CONFLICT DO NOTHING`; one `webhook.process` job only for a new row). Worker: `webhook.process` hands the stored
  event to the handler its provider's module registered; unknown providers are marked processed with an error;
  handler failures are recorded and retried. Payloads are hints: handlers re-fetch or apply only restrictive effects.
- **Worker helpers.** `lib/http.ts` (`fetch` through the injectable `ctx.fetch`, tied to the run's AbortSignal, 30 s
  default limit, redacted logging of tokens, codes, secrets and hashed email addresses; test-only base URLs via
  `testOnlyBaseUrl`, honoured only under `NODE_ENV=test`), `lib/audit.ts` (trimmed, redacted audit data),
  `lib/feedback.ts` / web `lib/feedback.ts` (`recordFeedback` inside the caller's transaction with a plan-facts
  snapshot from `computePlanFacts`).
- **Scheduling.** `JobQueue` adds per-type `policy` (`stately` allows one queued and one active job per
  `singletonKey`), `startAfter: Date` and keyed cron schedules in Melbourne time. On pg-boss 12.38.1 a `singletonKey`
  on a `standard` queue does **not** prevent a second queued job (pinned by a test), so every design's conditional
  database update stays the authoritative duplicate guard. Melbourne wall-clock helpers (`melbourneLocalToUtc` with
  nonexistent/ambiguous DST times, `melbourneDayRange`, `melbourneDateOf`, `melbourneZoneLabel`, `nextSendSlot`) are
  in `packages/core/src/time.ts`.
- **Hooks.** After an export is stored the render handler calls each module's export-ready hook; a failing hook is
  logged and never fails the export. `maintenance.cleanup` runs each module's cleanup task after the Stage A cleanup.
- **Legal pages.** `/privacy`, `/terms`, `/data-deletion` show only text the owner published (Settings → Business →
  Legal pages, stored in `settings.legal`); the suggested starting text is marked "Review before publishing".
- **Shared rules.** `isGenuinelyCompleted` (`packages/core/src/completion.ts`) checks stored booking columns only
  (`ACCEPTED` and a `payment` or `owner_marked` source with `completed_at`); `customers.square_email_unsubscribed`
  exists from migration `0001_foundations`.

## Trends (Stage B, WP3)

- **Three groups, never mixed** (memo §11): `trend_references.source_kind` is `live` (fetched by a `trend_watches`
  row), `noted` ("Note a trend", any signed-in user; TikTok has no permitted trend API) or `curated` (static, dated,
  sourced formats; `apps/web/src/lib/seed-trends.ts`, re-sourced once by the marker `trends.curated_sources_v2`,
  which only touches rows still carrying the first seed's source name and title).
- **Labels** come only from `trendLabel` (`packages/core/src/trend-label.ts`); typed text that would put
  "trending"/"viral" into a label is replaced by neutral wording. `validateEditPlan` rejects on-screen text overlays
  matching `\b(trending|viral|goes viral|blowing up)\b` (`TEXT_UNSUPPORTED_CLAIM`), so neither planner can put such
  a claim into a video.
- **Live sources.** `trends.refresh` (worker `handlers/trends.ts`) dispatches by `trend_watches.provider` to a
  source refresher (`modules/trends/sources.ts`). WP3 builds the YouTube AU popular chart
  (`modules/trends/youtube.ts`, `lib/youtube-client.ts`); WP5 adds the Instagram hashtag watch to `TREND_SOURCES`.
  A read records `last_queried_at` first, then replaces the watch's items in one transaction; refusals keep the old
  items and set the watch's `status` (`quota`, `error`, …) with a plain message. Read-only towards every service.
- **Isolation from the planners.** Nothing outside the trends module reads the trend tables (a worker test scans the
  worker and `packages/ai` sources and checks `buildPlannerInput`). "Use as idea" copies the card's own text to the
  clipboard for the Studio's Instructions box.
- Google Trends and TikTok Creative Center are plain links the owner opens with their own logins.

## Stages

- **A** (this milestone): upload, analysis, five previews, revise/regenerate with history, full-quality export.
- **B**: music controls and licensing model, saved preferences/feedback, publishing (Instagram/TikTok) with honest fallbacks.
- **C**: Square appointments, email, review requests, website/local search tools.

## Music controls and licence passport (Stage B, WP1)

- **Contracts** (`packages/core`): `music.ts` (licence passport incl. `meta_sound_collection`, `facebook`,
  `destinationLock`; `normaliseLicence`, `musicClearanceFor`, `licenceStateOf`), `audio-patch.ts` (`AudioPatchSchema`,
  `needsRecut`, `applyAudioPatch`, `withoutMusic`), `music-ranking.ts`, `music-catalogue.ts` (interface only, no
  adapter), `spotify-link.ts`, `jobs/music.ts` (extends `edits.revise` with `mode: 'audio'` and `render.export` with
  `variant`), `settings/music.ts` (`music.spotifyReferenceMode`).
- **Data**: `music_tracks.genres`, `edit_versions.variant_exports`, `music_usage` (usage ledger, one row per version
  and purpose/platform), `music_references` (private Spotify links).
- **Sound panel**: sound-only changes are applied to the parent plan without the planner (validated again with
  `validateEditPlan`); track, beat and "re-cut to this section" changes go through the planner with
  `PlannerInput.beatSync` / `revealOnBeat` / `musicStartSec`. A new version keeps its parent's track.
- **Exports**: the standard file needs music the licence clears (web route, then the worker again); the `no_music`
  variant is the same version without music, stored next to it, and needs no clearance. Export-ready hooks get the
  variant.
- **Spotify**: link-only by default; the official embed only on signed-in pages once the legal pages exist and the
  owner acknowledged Spotify's terms. Nothing from Spotify reaches the planner, AI prompts, publishing, email or the
  website module (a unit test checks the imports).

## Publishing (Stage B, WP4)

- **Contracts** (`packages/core/src/publishing.ts`): `checkPublishEligibility` (built on `musicClearanceFor`: an
  unconfirmed, non-promotional, expired or unknown licence gives only the music-free file everywhere; a platform the
  licence does not tick gets only `no_music`; Meta Sound Collection music never goes to TikTok), `methodVariantRefusal`,
  `validateCaption` (2,200 graphemes, the CC BY credit appended once), `resolveSchedule` (Melbourne, DST-aware, 10 min
  to 90 days), `checkMediaForPlatform` (memo §3/§4 limits incl. 25 Mbps video and AAC ≤ 128 kbps; resumable cap),
  `derivePostStatus`, `targetActionsFor`, `validatePostLink`, request schemas. Jobs in `jobs/publishing.ts`, the
  `publishing.captionFooter` setting in `settings/publishing.ts`.
- **Data**: `publish_posts` (one per video and compose action; `approved_by/at`, `music_check` with the licence
  snapshot, derived `status` and `status_message`), `publish_targets` (one per post and platform, unique; `method`,
  `media_variant`, `media_key`, `manual_step`, `submitted_at`, `provider_state` without tokens, unique
  `idempotency_key = pt_<id>`), `social_accounts` (discovered Instagram accounts; the credential lives encrypted on the
  `meta` row of `integration_connections`).
- **Flow**: composer → drafts (`POST /api/publish-posts`) → owner approval → `publish.prepare` → manual targets: the
  owner downloads/shares, copies the caption and taps "I've posted it"; Instagram direct: `publish.target` claims the
  target with one conditional update (queued, or processing waiting at the publish step, or claimed by this same job
  before a restart), creates the Reels container (`upload_type=resumable`, `thumb_offset`), saves its id, streams the
  file from private storage to `rupload.facebook.com`, then `publish.poll` reads `status_code` and
  `copyright_check_status` (a match never publishes: the owner chooses "Post without music" or "Post it yourself"),
  and `publish.target` sets `submitted_at` just before `media_publish` and reads the permalink back. A retry always reads
  the container first: `PUBLISHED` is never published again (the media id is recovered from the account's media list).
- **Effects only when published**: the `publish` feedback event (`recordFeedback`, plan facts) and the `music_usage` row
  (`purpose 'publish'`, the platform) are written when a destination becomes `published` (platform read-back or the
  owner's confirmation), never at approval.
- **Export-ready hook**: when `render.export` stores a version's file (standard or `no_music`), posts waiting for it get
  `publish.prepare` again. `publish.dispatch` hands due scheduled targets on, turns due manual ones into "Your turn",
  and settles a processing target untouched for an hour (failed with Retry, or `check_before_retry` once submitted).
