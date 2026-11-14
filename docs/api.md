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
| GET / PUT | `/api/settings` | `AppSettings` (brand, business, preferences); PUT accepts a partial object |
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
