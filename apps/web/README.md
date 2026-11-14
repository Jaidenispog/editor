# @studio/web — Studio Assistant web app

Next.js 16 (App Router, React 19, Tailwind CSS v4) application shell, authentication, settings and the JSON
API foundation. It never renders video: long work is queued for `apps/worker` through pg-boss.

## Running it

```bash
# from the repository root (one .env at the root is shared with the worker)
pnpm --filter @studio/web dev          # next dev --webpack on http://localhost:3000
pnpm --filter @studio/web build        # next build --webpack (works without a database or secrets)
pnpm --filter @studio/web start        # serve the production build
pnpm --filter @studio/web typecheck    # next typegen && tsc
pnpm --filter @studio/web test         # vitest (unit); DB-backed tests run when TEST_DATABASE_URL is set
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm --filter @studio/web test
```

First run: open `/setup` (only available while no account exists) or create the owner from the command line:

```bash
pnpm --filter @studio/web create-owner --email you@example.com --password 'at least ten characters' --name 'Sam'
# or OWNER_EMAIL / OWNER_PASSWORD / OWNER_NAME in the environment; add --reset-password to re-key an account
```

Notes

- **Webpack, not Turbopack.** The workspace packages import TypeScript files with `.js` suffixes (TypeScript's
  ESM style). Webpack maps them back via `experimental.extensionAlias`; Turbopack in Next 16.4 cannot, so `dev`
  and `build` pass `--webpack`.
- **Environment is read lazily** through `getEnv()` (`src/lib/env.ts`), never at import time, so `next build`
  succeeds with no `.env`. In development `getEnv()` loads the repository-root `.env` (existing variables win).
- **Relative storage paths** (`STORAGE_LOCAL_ROOT=./data/storage`) are resolved against the repository root,
  not the process working directory, so the web app and the worker see the same files.
- `output: 'standalone'` with `outputFileTracingRoot` at the monorepo root.

## Layout

```
src/
  proxy.ts                    Next 16 request interception (cookie presence only; see "Auth")
  app/
    layout.tsx                Root: accent CSS variables from Settings → Branding, ToastProvider
    globals.css               Tailwind v4 @theme tokens (charcoal scale, accent, radii, fonts)
    (auth)/login, (auth)/setup
    (app)/layout.tsx          Signed-in shell: sidebar (≥ lg), header + user menu, bottom tab bar (< lg)
    (app)/page.tsx            Dashboard
    (app)/studio/…            Video Studio project list and project page
    (app)/library, publishing, appointments, emails, reviews, website, settings
    api/…                     JSON API (below)
  components/ui/              Component kit (see below)
  components/app/             App-level components (navigation, project cards, job list, integration cards)
  lib/                        Server helpers (server-only) + lib/shared (isomorphic) + lib/client (browser)
test/                         Vitest unit tests (+ one DB-backed suite gated on TEST_DATABASE_URL)
scripts/create-owner.ts       CLI owner account creation
```

## Auth

