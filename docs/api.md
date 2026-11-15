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
| GET | `/api/music/suggestions?durationSec=25&styleId=beat_montage` | `{ tracks: [{ id, score, rank, reasons, usable, unusableReason? }], notes }`: the owner's own tracks ranked by genre, mood, artist and tempo; unusable ones (not analysed, licence not confirmed or expired, shorter than the edit) last with the reason. With an accepted `preferences.editingStyle.musicFit` (tempo and energy estimated from the owner's own videos): +2 when the track's BPM is in the range ("Tempo close to your videos (118–126 BPM)"), +1 for half or double time, +1 for a clear drop (≥ 6 dB, found on the track's own stored energy curve) when the videos have one; tracks without a BPM say "tempo unknown". Nothing is chosen automatically; nothing outside the library is searched |
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
| PUT | `/api/settings` (changed) | `preferences.editingStyle` value fields (`transitionPalette`, `beatSync`, `beatsPerCut`, `reveal`, `zoom`, `musicFit`) are editable and merged over the stored style; `editingStyle.sources` and `.summaryDecisions` are refused (400); each changed value records `sources[field] = { by: 'owner' }` and audit `preferences.editing_style_changed`. `preferences.learned`, `.learning` and `.styleAffinity` are refused (400 "Use the preferences controls…"); a `music` section is refused with a 400 naming `PUT /api/music/references/mode`. Every learnable field the patch changes is pinned `by: 'owner'`. The write happens under a row lock and keeps the stored `learned` and `styleAffinity`. Changing `brand.logoPlacement` adds audit `settings.logo_placement_changed` |
| POST | `/api/edits/[id]/dismiss` | Studio access. `{ value }`: "Hide this edit" / "Show again" (`edits.dismissed_at`; nothing is deleted); records a `dismiss` feedback event with plan facts and queues the recompute |
| POST | `/api/references/uploads?projectId=…[&useVision=1]` | Studio access to the project. Body as `POST /api/projects/[id]/uploads` (video file rules; `kind` ignored). Starts a `reference_video` upload; `useVision=1` stores the owner's tick for the on-screen text estimate (`driverState.referenceOptions`). Parts and `POST /api/uploads/[id]/complete` work as for clips; completion returns `kind: 'reference_video'`, queues `ingest.asset` (reference branch) and writes audit `reference.uploaded`; the project status is not changed |
| GET | `/api/references` | Owner. `{ references: [{ id, filename, status, statusMessage, thumbnailUrl, profile, createdAt, projectId, projectTitle }] }` across projects that still exist |
| POST | `/api/references/[assetId]/decide` | Owner. `{ accept: SuggestionField[], dismiss: SuggestionField[] }` (`defaultDurationSec`, `pacing`, `colour`, `textDensity`; 400 for a field the reference did not suggest or one in both lists). Accepting sets the value and pins it `by: 'reference'` with the file name. `{ profile, preferences }`; audit `reference.suggestions_decided` |
| DELETE | `/api/assets/[id]` (existing) | Also removes a reference video; accepted preferences stay pinned |
| GET | `/api/references/summary` | Signed in (staff read-only: rows and counts only, `list` and `referenceAssetIds` empty). "Your style from your videos" (preferences design §4.3.1.4, §4.3.1.9): the latest 12 measured reference videos of every project combined. `{ summary: { total, measured, olderMeasurement, updatedAt, referenceAssetIds, suggestions }, suggestions: SummarySuggestion[], videos: { total, measured, olderMeasurement, measuring, failed }, list: [{ id, filename, projectId, projectTitle, thumbnailUrl, measuredAt, line, olderMeasurement }] }`. Rows in order Pace, Length, Colour, On-screen text, Transitions, Cutting to the beat, Big moment (reveal), Zooms, Music: `{ field, label, value, valueKey, seen, action, evidence: { measured, agreeing, total, notMeasured: [{ reason, count }] }, alsoChanges: [{ field, value }], state: 'open' \| 'matches' \| 'differs' \| 'accepted' \| 'dismissed' \| 'not_measured', inUse }`. Every value is an estimate; a row is offered only when ≥ 60 % of the measured videos agree and at least two were measured (or exactly one video exists) |
| POST | `/api/references/summary/decide` | Owner. `{ accept: ReferenceSummaryField[], dismiss: ReferenceSummaryField[], valueKeys: { [field]: string } }`. 409 `CONFLICT` "Your style summary changed — check the new suggestion." when a `valueKey` no longer matches (nothing is written); 400 for a row without a suggestion or a field in both lists. Accepting a length/pace/colour/text row sets the declared value and pins it `by: 'reference'` (`referenceName: 'Your videos (n)'`, `referenceAssetIds`); an editing-style row sets `preferences.editingStyle[field]` with `sources[field] = { by: 'reference' }`; `alsoChanges` are applied with the row (a palette with a flashy type also sets `transitions: 'varied'`; "Cutting to the beat" also sets `beatsPerCut`). Every decision is recorded in `editingStyle.summaryDecisions` with its `valueKey`; a dismissed row comes back only when its value changes. All writes go through `updateSettingsLocked`. `{ summary, preferences }`; audit `reference.summary_decided` (+ `preferences.editing_style_changed` when something was accepted) |
| POST | `/api/references/summary/reset` | Owner. "Go back to each style's own": `editingStyle` values and their sources return to the defaults (their summary decisions are forgotten); length, pace, colour and text stay. `{ summary, preferences }`; audit `preferences.editing_style_changed` |

`GET /api/projects/[id]/status` (changed): edits gain `dismissed`; `defaults` come from the effective preferences and
gain `styleOrder` and `musicVolume`; `references: ReferenceDto[]` (reference videos are never in `assets`); music
options carry `genres`, `moods` and `licenceState`. New generations order their cards by the effective style order.

Feedback written by the web app: `favourite`/`unfavourite` and `dismiss` (`planFacts` of the current version),
`download` (`planFacts`; the music-free file counts without music), `revise` (`instruction`, parsed `hints`,
`audioPatch`, `parentPlanFacts`) and `regenerate` (`parentVersionId`, `parentPlanFacts`). Favouriting no longer
changes `styleAffinity` in the request.

