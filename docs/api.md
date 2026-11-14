# JSON API (apps/web)

All routes live under `/api`, require a signed-in session cookie (except `auth`, `setup`, `health`, `media`), and
return JSON. Errors are `{ "error": { "code", "message", "details?" } }` with an HTTP status from the code
(`VALIDATION` 400, `UNAUTHORISED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `UNSUPPORTED` 422,
`RATE_LIMITED` 429, `INTERNAL` 500). State-changing requests must come from the app's own origin (CSRF guard).

**Who sees what.** The owner can open every project; staff can open only the projects they created. Every
project-scoped route (projects, clips, uploads, edits, versions, jobs, status) answers 404 for a project the
user may not open, so other people's projects are never revealed. Jobs without a project (library music
analysis, maintenance) can only be cancelled or retried by the owner. The dashboard, the project list and the
Content Library apply the same rule.

## Auth and setup
| Method | Route | Body / notes |
| --- | --- | --- |
| POST | `/api/setup` | `{ email, password, displayName }` — only while no users exist; creates the owner |
| POST | `/api/auth/login` | `{ email, password }` → sets `sa_session`; rate limited |
| POST | `/api/auth/logout` | clears the session |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` |
| GET | `/api/health` | `{ ok, db, queue, storage, worker: { alive, lastSeenAt } }` — `ok` (200, else 503) covers only what the web app itself needs (database, queue, storage). `worker` is information: `alive` is true when a background worker recorded a heartbeat in the last 60 s (database clock), `lastSeenAt` is the newest heartbeat (ISO) or `null` when none is recorded (never started, or stopped cleanly). A stopped worker never makes this 503. |

## Settings and integrations
| Method | Route | Notes |
| --- | --- | --- |
| GET / PUT | `/api/settings` | `AppSettings` (brand, business, preferences, legal and module sections); PUT accepts a partial object and keeps sections it does not mention |
| POST / DELETE | `/api/settings/logo` | multipart logo upload → stored at `brand/logo.<ext>` (DELETE removes it); only `brand.logoStorageKey` changes, under the settings row lock (`updateSettingsLocked` in `apps/web/src/lib/settings.ts`, the only whole-object settings writer; publishing settings use a single-path jsonb_set and `resetLearning` its own locked transaction) |
| GET | `/api/integrations/status` | per integration: `{ configured, connected, message }` |
| GET / POST / PUT / DELETE | `/api/trends` | curated or live trend references |

## Projects and clips (Video Studio)
| Method | Route | Notes |
| --- | --- | --- |
| GET / POST | `/api/projects` | list the projects the user may open (with counts, latest generation; `?search=`) / create `{ title, clientName?, notes? }` (owned by the signed-in user) |
| GET / PATCH / DELETE | `/api/projects/[id]` | DELETE removes rows **and** stored media (permanent); 404 for staff on someone else's project |
| GET | `/api/projects/[id]/jobs` | recent background jobs of the project, newest first |
| POST | `/api/projects/[id]/assets/order` | `{ assetIds: string[] }` (each id once, all clips of this project) → `{ assets: [{ id, sortOrder }] }`; renumbers every clip in one transaction (listed clips first, unlisted clips keep their relative order after them); 400 for ids from another project or duplicates |
| GET | `/api/projects/[id]/status` | polling payload: project, assets, generations, edits with versions, active jobs, `busy`, and `worker: { alive, lastSeenAt, startHint }` (`startHint` is `dev` or `service`; the page shows "The background worker isn't running" above the clips when `alive` is false while `busy`) |
| POST | `/api/projects/[id]/uploads` | `{ filename, size, mimeType, kind }` → `{ uploadId, partSize, partCount, receivedParts }` |
| PUT | `/api/uploads/[id]/parts/[n]` | raw bytes of part `n` (1-based); idempotent |
| GET | `/api/uploads/[id]` | `{ receivedParts }` for resuming after a page reload |
| POST | `/api/uploads/[id]/complete` | assembles the file → `{ assetId }` (video → `ingest.asset` job; audio → music track + `music.analyse`) |
| DELETE | `/api/uploads/[id]` | aborts and deletes staged parts |
| PATCH | `/api/assets/[id]` | `{ clipLabel?, manualLabels?, sortOrder? }` — manual tags recompute style support; `manualLabels` replaces the clip's per-shot tags (`{ [shotId]: label }`, ids must be shots of this clip) |
| GET | `/api/assets/[id]/shots` | `{ assetId, clipLabel, manualLabels, shots: [{ id, startSec, endSec, label, source, detectedLabel, manualLabel, description, frameUrl }] }`; `source` is `shot_tag`, `clip_tag`, `vision_model` or `heuristic`; `frameUrl` is an expiring link to the analysis still nearest the middle of the shot |
| POST | `/api/assets/[id]/retry` | re-queues ingest for a failed clip |
| DELETE | `/api/assets/[id]` | removes the clip and its derived files |
| POST | `/api/projects/[id]/generate` | `GenerationSettings` → creates generation + one edit per style (v1 "planning") → `edits.generate` job. `musicStartSec` (seconds, or `null` = automatic) needs a `musicTrackId`, must be inside the track and leave at least `durationSec` of music (400 with a plain message otherwise); planners start the music on the first beat at or after it |

## Edits, versions, export
| Method | Route | Notes |
| --- | --- | --- |
| POST | `/api/edits/[id]/favourite` | `{ value: boolean }` (also records a feedback event and style affinity) |
| POST | `/api/edits/[id]/revise` | `{ instruction }` → new version (origin `revise`) → `edits.revise` job |
| POST | `/api/edits/[id]/regenerate` | new version (origin `regenerate`) |
| POST | `/api/edits/[id]/current-version` | `{ versionId }` — switch the card to an older version (nothing is deleted) |
| POST | `/api/edit-versions/[id]/export` | queues `render.export` for that version only |
| GET | `/api/edit-versions/[id]/download` | `{ url }` — expiring link to the export (or preview with `?kind=preview`) |
| POST | `/api/jobs/[id]/cancel` | cooperative cancel (flag + queue cancel) |
| POST | `/api/jobs/[id]/retry` | re-queue a failed job |

## Music
| Method | Route | Notes |
| --- | --- | --- |
| GET / POST | `/api/music` | library tracks with licence and beat status |
| POST | `/api/music/uploads` | `{ filename, size, mimeType }` → 201 upload session for a library track (Settings → Music library). Parts and completion use `/api/uploads/[id]/…`; completion needs `licence` and `confirmLicence: true`. The session is stored against the most recently active project the user can open (upload sessions belong to a project); 409 "Create a project…" when there is none. The finished track is a library track |
| PATCH / DELETE | `/api/music/[id]` | `{ title?, artist?, moods?, licence?, confirmLicence? }`. `confirmLicence: true` records the confirmation time on the server (new licence details confirmed again are dated now); `false` withdraws it, so Generate refuses the track |

## Media
`GET /api/media/[token]` streams a file for the local storage driver after verifying the HMAC token (supports HTTP
Range for video seeking). With the S3 driver, links are presigned by the bucket instead.

## Stage B/C shared routes (foundations, WP0)

**Public paths** (no session; listed once in `apps/web/src/lib/public-routes.ts`): `/privacy`, `/terms`,
`/data-deletion`, `/api/webhooks/*`, `/api/public/*`, `/r/*`, `/u/*`, plus the Stage A ones. Each protects itself
(signatures, Basic credentials or unguessable tokens; legal pages answer 404 until published).

| Method | Route | Notes |
| --- | --- | --- |
| GET / PUT | `/api/settings` | Also `legal: { privacy \| terms \| dataDeletion: { draft, published, publishedAt } }` (owner) and `business.termsUrl` / `business.privacyUrl`. Sections the request does not mention are kept |
| GET | `/privacy`, `/terms`, `/data-deletion` | Public pages with the text the owner published in Settings → Business → Legal pages; 404 until published. Blank `business.privacyUrl` / `termsUrl` mean these pages |
| GET | `/api/integrations/google/connect` | Owner. `?product=business_profile\|search_console` (anything else 400). 302 to Google with that product's scope only, `access_type=offline`, `prompt=consent`, PKCE S256; sets the 10-minute HttpOnly state cookie `sa_oauth_google` (path `/api/integrations/google`). 422 when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are missing |
| GET | `/api/integrations/google/callback` | Owner, same session. Checks the state cookie (missing, tampered, expired, other session or mismatched state are refused), exchanges the code once (10 s, no retry), stores encrypted tokens in the product's own row (`google_business_profile` or `google_search_console`), audits, queues the product's read-only check when its module has registered it, clears the cookie and returns 302 to `/settings?tab=integrations&connected=…` (or `checking=…`, or `google_error=<plain message>`) |
| GET | `/api/integrations/status` | Each entry also has `state` (`not_configured`, `not_connected`, `connected`, `awaiting_approval`, `unavailable`, `needs_reauth`, `error`), `liveMode` (`live`, `development_live`, `sandbox`, `staging`, `read_only` or null) and `verified` |

Webhook routes call `readRawBody` (256 KiB limit, 413 above it), verify, then `storeWebhookEvent`: one row per
(provider, external event id) and one `webhook.process` job only when the row is new.

## Music (Stage B, WP1)

Licence passport rules apply on every way in (`POST /api/music`, `PATCH /api/music/[id]`, upload completion): CC BY-NC
is refused (400 "Non-commercial licences don't cover promoting a business…"), CC BY needs `attributionText`, and
`meta_sound_collection` is forced to `destinationLock: 'meta_only'` with TikTok, YouTube and website off. Licence
fields added in Stage B: `accountHolder`, `planName`, `providerTrackRef`, `downloadedAt`, `termsAcceptedAt`,
`permitted.facebook`, `permitted.paidAds`, `destinationLock`. Track summaries add `genres` and `licenceState`
(`confirmed` / `not_confirmed` / `expired` / `meta_only`).

| Method | Route | Notes |
| --- | --- | --- |
| PATCH | `/api/music/[id]` | Also `genres`. Licence changes and `confirmLicence` are **owner only** (403 for staff); staff may change title, artist, moods and genres. DELETE is owner only |
| GET | `/api/music/[id]/listen` | `{ url, expiresInSeconds, mimeType }`: expiring link to the track's audio (Sound panel "Listen") |
| GET | `/api/music/suggestions?durationSec=25&styleId=beat_montage` | `{ tracks: [{ id, score, rank, reasons, usable, unusableReason? }], notes }`: the owner's own tracks ranked by genre, mood, artist and tempo; unusable ones (not analysed, licence not confirmed or expired, shorter than the edit) last with the reason. Nothing is chosen automatically; nothing outside the library is searched |
| GET | `/api/music/versions/[id]` | Studio access. The music of one version: track and licence chip, `clearance` (`MusicClearance`), `clearanceSummary`, `downloadLabel`, the plan's sound settings, beats and loudness, and `noMusicExport` state |
| GET / POST | `/api/music/references` | Private Spotify references (memo §1). GET (signed in) `{ mode, storedMode, canEmbed, missing, termsAcknowledged, notice, references }`; POST (owner) `{ url, notes? }` → 201; 400 "That isn't a Spotify link." (lookalike hosts refused), 409 when already saved. Only the canonical URL, type, id and notes are stored; the server never calls Spotify |
| PATCH / DELETE | `/api/music/references/[id]` | Owner. `{ notes }` |
| PUT | `/api/music/references/mode` | Owner. `{ mode: 'link_only' \| 'embed', acknowledgeSpotifyTerms?: true }`. `embed` is refused (409, `details.missing`) until a terms of use page and a privacy policy page exist (own URLs or the published `/terms` and `/privacy`) and Spotify's terms are acknowledged. `link_only` always works. The embed URL is only returned while embed mode is in force |
| POST | `/api/edits/[id]/revise` | `{ instruction?, audio?: AudioPatch }` (at least one). A sound change alone that needs no re-cut queues `edits.revise` with `mode: 'audio'` (same cuts, `planSource: 'manual'`, "Sound changed · cuts kept"); a new track, beat options or `startSec` with `keepCuts: false` re-plan (`mode: 'revise'`, "Re-cut to the music"). A chosen `trackId` must be a ready library track with a confirmed licence |
| POST | `/api/edit-versions/[id]/export[?variant=no_music]` | Standard: 409 `CONFLICT` with `details.musicClearance` when the music is not cleared (audit `music.export_blocked`); response adds `variant` and `musicClearance`. `no_music`: the same version rendered without music into `export-no-music.mp4` (`edit_versions.variant_exports.no_music`); never needs clearance; idempotent per variant (singleton `export:{id}:{variant}`) |
| GET | `/api/edit-versions/[id]/download` | `?kind=export\|export_no_music\|preview`. Adds `musicClearance` and `label` ("For Instagram/Facebook upload only" with file name suffix `-instagram-facebook-only` for Meta-locked music) |

Worker side: `render.export` checks the standard variant's clearance again before rendering; a blocked export is
marked failed with the reason and the job ends without a retry. A successful standard export with music inserts one
`music_usage` row (`purpose 'export'`, licence snapshot, clearance; `ON CONFLICT DO NOTHING`).

## Preferences (Stage B, WP2)

Learned editing preferences, "Hide this edit", reference videos and the logo in videos. Learning is deterministic
(no model training): favourites, downloads, publishes, revisions, regenerations and hidden edits are recorded in
`feedback_events` with a plan-facts snapshot, and the `preferences.recompute` job (debounced 10 s after feedback,
nightly at 3:17 am Melbourne time) writes only `preferences.learned` and `preferences.styleAffinity` with `jsonb_set`.
Effective value per field: pinned → declared; else learned (when learning is on); else declared.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/preferences` | Signed in (staff read-only, `canEdit: false`). `{ declared, effective, learned, learning, fields: [{ field, label, value, source: 'learned'\|'owner'\|'reference'\|'default', explanation, suggestion, pin, notEnoughEvidence }], recent: [{ id, type, text, when, at }], canEdit }`; `recent` is the last 20 choices in plain words with Melbourne times |
| POST | `/api/preferences/pin` | Owner. `{ field, pinned, value? }`. Pinning without a value pins the value in use; a value is validated per field (400). Audit `preferences.pinned` / `preferences.unpinned` |
| POST | `/api/preferences/learning` | Owner. `{ enabled }` ("Learn from my choices"). Audit `preferences.learning_toggled` |
| POST | `/api/preferences/reset` | Owner. `{ confirm: true }` (400 without it). Sets `learning.resetAt` to now, clears `learned` and `styleAffinity`, keeps the owner's settings and pins, queues a recompute. Audit `preferences.learning_reset` |
| POST | `/api/preferences/recompute` | Owner. "Try again" after `learned.error` was set. `{ queued: true }` |
| PUT | `/api/settings` (changed) | `preferences.learned`, `.learning` and `.styleAffinity` are refused (400 "Use the preferences controls…"); a `music` section is refused with a 400 naming `PUT /api/music/references/mode`. Every learnable field the patch changes is pinned `by: 'owner'`. The write happens under a row lock and keeps the stored `learned` and `styleAffinity`. Changing `brand.logoPlacement` adds audit `settings.logo_placement_changed` |
| POST | `/api/edits/[id]/dismiss` | Studio access. `{ value }`: "Hide this edit" / "Show again" (`edits.dismissed_at`; nothing is deleted); records a `dismiss` feedback event with plan facts and queues the recompute |
| POST | `/api/references/uploads?projectId=…[&useVision=1]` | Studio access to the project. Body as `POST /api/projects/[id]/uploads` (video file rules; `kind` ignored). Starts a `reference_video` upload; `useVision=1` stores the owner's tick for the on-screen text estimate (`driverState.referenceOptions`). Parts and `POST /api/uploads/[id]/complete` work as for clips; completion returns `kind: 'reference_video'`, queues `ingest.asset` (reference branch) and writes audit `reference.uploaded`; the project status is not changed |
| GET | `/api/references` | Owner. `{ references: [{ id, filename, status, statusMessage, thumbnailUrl, profile, createdAt, projectId, projectTitle }] }` across projects that still exist |
| POST | `/api/references/[assetId]/decide` | Owner. `{ accept: SuggestionField[], dismiss: SuggestionField[] }` (`defaultDurationSec`, `pacing`, `colour`, `textDensity`; 400 for a field the reference did not suggest or one in both lists). Accepting sets the value and pins it `by: 'reference'` with the file name. `{ profile, preferences }`; audit `reference.suggestions_decided` |
| DELETE | `/api/assets/[id]` (existing) | Also removes a reference video; accepted preferences stay pinned |

`GET /api/projects/[id]/status` (changed): edits gain `dismissed`; `defaults` come from the effective preferences and
gain `styleOrder` and `musicVolume`; `references: ReferenceDto[]` (reference videos are never in `assets`); music
options carry `genres`, `moods` and `licenceState`. New generations order their cards by the effective style order.

Feedback written by the web app: `favourite`/`unfavourite` and `dismiss` (`planFacts` of the current version),
`download` (`planFacts`; the music-free file counts without music), `revise` (`instruction`, parsed `hints`,
`audioPatch`, `parentPlanFacts`) and `regenerate` (`parentVersionId`, `parentPlanFacts`). Favouriting no longer
changes `styleAffinity` in the request.

Worker side: `ingest.asset` for `kind = 'reference_video'` makes the proxy, thumbnail and shot list (no vision
labelling, no transcription), samples 8 frames only with the owner's tick and a configured AI provider, then queues
`reference.analyse` (singleton `reference:<assetId>`). That job measures the look (`signalstats`), optionally asks
the vision model whether added text is visible (≤ 8 frames, `oversized_image: 'error'`, never identifies people;
usage recorded as `reference:text`), stores `media_assets.reference_profile` and deletes the original, proxy and
frames (keeps the thumbnail). `render.preview` stores the brand it used in `edit_versions.render_brand` (logo copied
to `brand/render-logos/<sha256>.<ext>`); `render.export` reuses that snapshot so the export matches its preview. A
missing logo renders without it ("Logo not found — rendered without it").

## Trends (Stage B, WP3 and WP5)

Settings → Trends shows three groups that are never mixed: **live signals** (official APIs only; each item has its
source and fetch time in Melbourne time and goes "Out of date" after 48 h), **noted by staff** and **curated
references** (sourced, dated barber formats). Every item's `label` comes from `trendLabel` (`packages/core/src/
trend-label.ts`) and never says "trending" or "viral". No trend data is ever passed to an edit planner.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/trends` | Signed in. `{ live: [{ watch, items, posts? }], noted: TrendItemDto[], curated: TrendItemDto[], sources: [{ provider, status, watch, watches?, budget? }], viewer: { id, isOwner } }`. `TrendItemDto` has `kind` (`curated`, `noted`, `live`), `label`, `dueForReview` (curated, 180 days), `editorSuggestion` (no source link), `sources`, `stale` and the YouTube row fields (`channelTitle`, `categoryName`, `position`). Instagram hashtag groups (WP5) are in Instagram's `top_media` order and carry `posts` (`rank`, `mediaType`, `mediaTypeLabel`, `postedAt`, `likeCount`, `commentsCount`, `countsLine`, `permalink`; never captions, images or account names); the `instagram_hashtag` source has `watches` (one per hashtag) and `budget` (`used`, `limit` 30, `enabled`, `maxEnabled` 10, `nextFreeAt`) |
| POST / PUT / DELETE | `/api/trends` | Owner. Curated references only (`sourceKind` cannot be set by clients; noted and live rows give 404). PUT `markVerified: true` = "Mark reviewed" |
| POST | `/api/trends/notes` | Signed in. `{ title, summary?, platform: tiktok\|instagram\|youtube\|in_person\|other, sourceUrl? (http/https), seenOn: YYYY-MM-DD (not in the future), category? }` → 201 `{ trend }` labelled "Noted by <name> on <date> · seen on <platform>"; audit `trends.noted` |
| DELETE | `/api/trends/notes/[id]` | The owner, or the person who noted it (otherwise 403); audit `trends.note_deleted` |
| POST | `/api/trends/watches` | Owner. `{ provider: 'youtube_chart' }` or `{ provider: 'instagram_hashtag', hashtag }` → `{ watch, jobId }` and queues `trends.refresh` (the first read is the capability check); already on → `jobId: null`. YouTube: 422 `INTEGRATION_NOT_CONFIGURED` without `YOUTUBE_API_KEY`. Instagram (WP5): the hashtag is lower-cased without `#`; 400 `VALIDATION` unless it is letters, digits and underscores (≤ 100) and free of "trending"/"viral"; 422 `INTEGRATION_NOT_CONFIGURED` without the Meta app settings or a connected Instagram account ("Reconnect …" when it needs re-authorisation); 409 `CONFLICT` with 10 hashtags watched; 429 `RATE_LIMITED` (`details.nextFreeAt`) when 30 distinct hashtags were queried in the last 7 days (turned-off ones included); a hashtag already counted this week can be turned back on. Audit `trends.watch_added` |
| DELETE | `/api/trends/watches/[id]` | Owner. Turns the source off and deletes its items; the row stays 7 days (hashtag budget). Audit `trends.watch_removed` |
| POST | `/api/trends/watches/[id]/refresh` | Owner. `{ jobId }`; reuses a queued or running read. 429 `RATE_LIMITED` (with `details.nextRefreshAt`) within 6 h of the last query, or 5 min after a failed one |

`GET /api/integrations/status` has a `youtube_chart` entry: `not_configured` without the key (names
`YOUTUBE_API_KEY` only), otherwise `not_connected` with `liveMode: 'read_only'`; the list there does not read the
watch, so the chart's own state (`connected`, `error` for quota or a bad key) is in the `sources` of `GET /api/trends`.
It also has an `instagram_hashtags` entry (WP5): `not_configured` without `META_APP_ID`, `META_APP_SECRET`,
`META_LOGIN_CONFIG_ID`; `not_connected` until Instagram is connected (publishing) and while no hashtag is watched;
`needs_reauth` when the `meta` connection or a watch needs reconnecting; `unavailable` once Meta refused hashtag search
(`social_accounts.capabilities.hashtagSearch = false`); `connected` (`liveMode: 'read_only'`) after a successful read.

Job `trends.refresh` `{ watchId: string | null }`: null (the daily 5:41 am Melbourne schedule, key `daily`) queues one
read per enabled watch. One read: `GET https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&
regionCode=AU&maxResults=20` (1 quota unit, 15 s limit). 200 → items upserted on `(watch_id, external_id)`, items
missing from the result deleted, watch `ok`. `quotaExceeded`/`dailyLimitExceeded` → `quota`; 400 (`keyInvalid`,
`badRequest`) → "The YouTube API key isn't valid."; `accessNotConfigured` → "Turn on YouTube Data API v3 in your Google
Cloud project."; 5xx/429/network → one retry after 5 minutes, then `error`. `maintenance.cleanup` deletes live items
fetched over 7 days ago and turned-off watches last queried over 7 days ago.

Instagram hashtag watch reads (WP5, worker `modules/trends/instagram.ts`), as the watch's Instagram account with the
`meta` connection's token in an `Authorization: Bearer` header (never in a URL or payload) plus `appsecret_proof`,
15 s per call: first `GET graph.facebook.com/{META_GRAPH_VERSION}/ig_hashtag_search?user_id&q` (stores the hashtag id
in `external_id`), then on every read `GET /{hashtag-id}/top_media?user_id&fields=id,media_type,permalink,timestamp,
like_count,comments_count&limit=9`. Before each read the watch takes a place in the weekly limit under an advisory
lock (a hashtag already counted this week always may; a new one is refused as `quota` with the date a place frees
up, and nothing is called). Mapping: 190 → `needs_reauth`; 10, 200–299 or a permission/feature message →
`unavailable` and `capabilities.hashtagSearch = false`; 4, 17, 32, 613 → `quota` ("Instagram asked us to slow down;
trying again tomorrow"); Instagram's 30-hashtag message → `quota`; empty search → `error` ("Instagram found no hashtag
with that name"); other 4xx → `error` with Meta's message; 5xx/429/network/time-out → one retry, then `error`.

## Publishing (Stage B, WP4 and WP10)

Manual posting ("Post it yourself") always works; Instagram direct publishing (Meta Unified Login, system-user token,
Development mode) is optional and switched on only after a first verification post the owner confirms. TikTok is
manual only until WP10. Nothing is ever posted to test a connection. Times are entered in Melbourne time and stored in
UTC. Staff see and draft posts of their own projects; approval, cancel, retry, resolve and every integration control
are owner only.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/publishing/eligibility?versions=a,b` | Session. Per version (1–5, preview ready): `eligibility` (`PlatformEligibility[]`: `allowedVariants`, `automationAllowedForStandard`, `reasons`, `manualStepHint`, `downloadLabel`), `methods` (`MethodOption[]` per platform; `manual` always available, `instagram_api` only with a connected account: `isVerification` until verified, unavailable while the switch is off), `captionSuffix` (CC BY credit), `defaultCoverTimeSec`, `priorTargets`; plus `quota.instagram`, `captionFooter`, `canApprove` |
| GET | `/api/publishing/candidates` | Session. Recent preview-ready versions for the composer's picker (nothing ticked) |
| GET | `/api/publishing/connections` | Session. Instagram connection facts (never the token): `configured`, `missingEnv`, `connectionStatus`, `lastError`, `tokenExpiresAt` (null = never), `tokenExpiringSoon` (7 days), `discoveryEmpty`, `accounts` (verified, `directPublishEnabled`, quota), handles, `captionFooter`, `canManage` |
| GET | `/api/publishing/badges?versions=a,b` | Session. `{ badges: [{ versionId, platform, status, label }] }` for Studio and Library cards ("Instagram · Posted", "TikTok · Your turn", "… · Scheduled 15 Nov") |
| PUT | `/api/publishing/settings` | Owner. `{ captionFooter ≤ 500 }` (stored in `settings.publishing` with `jsonb_set`) |
| POST | `/api/publish-posts` | Session. `{ items: [{ editVersionId, caption, coverTimeSec, mode: now\|scheduled\|draft_handoff, schedule?: { date: YYYY-MM-DD, time: HH:mm }, targets: [{ platform, method, delivery?, variant }] (1–2, one per platform) }] (1–5), allowRepeat? }` → `{ posts: PublishPostDto[] }` (status `draft`). 400 for a caption over 2,200 graphemes (credit line included), a Melbourne time that does not exist ("That time doesn't exist in Melbourne…"), less than 10 minutes or more than 90 days ahead, a file the music rule refuses (e.g. Meta Sound Collection music to TikTok), or a method not on offer; 422 `UNSUPPORTED` for Zernio; 409 when the version already has a published, processing or submitted target on that platform unless `allowRepeat` |
| POST | `/api/publish-posts/approve` | Owner. `{ postIds, consent?: { tiktokPublic } }`. Re-runs the music rule (400 when the licence changed), stores `music_check` with the licence snapshot, sets `approved_by/at`, audits `publish.approved`, queues `publish.prepare`. Idempotent. A Zernio target needs `consent.tiktokPublic` (400). Writes no feedback event and no `music_usage` row |
| GET | `/api/publish-posts?view=queue\|history&cursor=` | Session. Queue = draft/approved/in progress or any destination waiting for the owner; history = the rest. Newest first |
| GET / PATCH / DELETE | `/api/publish-posts/[id]` | GET adds `history` (audit entries). PATCH `{ caption?, coverTimeSec?, schedule?, targets? }`: a time change keeps the approval; anything else returns an approved post to `draft` (owner); 409 once a destination has started going out. DELETE: drafts only (409 otherwise), cover removed |
| POST | `/api/publish-posts/[id]/cancel` | Owner. Destinations without `submitted_at` become `cancelled`; published ones stay. 409 for a draft (delete it instead) |
| GET | `/api/publish-targets/[id]/media` | Session. `{ videoUrl, videoFilename, byteSize, coverUrl (Instagram), caption, label }` with expiring links to the exact file the music rule picked. 409 until the file is prepared |
| POST | `/api/publish-targets/[id]/confirm-posted` | Session (owner for `check_before_retry`). `{ url? }`: only `https://www.instagram.com/(reel\|p)/…`, `https://www.tiktok.com/@…/video/…` or `https://vm.tiktok.com/…` (400 otherwise; lookalike hosts refused). → `published` with `confirmed_by/at`; writes the `publish` feedback event (once per version and platform) and the `music_usage` row (standard file with music, `purpose 'publish'`, the platform). On a published target without a link it only adds the link |
| POST | `/api/publish-targets/[id]/undo-confirm` | Session. Manual confirmations only → back to the owner's turn (feedback is kept) |
| POST | `/api/publish-targets/[id]/retry` | Owner. `failed` and retryable only → `queued` with the same idempotency key; queues `publish.target` (or `publish.prepare` when the file is missing) |
| POST | `/api/publish-targets/[id]/resolve` | Owner. `{ action: post_without_music \| post_manually \| retry_anyway \| mark_posted }`. `post_without_music` (after a copyright match or a licence change): variant `no_music`, container cleared, prepared again. `post_manually`: method `manual` (variant switched to one the licence allows). `retry_anyway` (`check_before_retry` only): clears `submitted_at`, audited `publish.target.override_retry`; the worker reads the platform's status first |
| POST | `/api/social-accounts/[id]/verification` | Owner. `{ result: seen\|not_seen, targetId }` for a published first verification post; `seen` sets `capabilities.verifiedDirectAt` |
| PATCH | `/api/social-accounts/[id]` | Owner. `{ directPublishEnabled }`; 409 until the verification is recorded |
| GET | `/api/integrations/instagram/connect` | Owner. 302 to `https://www.facebook.com/{v}/dialog/oauth?client_id&redirect_uri&config_id&response_type=code&override_default_response_type=true&state` (no `scope`); state in the 10-minute `sa_oauth_meta` cookie (path `/api/integrations/instagram`). 422 without `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` |
| GET | `/api/integrations/instagram/callback` | Owner, same session. One code exchange (`GET /{v}/oauth/access_token`, 10 s, no retry), token encrypted on the `meta` connection, audit `integration.meta.connected`, queues `social.check` (reason `connect`), back to `/settings?tab=integrations&instagram=checking` (or `instagram_error=…`) |
| POST | `/api/integrations/instagram/account` | Owner. `{ igUserId: 5–30 digits }` when discovery is empty → stored as `config.pendingIgUserId`, read-only check queued |
| DELETE | `/api/integrations/meta` | Owner. Token wiped, connection `disconnected`, accounts `disconnected` with the switch off, unsent automated Instagram targets → "reconnect" |
| POST | `/api/integrations/[provider]/check` | Owner. `meta` (or `instagram`) → `{ jobId }` of a read-only `social.check`; other providers 404 |

`PublishPostDto` = `{ id, versionId, projectId, projectTitle, styleName, versionNo, previewThumbUrl, caption, coverUrl,
coverTimeSec, mode, scheduledFor, scheduledForLabel, status, statusMessage, approvedAt, createdAt, targets }`;
`TargetDto` = `{ id, platform, method, delivery, handle, variant, status, manualStep, statusMessage, publishedUrl,
publishedAt, confirmedByName, attempts, isVerification, accountId, awaitingVerificationAnswer, actions }` (types in
`apps/web/src/lib/shared/publishing-dto.ts`; `actions` from `targetActionsFor` in core).

Jobs (worker): `publish.prepare { postId, projectId }` (file exists? else queue `render.export` with the variant;
ffprobe check against the platform's limits; cover JPEG cut from the export; manual targets become the owner's turn
when due, automated ones get `publish.target`), `publish.target { targetId, postId, projectId }` (claim → Instagram
state machine), `publish.poll { …, pollNo }` (container status every 60 s ×5, then every 5 min up to 24 h, then the
copyright check), `publish.dispatch {}` (every minute, key `every-minute`), `social.check { connectionId, reason }`
(read-only; daily at 4:23 am Melbourne, key `daily`). The three per-target queues are pg-boss `stately`.

## Square appointments (Stage C, WP6 and WP6b)

## Email and reviews (Stage C, WP7)

## Website and local search (Stage C, WP8)

## Google Business Profile (Stage C, WP9)