- Argon2id (`@node-rs/argon2`, 19 MiB, t=2, p=1). Passwords ≥ 10 characters.
- Session cookie `sa_session`: 32 random bytes (base64url), `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days,
  `Secure` in production when `APP_URL` is https. The database stores only `sha256(token)` as `sessions.id`.
- Sliding expiry: `validateSession` pushes `expires_at` out to 30 days (at most once an hour); the proxy
  re-sets the cookie's Max-Age on every page navigation.
- Login throttling via `login_attempts`: blocked after 8 failures per email or 30 per IP within 15 minutes.
  Unknown emails still spend a full Argon2 verification (no timing oracle). Generic error message.
- `audit_log` entries: `auth.setup`, `auth.login`, `auth.login_failed`, `auth.login_blocked`, `auth.logout`,
  `auth.password_changed`, `auth.session_revoked`, settings/project/music changes.
- The proxy only checks that the cookie exists. Real validation happens in `(app)/layout.tsx` and every API
  handler. A stale cookie on a page goes to `/api/auth/session-expired`, which clears it and shows sign-in
  (prevents a redirect loop between `/login` and the app).
- CSRF: every non-GET request must carry an `Origin` matching the request origin or `APP_URL`, or
  `Sec-Fetch-Site: same-origin`; requests with neither are refused (403).

## JSON API

All responses are JSON. Errors: `{ "error": { "code", "message", "details?", "requestId" } }` (see `docs/api.md`).
Protected routes return 401 without a valid session; owner-only writes return 403 for staff.

| Method | Route | Notes |
| --- | --- | --- |
| POST | `/api/setup` | `{ email, password, displayName }` while no users exist → owner + signed in |
| POST | `/api/auth/login` | `{ email, password }` → `{ user }`, sets cookie; 429 when throttled |
| POST | `/api/auth/logout` | clears session and cookie (works with an expired session too) |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` → `{ ok, signedOutSessions }` |
| GET | `/api/auth/sessions` | `{ sessions: [{ id, createdAt, lastSeenAt, expiresAt, userAgent, ipAddress, current }] }` |
| DELETE | `/api/auth/sessions/[id]` | sign out another device (not the current one) |
| GET | `/api/auth/session-expired?next=` | clears a stale cookie → 303 to `/login?reason=expired` |
| GET | `/api/health` | `{ ok, db, queue, storage }`; 503 when something is down (public) |
| GET / PUT | `/api/settings` | `{ settings }`; PUT takes `{ brand?, business?, preferences? }` partials (owner) |
| POST / DELETE | `/api/settings/logo` | multipart `file` (PNG/JPEG/WebP ≤ 2 MB, sniffed) → `brand/logo.<ext>` |
| GET | `/api/integrations/status` | `{ integrations: IntegrationStatus[] }` (never secret values) |
| GET | `/api/media/[token]` | local driver only: HMAC token, Range (206/416), `Content-Disposition` for downloads; 404 on s3 |
| GET / POST | `/api/projects` | list (`?search=`) with clip/edit counts + latest generation / create `{ title, clientName?, notes? }` → 201 |
| GET / PATCH / DELETE | `/api/projects/[id]` | DELETE = permanent: cancels jobs, deletes the storage prefix, hard-deletes rows |
| GET | `/api/projects/[id]/jobs` | `{ jobs: JobDto[] }` newest first |
| POST | `/api/jobs/[id]/cancel` | `{ job }`; queued → cancelled at once; running → `cancelRequested` + `boss.cancel` |
| POST | `/api/jobs/[id]/retry` | `{ job }`; failed/cancelled jobs re-queued on the same tracking row |
| GET / POST | `/api/music` | library tracks / register an already-stored file under `music/` + queue `music.analyse` |
| GET / PATCH / DELETE | `/api/music/[id]` | PATCH `{ title?, artist?, moods?, licence?, confirmLicence? }`; DELETE removes the audio file |
| GET / POST / PUT / DELETE | `/api/trends` | list / create (curated) / update `{ id, …, enabled?, markVerified? }` / delete `?id=` |

## lib modules

Server-only modules start with `import 'server-only'`. Use them from server components and route handlers.

| Module | Exports |
| --- | --- |
| `env.ts` | `getEnv()`, `findRepoRoot()`, `resolveConfiguredPath()` |
| `logger.ts` | `getLogger()` (pino, secrets redacted) |
| `db.ts` | `getDb()`, `getDbHandle()` (one pool per process, cached on `globalThis`) |
| `storage.ts` | `getBlobStore()`, `getLocalDiskStore()` |
| `queue.ts` | `getQueue()` (producer `JobQueue`, started lazily, cached; retried after a failed start) |
| `auth-core.ts` | `hashPassword`, `verifyPassword`, `generateSessionToken`, `hashSessionToken`, `passwordProblem`, `LOGIN_LIMITS` |
| `auth.ts` | `createSession`, `validateSession`, `destroySession`, `destroySessionById`, `destroyOtherSessions`, `listUserSessions`, `authenticate`, `createOwnerAccount`, `changePassword`, `countUsers`, `requestMetaFromHeaders` |
| `session.ts` | `getCurrentUser()`, `getCurrentSession()` (React `cache`), `getSessionToken`, `setSessionCookie`, `clearSessionCookie` |
| `api.ts` | `handleApi(handler)`, `handlePublicApi(handler, { csrf })`, `parseJson(req, schema)`, `requireUser()`, `requireSession()`, `requireOwner(user)`, `assertSameOrigin(req)` |
| `api-errors.ts` | `mapErrorToResponse(err, requestId)`, `zodIssuesToDetails` |
| `csrf.ts` | `isSameOriginRequest(input)` |
| `settings.ts` / `settings-merge.ts` | `getSettings()`, `updateSettings(patch, userId)`, `saveSettings`, `getSettingsOrDefaults()`, `SettingsPatchSchema`, `mergeSettings` |
| `seed-trends.ts` | `ensureCuratedTrends()`, `CURATED_TRENDS` (8 format descriptions, once ever) |
| `jobs.ts` | `createTrackedJob({ type, payload, projectId?, refId?, singletonKey?, priority? })`, `cancelJob`, `retryJob`, `getJob`, `listProjectJobs`, `listActiveJobs`, `cancelProjectJobs`, `toJobDto`, `defaultRefId` |
| `media-links.ts` | `signedUrlFor(key, { downloadName?, contentType? })`, `maybeSignedUrl`, `downloadNameFor(parts, ext)` |
| `http-range.ts` | `parseRangeHeader(header, size)`, `contentDispositionAttachment(name)` |
| `crypto.ts` | `encryptToken`, `decryptToken`, `getEncryptionKey` (AES-256-GCM via `@studio/db`) |
| `projects.ts` | `listProjects`, `getProjectOrThrow`, `createProject`, `updateProject`, `deleteProjectPermanently`, schemas |
| `music.ts` | `listLibraryTracks`, `getTrackOrThrow`, `createLibraryTrack`, `updateTrack`, `deleteTrack`, `toMusicSummary`, schemas |
| `trends.ts` | `listTrends`, `createTrend`, `updateTrend`, `deleteTrend`, schemas |
| `integrations.ts` | `getIntegrationStatuses()`, `buildIntegrationStatuses(env, facts)` (pure) |
| `storage-usage.ts` | `getStorageUsage()` |
| `audit.ts` | `writeAudit(entry)` (never throws) |
| `format.ts` | `formatDateTime`, `formatDate` (Australia/Melbourne), `formatRelative`, `formatBytes`, `formatSeconds`, `formatProgress` |
| `shared/*` | `cn`, `accentCssVariables`, session-cookie constants + `safeNextPath`, `IntegrationStatus` type, DTOs (`ProjectSummaryDto`, `JobDto`, `JOB_TYPE_LABELS`) |
| `client/api-client.ts` | `apiRequest(path, { method, body, signal })`, `ApiClientError`, `fieldErrors(err)` (browser) |

