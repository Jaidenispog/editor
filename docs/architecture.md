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
- **Start-up waits for the database** (`apps/worker/src/lib/startup.ts`). The worker's first connection (a `select 1`
  probe, then `pg-boss` start) is retried while the error says the database is not reachable yet (`ECONNREFUSED`,
  `ENOTFOUND`, `ETIMEDOUT`, 57P03 "starting up", connection timeouts, also inside `AggregateError`/`cause`), with
  backoff 1 s → 2 → 4 → 8 → 15 s (capped) and **one** plain log line, e.g. `Waiting for the database at
  127.0.0.1:5433. Start it with: bash scripts/local-postgres.sh start`. SIGINT/SIGTERM stop the wait. Configuration
  problems are not retried: an address that is not `postgres://`, a refused password (28P01/28000), a missing
  database (3D000), a missing permission (42501), a certificate problem, a database that was not migrated for this
  version (no `worker_heartbeats` table: "Run: bash scripts/dev.sh migrate"; checked before pg-boss starts, so a
  wrong or unmigrated database is left untouched), an invalid environment or a job type without its handler print one
  plain message and exit with status 78 (EX_CONFIG). Any other error that is not retried is unexpected rather than a
  setting: the worker prints it and exits 1, so dev.sh reports it and starts the worker again (`isConfigurationError`
  / `startupFailure` in `apps/worker/src/lib/startup.ts`). Messages carry only host and port; passwords and
  connection strings are redacted.
- **`scripts/dev.sh` supervises the worker.** It runs the worker without watch mode (`tsx src/main.ts`): `tsx watch`
  keeps its process alive after a crash, waiting for a file change, so a dead worker was invisible (14 Nov 2026
  incident: clips sat on "Waiting to be analysed"). When the worker exits, dev.sh says so in plain words and starts it
  again after 2, 4, 8, … s (at most 30 s); after exit status 78 or five crashes in five minutes it stops both
  processes with the reason. `bash scripts/dev.sh --watch` and `pnpm dev:worker` keep watch mode for developers.
- **Worker heartbeat** (`worker_heartbeats`, `packages/db/src/worker-heartbeats.ts`). Each worker upserts one row
  (id = its `workerId`, hostname, pid, version, queues, `started_at`, `last_seen_at`) as soon as it has registered its
  handlers and then every 15 s, always with the database's `now()`; a graceful stop deletes the row, and rows not
  seen for a day are pruned at start-up. Before each beat the worker runs `select 1` on its queue (pg-boss) pool and
  skips the beat while that fails, so a worker whose separate `QUEUE_DATABASE_URL` is down stops counting as running;
  a beat never starts while the previous one is still being written. Limitation: the heartbeat proves the process
  runs and can reach both databases, not that pg-boss is still fetching jobs, so a job loop stuck inside a healthy
  process is not shown as a stopped worker (per-job heartbeats and the stale-job sweep still recover its jobs). The web app (`apps/web/src/lib/worker-status.ts`) treats the worker as
  running only when the newest `last_seen_at` is at most 60 s old by the database clock; any read failure counts as
  "not running". With no live worker, the project page shows a notice above the clips while anything is queued or in
  progress, the dashboard's "In progress" card shows it too, and `GET /api/health` reports `worker: { alive,
  lastSeenAt }` without changing its own 200/503 rule. This is separate from the per-job heartbeat in `jobs` (10 s,
  used for stale-job recovery) and from pg-boss's own job heartbeat.

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
  (a live-Square `production` booking, `ACCEPTED`, and a `payment` or `owner_marked` source with `completed_at`); its
  SQL twin `genuinelyCompletedBookingWhere` (`packages/db/src/completion.ts`) is used by every query that picks real
  visits. Sandbox bookings never count. `customers.square_email_unsubscribed` exists from migration
  `0001_foundations`.

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

## Instagram hashtag watch (Stage B, WP5)

- **A second live source** for Settings → Trends (preferences design §4.12 and §8.1, memo §11). The owner adds
  hashtags; `trends.refresh` reads each one through `modules/trends/instagram.ts`, registered as
  `TREND_SOURCES.instagram_hashtag` in `handlers/trends.ts`. Each `trend_watches` row is one hashtag
  (`query` lower case without `#`, `external_id` = Instagram's hashtag id after the first search, `social_account_id`
  = the Instagram account it is searched as). No migration: the table came with WP3.
