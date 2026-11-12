# JSON API (apps/web)

All routes live under `/api`, require a signed-in session cookie (except `auth`, `setup`, `health`, `media`), and
return JSON. Errors are `{ "error": { "code", "message", "details?" } }` with an HTTP status from the code
(`VALIDATION` 400, `UNAUTHORISED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `UNSUPPORTED` 422,
`RATE_LIMITED` 429, `INTERNAL` 500). State-changing requests must come from the app's own origin (CSRF guard).

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
| GET / POST | `/api/projects` | list (with counts, latest generation) / create `{ title, clientName?, notes? }` |
| GET / PATCH / DELETE | `/api/projects/[id]` | DELETE removes rows **and** stored media (permanent) |
| GET | `/api/projects/[id]/status` | polling payload: project, assets, generations, edits with versions, active jobs |
| POST | `/api/projects/[id]/uploads` | `{ filename, size, mimeType, kind }` → `{ uploadId, partSize, partCount, receivedParts }` |
| PUT | `/api/uploads/[id]/parts/[n]` | raw bytes of part `n` (1-based); idempotent |
| GET | `/api/uploads/[id]` | `{ receivedParts }` for resuming after a page reload |
| POST | `/api/uploads/[id]/complete` | assembles the file → `{ assetId }` (video → `ingest.asset` job; audio → music track + `music.analyse`) |
| DELETE | `/api/uploads/[id]` | aborts and deletes staged parts |
| PATCH | `/api/assets/[id]` | `{ clipLabel?, manualLabels?, sortOrder? }` — manual tags recompute style support |
| POST | `/api/assets/[id]/retry` | re-queues ingest for a failed clip |
| DELETE | `/api/assets/[id]` | removes the clip and its derived files |
| POST | `/api/projects/[id]/generate` | `GenerationSettings` → creates generation + one edit per style (v1 "planning") → `edits.generate` job |

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
| PATCH / DELETE | `/api/music/[id]` | licence confirmation, moods, title |

## Media
`GET /api/media/[token]` streams a file for the local storage driver after verifying the HMAC token (supports HTTP
Range for video seeking). With the S3 driver, links are presigned by the bucket instead.