## Component kit (`src/components/ui`)

`Button` (primary/secondary/ghost/danger, sm/md/lg/icon, `loading`) and `buttonClasses()` for links · `Card`,
`CardHeader`, `CardBody`, `CardFooter` · `Input`, `Textarea`, `Select`, `Field` (labels, hints, errors and aria
wired up) · `Switch` (role=switch) · `Badge` · `StatusPill` (+ `toneForStatus`, `statusLabel` for every status word
used by jobs, assets, versions and generations) · `Tabs` (WAI-ARIA, controlled or not) · `Dialog` (native
`<dialog>`, focus trap, Esc/backdrop close) · `ToastProvider` + `useToast()` · `EmptyState` · `Spinner` ·
`Skeleton` · `PageHeader` · `Alert`. Barrel: `@/components/ui`.

App components (`src/components/app`): `SidebarNav`, `MobileNav`, `NAV_ITEMS`, `UserMenu`, `BrandMark`,
`NewProjectButton`, `ProjectList`, `ProjectCard`, `JobList` (progress bars + cancel/retry), `IntegrationStatusList`,
`SectionOverview` (used by the Stage B/C section pages).

Design: charcoal and white, one accent (`--accent`, `--accent-foreground`, `--accent-soft`; Tailwind classes
`bg-accent`, `text-accent-foreground`, `bg-accent-soft`). Fonts: system stack with Inter first (no network fetch).

## Video Studio (project page)

`src/app/(app)/studio/[projectId]/page.tsx` renders the first status payload on the server and hands it to
`StudioWorkspace` (`src/components/studio/`), which keeps it fresh by polling
`GET /api/projects/[id]/status` every 3 s while anything is queued or working, every 20 s otherwise, and not at
all while the tab is hidden (it refreshes as soon as the tab is visible again).

Layout, top to bottom: project header (edit details, permanent delete with a typed confirmation) → drop zone
(several files, per-file progress, pause/resume, cancel, retry) → clip cards (thumbnail, duration, HDR/rotation/
speech/no-sound badges, analysis status, retry/remove, "What's in this clip?" tag) → style controls (five style
toggles with plain reasons when unsupported, 8–90 s length slider, music from the library with BPM and licence
status, "Upload licensed track" licence form, original sound, captions, instructions, "Generate N edits") →
background jobs with progress and cancel → preview grid (9:16 players on signed links, favourite, warnings,
built-in-editor note, Revise dialog with suggestion chips and Regenerate, version switcher, Export full quality →
Download) → earlier generations.

| Piece | Where |
| --- | --- |
| Status payload (shape + loader) | `lib/studio-status-shape.ts` (pure, tested), `lib/studio-status.ts` |
| Access checks | `lib/studio-access.ts`: owner sees every project, staff only their own; deleted projects are 404 |
| Uploads | `lib/uploads.ts`; maths and type rules shared with the browser in `lib/shared/upload-math.ts` |
| Clips | `lib/assets.ts` (tags → `styleSupportWithManualLabels`, retry, delete with storage prefix) |
| Generate / edits / export | `lib/studio-edits.ts` |
| Request schemas | `lib/shared/studio-schemas.ts` (+ `GenerateRequestSchema` in `lib/studio-edits.ts`) |
| Browser uploader | `lib/client/uploader.ts` (`ChunkedUploader`) |
| DTOs | `lib/shared/studio-dto.ts` |

