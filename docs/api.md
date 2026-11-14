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
| GET | `/api/health` | `{ ok, db, queue, storage }` |

## Settings and integrations
| Method | Route | Notes |
| --- | --- | --- |
| GET / PUT | `/api/settings` | `AppSettings` (brand, business, preferences, legal and module sections); PUT accepts a partial object and keeps sections it does not mention |
| POST | `/api/settings/logo` | multipart logo upload → stored at `brand/logo.<ext>` |
| GET | `/api/integrations/status` | per integration: `{ configured, connected, message }` |
| GET / POST / PUT / DELETE | `/api/trends` | curated or live trend references |

## Projects and clips (Video Studio)
| Method | Route | Notes |
| --- | --- | --- |
| GET / POST | `/api/projects` | list the projects the user may open (with counts, latest generation; `?search=`) / create `{ title, clientName?, notes? }` (owned by the signed-in user) |
| GET / PATCH / DELETE | `/api/projects/[id]` | DELETE removes rows **and** stored media (permanent); 404 for staff on someone else's project |
| GET | `/api/projects/[id]/jobs` | recent background jobs of the project, newest first |
| POST | `/api/projects/[id]/assets/order` | `{ assetIds: string[] }` (each id once, all clips of this project) → `{ assets: [{ id, sortOrder }] }`; renumbers every clip in one transaction (listed clips first, unlisted clips keep their relative order after them); 400 for ids from another project or duplicates |
| GET | `/api/projects/[id]/status` | polling payload: project, assets, generations, edits with versions, active jobs |
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

## Preferences (Stage B, WP2)

## Trends (Stage B, WP3 and WP5)

Settings → Trends shows three groups that are never mixed: **live signals** (official APIs only; each item has its
source and fetch time in Melbourne time and goes "Out of date" after 48 h), **noted by staff** and **curated
references** (sourced, dated barber formats). Every item's `label` comes from `trendLabel` (`packages/core/src/
trend-label.ts`) and never says "trending" or "viral". No trend data is ever passed to an edit planner.

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/trends` | Signed in. `{ live: [{ watch, items }], noted: TrendItemDto[], curated: TrendItemDto[], sources: [{ provider, status, watch }], viewer: { id, isOwner } }`. `TrendItemDto` has `kind` (`curated`, `noted`, `live`), `label`, `dueForReview` (curated, 180 days), `editorSuggestion` (no source link), `sources`, `stale` and the YouTube row fields (`channelTitle`, `categoryName`, `position`) |
| POST / PUT / DELETE | `/api/trends` | Owner. Curated references only (`sourceKind` cannot be set by clients; noted and live rows give 404). PUT `markVerified: true` = "Mark reviewed" |
| POST | `/api/trends/notes` | Signed in. `{ title, summary?, platform: tiktok\|instagram\|youtube\|in_person\|other, sourceUrl? (http/https), seenOn: YYYY-MM-DD (not in the future), category? }` → 201 `{ trend }` labelled "Noted by <name> on <date> · seen on <platform>"; audit `trends.noted` |
| DELETE | `/api/trends/notes/[id]` | The owner, or the person who noted it (otherwise 403); audit `trends.note_deleted` |
| POST | `/api/trends/watches` | Owner. `{ provider: 'youtube_chart' }` → `{ watch, jobId }` and queues `trends.refresh` (the first read is the capability check); already on → `jobId: null`. 422 `INTEGRATION_NOT_CONFIGURED` without `YOUTUBE_API_KEY`; `{ provider: 'instagram_hashtag' }` → 422 `UNSUPPORTED` until WP5. Audit `trends.watch_added` |
| DELETE | `/api/trends/watches/[id]` | Owner. Turns the source off and deletes its items; the row stays 7 days (hashtag budget). Audit `trends.watch_removed` |
| POST | `/api/trends/watches/[id]/refresh` | Owner. `{ jobId }`; reuses a queued or running read. 429 `RATE_LIMITED` (with `details.nextRefreshAt`) within 6 h of the last query, or 5 min after a failed one |

`GET /api/integrations/status` has a `youtube_chart` entry: `not_configured` without the key (names
`YOUTUBE_API_KEY` only), otherwise `not_connected` with `liveMode: 'read_only'`; the list there does not read the
watch, so the chart's own state (`connected`, `error` for quota or a bad key) is in the `sources` of `GET /api/trends`.

Job `trends.refresh` `{ watchId: string | null }`: null (the daily 5:41 am Melbourne schedule, key `daily`) queues one
read per enabled watch. One read: `GET https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&
regionCode=AU&maxResults=20` (1 quota unit, 15 s limit). 200 → items upserted on `(watch_id, external_id)`, items
missing from the result deleted, watch `ok`. `quotaExceeded`/`dailyLimitExceeded` → `quota`; 400 (`keyInvalid`,
`badRequest`) → "The YouTube API key isn't valid."; `accessNotConfigured` → "Turn on YouTube Data API v3 in your Google
Cloud project."; 5xx/429/network → one retry after 5 minutes, then `error`. `maintenance.cleanup` deletes live items
fetched over 7 days ago and turned-off watches last queried over 7 days ago.

## Publishing (Stage B, WP4 and WP10)

## Square appointments (Stage C, WP6 and WP6b)

## Email and reviews (Stage C, WP7)

## Website and local search (Stage C, WP8)

## Google Business Profile (Stage C, WP9)