- **Credential.** It reuses the publishing module's Instagram connection: the `meta` row in `integration_connections`
  (system-user token, decrypted only in the worker) found through `social_accounts.connection_id`. It shares the
  publishing Graph host, version, `appsecret_proof`, `GraphApiError` and `mapGraphError`; the two reads
  (`ig_hashtag_search`, `top_media`) live in `HashtagGraphReader` beside the source because `lib/meta/graph.ts`
  belongs to the publishing package.
- **Weekly limit.** Instagram allows 30 distinct hashtags per account in any 7 days, and whether `top_media` counts is
  unknown, so every hashtag touched counts for 7 days from `last_queried_at` (turned-off rows are kept that long).
  `claimHashtagQuery` takes a transaction-level advisory lock, checks `mayQueryHashtag` (`packages/core/src/
  hashtag-watch.ts`) and sets `last_queried_at` in one step, so two workers cannot both take the 30th place. The web
  app refuses an 11th watched hashtag and a 31st weekly one before queueing anything.
- **Capability check.** The first read of a hashtag is the check. Meta refusing the permission sets the watch to
  `unavailable` and `social_accounts.capabilities.hashtagSearch = false`; the Integrations and Trends cards then say
  "not available" (a valid end state). A successful read sets it back to `true`.
- **Stored per post:** rank, media type, posted time, like and comment counts as reported, Instagram permalink
  (`InstagramHashtagItemDataSchema`). Never captions, media URLs, images or account names.

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

## Saved preferences, reference video and brand (Stage B, WP2)

- **Contracts** (`packages/core`): `preference-learning.ts` (`LEARNABLE_FIELDS`, `LearnedPreferencesSchema`,
  `LearningStateSchema`, `computeLearnedPreferences`, `effectivePreferences`, `styleAffinityFrom`, `pinOwnerSetFields`),
  `reference.ts` (`ReferenceStyleProfileSchema`, `profileReference`), `brand.ts` (`logoPlacement`, `logoCorner`,
  `logoOpacity`, `BUNDLED_FONTS`, `RenderBrandSnapshotSchema`), `settings.ts` (`styleOrder`, `musicGenres`,
  `musicArtists`, `learning`, `learned`; `parseStoredSettings` pins hand-set values of settings that predate learning),
  `jobs/preferences.ts` (`preferences.recompute`, `reference.analyse`).
- **Data**: `edits.dismissed_at`, `edit_versions.render_brand`, `media_assets.reference_profile`,
  `feedback_events_created_idx` (migration `preferences`).
- **Learning**: every owner action writes a `feedback_events` row with plan facts inside its own transaction, then
  queues a debounced `preferences.recompute` (10 s, singleton). The job is a pure function of the events, writes only
  its subtree with `jsonb_set` (conditional on the reset point it read), and runs nightly so recency decay applies.
  Web writes to settings take a row lock and keep the stored `learned` and `styleAffinity`, so neither side loses the
  other's change. Every reader (Studio defaults, `buildPlannerInput`, the rules planner's `effectiveSettings`) uses
  `effectivePreferences`: pinned → declared, else learned, else declared. The style order sorts new generations' cards;
  it never hides a style.
- **Reference videos**: `kind = 'reference_video'` assets with their own upload route and ingest branch; they are
  excluded by kind from footage, style support, the status clip list and planner input. `reference.analyse` stores
  only measurements and deletes the original, proxy and frames (deletion stays last and tolerant, so a retry is safe).