Uploads: 8 MiB parts (the proxy buffers request bodies up to 10 MB), two files at a time, each part retried up
to 3 times with 1 s / 2 s / 4 s back-off. The upload id is remembered in `localStorage` under
`studio-upload:<project>:<name>:<size>:<lastModified>`; dropping the same file after a reload asks the server for
`receivedParts` and sends only the rest. Part records are merged into `driverState.parts` and `receivedParts` in
one atomic SQL update, so parallel or repeated parts are safe. Completion is claimed atomically
(`driverState.completingSince`), so a double click cannot create two clips; a completed session returns the same
id. Videos become `media_assets` (`sortOrder` = next) + `ingest.asset`; audio becomes a library `music_tracks` row
(via `createLibraryTrack`) + `music.analyse`, and only with `licence` and `confirmLicence: true` in the body.

Signed links change on every poll, so cards keep the first link for a clip/version until half of
`MEDIA_LINK_TTL_SECONDS` has passed (or the player reports an error) to avoid reloading a playing video.

### Video Studio API (in addition to the table above)

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/projects/[id]/status` | `StudioStatusDto`: project, five styles with support, clips, library music, generations (newest first, 20) with edits and every version, active jobs, defaults, limits, `busy` |
| POST | `/api/projects/[id]/uploads` | `{ filename, size, mimeType, kind }` → 201 `{ uploadId, partSize, partCount, receivedParts, status }` |
| PUT | `/api/uploads/[id]/parts/[n]` | raw bytes; size must match the part → `{ partNumber, receivedParts }` |
| GET / DELETE | `/api/uploads/[id]` | resume info / abort (204) |
| POST | `/api/uploads/[id]/complete` | `{}` for video; `{ title?, artist?, licence, confirmLicence: true }` for music → `{ assetId, kind }` |
| PATCH / DELETE | `/api/assets/[id]` | `{ clipLabel?, manualLabels?, sortOrder? }` → `{ asset, styles? }` / removes rows and files |
| POST | `/api/assets/[id]/retry` | 202 `{ jobId }` |
| POST | `/api/projects/[id]/generate` | `GenerationSettings` (unique, supported styles; no clips still processing; music ready with a confirmed licence) → 201 `{ generationId, jobId, edits }`; 409 while a generation is still being planned |
| POST | `/api/edits/[id]/favourite` | `{ value }` → `{ isFavourite }` (+ feedback event, style affinity ±1, floor 0) |
| POST | `/api/edits/[id]/revise` · `/regenerate` | `{ instruction }` / `{ instruction? }` → 201 `{ versionId, versionNo, jobId }`; 409 while the current version is still being made |
| POST | `/api/edits/[id]/current-version` | `{ versionId }` (must belong to the edit) |
| POST | `/api/edit-versions/[id]/export` | 202 `{ versionId, exportStatus, exportMessage, jobId }`; idempotent while queued/rendering/ready (`singletonKey export:<id>`) |
| GET | `/api/edit-versions/[id]/download` | `{ url, filename }` ("<project>-<style>-v<n>.mp4"); `?kind=preview` for the preview |

### Tests

`test/upload-math.test.ts`, `test/studio-schemas.test.ts`, `test/studio-status-shape.test.ts` (unit) and
`test/studio-routes.integration.test.ts`, which calls the real route handlers against a throwaway database
(session lookup stubbed; CSRF guard, storage and pg-boss real): multipart upload with out-of-order and duplicate
parts → asset + `ingest.asset` job; music upload requires confirmation; tagging recomputes style support;
generate → generation, five edits in slot order, v1 rows, `edits.generate` job; revise keeps v1 and makes v2;
version switching; favourite; export idempotency; download names; cross-site requests refused; clip removal
deletes its files.

## Known limitations

- Next 16 removes `Content-Length` from route-handler responses, so local-driver media is sent with chunked
  transfer encoding (206 responses still carry `Content-Range`). Production on S3 storage serves presigned URLs
  directly from the bucket with full headers.
- `notFound()` inside `(app)` pages renders the not-found screen with status 200 because `loading.tsx` starts
  streaming first.
- Connecting Square, Instagram, TikTok and Google accounts (OAuth flows) is not built yet; their cards show the
  setup steps and missing server settings only.