Reference profiles (`media_assets.reference_profile`) are `version: 2` since reference style v2 (design §4.3.1.5):
the v1 fields plus `style` (`ReferenceStyleSignals`: measured span, end screen skipped, raw shot quartiles, join counts
and family, beat sync with its chance correction, drop, zooms, music tempo and 8-point energy shape; every number an
estimate, no array longer than 8). Readers use `readReferenceProfile`, which returns a stored v1 profile in the v2
shape with `style: null` (shown as "Measured before transitions and beat were added"); stored v1 rows are never
rewritten. `ReferenceDto.profile` is always that v2 shape.

Worker side: `ingest.asset` for `kind = 'reference_video'` makes the proxy, thumbnail and shot list (no vision
labelling, no transcription), samples 8 frames only with the owner's tick and a configured AI provider, then queues
`reference.analyse` (singleton `reference:<assetId>`). That job measures the look (`signalstats`), then the reference
style v2 signals with `measureReferenceStyle` on the proxy (asset status messages "Measuring transitions" and
"Measuring the beat"; the reference's own sound is decoded in memory only for tempo, beat alignment and energy, and is
never kept, exported or sent to any AI model), optionally asks
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
manual, plus the optional route through Zernio (WP10, below) when the server sets `TIKTOK_PUBLISH_PROVIDER=zernio`.
Nothing is ever posted to test a connection. Times are entered in Melbourne time and stored in
UTC. Staff see and draft posts of their own projects; approval, cancel, retry, resolve and every integration control
are owner only.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/publishing/eligibility?versions=a,b` | Session. Per version (1–5, preview ready): `eligibility` (`PlatformEligibility[]`: `allowedVariants`, `automationAllowedForStandard`, `reasons`, `manualStepHint`, `downloadLabel`), `methods` (`MethodOption[]` per platform; `manual` always available, `instagram_api` only with a connected account: `isVerification` until verified, unavailable while the switch is off; `zernio` twice (`delivery` `publish` and `draft`) only with the flag on and a chosen account, each `isVerification` until its own verification, with `tiktokInteractions` seeds), `captionSuffix` (CC BY credit), `defaultCoverTimeSec`, `priorTargets`; plus `quota.instagram`, `quota.zernio { last24h, cap: 15 }`, `captionFooter`, `canApprove` |
| GET | `/api/publishing/candidates` | Session. Recent preview-ready versions for the composer's picker (nothing ticked) |
| GET | `/api/publishing/connections` | Session. Instagram connection facts (never the token): `configured`, `missingEnv`, `connectionStatus`, `lastError`, `tokenExpiresAt` (null = never), `tokenExpiringSoon` (7 days), `discoveryEmpty`, `accounts` (verified, `directPublishEnabled`, quota), handles, `captionFooter`, `canManage` |
| GET | `/api/publishing/badges?versions=a,b` | Session. `{ badges: [{ versionId, platform, status, label }] }` for Studio and Library cards ("Instagram · Posted", "TikTok · Your turn", "… · Scheduled 15 Nov") |
| PUT | `/api/publishing/settings` | Owner. `{ captionFooter ≤ 500 }` (stored in `settings.publishing` with `jsonb_set`) |
| POST | `/api/publish-posts` | Session. `{ items: [{ editVersionId, caption, coverTimeSec, mode: now\|scheduled\|draft_handoff, schedule?: { date: YYYY-MM-DD, time: HH:mm }, targets: [{ platform, method, delivery?, variant }] (1–2, one per platform) }] (1–5), allowRepeat? }` → `{ posts: PublishPostDto[] }` (status `draft`). 400 for a caption over 2,200 graphemes (credit line included), a Melbourne time that does not exist ("That time doesn't exist in Melbourne…"), less than 10 minutes or more than 90 days ahead, a file the music rule refuses (e.g. Meta Sound Collection music to TikTok), or a method not on offer; 422 `UNSUPPORTED` for Zernio while the server flag is off; 409 when the version already has a published, processing or submitted target on that platform unless `allowRepeat` |
| POST | `/api/publish-posts/approve` | Owner. `{ postIds, consent?: { tiktokPublic, tiktokInteractions?: { allowComment, allowDuet, allowStitch } } }`. Re-runs the music rule (400 when the licence changed), stores `music_check` with the licence snapshot, sets `approved_by/at`, audits `publish.approved`, queues `publish.prepare`. Idempotent. A Zernio target needs `consent.tiktokPublic` and `tiktokInteractions` (400), refuses a switch TikTok has turned off (400), and stores `provider_state.consent` with the binding (caption, cover, file, delivery, account, choices) the worker re-checks. Writes no feedback event and no `music_usage` row |
| GET | `/api/publish-posts?view=queue\|history&cursor=` | Session. Queue = draft/approved/in progress or any destination waiting for the owner; history = the rest. Newest first |
| GET / PATCH / DELETE | `/api/publish-posts/[id]` | GET adds `history` (audit entries). PATCH `{ caption?, coverTimeSec?, schedule?, targets? }`: a time change keeps the approval; anything else returns an approved post to `draft` (owner); 409 once a destination has started going out. DELETE: drafts only (409 otherwise), cover removed |
| POST | `/api/publish-posts/[id]/cancel` | Owner. Destinations without `submitted_at` become `cancelled`; published ones stay. 409 for a draft (delete it instead) |
| GET | `/api/publish-targets/[id]/media` | Session. `{ videoUrl, videoFilename, byteSize, coverUrl (Instagram), caption, label }` with expiring links to the exact file the music rule picked. 409 until the file is prepared |
| POST | `/api/publish-targets/[id]/confirm-posted` | Session (owner for `check_before_retry`). `{ url? }`: only `https://www.instagram.com/(reel\|p)/…`, `https://www.tiktok.com/@…/video/…` or `https://vm.tiktok.com/…` (400 otherwise; lookalike hosts refused). → `published` with `confirmed_by/at`; writes the `publish` feedback event (once per version and platform) and the `music_usage` row (standard file with music, `purpose 'publish'`, the platform). On a published target without a link it only adds the link |
| POST | `/api/publish-targets/[id]/undo-confirm` | Session. Manual confirmations only → back to the owner's turn (feedback is kept) |
| POST | `/api/publish-targets/[id]/retry` | Owner. `failed` and retryable only → `queued` with the same idempotency key; queues `publish.target` (or `publish.prepare` when the file is missing) |
| POST | `/api/publish-targets/[id]/resolve` | Owner. `{ action: post_without_music \| post_manually \| retry_anyway \| mark_posted }`. `post_without_music` (after a copyright match or a licence change): variant `no_music`, container cleared, prepared again. `post_manually`: method `manual` (variant switched to one the licence allows). `retry_anyway` (`check_before_retry` only): clears `submitted_at`, audited `publish.target.override_retry`; the worker reads the platform's status first |
| POST | `/api/social-accounts/[id]/verification` | Owner. `{ result: seen\|not_seen, targetId }` for a published first verification post (or a Zernio draft verification handed over to the TikTok inbox); `seen` sets `capabilities.verifiedDirectAt` (drafts: `verifiedDraftAt`) |
| PATCH | `/api/social-accounts/[id]` | Owner. `{ directPublishEnabled?, draftsEnabled? }` (`draftsEnabled`: Zernio TikTok accounts); each 409 until its own verification is recorded |
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