- **Reference style v2 — "your style from your videos"** (preferences design §4.3.1). TikTok is never read: the owner
  uploads their own posted videos as references. Three layers, each with one job:
  - `packages/media/src/analysis/reference-style.ts` (`measureReferenceStyle`): on the proxy, Pass A (one FFmpeg run:
    scene score, YAVG/YDIF, blur per frame), Pass B (72 × 128 grey frames at 30 fps, in memory) and Pass C (the
    reference's own sound through the existing `decodePcm` + `detectBeats`, in memory only). Pure frame maths finds
    flashes/dips, hard cuts (local-median threshold, ±2-frame maximum, no shift between the frames either side),
    punch-in jumps (scale fit), gradual joins (cross-fade fit on every frame, vertical/horizontal shift, moving band,
    zoom), zooms inside shots (scale fit at 15 %/50 %/85 %) and a dark end screen. Honours the AbortSignal between
    passes and inside the loops; a failed sound pass leaves beat, drop and music unmeasured.
  - `packages/core/src/reference-style.ts` (pure): `assembleReferenceSignals` reduces the raw events to the stored
    numbers (`reference-signals.ts` schema), with beat sync reportable only above chance (binomial p < 0.01),
    `findDrop` on the 0.25 s energy curve (also used for the owner's tracks), `paletteFromCounts` in
    `TRANSITION_TYPES` only, `summariseReferenceStyle` (latest 12 profiles, ≥ 60 % agreement), wording that always
    says "estimate", and `applySummaryDecisions` / `resetEditingStyle`.
  - `preferences.editingStyle` (`packages/core/src/editing-style.ts`, defaults change nothing): `transitionPalette`,
    `beatSync`, `beatsPerCut`, `reveal`, `zoom`, `musicFit`, plus server-managed `sources` and `summaryDecisions`.
    Only an owner decision writes it (summary routes or Settings, through `updateSettingsLocked`).
  The rules planner applies it in the existing vocabulary only (`packages/ai/src/rules/editing-style.ts`): palette
  transitions at the joins each style allows, accents whose peak (20 % into `fadewhite`/`fadeblack`) lands on every
  4th/8th beat in the beat montage and on the reveal elsewhere, cuts in whole N-beat steps, the reveal on the track's
  strongest beat (`strongestBeat`; with the music start on automatic the start moves by whole bars), and `none` /
  push-in / punch-in zooms capped so exports do not soften; clean promo stays calm. With the default style every plan
  is byte-identical to before (snapshot test). The AI brief gets `job.editingStyle` (with the reveal's output time)
  and the palette in `allowedTransitions`; the validator's `extraStyleTransitions` silences only the
  `OFF_STYLE_TRANSITION` warning. `musicFit` only ranks the owner's own licensed tracks.
- **Brand in videos**: `packages/media/src/render/logo.ts` lays out the corner mark (≤ 150 px, inset 12 px in R_head)
  and the end card (≤ 420 × 300 px at y 380, last min(2 s, 30 %)) from the text layout of the same render, so the
  corner mark steps aside for top text and the end card is skipped when top or centre text overlaps it; every
  rectangle is checked against R_head and the forbidden areas before rendering. The overlay chain runs before the
  `ass` filter and adds no time to the timeline. `resolveRenderFont` maps fonts that are not bundled to Inter. Each
  preview stores its brand snapshot (logo copied by content hash), and the export uses it.

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

### TikTok through Zernio (Stage C, WP10)

- **Switch**: only with `TIKTOK_PUBLISH_PROVIDER=zernio` and `ZERNIO_API_BASE_URL`; otherwise TikTok is manual and no
  Zernio request is ever made. Contracts in `packages/core/src/zernio.ts` (strict Zod create body, consent and
  approval binding, interaction seeds, poll and lookup schedules, webhook envelope); adapter in
  `apps/worker/src/publishing/zernio.ts`; errors in `publishing/errors.ts` (`mapZernioError`, branching on HTTP
  status, `type` and `code`, never on Zernio's free text).
- **Connect**: the owner pastes a key (encrypted on the `zernio` connection row) and chooses one TikTok account
  Zernio lists (`social_accounts`, provider `zernio`); the read-only `social.check` verifies the key, lists accounts
  with their health (Business lane required) and stores creator-info seeds for the review card's Comments, Duets and
  Stitches switches. A stored account id missing from Zernio's list makes the owner choose again (never matched by
  handle).
- **Approval binding**: approval stores `provider_state.consent` (the tick, the three choices, and the caption, cover,
  file, delivery and account shown). Just before the create the worker re-reads the target and refuses on any change.
- **State machine**: pre-flight reads (lane, permission, token, cooldown, creator info) → presign and a streamed `PUT`
  through a pinned, redirect-free, private-address-refusing transport → `submitted_at` → `POST /v1/posts`. 201/200/207
  save `post._id` and are read by `post.status` (207 `scheduled` stays queued); a 409 duplicate is adopted only when its
  metadata is ours; refusals (400, 401, 402, 403, other 409) clear `submitted_at` (a 400 also the upload); unclear
  outcomes keep `submitted_at` and look the post up by `metadata.studioTargetId`, then "check before retry". A failed
  post is retried in place (`/retry`). A delivered draft (entry `published` with `isDraft`, the echoed
  `tiktokSettings.draft`, or our `delivery = draft`) becomes "finish in the TikTok app". Reversals follow Zernio and
  are audited `publish.target.reconciled`; effects (feedback, ledger) still happen once, when first published.
- **Webhooks**: hints only; the stored envelope finds the target by metadata first and queues a read with our key.

## Square appointments (Stage C, WP6 and WP6b)

- **Tier 0 (read-only).** Square stays the source of truth. The worker copies bookings, customers and the
  business snapshot (locations, booking profile, team, APPOINTMENTS_SERVICE catalogue) through the official
  `square@46.0.0` SDK behind a narrow `SquareApi` interface (`apps/worker/src/square/api.ts`; `maxRetries: 0`, 20 s,
  the run's AbortSignal). Nothing writes to Square and nothing sends a message; Square keeps sending its own
  confirmations and reminders. Booking changes (Tier 1) stay off in code (`SQUARE_TIER1_AVAILABLE = false`) until WP6b
  and the sandbox smoke test.
- **Contracts** (`packages/core/src/square.ts`): stored config/capabilities schemas, `squareScopes`,
  `squareIntegrationState`, `tier1Status`, `classifyVariation`, `mapBookingStatus`, `deriveAttendance`,
  `deriveCompletion` (decides `completed_at`/`completion_source`; consumers use `isGenuinelyCompleted` from
  `completion.ts`), `matchPayments`, `availabilityRange`, `bookingWindows`, `mapSquareError`.
- **Data**: `bookings` gains environment, Square customer id, end time, Square update time, `attendance` +
  evidence, the owner's mark and `missing_from_square_at`; `customers` gains environment, Square version and sync time
  (and fills WP0's `square_email_unsubscribed`); new `square_availability_searches` (deleted after 24 h by
  `maintenance.cleanup`). `purgeSquareData` (`packages/db/src/square-purge.ts`) deletes bookings and searches and always
  scrubs customers (soft delete), so rows of other modules keep working; it also deletes stored Square webhook
  deliveries. Mirror writes (`upsertBooking`, `upsertCustomer`) run under `withMirrorGuard` (`square/map.ts`): a
  transaction holding the `square` row `FOR SHARE` that writes only while the job's connection (same seller and
  environment, `connected`/`error`) is still current; disconnect and location changes take the row `FOR UPDATE`.
  Bookings are copied, listed and matched only for the studio's location (`effectiveLocationId`); with several active
  locations and none chosen, no booking is copied and the card says so.
- **Flow**: Connect (OAuth code flow, read scopes) → callback stores encrypted tokens (purging another environment's or
  account's data first) → `square.sync` → every 10 minutes (31-day window) and nightly reconcile (3 × 31 days, missing
  bookings re-read and marked) → `square.attendance` matches COMPLETED payments to ended ACCEPTED bookings (strong =
  same client; weak = possible) → `completed_at` set only for a strong match or the owner's mark; a refund, a later
  NO_SHOW/cancellation or "didn't attend" resets the source to `none`; sandbox bookings keep their attendance label
  but never complete. Verified webhooks store a minimal envelope and only queue `square.refresh`, which re-reads the
  object from Square. Stale versions never overwrite newer ones. Opening the connection (and its token refresh) runs
  inside each handler's error handling, so its failures reach the card and fail an availability search. A booking whose
  `start_at` is not an RFC 3339 instant is skipped and its id logged (design §4.8). Only a signed delivery for the
  connected seller (not after a disconnect) updates "last update received". `square.revoke` makes no call when the
  server has since been switched to the other Square environment; the card shows the revoke outcome after a
  disconnect and, when Square did not confirm it, tells the owner to remove the app in Square's App integrations page.
- **Times**: everything stored in UTC; availability searches use `availabilityRange` (a 23-hour DST day is widened to
  Square's 24-hour minimum and the extra slots dropped); lists are grouped by Melbourne day.
- **Tier 1: booking changes and the self-test (WP6b), switched off in this version.** Built and tested against the
  fake of Square, but `SQUARE_TIER1_AVAILABLE` stays `false` until the sandbox smoke test records Square's real answers
  (fee-protected services, PENDING cancels, the plan error); while it is false every Tier 1 route refuses and the card
  shows the checklist read-only. Contracts in `packages/core/src/square-changes.ts` (`BookingChangeRequestSchema`,
  statuses, `writeGateReason`, `bookingActions`, `selfTestAllowed`, the notification sentence). One owner-approved
  `square_booking_changes` row per change (`packages/db/src/schema/square-changes.ts`; `merchant_id` + `environment`
  bind the approval to the account the owner saw; idempotency key `sabc_<id>`). The web app records the change after
  checking its copy (checklist, a ≤ 5-minute-old search, the booking's version) and queues `square.booking_change`;
  `apps/worker/src/square/change.ts` is the only code that writes to Square: claim → gate → plan flag → service from
  the catalogue → booking version → fresh availability → `submitted_at` under the connection row's `FOR SHARE` lock →
  one write → confirmed (mirrored, double-booking check) or Square's refusal stored verbatim (plan/permission refusals
  pause changes; an unexplained 4xx marks the service "Book in Square"). Time-outs re-send with the same key; the last
  attempt leaves `unknown`, which `square.sync` settles (`settleUnknownChanges`). The self-test
  (`handlers/square-self-test.ts`) books, moves by one free slot and cancels through the same routine; its step rows
  have fixed ids so it resumes after a crash, and the cancel is always attempted. Its result counts only for the same
  account and environment and is the Square card's `verified` on live Square.

## Email and review requests (Stage C, WP7)

- **Provider**: Postmark over plain `fetch` behind `EmailProvider` (`apps/worker/src/lib/email/`); `createEmailProvider`
  returns null unless `EMAIL_PROVIDER=postmark` with a token and `EMAIL_FROM`. Factual messages use the Transactional
  stream; review requests and campaigns (commercial) use the Broadcast stream with Postmark's one-click unsubscribe plus
  the app's own permanent `/u/{token}` link. The web app never calls Postmark.
- **Rules in core** (`packages/core/src/email.ts`, `email-lint.ts`, `reviews.ts`): the Markdown-subset renderer (every
  value escaped; a fixed sender-identification footer; stored copies carry markers instead of personal token links),
  the linter (incentive, selective and reminder wording; factual emails without links or promotion), the consent fold
  (express by default; the "inferred" rule off unless the owner turns it on), the single send gate
  `evaluateSendPolicy` (block / defer / send with plain reasons), and `reviewEligibility` (no rating, spend, feedback,
  notes or staff input; pinned by a test).
- **`email.send` state machine**: only `approved`/`queued` messages; the gate runs on fresh facts immediately before
  the call; a conditional claim sets `submitted_at` (the non-repeatable call marker), the hashed tokens and the
  token-free stored copy, then Postmark is called once. A cancel that arrives between the claim and the call releases
  the claim (Postmark was not called). Transient errors release the claim and retry; an unknown outcome keeps it and
  the retry calls `findSent` first (found → sent, else `check_before_retry` for the owner). The owner's "Send again"
  claims the message anew with new tokens; the earlier token hashes move to `email_link_tokens` (migration 0010) and
  keep working on `/u/…` and `/r/…`. 406 suppresses the address (unless it is the app's own earlier unsubscribe push to
  a client who has since given permission again: then no block is added and the owner is told to remove the address
  from the Broadcast stream's suppression list in Postmark), 412 records "waiting for approval" (cleared by the next accepted live send to an address
  outside the sender's domain), auth/sender errors stop dispatch until the next successful check. Campaign messages
  are sent only while their campaign is `approved`/`sending`; a held message (`provider_not_ready`,
  `webhooks_missing`) is pushed 30 minutes forward, and dispatch leaves commercial email waiting while the webhooks
  are missing and not attested.
- **Automation**: `email.automation.sweep` turns genuinely completed bookings (`isGenuinelyCompleted`, completed after
  the switch was turned on and within `maxAgeDays`) into one request and message per booking (`ON CONFLICT
  (dedupe_key) DO NOTHING`), or a skipped request with its reason (bookings already handled are excluded in SQL, so more
  than 200 completions in the window never hold newer ones back); cancels pending items whose booking changed; records
  Square's email opt-out once as a `withdrawn` ledger event. `email.dispatch` hands due approved messages on; daily
  caps, the send window and one automated email per client per Melbourne day are deferrals in the gate.
- **Consent and suppressions**: the append-only `consent_events` ledger and the global `email_suppressions` list are
  the only sources of truth (the `customers` consent columns are a display cache). Webhooks (Basic auth) may only
  restrict sending or update delivery display; campaigns pause automatically above 0.1% complaints or 5% bounces.
- **Reviews**: the owner's pasted review link (never built by the app), a tracked `/r/{token}` redirect that never
  branches, requests tracked separately from reviews, and the Places API rating (latest snapshot only, daily). A sent
  request whose booking later stopped counting as a visit reads "Sent before the booking changed" (Reviews and
  Appointments); nothing else happens. The review automation needs a link that passes `validateReviewLink`, and
  "Square sends feedback or review requests" cannot be ticked while it is on.

## Website and local search (Stage C, WP8)

- **Contracts** (`packages/core/src/website.ts`, `website-checks.ts`, `robots.ts`): the stored `WebsiteAuditResult`
  and `WebsiteChange` schemas, the `website` settings section and `business.openingHours`, site scope and URL
  normalisation, Australian phone numbers, the ~50-check catalogue (`runWebsiteChecks`), prioritisation
  (`prioritiseFindings`, "Do these first"; no overall score), suggestions built only from Settings (titles,
  descriptions, `HairSalon` JSON-LD that omits unknown fields), `classifyQuery`, `checkCopyClaims`, copy-paste
  instructions and the change lifecycle (dedupe key, refresh, supersede, verification). All pure and unit tested.
- **Crawler** (`apps/worker/src/website/`): `fetcher.ts` is a stricter HTTP client than `lib/http.ts` — GET/HEAD only,
  no cookies or auth, every host resolved and refused if any address is private/reserved (`ssrf.ts`), the connection
  pinned to the checked address, ports 80/443 only, redirects followed by hand (≤ 5, each re-validated), size and time
  caps, ≤ 400 requests per check and polite spacing (500 ms, or robots.txt `Crawl-delay`) with a 12-minute budget for
  that waiting (later requests to the owner's site are skipped and the check says so; the home page's request is kept
  back first, so even the longest Crawl-delay ends as a partial check, never an error). A robots.txt with no HTTP answer
  (unresolvable, refused, timed out, blocked host) means the site is unreachable: a complete check with one
  `site_unreachable` finding; a robots.txt 5xx stops the crawl with `robots_unreachable`. `crawl.ts` reads robots.txt
  (RFC 9309; per host, so the www./bare twin's own robots.txt is read before any page there, and every redirect hop
  of a page must be allowed too), host variants, the root, the sitemap (fast-xml-parser, entities off), ≤ 25 HTML pages breadth-first,
  image sizes, links and a soft-404 probe. `extract.ts` parses pages with cheerio as data only. Tests inject a
  loopback policy in code. The only setting that touches the guard is the browser test's `WEBSITE_FIXTURE_BASE_URL`:
  ignored unless `NODE_ENV=test`, and even then it maps one exact host name to the local fixture on 127.0.0.1 while
  every other loopback or private address stays refused (`websiteFetchPolicy` in `website/deps.ts`).
- **Changes**: `website.audit` stores the validated result and summary and refreshes prepared changes in one
  transaction (`changes.ts`): one open change per dedupe key (partial unique index), owner/AI wording kept, superseded
  when the finding is gone or the page changed, applied changes verified from the next check.
- **Apply** (`apply.ts`, `adapters/wordpress.ts`): only after the owner's explicit confirmation (`approved_by`). The old
  text must occur exactly once; a durable marker stored before the write (`apply_result.writeSentAt`, `preWriteHash`,
  `changeHash`) lets a retry tell a write that landed (`already_applied`, no second write, deletions included) from one
  that never did. The marker counts only for the change it was written for, is dropped when the wording changes or
  WordPress refuses the write, and a page edited since falls back to the first-attempt rule. The approval is bound to
  the change and its destination (`apply_result.approvalHash`, `@studio/core/website-approval`) and checked again
  before writing; the page is re-read (content and `modified_gmt`) right before the write, and nothing is written if
  it changed. WordPress calls use the guarded, pinned transport (`guarded-fetch.ts`, no redirects followed);
  read-back through WordPress, then a public read through the guarded fetcher. Only page text and image descriptions
  are written through core WordPress; titles, descriptions, structured data, header code and robots.txt stay
  copy-paste. A WordPress host other than the public website is labelled `staging`.
- **Search Console** (`lib/google/search-console.ts`, `handlers/search-sync.ts`): read-only (`webmasters.readonly`),
  `sites.list` then auto-select (Domain property first), 16-month backfill in 31-day windows, 10-day refresh, idempotent
  upserts into `search_metrics`. Grouping (brand / local / service / other / not listed) happens when reading
  (`apps/web/src/lib/website.ts`), so edited word lists apply to all history.
- **AI wording** (`packages/ai/src/website-copy.ts`): only on the owner's click, Haiku, page text as delimited data,
  structured output, options filtered by `checkCopyClaims` and `unsupportedFactClaims` (no number the AI was not
  given); `null` (button hidden) unless `AI_PROVIDER=anthropic`.
- **Business Profile Performance** (`search.sync` source `business_profile`, its connection check branch and card)
  is built by WP9 (next section), which extends the payload enums in a backwards-compatible way.

## Google Business Profile (Stage C, WP9)

- **One connection, two uses**: the `google_business_profile` row (shared Google sign-in, `business.manage` only)
  holds `config.locations` (discovery), `config.account`/`location`/`locationTitle` (the chosen listing) and two
  capability keys written by read-only calls: `apiAccess` (discovery and reviews) and `performanceApi`, each
  `available` / `awaiting_approval` / `api_disabled` / `error` (`packages/core/src/business-profile.ts`). Google gives a
  project quota 0 until it approves Basic API Access (memo §7): a 429, or a 403 naming a quota limit of 0, is recorded as
  `awaiting_approval` and the job ends normally, so nothing retries until the next scheduled run.
- **Reviews** (`apps/worker/src/lib/google/business-profile.ts`, `handlers/reviews-gbp.ts`): discovery (Account
  Management `accounts`, Business Information `{account}/locations?readMask=name,title,storefrontAddress`) on connect
  or while no location is chosen (one location is chosen automatically; several wait for the owner on the Reviews
  page); then v4 `reviews.list` (page size 50, newest update first). Daily syncs stop at the stored
  `reviews.review_updated_at` watermark; `weekly_full` and the first sync read every page, which also picks up reviews
  Google's known "missing from page 2 onward" issue left out. Upsert on `(provider, external_review_id)`; `raw` keeps the
  location, `reviewReplyState` and `policyViolation`. Nothing is ever written to Google (no replies).
- **Performance** (`lib/google/business-profile-performance.ts`, `modules/business_profile/performance.ts`):
  `website.connection_check` with `provider: 'business_profile_performance'` makes one 7-day
  `fetchMultiDailyMetricsTimeSeries` read and records `performanceApi`; `search.sync` with `source: 'business_profile'`
  runs only while it is `available`: 18 months of daily metrics in 92-day windows on the first sync (35 days later) and
  monthly search keywords (6 complete months, later 2; each month replaced in one transaction) into `search_metrics`
  (source `business_profile`, property `locations/{id}`). A day listed without a value is stored as NULL, never 0. The
  request parameter names and response nesting are those of the design (⚠, not in the memo): anything else fails with
  "Google's response format wasn't recognised" and stores nothing. The two WP8 handlers only dispatch to this module.
- **Web** (`apps/web/src/lib/business-profile.ts`, `lib/integrations/business_profile.ts`): one pure state function
  feeds the Settings card, the "Reviews on Google" tab (`components/reviews/google-reviews-tab.tsx`) and the Website
  page's `components/website/profile-performance-card.tsx`. Tiles sum only what Google returned in the range ending on
  the last day with a value.