### TikTok through Zernio (Stage C, WP10)

Optional, behind `TIKTOK_PUBLISH_PROVIDER=zernio` plus `ZERNIO_API_BASE_URL` (`https://zernio.com/api`); without the
flag nothing about Zernio is offered and the routes below answer 409 (the webhook 404). The web app never calls Zernio:
it stores the key and queues the worker's read-only `social.check`. Facts: `docs/research/zernio-api.md`; design:
publishing §7.2.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/integrations/zernio` | Session. `ZernioConnectionDto`: `enabled`, `configured`, `missingEnv`, `connectionStatus`, `keyHint` (last four characters only; never the key), `lastError`, `lastCheckedAt`, `candidates` (TikTok accounts Zernio listed, each with a plain `problem` or null), `account` (lane, verified, draft verified, both switches, `last24h`), `webhookSigning`, `webhookUrl`, `canManage` |
| POST | `/api/integrations/zernio` | Owner. `{ apiKey: 10–200 characters }` (no prefix check: `sk_` and `zrk_` keys) → `{ status, keyHint, jobId }`. Key encrypted on the `zernio` connection, audit `integration.zernio.connected`, read-only `social.check` queued |
| POST | `/api/integrations/zernio/account` | Owner. `{ zernioAccountId }`, one of the listed candidates (400 otherwise). Keeps one Zernio TikTok row: choosing again replaces its Zernio id; a different handle starts unverified with both switches off. Audit `social_account.selected`; check queued |
| POST | `/api/integrations/zernio/check` | Owner. → `{ jobId }` of a read-only `social.check`. Never posts |
| DELETE | `/api/integrations/zernio` | Owner. Key wiped, account `disconnected` with both switches off, unsent Zernio targets → "reconnect", stored Zernio webhook deliveries deleted. Audit `integration.zernio.disconnected` |
| POST | `/api/webhooks/zernio` | Public (no session, no CSRF), raw body ≤ 256 KB. `X-Zernio-Signature` checked (hex HMAC-SHA256 of the raw body, timing-safe) when `ZERNIO_WEBHOOK_SECRET` is set. Stores an envelope only (`id`, `event`, `postId`, `studioTargetId`, `platform`, `accountId`) under the event id when verified, otherwise under `unverified:<sha256(body)>`; a redelivery is one row and one `webhook.process`. Answers JSON 200 (`{ ok, duplicate }`) even for a bad signature; 400 for a body that is not JSON |

Worker: `publish.target` runs the Zernio state machine (health → account list and cooldown → creator info → presign →
`PUT` upload → `submitted_at` → `POST /v1/posts` with `Idempotency-Key` = target id and `metadata.studioTargetId`);
`publish.poll` reads `GET /v1/posts/{id}` at 1, 2, 5 and 10 minutes, every 15 minutes to 6 hours, then every 50
minutes to 50 hours, or after an unclear create looks the post up (`GET /v1/posts?updatedSince&accountId&fields`) four
times before "check before retry"; a Retry of a failed post calls `POST /v1/posts/{id}/retry`; `webhook.process`'s
`zernio` handler only queues a read (`account.disconnected` queues the check). No new job types.

## Square appointments (Stage C, WP6 and WP6b)

WP6 is Tier 0: read-only. Studio Assistant never sends a message. WP6b adds booking changes and the self-test
(Tier 1, below): built and tested against a fake of Square, but **switched off in this version**
(`SQUARE_TIER1_AVAILABLE = false` in `packages/core/src/square.ts`) until the sandbox smoke test has recorded Square's
real answers (design §11.3); until then every Tier 1 route refuses with a plain reason and nothing is written to
Square. All times are ISO UTC with a Melbourne `…Label` beside them. Types in `apps/web/src/lib/shared/square-dto.ts`.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/integrations/square/connect?access=read` | Owner. 302 to Square's authorise page (code flow, read scopes, `session=false`); state in a 10-minute HttpOnly cookie on `/api/integrations/square`. 409 when the server keys are missing. `access=write` ("Give permission", Tier 1) adds `APPOINTMENTS_WRITE` and `APPOINTMENTS_ALL_WRITE`; 422 while booking changes are not available; the callback audits `integration.square.scopes_upgraded` |
| GET | `/api/integrations/square/callback?code&state[&error]` | Owner, same session. One code exchange (10 s, no retry); another environment's or account's copied data is purged first; tokens stored encrypted; queues `square.sync { reason: 'connect' }`; 302 to `/settings?tab=integrations&square=checking` (or `square_error=…`) |
| GET | `/api/integrations/square` | Signed in. `SquareStatusDto`: `state` (shared union), `liveMode` (`sandbox`/`live`), `dataEnvironment`, location choice, last sync, stale flag, webhooks line, `tier1` (checklist lines, `summary` incl. "Paused: …", `canEnable`/`enableReason`, `switchOn`, `canGivePermission`, `notificationSentence`), `selfTest` (`status`, `current`, `atLabel`, `failure`, `canRun`/`runReason`, `notifies`, `askNotification`, the three `steps`), services with labels, team, latest sync job; owner-only `details` (merchant id, scopes, access expiry). Never tokens |
| PATCH | `/api/integrations/square` | Owner. `{ locationId?, serviceConfirmation?: { variationId, confirmed }, writesEnabled? }` → `SquareStatusDto`. `writesEnabled: true` → 409 unless booking changes are available and checklist lines 1–4 are ticked (plan flag, permissions, a bookable service, a self-test passed on this account and environment); turning it on again clears a pause (`writesSuspendedReason`); audits `writes_enabled` / `writes_disabled`. Choosing a location deletes the copied bookings of every other location (audit `otherLocationBookingsRemoved`) and queues a sync |
| DELETE | `/api/integrations/square` | Owner. `{ purgeData }` → `{ status: 'disconnected', revokeJobId, purged }`. Tokens wiped; with `purgeData` bookings and stored Square webhook deliveries deleted and Square clients scrubbed (never deleted), under the connection row's lock so a running job cannot write them back; queues `square.revoke` (skipped if the same account is reconnected before it runs; no call, audited `revoke_failed { reason: 'environment_changed' }`, when the server has since been switched to the other Square environment). After a disconnect, `GET` carries owner-only `revoke { state: pending\|revoked\|failed, message }`; `failed` tells the owner to remove Studio Assistant in Square's App integrations page |
| POST | `/api/integrations/square/sync` | Owner. → `{ jobId }` (`square.sync { reason: 'manual' }`). 409 when not connected |
| GET | `/api/appointments?view=upcoming\|confirm\|past&from&days&cursor` | Signed in. `{ bookings: BookingDto[], nextCursor, environment, syncedAt }` from the local copy, for the studio's Square location only (empty while the owner still has to choose one) (upcoming: today + 31 days; confirm: ended ACCEPTED bookings of the last 14 days still needing a word; past: 90 days). Past bookings carry `reviewRequest { status, label }` ("Review request: Skipped — …"; a request sent before Square cancelled the booking, marked it a no-show or the owner pressed "Didn't happen" has `status: 'booking_changed'`, "Review request: Sent before the booking changed") or null |
| GET | `/api/appointments/[id]` | Signed in. `BookingDetailDto` (evidence, "Open in Square" link with a one-line instruction; notes, email and phone only for the owner; `squareVersion`; `actions { move, cancel }` each `{ allowed, reason }` — owner only, Tier 1 ready, ACCEPTED, in the future, Move only for a bookable service; `changes: BookingChangeDto[]`) |
| POST | `/api/appointments/[id]/attendance` | Owner or staff. `{ value: 'attended' \| 'not_attended' \| null }` → `BookingDto`. 409 on Square `NO_SHOW`/cancelled/declined/pending or before the start. Sets `completed_at`/`completion_source` (`owner_marked`) once the appointment has ended, for live Square bookings only (a sandbox booking keeps the label but never counts as completed); audit `booking.attendance_marked` |
| GET | `/api/appointments/clients?q&cursor` | Signed in. `{ clients: ClientDto[], nextCursor }`; email and phone (and searching by them) only for the owner |
| GET | `/api/appointments/clients/[id]` | Signed in. `ClientDto` + bookings |
| GET | `/api/appointments/services` | Signed in. `{ services, teamMembers }` with the per-service label (`bookable`, `needs_confirmation`, `book_in_square`, `unverified`, `not_bookable`) |
| POST | `/api/appointments/availability` | Signed in. `{ serviceVariationId, teamMemberId?, fromDate: 'YYYY-MM-DD', days: 1..14, bookingId? }` → `{ searchId, jobId }`. 400 for an unknown service or a day before today (Melbourne). With `bookingId` (the booking's own service) the worker uses Square's booking filter: times that booking could move to |
| GET | `/api/appointments/availability/[searchId]` | Signed in. `{ status, slots: [{ startAt, dayLabel, startLabel, endLabel, teamMemberName, … }], fetchedAt, fetchedLabel, stale, error }` |
| POST | `/api/appointments/changes` | **Owner** (Tier 1). `{ kind: 'create', customerId, serviceVariationId, teamMemberId, startAt, availabilitySearchId, sellerNote? ≤ 4096 }` \| `{ kind: 'reschedule', bookingId, startAt, teamMemberId, availabilitySearchId, expectedVersion }` \| `{ kind: 'cancel', bookingId, expectedVersion }` → `{ change: BookingChangeDto, jobId }`. `customerId` is Studio Assistant's id of a client copied from Square. Records what the owner approved (the segment copied from the slot Square returned), audit `booking.change_requested`, queues `square.booking_change`. 422 with the plain reason while booking changes are not available, switched off or paused, or for a service not bookable from here, a PENDING / past / cancelled booking, or staff; 400 for a slot not in a `done` search at most 5 minutes old with the same barber, or a client from the other environment; 409 when the booking's Square version differs or another change to it is still running |
| GET | `/api/appointments/changes/[id]` | Signed in. `BookingChangeDto { id, kind, status, statusLabel, pill, done, statusMessage, squareDetail, freshSlots, bookingId, startLabel ("Sat 21 Nov, 10:30–11:15 am AEDT"), createdAt, createdLabel, finishedAt, selfTest, canWithdraw }` (polled every second). Never the idempotency key or Square ids. A queued change whose job was cancelled before it started is closed as withdrawn |
| POST | `/api/appointments/changes/[id]/cancel` | **Owner**. Withdraws a `queued` change (→ `cancelled`, audit `booking.change_cancelled`); 409 once checking has started |
| POST | `/api/integrations/square/self-test` | **Owner** (Tier 1). `{ customerId, serviceVariationId, teamMemberId, startAt, availabilitySearchId, acknowledgeLive }` → `{ selfTestId, jobId }`. Creates the three step rows (`<selfTestId>-create`, `-reschedule`, `-cancel`), sets `selfTestStatus: 'running'`, audit `self_test_requested`, queues `square.self_test`. 422 until lines 1–3 are ticked (and while not available); 409 while a test runs; 400 on live Square without `acknowledgeLive`, for a slot not in a fresh search, or one less than 48 hours ahead |
| POST | `/api/integrations/square/self-test/notification` | **Owner**. `{ answer: 'yes' \| 'no' \| 'unknown' }` → `SquareStatusDto`: did the client get Square's confirmation for the test booking (stored as `capabilities.squareNotifiesApiBookings`; drives the change dialog's notification sentence, only for the live account it was given for). 409 unless the current self-test's booking step was confirmed by Square on live (production) Square for this account — a sandbox test, or one that never made a booking, is never asked about |
| POST | `/api/webhooks/square` | Public, no CSRF. HMAC-SHA256 of `notification URL + raw body` (timing-safe); invalid → 401 and not stored; valid → stored once per `event_id` as a minimal envelope (`event_id`, `type`, `merchant_id`, `created_at`, `data: { type, id }`; Square's copy of the object is dropped) and `webhook.process` queued; 404 when `SQUARE_WEBHOOK_SIGNATURE_KEY` is unset |

Jobs (worker; all read-only towards Square except `square.booking_change`): `square.sync { reason: connect|schedule|manual|reconcile }` (token status,
snapshot, bookings in ≤ 31-day windows, reconcile, customers, then `square.attendance`; `stately`; crons every 10
minutes, key `every-10-minutes`, and 2:47 am, key `nightly-reconcile`), `square.refresh { entity, squareId }` (from a
webhook), `square.attendance { squareCustomerId?, fromIso?, toIso? }` (payment matching; every 30 minutes),
`square.availability { searchId }`, `square.token_refresh {}` (3:13 am daily), `square.revoke { merchantId,
environment }`. The `webhook.process` handler for provider `square` ignores other merchants (`merchant_mismatch`) and
only queues `square.refresh`.

Tier 1 jobs (WP6b): `square.booking_change { changeId }` is **the only code that writes to Square** (2 retries 20 s
apart, 5 minutes each): claim (`queued|checking` and no `submitted_at`) → gate (the live connection is the approved
`merchant_id` and environment; checklist) → Square's plan flag (refused → `not_allowed`, pause `plan`) → the service
re-read from the catalogue (bookable at the confirmed version, barber offers it) → the booking (same version, ACCEPTED,
future; else `changed_in_square`) → a fresh SearchAvailability for that Melbourne day (same start and barber; else
`slot_unavailable` with up to 20 nearest `fresh_slots`) → `submitted_at` set under the connection row's `FOR SHARE`
lock → one CreateBooking / UpdateBooking / CancelBooking with idempotency key `sabc_<id>` → `confirmed` (mirrored,
double-booking warning) or Square's 4xx stored verbatim (`not_allowed` pauses changes; 409 → `changed_in_square`;
a 400/422 for a create or move → `rejected` and the service becomes "Book in Square" until the owner confirms it again,
which clears the mark; a 404 on a create → `rejected` without marking the service). The write itself is sent under the
same `FOR SHARE` lock after the same connection check, so a disconnect in between sends nothing. A cancel is not held
back by checklist line 3 (it books nothing). Time-outs and 5xx retry with the same key; after the last attempt
`unknown`, settled by the next `square.sync` (found → `confirmed`, a cancel only when Square shows
`CANCELLED_BY_SELLER`; a client cancel online meanwhile → `changed_in_square` "The client cancelled this in Square.";
not found after 24 hours → "probably not made"). A change whose job was cancelled, or failed before anything was sent
(still `queued`, or `checking` with no `submitted_at`), is closed when it is next read or when another change to the
same booking is requested, and at once when a queued job is cancelled. Statuses: `queued, checking, submitted, confirmed, slot_unavailable, changed_in_square, not_allowed, rejected,
unknown, failed` (Square unreachable while checking; nothing sent), `cancelled`. `square.self_test { selfTestId }` (2
retries, 10 minutes) runs the three steps through the same routine, resumes at the first unfinished step, always
attempts the cancel, and stores `selfTestStatus/At/Environment/MerchantId/Failure` (a test booking that may be left in
Square is named with its time, or both times while the move's outcome is unknown). A test stopped by the owner or
failing on its last attempt is closed by the worker (steps not sent → `cancelled`, a step sent without an answer →
`unknown`) and recorded as failed; one whose worker died is closed the same way by the web app when the card is next
read or a new test is requested. No cron ever queues either job.

## Email and reviews (Stage C, WP7)

Owner = `requireOwner`; Staff+ = any signed-in user. Every state-changing session route goes through `handleApi` (CSRF
guard). Routes never call Postmark or Google: they write rows and queue jobs; `email.send` runs the send gate again
immediately before every provider call. Errors use the standard envelope; a gate refusal is 422 `UNSUPPORTED` with the
reasons in `details` (`path` = reason code).

| Method | Path | Notes |
| --- | --- | --- |
| GET / POST | `/api/email/messages` | Owner. GET `?status=a,b&origin&purpose&customerId&campaignId&view=to_approve\|sent` → `{ items: EmailMessageDto[], nextCursor }` (no token data). POST `{ customerId, templateId?, messageClass: transactional_factual\|campaign, subject, bodyMarkdown }` → draft (`dedupe_key = manual:{id}`) |
| GET / PATCH | `/api/email/messages/[id]` | Owner. GET → `{ message, renderedHtml (markers instead of personal links), timeline, consentBasis, blockers, lint }`. PATCH `{ subject?, bodyMarkdown? }` only while `draft` (409 otherwise) |
| POST | `/api/email/messages/[id]/approve` | Owner. `{ scheduledFor?: ISO \| null }`; 422 with the blockers when the gate would block; a due message is queued at once (`email.send`, key `email-send:{id}`) |
| POST | `/api/email/messages/approve-batch` | Owner. `{ ids (≤ 100) }` → `{ approved, blocked: [{ id, reasons }] }` |
| POST | `/api/email/messages/[id]/cancel` | Owner. 409 once `sending`/`sent` |
| POST | `/api/email/messages/[id]/send-again` | Owner. `{ confirm: true }`, only for `owner_action = check_before_retry`; audited `email.message.override_retry` |
| POST | `/api/email/messages/[id]/preview-to-me` | Owner. Same draft, "[Preview]" subject, to the owner's own address only (origin `preview`) |
| POST | `/api/email/lint` | Owner. `{ messageClass, subject, bodyMarkdown, customerId? }` → `{ errors, warnings, preview: { subject, html, text } }` (no side effects) |
| GET / POST | `/api/email/templates` | Owner. GET seeds the built-in templates once. POST `{ name, purpose, messageClass, subject, bodyMarkdown }`; 400 on lint errors |
| PATCH | `/api/email/templates/[id]` | Owner. Partial + `enabled` (archive; never deleted) |
| PUT | `/api/email/automations/[name]` | Owner. `follow_up` \| `review_request`; `{ enabled, mode, templateId, delayHours, dailyCap }`. Switching on records `enabledAt`; 422 when the review link is missing or Square already sends feedback. Switching off cancels what the automation approved by itself |
| PUT | `/api/email/settings` | Owner. Partial `{ senderName, replyTo, consentWording, allowInferredConsent, sendWindow, dailyCommercialCap, squareSends, webhooksAttested }` |
| GET | `/api/email/status` | Staff+. `{ state, liveMode, approved, webhooks, lastCheckedAt, message, missingEnv, pill }` |
| POST | `/api/email/check` | Owner. Queues the read-only `email.provider.check` (no email is sent) |
| GET / POST | `/api/email/campaigns` | Owner. POST `{ name, templateId?, subject, bodyMarkdown, audience: { lastVisitWithinDays: 90\|180\|365\|null } }` |
| GET / PATCH | `/api/email/campaigns/[id]` | Owner. PATCH only while `draft` |
| POST | `/api/email/campaigns/[id]/audience-preview` | Owner. `{ search? }` → `{ included, excluded, byReason, rows, audienceHash, schedule }` |
| POST | `/api/email/campaigns/[id]/approve` | Owner. `{ audienceHash, confirmConsent: true }`; 409 when the audience or content changed since the preview; queues `email.campaign.expand` |
| POST | `/api/email/campaigns/[id]/pause` · `/resume` · `/cancel` | Owner. Each runs under the campaign row's lock, which expansion also takes, so no message is prepared after a pause or cancel. Pause hands queued, unsubmitted messages back to `approved`; resume expands again (adding nothing twice) when expansion had not finished; cancel stops every unsent message |
| POST | `/api/email/suppressions/[id]/lift` | Owner. `{ note, confirm }`: bounces need "the address was corrected"; complaints need new express consent after the complaint and "they asked to hear from us again"; unsubscribes are only reversed by new consent (409) |
| GET / POST | `/api/customers` | GET Staff+ `?q&permission=express\|none\|unsubscribed\|suppressed`. POST Owner `{ givenName, familyName?, email, phone? }` (409 on a duplicate address) |
| PATCH | `/api/customers/[id]` | Owner. Manual clients only (Square clients: notes only) |
| GET / POST | `/api/customers/[id]/consent` | Staff+. GET → `{ state, events, suppressions, wording, wordingHash, postmarkReactivated, providerStillSuppressed }` (`providerStillSuppressed`: Postmark refused a marketing email after new consent because of the app's own earlier unsubscribe push; the owner removes the address from the Broadcast stream's suppression list in Postmark). POST `{ method: in_person_device\|verbal_owner_recorded, wordingHash, clientConfirmed: true, note? }` (409 when the wording changed); lifts an active unsubscribe only |
| POST | `/api/customers/[id]/unsubscribe` | Staff+. `{ method: in_person\|phone\|reply_email\|owner_other, note? }` |
| POST | `/api/customers/[id]/review-opt-out` | Staff+ may set `true`; only the owner may set `false` |
| GET / POST | `/api/reviews/requests` | Owner. GET `?status` → `{ items, counts: { sentThisMonth, openedThisMonth } }`. POST `{ customerId, visitDate (today … 7 days ago), attest: true }` → a draft, or a `skipped` request with its reason; 409 for the same visit twice |
| POST | `/api/reviews/requests/[id]/approve` · `/skip` · `/cancel`, `/api/reviews/requests/approve-batch` | Owner. Skip `{ reason: asked_in_person\|wrong_client_details\|other, note? }` (note required for `other`) |
| PUT | `/api/reviews/link` | Owner. `{ url }` → validated (`https`, Google hosts only, ≤ 500) into `settings.business.googleReviewLink` |
| POST | `/api/reviews/link/use-google` | Owner. Copies `writeAReviewUri` from the confirmed Places snapshot |
| GET / PUT / DELETE | `/api/integrations/google-places` | Owner. GET → `PlacesStateDto`. PUT `{ placeId }` queues `reviews.places.sync` (`connect`). DELETE removes the Place ID and snapshot |
| POST | `/api/integrations/google-places/confirm` · `/refresh` | Owner. Confirm `{ confirm }` ("No" removes it). Refresh at most every 10 minutes (429) |
| POST | `/api/webhooks/postmark` | Public, no CSRF. HTTP Basic (`POSTMARK_WEBHOOK_USERNAME`/`PASSWORD`, constant time); 401 bad credentials (nothing stored), 503 not configured. Stored once per `(provider, external_event_id)`; `webhook.process` queued only for new rows |
| POST | `/api/public/unsubscribe/[token]` | Public, no CSRF (it can only reduce sending). Form post or RFC 8058 `List-Unsubscribe=One-Click`; idempotent; 303 to `/u/[token]?done=1` (`?invalid=1` for an unknown token). Tokens from an earlier attempt of a message the owner sent again still work |
| GET | `/u/[token]` | Public page. Viewing changes nothing; masked address; works without JavaScript. Shows "You're unsubscribed" only when an unsubscribe (or a withdrawal) is recorded for the address; the query string is ignored |
| GET | `/r/[token]` | Public. Counts a known token's open, then always 302 to the same saved review link (every token, valid or not) |

Jobs: `email.send` (`stately`, key `email-send:{id}`), `email.dispatch` (every minute), `email.automation.sweep` (every
10 minutes), `email.campaign.expand`, `email.provider.check` (daily 4:37 am Melbourne, plus once at worker start-up when
email is configured and the last check is over 10 minutes old, singleton key `email-provider-check:startup`; read-only),
`email.suppression.push`,
`reviews.places.sync` (daily 5:41 am, read-only); `webhook.process` handles provider `postmark`. Job payloads hold ids only.

## Website and local search (Stage C, WP8)

Owner-only (`requireOwner`; staff get 403), through `handleApi` (session + CSRF guard). Long work is always a worker
job; no route calls the owner's website, WordPress or Google. Responses never contain tokens, passwords, page HTML or
apply internals beyond `outcome`, `message` and `verification`. Shapes: `apps/web/src/components/website/types.ts`.

| Method | Route | Body | Response / notes |
| --- | --- | --- | --- |
| GET | `/api/website` | — | `WebsiteOverviewDto`: setup checklist (website, host, ownership, missing details with what each enables, Business Profile comparison text), latest check and its validated result, "fixed since last check", active job, why "Check my website" is disabled, open changes, AI availability, the two connection cards, search word lists, platform hint |
| POST | `/api/website/ownership` | `{ confirm: true }` | `{ host, confirmedAt }`; 400 without a website address. Sets the server-only `website.ownershipConfirmedHost/At`; audit `website.ownership.confirmed` |
| PUT | `/api/website/profile-check` | `{ checked }` | `{ profileDetailsCheckedAt }` (manual comparison, no API call) |
| POST | `/api/website/audits` | `{}` | 202 `{ audit, job }`; 400 setup incomplete; 409 "A check is already running" (database guard: partial unique index) or the 5-minute cool-down; audit `website.audit.requested` |
| GET | `/api/website/audits` | `?limit=20` | `{ audits }` (summaries only) |
| GET | `/api/website/audits/[id]` | — | `{ audit, result, fixedSinceLast }` (older checks keep only their summary) |
| GET | `/api/website/edits` | `?status=open\|done\|dismissed` | `{ edits: WebsiteEditDto[] }` with `applyAvailable { ok, reason }`, copy-paste `instructions { text, markdown }`, AI options, verification |
| POST | `/api/website/edits` | `{ kind: 'image_alt_text', pageUrl, imageSrc, after }` or `{ kind: 'text_replace', pageUrl, before, after }` | 201 `{ edit }`; the page must be in the latest check and `before` in its stored facts; 409 when an open change already exists |
| PATCH | `/api/website/edits/[id]` | `{ after }` | `{ edit, warnings }`; kind limits (titles 10–70, descriptions 50–170); `checkCopyClaims` warnings are soft for the owner's text; source → `owner`. 409 when the change was claimed for applying meanwhile (also for `choose-draft`) |
| POST | `/api/website/edits/[id]/draft` | `{}` | 202 `{ job }` (`website.copy_draft`); 422 when AI isn't configured or the kind isn't a title/description |
| POST | `/api/website/edits/[id]/choose-draft` | `{ index: 0..2 }` | `{ edit }` (source `ai_draft`, always labelled) |
| POST | `/api/website/edits/[id]/apply` | `{ confirm: true, expectedAfter, expectedBefore?, expectedDestination?: { host, environment } }` | 202 `{ edit, job }`; 409 when the wording, the old text or the WordPress destination changed since the dialog opened (or the change changed between reading and approving it); 422 without a connected adapter or for an unsupported kind. Sets `approved_by/at` and `apply_result.approvalHash` (the change and destination approved; the worker refuses to write when either differs); audit `website.edit.apply_requested` (before/after trimmed to 200 characters) |
| POST | `/api/website/edits/[id]/mark-done` | `{}` | `{ edit }`: `applied`, `applied_via = 'manual'`, verification `pending` (the next check confirms it) |
| POST | `/api/website/edits/[id]/reject` | `{ reason? }` | `{ edit }` |
| POST | `/api/website/edits/[id]/undo` | `{}` | 201 `{ edit }`: the reverse change (source `undo`), applied with the normal confirmation; only for WordPress-applied text and image descriptions (not for a removal, whose reverse could never find the text: 422) |
| GET | `/api/website/search-performance` | `?range=28d\|3m\|16m` | `SearchPerformanceDto`: `state` (not_configured / not_connected / choose_property / no_property / syncing / no_data / connected / needs_reauth / error), groups (brand, local, service, other) with impression-weighted average position, the "not listed" remainder, daily series, top 20 searches per group, `dataThrough`. Grouping happens when reading; no numbers unless Google returned rows |
| POST | `/api/website/search-performance/sync` | `{ source: 'search_console' \| 'business_profile' }` | 202 `{ job }`; 429 within 15 minutes of the last sync of that source (a Business Profile sync never blocks or marks Search Console as syncing). `business_profile` does the same as `POST /api/website/business-profile-performance` (422 until Google has approved access) |
| PUT | `/api/website/query-groups` | `{ brandTerms?, placeTerms?, serviceTerms? }` | `{ website }` |
| PUT | `/api/integrations/google-search-console/property` | `{ siteUrl }` (one of the readable listed properties) | `{ property, job }` + queues `search.sync` (`connect`) |
| POST | `/api/integrations/google-search-console/check` | `{}` | 202 `{ job }` (read-only) |
| DELETE | `/api/integrations/google-search-console` | `?deleteData=true\|false` | 202; status `disconnected`, queues the shared `google.disconnect`; `deleteData=true` deletes every stored Search Console row (all properties this connection ever synced, since choosing another property keeps the earlier rows) |
| POST | `/api/integrations/website/wordpress` | `{ baseUrl (https), username, applicationPassword }` | 202 `{ state: 'checking', job }`; the credential is encrypted and never echoed. 400 for a non-443 port, a private or reserved IP address, `localhost`, a local network name, or a name that resolves to a private or reserved address (a name that doesn't resolve yet is accepted; the worker checks again before every connection) |
| POST | `/api/integrations/website/check` | `{}` | 202 `{ job }` (read-only) |
| DELETE | `/api/integrations/website` | — | 204; wipes the credential; approved changes go back to "To review" |

`PUT /api/settings` accepts `business.openingHours` (up to two ranges per day, `HH:MM`, closes after opens) and a
`website` section, from which the server-only ownership fields are dropped. The shared Google routes
(`/api/integrations/google/{connect,callback}?product=search_console`) now queue `website.connection_check`.

Jobs (`packages/core/src/jobs/website.ts`): `website.audit { auditId }`, `website.edit_apply { editId }`,
`website.copy_draft { editId }`, `website.connection_check { provider: 'google_search_console' | 'website', reason }`
(read-only), `search.sync { source: 'search_console', reason: 'connect' | 'daily' | 'manual' }` (daily at 7:37 am
Melbourne, key `search_console_daily`). All have `projectId = null`; payloads hold ids only.

## Google Business Profile (Stage C, WP9)

Owner-only (`requireOwner`; staff get 403), through `handleApi` (session + CSRF guard). No route calls Google: every
read is a worker job. Only what Google returned is ever sent; a number Google did not send is `null` (shown "—").
Shapes: `apps/web/src/lib/shared/business-profile-dto.ts`. One connection (`google_business_profile`, scope
`business.manage`, through the shared `/api/integrations/google/{connect,callback}?product=business_profile`, which
now queues `reviews.gbp.sync { reason: 'connect' }`) serves both the reviews list and the Performance numbers.

| Method | Route | Body | Response / notes |
| --- | --- | --- | --- |
| GET | `/api/reviews/google` | — | `{ places, profile }`: `places` is WP7's Places state; `profile` is `GoogleReviewsDto` with `state` (not_configured / not_connected / checking / not_checked / awaiting_approval / choose_location / needs_reauth / error / connected; `checking` only while a `reviews.gbp.sync` is queued or running, `not_checked` when signed in with no answer from Google recorded and none running — the tab offers Check again), the chosen location, the discovered `locations` (only while choosing), up to 200 reviews of the chosen location, newest first (`limited` is true when more are stored, and the tab says it shows the newest ones) (stars, reviewer, dates, text, owner reply, Google's reply state and policy flag in plain words), Google's own `totalReviewCount` and `averageRating` and `syncedAt` (only when they were read for the chosen location; cleared when another location is chosen and on disconnect), `canRefresh` |
| POST | `/api/reviews/google/refresh` | `{}` | 202 `{ jobIds }` (`reviews.gbp.sync`, `manual`); 429 within 10 minutes of the last read; 422 when not connected |
| PUT | `/api/integrations/google-business-profile/location` | `{ locationName: 'locations/{id}' }` (one of the discovered ones) | `{ state }`; 400 for anything Google did not list. Removes stored reviews of any other location, resets the Performance state, queues `reviews.gbp.sync` (`manual`) and the Performance probe; audit `integration.google_business_profile.location_selected` |
| POST | `/api/integrations/google-business-profile/check` | `{}` | 202 `{ jobs }`: "Check again" — re-reads locations and reviews and, with a location chosen, re-probes Performance (all read-only). 422 when not connected. This is also the Performance re-probe the website design §9.3 called `business-profile-performance/check` (no separate route) |
| DELETE | `/api/integrations/google-business-profile` | `?deleteData=true\|false` | 202; status `disconnected` (under the row lock), Google's review totals cleared, queued or running Business Profile jobs (`reviews.gbp.sync`, `search.sync` source `business_profile`, the Performance probe) cancelled, queues the shared `google.disconnect`; `deleteData=true` also deletes the stored Google reviews and every `search_metrics` row with source `business_profile`. A job still running stores nothing more and never switches the row back (the worker writes only while the row is signed in) |
| GET | `/api/website/business-profile-performance` | `?range=28d\|3m\|12m` (anything else → 28d) | `ProfilePerformanceDto`: `state` (not_configured / not_connected / checking / choose_location / awaiting_approval / not_checked / api_disabled / needs_reauth / error / syncing / no_data / connected; `checking` only while the first reviews check or the Performance probe is queued or running), tile totals (calls, direction requests, website clicks, bookings, message clicks, views on Search and on Maps with their mobile/desktop parts), `dataThrough` (last day with a value), the latest month of search keywords grouped with `classifyQuery` (`threshold` when Google only says "fewer than N"). No numbers unless `connected` |
| POST | `/api/website/business-profile-performance` | `{}` | 202 `{ job }` (`search.sync`, source `business_profile`, `manual`); 422 until Google has approved access; 429 within 15 minutes |

Jobs: `reviews.gbp.sync { reason: 'connect' | 'daily' | 'manual' | 'weekly_full' }`
(`packages/core/src/jobs/business_profile.ts`; daily 5:53 am, full re-read Mondays 6:07 am Melbourne). The same file
extends two website queues backwards-compatibly: `website.connection_check` gains `provider:
'business_profile_performance'` (read-only 7-day probe; re-probed Mondays 8:13 am while not available) and
`search.sync` gains `source: 'business_profile'` (daily 7:47 am; does nothing until Google has approved access).
Payloads hold no tokens or review text.
