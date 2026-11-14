# Stage B/C implementation plan

Status: plan only, written 2026-11-14 by the lead architect. Nothing here is built yet. It turns the five module
designs into ordered work packages that can be built in parallel without two packages editing the same file at the
same time.

Inputs (read all of them before starting a package):

- `docs/spec.md` (the owner's brief, source of truth for scope)
- `docs/research/platform-constraints.md` ("the memo"; supersedes `decisions-summary.md`)
- `docs/HANDOVER.md` (Stage A state; Stage A passes on synthetic footage only)
- Module designs, all under `docs/design/`:
  - `publishing.md`
  - `preferences-music-trends.md`
  - `square-appointments.md`
  - `email-and-reviews.md`
  - `website-local-search.md`

Each design now starts with a "Lead-architect reconciliation" box listing what this plan changed in it. Section 9
lists every edit.

**Owner availability.** On 2026-11-14 the owner said account setup will be done later. Every package below is built
and tested with fakes, sandbox modes and labelled local data, and ends in an honest "needs setup" state. The owner
checklist (section 7) collects every account step in one place for when they are ready. No package needs an owner
credential to merge.

---

## 1. Cross-check results

### 1.1 Conflicts found and how they are resolved

| # | Conflict | Designs | Resolution |
| --- | --- | --- | --- |
| C1 | Two different `isGenuinelyCompleted` functions: Square's derives completion from attendance and payments; email's checks the stored `completion_source`/`completed_at` | Square §4.7, email §3.6 | The Square function becomes `deriveCompletion` and writes the columns. `isGenuinelyCompleted` (stored-column check) is defined once in `packages/core/src/completion.ts` (WP0). Email re-checks it at send time. |
| C2 | Square "clears" `completion_source` to null, but the column is `NOT NULL DEFAULT 'none'` | Square §4.7, schema | Reset to `'none'`. |
| C3 | Who records Square's email opt-out: email says the Square sync writes a `withdrawn` consent event; Square says it only fills a column | email §3.6, Square §5.3 | Square fills `customers.square_email_unsubscribed`. Email treats `true` as a marketing block and records the ledger event itself. The column is created by the WP0 migration so WP6 and WP7 can be built in parallel. |
| C4 | Three different `IntegrationStatus` field sets: publishing `state`+`liveMode: live/development_live`; preferences `state` incl. `configured` + `mode`; Square/email `liveMode: sandbox/live`; website reuses `sandbox` for "staging" and adds `awaiting_approval` | all five | One contract (section 2.1), built by WP0. |
| C5 | "Make a music-free version": publishing renders a `no_music` export **variant of the same version**; preferences makes a **new version** with an audio patch | publishing §3.4, preferences §4.9–4.10 | Export dialog and card menu use the `no_music` variant (no new version). "No music" in the Sound panel stays a revision. WP1 builds the variant; publishing only consumes it. |
| C6 | Both designs change `edit_versions` (`variant_exports`, `render_brand`) and `render.ts` | publishing, preferences | Variant → WP1; brand snapshot → WP2; WP4 hooks into exports through WP0's export-ready hook instead of editing `render.ts`. |
| C7 | `publish` feedback event at approval (publishing) vs when published (preferences) | publishing §5.1, preferences §12 | When a target becomes `published` (platform read-back or owner confirmation). |
| C8 | `music_usage` ledger row at approval (publishing) vs when published (preferences) | publishing §3.3, preferences §12 | When published. Approval records only `publish_posts.music_check`. |
| C9 | Hashtag watch reads the Instagram token from `social_accounts`, but publishing moves the credential to `integration_connections` and makes the `social_accounts` token nullable | preferences §8.1/§11, publishing §5.2 | Hashtag watch uses the `meta` connection's credential and publishing's Graph client and `mapGraphError`. |
| C10 | Hashtag permission "reconnect with the extended configuration": the login dialog sends no `scope` and there is one `META_LOGIN_CONFIG_ID` | preferences §8.1, publishing §7.1.1 | The owner adds the permission to the same configuration and reconnects. |
| C11 | Two music checks: `checkPublishEligibility` wraps `checkMusicForPlatforms`; preferences defines `musicClearanceFor` | publishing §3.2, preferences §5.3 | `checkPublishEligibility` is built on `musicClearanceFor` (WP1). |
| C12 | Unverified Zernio webhooks stored under the payload's event id would let a forged event block the real one through the unique index (Square's design explicitly avoids this) | publishing §7.2.5, Square §7.3 | Unverified Zernio rows use the key `unverified:<sha256(body)>`. |
| C13 | Google OAuth: email hardcodes `business.manage` into one row; website expects a `product=search_console` switch on the same routes | email §8.4, website §4.7/§7.2 | WP0 builds the routes with a product table and two separate rows. |
| C14 | Duplicate Melbourne time helpers: `melbourneLocalToUtc` (publishing), `melbourneDayRange` (Square), `nextSendSlot` in a new `zoned-time.ts` (email) | three designs | All in `packages/core/src/time.ts` (WP0). Square-specific `availabilityRange` stays in WP6. |
| C15 | Duplicate worker helpers: `lib/http.ts`, `lib/audit.ts`, `lib/credentials.ts`, `lib/google/oauth.ts`, `webhook.process`, `google.disconnect`, a second Graph client — each design says "create if the other has not" | all | Built once (WP0, or WP4 for the Graph client). |
| C16 | `/privacy` (Meta), `/data-deletion` (Meta) and terms/privacy URLs (Spotify embed) planned separately; preferences leaves "who writes them" open | publishing §10, preferences §4.8/Q7 | WP0 builds owner-edited public legal pages; the URLs default to them. |
| C17 | `purgeSquareData` deletes customers unless "another module references them", which ties it to tables other packages create | Square §5.3 | Always scrub (soft delete). |
| C18 | Hot files edited by several designs: `packages/core/src/jobs.ts`, `packages/queue/src/index.ts`, `apps/worker/src/main.ts`, `handlers/cleanup.ts`, both `lib/jobs.ts`, `apps/web/src/lib/integrations.ts`, `integrations-tab.tsx`, `edit-grid.tsx`, `status-pill.tsx`, `packages/config`, `.env.example`, `proxy.ts`, `settings.ts`, `business-tab.tsx` | all | WP0 turns each into a registry with one file per module (section 2.2). Remaining shared files follow the append-only rules in section 4. |
| C19 | Several crons on one queue (`square.sync` ×2, `search.sync` ×2, `reviews.gbp.sync` ×2), but the queue wrapper's `schedule()` passes no key | Square, website, email | pg-boss 12.38.1 `schedule()` accepts `options.key` (checked in `node_modules/pg-boss/dist/types.d.ts`). WP0 adds `key` to the wrapper. |
| C20 | Publishing needs per-queue `policy: 'stately'` and `startAfter: Date`; the wrapper hard-codes `policy: 'standard'` and only takes `startAfterSeconds` | publishing §6, Square §6 | WP0 adds both. It also tests `singletonKey` behaviour per policy on 12.38.1. Every design's authoritative guard is a conditional database update, so the queue key is only a second guard. |
| C21 | Zernio placed in the Stage B design, but the memo says "Optional Stage C auto-publishing" | publishing §7.2, memo §3 | Built as WP10 in Stage C. |
| C22 | `checkMediaForPlatform` omitted the memo's Reels bitrate limits (≤ 25 Mbps video, AAC ≤ 128 kbps) | publishing §6.2, memo §4 | Added. |
| C23 | The caption-ending field, the legal URLs, the opening hours and the review-link hint all edit `business-tab.tsx` | publishing, preferences, website, email | Caption ending moves to the Publishing page; legal fields and the review-link hint copy go to WP0; opening hours stay in WP8. |

### 1.2 Contradictions with the memo or the brief

Checked every "What the research allows" table against the memo. Besides C21 and C22 above, none was found. Points
confirmed:

- TikTok: no direct API; manual default; Zernio only behind a flag.
- Instagram: Unified Login system-user token, Development mode, resumable upload, switched on only after a recorded
  verification post. No old Instagram Login fallback and no library music.
- Spotify: link-only by default; never audio, never AI, never public surfaces.
- Music: licence passport; `meta_only` lock; CC BY-NC refused; usage ledger; music-free export.
- Square: Tier 0 reads on any plan; Tier 1 gated at runtime on `support_seller_level_writes`, fee-free services and a
  self-test; no-show marking, deposits and confirmations are never app actions; no prices shown as fact.
- Email: Postmark Transactional vs Broadcast streams; consent ledger; review requests treated as commercial;
  inferred consent off by default; no pre-appointment messages (Square sends reminders).
- Reviews: uniform requests with no gating and no incentives; never builds `g.page` or `writereview?placeid=` links;
  requests tracked separately from reviews.
- Website: no ranking promises; read-only Search Console; Business Profile metrics only after Google's approval;
  changes applied only through an authorised connection after an explicit owner action.
- Trends: live signals and curated references never mixed; TikTok contributes no live data; nothing is called
  "trending".

The memo's open questions stay open. Each package lists those it depends on as "verify with the owner's real
accounts".

### 1.3 Naming rules (for the remaining inconsistencies)

- Job types: `<module>.<action>` in lower case with dots, plus snake_case inside a part. Existing names stay
  (`social.check`, `email.provider.check`, `website.connection_check`). New ones follow the rule.
- Status words are reused where they mean the same thing: `queued`, `processing`, `published`, `failed`,
  `cancelled`, `needs_reauth`, `manual_step_required`, `awaiting_approval`. The connection status `disconnected` is
  shared. Labels and tones for all of them live in one place: `status-pill.tsx` (WP0).
- The "non-repeatable external call" marker is always a `submitted_at` column set by a conditional update just
  before the call. This applies to `publish_targets`, `email_messages` and `square_booking_changes`. After a crash
  with `submitted_at` set and no provider id, the item goes to an owner "check before retry" state. It is never sent
  again blindly.

---

## 2. Shared foundations (WP0)

### 2.1 Integrations framework

**Connection record.** `integration_connections` is one row per provider, as today (unique `provider` index).
TypeScript-only changes (no SQL, because enums have no CHECK constraints):

- `provider` adds `meta`, `zernio`, `postmark` and `google_places`.
- `status` adds `disconnected`.
- `capabilities` widens to `Record<string, boolean | string | number | null>`.

Credentials are always AES-256-GCM via `packages/db/src/crypto.ts`, decrypted only in the worker, plus in the web
OAuth callback for the single code exchange. They never appear in job payloads, `audit_log`, logs or DTOs.

**Display contract** (`apps/web/src/lib/shared/integration-types.ts`, optional fields added to `IntegrationStatus`;
the `configured`/`connected` booleans stay):

```ts
state: 'not_configured'    // server env missing (names only shown)
     | 'not_connected'     // env present, no connection / disconnected / source not enabled yet
     | 'connected'
     | 'awaiting_approval' // provider approval pending (Google Business Profile quota 0)
     | 'unavailable'       // capability check says the account/app cannot do this (e.g. hashtag search)
     | 'needs_reauth'
     | 'error';
liveMode: 'live' | 'development_live' | 'sandbox' | 'staging' | 'read_only' | null;
verified: boolean;          // a recorded live verification exists (Instagram/Zernio first post, Square self-test)
```

`buildIntegrationStatuses` is a pure function, as today, with one builder per module (section 2.2). Manual paths
(TikTok and Instagram "post it yourself", the review link) are always shown as available.

**OAuth helper** (`apps/web/src/lib/oauth-state.ts`):

- `createOAuthState({ provider, sessionId, cookiePath, pkce?, extra? })` sets an HttpOnly, SameSite=Lax, 10-minute
  cookie holding `sha256(state)`, the session id, an optional PKCE verifier and `extra` (for example the Google
  product or the Square access level).
- `consumeOAuthState(req, provider)` does a timing-safe check and clears the cookie.
- Callbacks need the owner session. Each one does the single code exchange inline (10 s timeout, no retry), encrypts
  the tokens, upserts the connection, writes an audit entry and enqueues the provider's first read-only check.
  Meta, Square and Google all use it.

**Google OAuth** (built in WP0 so WP7, WP8 and WP9 do not depend on each other):

- Routes: `GET /api/integrations/google/connect?product=` and `/callback`.
- Product table:
  - `business_profile` → `business.manage`, row `google_business_profile`, follow-up job `reviews.gbp.sync`
  - `search_console` → `webmasters.readonly`, row `google_search_console`, follow-up job `website.connection_check`
- If a follow-up job type is not registered yet, nothing is enqueued.
- Worker side, `apps/worker/src/lib/google/oauth.ts`: `getGoogleAccessToken(conn)` refreshes and stores the access
  token; `invalid_grant` makes the connection `needs_reauth`. The `google.disconnect` job revokes and wipes.

**Token refresh** (`apps/worker/src/lib/connections.ts`):

- `loadConnection(provider)` reads the row.
- `withConnectionLock(provider, fn)` runs `SELECT … FOR UPDATE` in a transaction, so two jobs never refresh at the
  same time or overwrite each other.
- `refreshIfExpiring(conn, skewSeconds, refresher)`.
- Provider rules stay in the modules: Square has a daily refresh job plus a refresh within 3 days in its client
  factory; Google refreshes on demand; Meta has no refresh (a daily `debug_token` expiry check); Zernio and
  WordPress use static keys.

**Webhook intake.**

- Web side, `apps/web/src/lib/webhooks.ts`: `readRawBody(req, maxBytes = 256 KiB)`, then
  `storeWebhookEvent({ provider, externalEventId, eventType, payload, signatureValid })` with
  `ON CONFLICT DO NOTHING`, then enqueue `webhook.process` only when a row was inserted.
- Verification is per provider and lives in each module: Square HMAC (refuse and do not store when invalid);
  Postmark Basic credentials (refuse and do not store); Zernio (store under an `unverified:` key unless the signature
  was verified).
- Worker side, `webhook.process` is a dispatcher that calls the handler a module registers for `provider`. Payloads
  are only hints: handlers re-fetch from the provider or apply only restrictive effects (Postmark suppressions).

**Capability checks.** Every provider has a read-only check job that never writes to the external system:

- `social.check`
- `email.provider.check`
- the token-status and snapshot steps of `square.sync`
- `reviews.places.sync`
- `website.connection_check`
- the first `trends.refresh` of a watch

They record their outcome through `recordConnectionCheck(provider, { status, capabilities, lastError })`. Live
"verification" actions (the first Instagram or Zernio post, the Square self-test, the first real email) are always
explicit owner actions recorded in `capabilities` and `audit_log`. They are never run to test a connection.

**Audit helper.** The worker gets `apps/worker/src/lib/audit.ts`, a twin of `apps/web/src/lib/audit.ts`. Its data
holds ids, codes and trimmed text (at most 200 characters), never secrets or message bodies.

**HTTP helper** (`apps/worker/src/lib/http.ts`):

- `fetch` tied to the run's `AbortSignal`, with a per-call timeout (default 30 s; uploads longer).
- A redacting logger that strips `Authorization`, `X-Postmark-Server-Token`, `X-Goog-Api-Key`, `access_token`,
  `appsecret_proof`, `input_token`, `client_secret` and `code`, and hashes email addresses.
- Test-only base-URL overrides are honoured only when `NODE_ENV=test`.
- `ctx.fetch` is injectable in `apps/worker/src/context.ts`.

**Provider-interface pattern** (all modules follow it):

- An interface in core or the worker.
- `createXProvider(env, deps)` returns `null` when the provider is not configured, and the UI shows "needs setup".
- A fake implementation and a local fake HTTP server exist only in tests.
- No simulated mode exists at runtime.

Existing and planned examples: `EmailProvider`, `MusicCatalogueProvider` (interface only), `WebsiteEditAdapter`, the
publishing adapters (Instagram, Zernio), `SquareApi`, `WebsiteCopywriter`.

### 2.2 Scheduler and registries

**Queue wrapper** (`packages/queue`):

- Per-type `policy` (`standard` by default, `stately` where a design asks).
- `EnqueueOptions.startAfter?: Date` alongside `startAfterSeconds`.
- `schedule(type, cron, payload, { key })`. pg-boss allows several schedules per queue by key; all schedules run in
  `Australia/Melbourne`.
- An integration test pins the `singletonKey` behaviour of `standard` and `stately` on 12.38.1.

**Due-time dispatch.** Items due at a time (scheduled posts, scheduled emails) carry a UTC timestamp and are picked up
by per-minute dispatcher crons (`publish.dispatch`, `email.dispatch`). One-off delays use `startAfter`. There are no
in-process timers.

**Time helpers** (`packages/core/src/time.ts`):

- `melbourneLocalToUtc(date, time)`: nonexistent and ambiguous DST times handled as in the publishing design §4.3.
- `melbourneZoneLabel(date)`
- `melbourneDayRange(date)`
- `melbourneDateOf(instant)`
- `nextSendSlot(earliest, window)`

**Module registries** (so parallel packages edit only their own files). WP0 creates every file below, with empty
stubs for each module: `music`, `preferences`, `trends`, `publishing`, `square`, `email`, `website`,
`business_profile`. The aggregators import every module file, so later packages never touch them.

| Registry | Aggregator (WP0 owns) | Per-module file (the module's package owns) |
| --- | --- | --- |
| Job types and payload schemas | `packages/core/src/jobs.ts` (re-exports `JOB_TYPES`, `ALL_JOB_TYPES`, `JOB_PAYLOAD_SCHEMAS`) | `packages/core/src/jobs/<module>.ts` |
| Queue settings | `packages/queue/src/index.ts` | `packages/queue/src/settings/<module>.ts` |
| Worker handlers, crons, webhook handlers, cleanup tasks, export-ready hooks | `apps/worker/src/modules/index.ts`, used by `main.ts`, `handlers/cleanup.ts`, `handlers/render.ts`, `handlers/webhook-process.ts` | `apps/worker/src/modules/<module>/index.ts` |
| `refIdFor` (worker) / `defaultRefId` (web) | `apps/worker/src/lib/jobs.ts`, `apps/web/src/lib/jobs.ts` | inside the module's worker index / `apps/web/src/lib/jobs/<module>.ts` |
| Integration status builders | `apps/web/src/lib/integrations.ts` (`buildIntegrationStatuses`) | `apps/web/src/lib/integrations/<module>.ts` |
| Integration cards | `apps/web/src/app/(app)/settings/_components/integrations-tab.tsx` | `…/settings/_components/integrations/<module>.tsx` |
| App settings sections | `packages/core/src/settings.ts` (`AppSettingsSchema`) | `packages/core/src/settings/<module>.ts` (new top-level sections only) |
| New database tables | `packages/db/src/schema.ts` re-exports; `drizzle.config.ts` schema glob | `packages/db/src/schema/<module>.ts` |
| Edit-card extras in the Studio | `apps/web/src/components/studio/edit-grid.tsx` (menu-item, badge and banner slots) | `apps/web/src/components/studio/extensions/<module>.tsx` |
| Public (no-session) routes | `apps/web/src/lib/public-routes.ts`, read by `proxy.ts` | — (WP0 pre-lists every public path in the designs) |

### 2.3 Other shared pieces in WP0

- **`packages/core/src/completion.ts`**: `isGenuinelyCompleted` (stored-column check, C1).
- **`packages/core/src/plan-facts.ts`**: `computePlanFacts(plan)` (preferences §5.3).
- **`recordFeedback(tx, event)`**: in `apps/web/src/lib/feedback.ts`, plus a worker twin in
  `apps/worker/src/lib/feedback.ts`. It inserts `feedback_events` with `planFacts` inside the caller's transaction.
  WP2 later adds the recompute trigger.
- **Legal pages**:
  - Public `/privacy`, `/terms` and `/data-deletion`.
  - Settings → Business → "Legal pages": owner-edited text with a plain draft marked "Review before publishing".
    Nothing is served until the owner publishes. Stored in a `legal` settings section.
  - `business.termsUrl` / `privacyUrl` default to those pages.
  - Meta (Privacy Policy and User Data Deletion URLs), Google's OAuth consent screen and the Spotify embed need them.
- **`status-pill.tsx`**: the labels and tones for every status listed in the five designs.
- **`packages/config` and `.env.example`**: every new variable from the designs, all optional, with plain comments.
  `describeCapabilities` reads them per module.

  | Group | Variables |
  | --- | --- |
  | Publishing | `META_LOGIN_CONFIG_ID`, `META_GRAPH_VERSION` (default `v26.0`), `TIKTOK_PUBLISH_PROVIDER` (`none`/`zernio`), `ZERNIO_API_BASE_URL`, `ZERNIO_WEBHOOK_SECRET` |
  | Trends | `YOUTUBE_API_KEY` |
  | Square | `SQUARE_WEBHOOK_NOTIFICATION_URL` |
  | Email and reviews | `EMAIL_PROVIDER` (`none`/`postmark`), `POSTMARK_SERVER_TOKEN`, `POSTMARK_TRANSACTIONAL_STREAM`, `POSTMARK_BROADCAST_STREAM`, `POSTMARK_WEBHOOK_USERNAME`, `POSTMARK_WEBHOOK_PASSWORD`, `GOOGLE_MAPS_API_KEY` |
  | Website | `AI_WEBSITE_MODEL` |
  | Test only | `META_GRAPH_BASE_URL`, `META_RUPLOAD_BASE_URL`, `SQUARE_API_BASE_URL` |

  The `TIKTOK_CLIENT_*` variables are documented as unused.
- **Copy fix**: the Settings → Business review-link hint becomes "Read reviews → Get more reviews (on a computer)"
  (email §9.3).

---

## 3. Work packages

Notation: **Owns** = files and directories only this package creates or edits while it is in flight. "(own module
files)" means the per-module registry files from section 2.2. Every package also adds its own sections to the docs
(section 4).

**Merge and migration rules (all packages).**

- Branch from the latest integration branch.
- Each package with SQL ships **one** migration. The number is assigned in merge order (the plan below). On merge,
  the lead rebases, deletes the package's generated migration, snapshot and journal entry, and regenerates them with
  `drizzle-kit generate --name <pkg>`. It diffs the result against the package's reviewed SQL and re-adds any
  statement drizzle-kit cannot express (website's constant-expression partial index).
- Migrations are additive:
  - `CREATE TABLE`
  - `ADD COLUMN` (nullable or with a default)
  - `CREATE INDEX`
  - relaxing `DROP NOT NULL` (publishing's two)
  - one data backfill (email's `message_class`)
- No drops, renames or type changes.

### Parallel groups (summary)

| Group | Packages (run concurrently) | Starts after | Migrations (planned numbers) |
| --- | --- | --- | --- |
| G0 | WP0 Foundations | Stage A merged (done 2026-11-14) | 0001_foundations |
| G1 | WP1 Music & licence ∥ WP3 Trends (no Instagram) | G0 | 0002_music, 0003_trends |
| G2 | WP2 Preferences, reference video & brand ∥ WP4 Publishing (manual + Instagram direct) | WP1 (neither needs WP3) | 0004_preferences, 0005_publishing |
| G3 | WP5 Instagram hashtag watch → **Stage B acceptance** | WP3 + WP4 | none |
| G4 | WP6 Square Tier 0 ∥ WP7 Email & review requests ∥ WP8 Website check & Search Console | Stage B accepted (brief §8: finish each stage first) | 0006_square, 0007_email_reviews, 0008_website |
| G5 | WP6b Square Tier 1 ∥ WP9 Google Business Profile (reviews + performance) ∥ WP10 TikTok via Zernio | WP6 / WP7 + WP8 / WP4 | 0009_square_changes, 0010_business_profile, none |

The sandbox has run at most two agents at once (HANDOVER §3). Run three-package groups as two plus one; the order
inside a group does not matter for correctness, only for migration numbers.

---

### WP0 — Shared foundations (G0)

- **Goal.** Everything in section 2, so that later packages share one way of doing integrations, scheduling and
  registration, and can run in parallel.
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/time.ts` (additions), `src/completion.ts`, `src/plan-facts.ts`, `src/integrations.ts` (state unions), `src/jobs.ts` + `src/jobs/*.ts` stubs (and `shared.ts` with `webhook.process`, `google.disconnect`), `src/settings.ts` + `src/settings/*.ts` stubs + `legal` section + `business.termsUrl/privacyUrl`, `src/index.ts` |
  | `packages/db` | `src/schema.ts` (re-exports + `integration_connections` TS enum widening + `customers.squareEmailUnsubscribed`), `src/schema/*.ts` stubs, `drizzle.config.ts`, `drizzle/0001_foundations.sql` + meta |
  | `packages/queue` | `src/index.ts` (policy, `startAfter`, schedule `key`, settings aggregator), `src/settings/*.ts` stubs |
  | `packages/config` | `src/index.ts`, `.env.example` |
  | `apps/worker` | `src/modules/**` stubs, `src/main.ts`, `src/context.ts` (`fetch`), `src/lib/{http,audit,credentials,connections,feedback}.ts`, `src/lib/google/oauth.ts`, `src/lib/jobs.ts`, `src/handlers/{webhook-process,google-disconnect,cleanup}.ts`, `src/handlers/render.ts` (only the export-ready hook call) |
  | `apps/web` | `src/lib/shared/integration-types.ts`, `src/lib/integrations.ts` + `src/lib/integrations/*.ts` stubs (existing entries moved into module files unchanged), `src/lib/oauth-state.ts`, `src/lib/google-oauth.ts`, `src/lib/webhooks.ts`, `src/lib/feedback.ts`, `src/lib/public-routes.ts`, `src/proxy.ts`, `src/lib/jobs.ts` + `src/lib/jobs/*.ts` stubs (`startAfterSeconds` pass-through), `src/app/api/integrations/google/{connect,callback}/route.ts`, `src/app/{privacy,terms,data-deletion}/page.tsx`, `settings/_components/integrations-tab.tsx` + `integrations/*.tsx` stubs, `settings/_components/business-tab.tsx` (legal pages, review-link hint), `src/components/ui/status-pill.tsx`, `src/components/studio/edit-grid.tsx` + `extensions/*.tsx` stubs |
  | docs | `docs/api.md` (an empty heading per module), `docs/architecture.md` (integrations framework section) |

- **Migration.** `0001_foundations`: `ALTER TABLE customers ADD COLUMN square_email_unsubscribed boolean;`
- **Depends on.** Stage A merged (true as of commit `366f249` and the hardening merge).
- **Acceptance tests.**
  - Typecheck and all existing tests pass. The worker still refuses to start when a registered type has no handler.
  - Unit tests:
    - `melbourneLocalToUtc`: 2026-10-04 02:30 nonexistent; 2027-04-04 02:30 ambiguous → 15:30Z on 3 Apr.
    - `nextSendSlot` across both DST changes.
    - `melbourneDayRange` gives 23-, 24- and 25-hour days.
    - `isGenuinelyCompleted` matrix, with `square_status` and `none` rejected.
    - `computePlanFacts` on fixture plans.
    - `buildIntegrationStatuses` keeps today's wording for existing entries.
    - OAuth state: tampered, expired and wrong-session cases.
    - Google product table: unknown product → 400.
    - The public-route list includes the webhook, unsubscribe and legal paths, and `/settings` stays private.
  - Integration tests (`TEST_DATABASE_URL`):
    - Webhook intake: the same event twice gives one row and one job.
    - The `webhook.process` dispatcher marks unknown providers processed with an error.
    - `withConnectionLock` serialises two refreshers.
    - pg-boss `stately` and `singletonKey` behaviour, and two keyed schedules on one queue.
    - Legal pages give 404 until published and are public once published.
    - `recordFeedback` inside a rolled-back transaction leaves no row.
- **Verify with the owner's real accounts.** Nothing. Google OAuth is exercised for real only by WP8 and WP9.

### WP1 — Music controls and licence passport (G1, Stage B)

- **Goal.** Preferences design §4.6–4.10 and §6.4/§6.7 (music parts):
  - licence passport: memo §2 kinds, `facebook`, `destinationLock`, CC BY-NC refused, CC BY credit
  - `normaliseLicence` and `musicClearanceFor`
  - export clearance gate and `music_usage` ledger
  - the `no_music` export variant (publishing §3.4)
  - Sound panel with audio-patch fast path and re-cut path; `beatSync` / `revealOnBeat`
  - revision-parser colour and beat phrases (parser only)
  - genre/mood/artist ranking ("Suggested for you")
  - Spotify references (link-only, embed behind the legal pages)
  - `MusicCatalogueProvider` interface only
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/music.ts`, `src/audio-patch.ts`, `src/music-ranking.ts`, `src/music-catalogue.ts`, `src/spotify-link.ts`, `src/revision.ts`, `src/jobs/music.ts` (incl. `edits.revise` `mode: 'audio'`, `render.export` `variant`), `src/settings/music.ts` |
  | `packages/db` | `src/schema/music.ts` (`music_usage`, `music_references`), `music_tracks.genres` and `edit_versions.variant_exports` in `src/schema.ts` |
  | `packages/storage` | `src/keys.ts` (`editExportVariant`) |
  | `packages/ai` | `src/types.ts`, `src/rules/{music,planner}.ts`, `src/anthropic/prompts.ts` (beat fields) |
  | `apps/worker` | `src/handlers/{generate,render}.ts` (music parts), `src/lib/plan-context.ts`, `src/modules/music/**` |
  | `apps/web` | `src/lib/{music,music-references,studio-edits}.ts` (export clearance, variant, audio revise, download kind/label), `src/lib/shared/{studio-schemas,studio-dto}.ts` (music fields), `src/app/api/music/**`, `src/app/api/edits/[id]/revise`, `src/app/api/edit-versions/[id]/{export,download}`, `src/components/studio/{sound-panel,energy-strip,style-controls,music-upload-dialog}.tsx`, `src/components/studio/extensions/music.tsx`, `settings/_components/{music-tab,licence-passport-form,music-references}.tsx`, `src/lib/integrations/music.ts`, `settings/_components/integrations/music.tsx`; the ESLint `no-restricted-imports` rule for `lib/music-references` |

- **Migration.** `0002_music`: `music_tracks.genres`, `music_usage`, `music_references`,
  `edit_versions.variant_exports`.
- **Depends on.** WP0.
- **Acceptance tests.** Preferences §13.1/§13.2 music items, plus:
  - `musicClearanceFor` matrix incl. `meta_only`, and `normaliseLicence` forcing.
  - CC BY-NC refused by the schema and the API.
  - `applyAudioPatch` + `validateEditPlan`; the `needsRecut` matrix.
  - The `no_music` variant has no music stream (ffprobe) and the plan stays valid.
  - A blocked-licence export fails `UNSUPPORTED` with no retry, and `no_music` still exports.
  - One `music_usage` row per export.
  - The Spotify parser rejects lookalike hosts.
  - `buildPlannerInput` contains no `open.spotify.com`.
  - Rules planner: `beatSync off` gives no snapping; `revealOnBeat` lands within ±0.25 s.
  - Stage A `pipeline.integration.test.ts` still passes.
- **Verify with the owner's real accounts.**
  - Whether the owner's music library plan really covers organic posts, website and boosts (written confirmation,
    memo §2).
  - How the Sound panel feels on real tracks.

### WP3 — Trends without Instagram (G1, Stage B; parallel with WP1)

- **Goal.** Preferences design §4.11–4.13 and §6.6:
  - three never-mixed groups
  - curated list re-sourced to the memo's URLs with "last reviewed" dates
  - "Note a trend"
  - Creative Center and Google Trends links
  - YouTube AU popular chart watch
  - `trendLabel`
  - `TEXT_UNSUPPORTED_CLAIM` in `validateEditPlan`
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/trend-label.ts`, `src/plan-validation.ts`, `src/jobs/trends.ts` |
  | `packages/db` | `src/schema/trends.ts` (`trend_watches`), `trend_references` columns in `src/schema.ts` |
  | `apps/worker` | `src/modules/trends/**`, `src/handlers/trends.ts`, `src/lib/youtube-client.ts` |
  | `apps/web` | `src/lib/{trends,trend-watches,seed-trends}.ts`, `src/app/api/trends/**`, `settings/_components/{trends-tab,live-signals,note-trend-dialog}.tsx`, `src/lib/integrations/trends.ts`, `settings/_components/integrations/trends.tsx` |

- **Migration.** `0003_trends`: the `trend_references` columns and partial unique index, plus `trend_watches`.
- **Depends on.** WP0.
- **Acceptance tests.**
  - `trendLabel` outputs never match `/trending|viral/i`.
  - The validator rejects claim text.
  - `trends.refresh` against a fetch fake: YouTube 200, `quotaExceeded` and `keyInvalid`; items deleted after 7 days.
  - The curated update touches only original seed rows.
  - Staff can note a trend; only the owner adds watches.
  - No trend data reaches planner input.
- **Verify with the owner's real accounts.** The first YouTube chart fetch, which needs `YOUTUBE_API_KEY` and costs
  1 unit.

### WP2 — Saved preferences, reference video and brand (G2, Stage B)

- **Goal.** Preferences design §4.1–4.5 and §6.1–6.2, §6.5, §6.7 (non-music parts):
  - feedback recording on favourite, download, revise, regenerate and dismiss, with plan facts
  - `preferences.recompute` and `effectivePreferences`
  - Settings transparency with pin and reset
  - "Hide this edit"
  - reference-video upload, measurement and deletion of the originals
  - logo end card / corner mark inside R_head
  - brand snapshot per version
  - text-density mapping fix and `resolveRenderFont`
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/preference-learning.ts`, `src/reference.ts`, `src/brand.ts`, `src/jobs/preferences.ts`, the preferences/brand parts of `src/settings.ts` (existing sections) |
  | `packages/db` | `edits.dismissed_at`, `edit_versions.render_brand`, `media_assets.reference_profile`, `feedback_events` index in `src/schema.ts` |
  | `packages/media` | `src/analysis/look.ts`, `src/render/{logo,types,render,command,ass,verify}.ts` |
  | `packages/ai` | `src/anthropic/text-estimate.ts`, `src/rules/settings.ts`, provider factory |
  | `apps/worker` | `src/modules/preferences/**`, `src/handlers/{preferences,reference,ingest}.ts`, brand and logo parts of `src/handlers/{render,generate}.ts` |
  | `apps/web` | `src/lib/{feedback,preferences,references,settings-merge,uploads,studio-status-shape,assets}.ts`, `src/lib/shared/upload-math.ts`, `src/app/api/{preferences,references}/**`, `src/app/api/edits/[id]/dismiss`, `src/app/api/settings/route.ts`, `src/components/studio/{reference-strip,upload-zone,studio-workspace}.tsx`, `src/components/studio/extensions/preferences.tsx`, `settings/_components/{preferences-tab,learned-preferences,branding-tab,logo-placement}.tsx` |

- **Migration.** `0004_preferences`.
- **Depends on.** WP1, which edits `render.ts`, `generate.ts`, `studio-edits.ts` and `packages/ai` before it.
- **Acceptance tests.** Preferences §13.1/§13.2 (non-music), plus:
  - Learning is deterministic.
  - A pinned field wins.
  - `resetAt` excludes older events.
  - A concurrent settings PUT is not lost (`jsonb_set`).
  - Reference ingest: profile stored, originals deleted, asset absent from footage and planner input.
  - Logo pixels sit only inside the expected rectangles at both sizes.
  - Export uses the preview's brand snapshot.
- **Verify with the owner's real accounts.**
  - Whether learned defaults feel right after a few weeks.
  - Logo legibility on the real logo.
  - Colour and pacing estimates on real reference videos.

### WP4 — Publishing: manual posting and Instagram direct (G2, Stage B; parallel with WP2)

- **Goal.** Publishing design except §7.2 (Zernio):
  - composer
  - eligibility (on WP1's `musicClearanceFor` and `no_music`)
  - Melbourne scheduling
  - manual posting with "I've posted it"
  - Instagram Unified Login connect and `social.check`
  - `publish.*` jobs with the duplicate-post rules
  - first verification post
  - Content Library badges and multi-select
  - `publish` feedback and `music_usage` rows when published

  TikTok shows only "Post it yourself".
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/publishing.ts`, `src/jobs/publishing.ts`, `src/settings/publishing.ts` |
  | `packages/db` | `src/schema.ts` blocks for `social_accounts`, `publish_posts`, `publish_targets` |
  | `apps/worker` | `src/modules/publishing/**`, `src/handlers/{publish-prepare,publish-target,publish-poll,publish-dispatch,social-check}.ts`, `src/publishing/{instagram,errors,post-status}.ts`, `src/lib/meta/graph.ts`, `test/fakes/graph-server.ts`, `test/publishing.integration.test.ts` |
  | `apps/web` | `src/lib/publishing.ts`, `src/lib/shared/publishing-dto.ts`, `src/lib/projects.ts` (cancel unsent posts, delete covers), `src/app/api/{publishing,publish-posts,publish-targets,social-accounts}/**`, `src/app/api/integrations/{instagram,meta}/**`, `src/app/api/integrations/[provider]/check`, `src/app/(app)/publishing/**`, `src/app/(app)/library/page.tsx`, `src/components/publishing/**`, `src/components/studio/extensions/publishing.tsx`, `src/lib/integrations/publishing.ts`, `settings/_components/integrations/publishing.tsx` |

- **Migration.** `0005_publishing`: publishing §5.2 (`social_accounts`, `publish_posts`, `publish_targets`).
  `edit_versions.variant_exports` is already in WP1.
- **Depends on.** WP1 (eligibility, `no_music`, `meta_only` labels) and WP0 (`recordFeedback`, hooks,
  `melbourneLocalToUtc`, OAuth state, `/privacy` and `/data-deletion`).
- **Acceptance tests.** Publishing §11.1 and §11.2 cases 1–7 and 12–17 against the Graph/rupload fake, plus:
  - Crash after `media_publish` gives no second publish.
  - Copyright match → `review_copyright_match` → post without music.
  - Quota requeue.
  - Error 190 → reconnect.
  - Partial post keeps the published target.
  - Licence changed after scheduling.
  - `meta_only` is never TikTok standard.
  - `kill -9` during upload.
  - Two claimers → one claim.
  - DST scheduling.
  - The composer preselects nothing and caps at 5.
  - The feedback event and ledger row appear only on `published`.
- **Verify with the owner's real accounts.** All of publishing §11.4 (Instagram):
  - Unified Login publishing in Development mode (the memo's "Main risk")
  - whether `business_management` is needed for discovery
  - the resumable size limit (100 vs 300 MB)
  - quota 50 vs 100, and token expiry
  - `thumb_offset` with resumable upload
  - Sound Collection copyright matching
  - Web Share on iOS

  The first verification post is a real public reel the owner chooses.

### WP5 — Instagram hashtag watch (G3, Stage B)

- **Goal.** Preferences §4.12 and §8.1:
  - the hashtag watch as a live-signal source
  - capability-checked; `unavailable` is a valid end state
  - the 30-per-7-days budget with at most 10 enabled
  - reads the `meta` connection's credential through WP4's Graph client
- **Owns.** `apps/worker/src/modules/trends/instagram.ts` (new file registered from the trends module index; WP3 has
  merged), `apps/worker/src/handlers/trends.ts` (Instagram branch), the hashtag card in
  `settings/_components/live-signals.tsx`, the `instagram_hashtags` entry in `src/lib/integrations/trends.ts`.
- **Migration.** None (`trend_watches` exists from WP3).
- **Depends on.** WP3, WP4.
- **Acceptance tests.** `trends.refresh` against the Graph fake: success with upsert and stale removal, codes 190,
  10 and 4, the 30-hashtag budget, empty search. The token is never in a payload or log.
- **Verify with the owner's real accounts.** Whether hashtag search is permitted for a Unified Login system-user
  configuration, the permission's exact name, and whether `top_media` counts towards the 30.
- **Stage B acceptance (after WP5).**
  - On synthetic footage plus fakes: music licence → export gates → publish manually and (with fakes) to Instagram →
    learned preferences visible → trends labelled.
  - Update `docs/HANDOVER.md` and the README status table (built / verified on synthetic data / waiting on account
    access).
  - Real-account items stay listed as waiting.

### WP6 — Square Tier 0: read-only appointments (G4, Stage C)

- **Goal.** Square design except §4.5–4.6 changes, the self-test and §6.3:
  - OAuth code flow with read scopes
  - sandbox/live handling with purge on switch
  - `square.sync`, `refresh`, `attendance`, `availability`, `token_refresh` and `revoke`
  - verified webhooks (Square handler for `webhook.process`)
  - customers and services mirror with the per-service label
  - attendance estimate with owner marks (the attendance route)
  - `deriveCompletion` writing `completed_at` / `completion_source`
  - `customers.square_email_unsubscribed` filled
  - Appointments page
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/square.ts` (incl. `availabilityRange`), `src/jobs/square.ts` |
  | `packages/db` | `src/schema/square.ts` (`square_availability_searches`), `bookings` and `customers` blocks in `src/schema.ts`, `src/square-purge.ts` |
  | `apps/worker` | `package.json` (`square@46.0.0`), `src/square/**`, `src/handlers/square-*.ts`, `src/modules/square/**`, `scripts/square-smoke.ts` |
  | `apps/web` | `src/lib/square/**`, `src/lib/shared/square-dto.ts`, `src/app/api/integrations/square/**` (except `self-test`), `src/app/api/appointments/**` (except `changes`), `src/app/api/webhooks/square/route.ts`, `src/app/(app)/appointments/**`, `src/components/appointments/**`, `src/lib/integrations/square.ts`, `settings/_components/integrations/square.tsx` |

- **Migration.** `0006_square`: the `bookings` and `customers` columns from Square §5.3 (except
  `square_email_unsubscribed`, which WP0 added) and `square_availability_searches`.
- **Depends on.** Stage B accepted, WP0.
- **Acceptance tests.** Square §11.1/§11.2 (Tier 0 parts) against `test/fakes/square-server.ts`:
  - Webhook HMAC: valid, invalid not stored, wrong URL; the `await` trap covered.
  - Six statuses mirrored verbatim; stale versions ignored.
  - 31-day windows; reconcile marks missing bookings.
  - `matchPayments` strong, weak and tie cases; refunds clear completion back to `none`.
  - An owner mark on a NO_SHOW booking is refused.
  - DST day ranges and the 23-hour availability extension.
  - Environment switch purges and scrubs customers.
  - No message is ever sent.
- **Verify with the owner's real accounts.**
  - Square §11.3 sandbox smoke (`session=false`, code lifetime, webhook delivery). This is developer-run but needs
    the owner's Square developer application.
  - On the live account: webhook delivery to the production URL, payment-match quality, location timezone,
    Dashboard deep links.

### WP7 — Email and review requests (G4, Stage C; parallel with WP6 and WP8)

- **Goal.** Email design except Business Profile Tier 2:
  - `EmailProvider` + Postmark
  - render, lint, consent ledger, suppressions, send gate
  - `email.send` state machine
  - dispatch, automation sweep (follow-ups and review requests from `isGenuinelyCompleted`, manual attestation),
    campaigns with auto-pause
  - unsubscribe page and one-click handling
  - Postmark webhooks (Basic auth)
  - review link and click redirect
  - Places Tier 1 rating and count
  - Emails and Reviews pages
  - `square_email_unsubscribed` treated as a marketing block
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/email.ts`, `src/email-lint.ts`, `src/reviews.ts`, `src/jobs/email.ts`, `src/settings/email.ts` (`email`, `reviews`) |
  | `packages/db` | `src/schema/email.ts` (`email_campaigns`, `consent_events`, `email_suppressions`), the `email_templates`, `email_messages` and `review_requests` blocks in `src/schema.ts` |
  | `apps/worker` | `src/lib/email/**`, `src/lib/google/places.ts`, `src/handlers/{email-*,reviews-places}.ts`, `src/modules/email/**`, `scripts/email-smoke.ts`, `test/fixtures/postmark/**` |
  | `apps/web` | `src/lib/{email,reviews,public-rate-limit}.ts`, `src/app/api/{email,customers,reviews}/**` (except `reviews/google/**`), `src/app/api/integrations/google-places/**`, `src/app/api/webhooks/postmark`, `src/app/api/public/unsubscribe/**`, `src/app/r/[token]`, `src/app/u/[token]`, `src/app/(app)/{emails,reviews}/**`, `src/components/{email,reviews}/**`, `src/app/(app)/page.tsx` (approval-count line), `src/lib/integrations/email.ts`, `settings/_components/integrations/email.tsx` |

- **Migration.** `0007_email_reviews`: email §5.2 (except the `reviews` table changes, which move to WP9).
- **Depends on.** Stage B accepted, WP0. Reads `bookings` and `customers` columns that exist after WP0; the
  completion values themselves come from WP6 at run time.
- **Acceptance tests.** Email §11.1/§11.2 against `FakeEmailProvider`:
  - `email.send` twice → one provider call.
  - Unknown outcome → `findSent` → no second send.
  - 406 → suppression.
  - 412 → `approved=false`.
  - The sweep run twice concurrently gives one request.
  - A booking completed before `enabledAt` is ignored.
  - Cancelled after creation → cancelled.
  - Daily cap carries over to 9:00 Melbourne tomorrow.
  - Unsubscribe POST is idempotent; GET changes nothing.
  - Webhook with wrong credentials → 401, nothing stored.
  - `SpamComplaint` auto-pauses.
  - The `reviewEligibility` parameter-key pin test (no gating inputs).
  - The linter blocks incentive wording.
  - `square_email_unsubscribed = true` blocks marketing.
- **Verify with the owner's real accounts.**
  - Postmark approval, DKIM/Return-Path, and real Gmail/Outlook delivery with the one-click button.
  - Postmark unsubscribe links after 30 days.
  - Places billing SKU and the attribution text.
  - The first live send: a one-off email to a consenting client, approved by the owner.
  - Real Square completions driving the automation.

### WP8 — Website check, prepared changes, WordPress apply, Search Console (G4, Stage C)

- **Goal.** Website design except Business Profile Performance:
  - ownership confirmation and site scope
  - crawler with SSRF guard and robots.txt
  - about 55 checks, prioritised
  - prepared changes with lifecycle and dedupe
  - optional AI wording (Haiku, on click only)
  - copy-paste instructions
  - WordPress adapter (read-only check, explicit apply, read-back)
  - Search Console via the WP0 Google OAuth product `search_console`
  - query classification (brand / local / service / not listed)
  - opening hours in Settings → Business
- **Owns.**

  | Package | Files and directories |
  | --- | --- |
  | `packages/core` | `src/website.ts`, `src/website-checks.ts`, `src/robots.ts`, `src/jobs/website.ts`, `src/settings/website.ts`, `business.openingHours` in `src/settings.ts` |
  | `packages/db` | `src/schema/website.ts` (`search_metrics`), the `website_audits` and `website_edits` blocks in `src/schema.ts` |
  | `packages/ai` | `src/website-copy.ts` |
  | `packages/config` | `AI_WEBSITE_MODEL` is already added by WP0; no change |
  | `apps/worker` | `src/website/**`, `src/lib/google/search-console.ts`, `src/handlers/{website-*,search-sync}.ts`, `src/modules/website/**`, `scripts/website-smoke.ts`, dependencies `cheerio`, `fast-xml-parser`, `undici` (exact pins, licence checked) |
  | `apps/web` | `src/lib/website.ts`, `src/lib/settings-merge.ts` (server-only website fields; WP2 has merged), `src/app/api/website/**`, `src/app/api/integrations/{google-search-console,website}/**`, `src/app/(app)/website/**`, `src/components/website/**` (except `profile-performance-card.tsx`), `settings/_components/business-tab.tsx` (opening hours), `src/lib/integrations/website.ts`, `settings/_components/integrations/website.tsx` |

- **Migration.** `0008_website`: website §5.2 (`website_audits`, `website_edits`, `search_metrics`), including the
  hand-added constant partial index.
- **Depends on.** Stage B accepted, WP0.
- **Acceptance tests.** Website §12.1/§12.2 against the fixture site:
  - robots.txt (RFC 9309 cases).
  - SSRF: loopback, private IP, redirect off-host and DNS rebinding are refused.
  - The 25-page cap and one active check.
  - Check catalogue and prioritisation.
  - `classifyQuery` groups.
  - The AI draft is rejected when it contains ranking claims, and page text is delimited as data.
  - WordPress fake: check is read-only; apply only with `approved_by`; a retry after a write gives
    `already_applied`; `before` text not found once gives a conflict.
  - Search Console fake: backfill windows, idempotent upsert, `invalid_grant` → `needs_reauth`.
- **Verify with the owner's real accounts.**
  - Which site builder the site uses and whether Application Passwords work.
  - Search Console property and type, and the unverified-app warning.
  - The anonymised-query share.
  - False positives on the real site.

### WP6b — Square Tier 1: booking changes and self-test (G5, Stage C)

- **Goal.** Square §4.5–4.6, §6.3 and the self-test:
  - write scopes requested only when the owner turns changes on
  - the `tier1Status` checklist
  - per-service fee confirmation
  - `square.booking_change` (the only writer: claim → gate → plan → service → booking → availability re-check →
    `submitted_at` → send → result)
  - `square.self_test`
  - unknown-outcome settlement
  - shipped behind `SQUARE_TIER1_AVAILABLE` until the sandbox smoke test records the real errors
- **Owns.** `apps/worker/src/square/change.ts`, `src/handlers/{square-booking-change,square-self-test}.ts`,
  `packages/db/src/schema/square-changes.ts` (`square_booking_changes`),
  `apps/web/src/app/api/appointments/changes/**`, `apps/web/src/app/api/integrations/square/self-test/**`, the
  change dialog and Tier 1 checklist components under `src/components/appointments/` (new files), plus additions to
  WP6's `src/jobs/square.ts` and `src/modules/square/index.ts` (WP6 has merged).
- **Migration.** `0009_square_changes`: `square_booking_changes` and its indexes.
- **Depends on.** WP6.
- **Acceptance tests.** Square §11.2 (write parts):
  - The gate refuses on plan flag false, missing scopes, a fee-bearing service or an unconfirmed service.
  - A slot gone at re-check → `slot_unavailable` with alternatives.
  - A version change → `changed_in_square`.
  - Timeout → retry with the same idempotency key → one booking.
  - Last attempt → `unknown`, settled by the next sync.
  - 4xx stored verbatim and the service becomes `book_in_square`.
  - The double-booking warning.
  - A self-test resumes after a crash.
- **Verify with the owner's real accounts.** Everything in Square §11.3/§11.4 about writes:
  - three no-show set-ups in sandbox (per service, per appointment, none) and the real error bodies
  - whether update and cancel work on fee-protected bookings
  - whether seller cancel covers PENDING
  - `support_seller_level_writes` on the owner's plan
  - the live self-test and whether Square notifies the client

### WP9 — Google Business Profile: reviews list and performance (G5, Stage C)

- **Goal.**
  - Email design Tier 2: location discovery, `reviews.gbp.sync` (incremental watermark, weekly full), the "Reviews
    on Google" tab with `reviewReplyState` and `policyViolation`, and "Waiting for Google approval" while quota is 0.
  - Website design §4.6 and §7.3: Performance daily metrics and monthly keywords into `search_metrics`, and the
    Business Profile performance card.
  - Both on the WP0 `business_profile` OAuth product.
- **Owns.** `apps/worker/src/lib/google/{business-profile,business-profile-performance}.ts`,
  `src/handlers/reviews-gbp.ts`, the `business_profile_performance` branch in `src/handlers/website-connection-check.ts`
  and the `business_profile` source in `src/handlers/search-sync.ts` (WP8 has merged), `src/modules/business_profile/**`,
  `packages/core/src/jobs/business_profile.ts`, `apps/web/src/app/api/integrations/google-business-profile/**`,
  `src/app/api/reviews/google/**`, `src/app/api/website/business-profile-performance`,
  `src/components/reviews/google-reviews-tab.tsx`, `src/components/website/profile-performance-card.tsx`,
  `src/lib/integrations/business_profile.ts`, `settings/_components/integrations/business_profile.tsx`, and the
  slots for those components in the Reviews and Website pages (WP7 and WP8 have merged).
- **Migration.** `0010_business_profile`: `reviews.review_updated_at` and the index
  `reviews_provider_created_idx` (moved from the email migration because only this package uses them).
- **Depends on.** WP7 (Reviews page), WP8 (Website page, `search_metrics`, `search.sync`), WP0 (Google OAuth).
- **Acceptance tests.**
  - Fakes:
    - quota-0 429 → `awaiting_approval`, not an error, with no retry until the next daily run
    - incremental watermark
    - page-2 known issue covered by the weekly full sync
    - `invalid_grant` → `needs_reauth` on the shared row
  - A missing metric value is stored as NULL, never 0.
  - An unknown response shape fails with a plain message.
  - No placeholder numbers are ever rendered.
- **Verify with the owner's real accounts.**
  - Google's Basic API Access approval (not guaranteed for a single location).
  - Whether `business.manage` shows an unverified-app warning.
  - Performance request/response shapes and retention.

### WP10 — TikTok automatic posting via Zernio (G5, Stage C, feature-flagged)

- **Goal.** Publishing §7.2: the Zernio key connect, account choice, `publish.target` Zernio branch,
  consent-tick approval, poll schedule, webhooks (hint only, `unverified:` keys), drafts, and the 15-per-24 h
  warning.
- **Owns.** `apps/worker/src/publishing/zernio.ts`, the Zernio branches in WP4's
  `src/handlers/{publish-target,publish-poll,social-check}.ts` and `src/publishing/errors.ts` (WP4 has merged), the
  `zernio` webhook handler in `src/modules/publishing/`, `test/fakes/zernio-server.ts`,
  `apps/web/src/app/api/integrations/zernio/**`, `apps/web/src/app/api/webhooks/zernio/route.ts`, the TikTok section
  of `settings/_components/integrations/publishing.tsx`, and the Zernio method options in `src/lib/publishing.ts`.
- **Migration.** None (the `publish_targets` columns exist from WP4).
- **Depends on.** WP4.
- **Blocked until.** `docs.zernio.com` is reachable and the ⚠ items in publishing §7.2 (base host, presign path,
  account list, post read, field names, webhook signing, idempotency, draft status) are confirmed and written into
  the design. Until then the adapter stays disabled and only the manual path shows.
- **Acceptance tests.** Publishing §11.2 cases 7–11 against the Zernio fake:
  - Both consent flags and `PUBLIC_TO_EVERYONE` are sent only after the consent tick.
  - Crash between POST and saving `postId` → `check_before_retry` and no second POST.
  - Retry uses `/v1/posts/{id}/retry`.
  - A webhook only triggers a poll; a forged event cannot block the real one.
  - Partial post keeps the published Instagram target.
- **Verify with the owner's real accounts.**
  - The audited lane end to end, held-over-cap behaviour, URL resolution delay, draft behaviour, and whether
    "first 2 accounts free" still holds.
  - The first verification post is a real public TikTok.

---

## 4. Rules for files that more than one package touches

- **Append-only shared files.** These may get one-line additions from parallel packages; the merger resolves them in
  plan order:
  - `packages/core/src/index.ts` and `packages/ai/src/index.ts` (export lines)
  - `packages/db/src/schema.ts` (only the table blocks the package owns, as listed above)
  - `docs/api.md`, `docs/architecture.md`, `docs/security.md`, `docs/deployment.md`, `docs/testing.md`,
    `README.md` (each package edits only its own module heading)
  - `docs/HANDOVER.md` (only the lead edits it)
- **Sequential ownership.** These change hands only between groups, never inside one: `render.ts`, `generate.ts`,
  `studio-edits.ts`, `edit-grid.tsx` (only WP0; packages use the extension files), `settings-merge.ts` (WP2, then
  WP8), `business-tab.tsx` (WP0, then WP8), `trends.ts` handler (WP3, then WP5), WP4's publishing handlers (then
  WP10), WP6's Square files (then WP6b), the website handlers (WP8, then WP9).
- **Never edited outside WP0:** the aggregators in section 2.2, `proxy.ts`/`public-routes.ts`, `status-pill.tsx`,
  `packages/config`, `.env.example`. If a package needs a change there, it asks the lead. A missing env var or status
  label is a WP0 bug, fixed on the integration branch.
- **Agents never commit** (HANDOVER). Each package hands back a report with the files changed, tests run, the
  migration SQL and anything left for the owner.

---

## 5. Order at a glance

```
G0  WP0 Foundations
      │
G1  WP1 Music & licence ───────┬──────────── WP3 Trends (no Instagram)
      │                        │                 │
G2  WP2 Preferences & brand    WP4 Publishing (manual + Instagram)
                               │                 │
G3                             └── WP5 Hashtag watch ──┘   → Stage B acceptance
      │
G4  WP6 Square Tier 0   ∥   WP7 Email & review requests   ∥   WP8 Website & Search Console
      │                      │                                  │
G5  WP6b Square Tier 1   ∥   WP9 Business Profile (needs WP7+WP8)   ∥   WP10 Zernio (needs WP4; blocked on docs)
```

---

## 6. What can only be verified with the owner's real accounts (summary)

| Integration | Needs the owner | Until then the app shows |
| --- | --- | --- |
| Instagram direct publishing | Meta app, business portfolio, configuration, first verification post | "Post it yourself" (always works); Instagram card "not connected" or "connected, not verified" |
| Instagram hashtag watch | Hashtag permission added to the same configuration | "Not configured" or "Not available" |
| TikTok via Zernio | Zernio account, TikTok Business connection, confirmed API docs, verification post | Manual TikTok posting only |
| YouTube chart | `YOUTUBE_API_KEY` | "Optional, not configured" |
| Music | Business-eligible library plan with written coverage; honest licence forms | Previews allowed; exports blocked for unconfirmed licences; music-free export always available |
| Square Tier 0 | Square developer app, sandbox, then live keys, webhook subscription | "Needs setup"; no bookings shown |
| Square Tier 1 | Plus or Premium plan, fee-free services, sandbox error recording, live self-test | "Do this in Square" links |
| Email | Domain DNS, Postmark servers and streams, approval, webhooks, consent recorded at the counter | Drafts and previews only; nothing sent |
| Review requests | The official review link (desktop) | "Add your review link" |
| Google rating | Maps billing, Places key, Place ID | "Not connected"; no numbers |
| Google reviews list and performance | Business Profile API approval (not guaranteed), OAuth consent screen in Production | "Waiting for Google" |
| Search Console | Verified property, OAuth client | "Not connected"; no numbers |
| WordPress apply | Editor user and Application Password (WordPress sites only) | Copy-paste instructions |
| AI (vision, reference text, website wording) | `ANTHROPIC_API_KEY` | Rules/heuristic paths; AI buttons hidden |

---

## 7. Owner setup checklist (all integrations, plain language)

You said you will do these later. That is fine: everything is built so the app works without them and simply says
"needs setup". Do them in any order. Steps marked **(free)** cost nothing to set up. Never send passwords or keys in
chat; the person running the server puts them in the server settings.

**Before anything else (needed by several integrations).**

1. **Publish your legal pages.** Go to Settings → Business → Legal pages. Read the draft privacy policy, terms and
   data-deletion pages, change anything that isn't true for your shop, and press Publish. Meta, Google and the
   Spotify player all need these pages. **(free)**
2. **Business details.** Check Settings → Business: business name, street address, suburb, postcode, phone, email,
   website, booking link, your Instagram and TikTok handles, and (optionally) opening hours. **(free)**
3. **A web address with HTTPS** for the app. Meta, Square, Google and Postmark only send people back to a secure
   address. The person running the server sets this up.

**Videos and music (Stage B).**

4. **Music you may use for the shop.** If you use a music library, the plan must be a business plan in the
   business's name (not Personal, Social or Creator). Ask the library to confirm in writing that it covers
   Instagram, TikTok, your website and paid boosts. Keep the invoices. Register your accounts in the library's
   safelist page.
5. **Upload tracks honestly.** Settings → Music: fill in the licence form for each track. "I'm not sure" is allowed
   for previews only.
6. **Meta Sound Collection (optional).** Download tracks on a computer while signed in to the shop's Meta account,
   accept the terms, and note the date. Those videos are for Instagram and Facebook only.
7. **TikTok.** Keep the shop's TikTok as a Business Account. Add music from Commercial Sounds inside the TikTok
   app. **(free)**
8. **Spotify (optional).** Paste Spotify links as private references. To see the player instead of plain links,
   publish the legal pages (step 1), read Spotify's Developer Terms and Widget Terms, then switch it on. Spotify
   music never goes into your videos and is not licensed for playing in the shop. **(free)**
9. **Logo (optional).** Upload a transparent PNG (600 px or wider) in Settings → Branding and choose End card, Corner
   mark or Both. **(free)**
10. **AI help (optional).** Create an Anthropic (Claude) account with an API key and a low monthly spending limit
    (for example US$10–20). The person running the server sets `AI_PROVIDER=anthropic` and the key. Tell filmed
    clients that video frames are checked by an overseas AI service.

**Posting (Stage B).**

11. **Posting yourself works today.** Download, copy the caption, post in the app, tap "I've posted it". **(free)**
12. **Instagram direct posting (optional, about 30–60 minutes at a computer).**
    - Make sure the shop's Instagram is a professional account, in a Meta business portfolio you fully control.
    - At developers.facebook.com, create a Business-type app with "Manage messaging & content on Instagram" and
      Facebook Login for Business.
    - Leave it in Development mode.
    - Create one configuration:
      - System-user token, expiry Never (or 60 days)
      - your Instagram account
      - `instagram_basic` and `instagram_content_publish`
    - Add the redirect address `https://<app address>/api/integrations/instagram/callback`.
    - Add the Privacy Policy and Data Deletion addresses from step 1.
    - Give the server person the App ID, the App Secret and the Configuration ID.
    - Then Settings → Integrations → Connect Instagram, and make one real "first verification post" you're happy
      to share.
13. **Instagram hashtag watch (optional).** After step 12, add the hashtag search permission to the same
    configuration, reconnect, and add up to 10 hashtags (Instagram allows 30 different ones a week).
14. **YouTube chart (optional).** In Google Cloud, enable "YouTube Data API v3", create a key restricted to it, and
    give it to the server person as `YOUTUBE_API_KEY`. **(free within the daily quota)**
15. **TikTok automatic posting via Zernio (optional, later).** Create a Zernio account in the business's name and
    connect only TikTok (Business connection, approve every permission). Paste a Zernio API key in Settings →
    Integrations once we switch this on. Posts through Zernio are public immediately.

**Appointments (Stage C).**

16. **Square, sandbox first.**
    - Sign in at developer.squareup.com and create an app called "Studio Assistant".
    - Turn on Appointments in the sandbox test account (a couple of services and a bookable team member).
    - Give the server person the sandbox Application ID and Secret.
    - Add the redirect `https://<app address>/api/integrations/square/callback`.
    - Optionally add the webhook `https://<app address>/api/webhooks/square` (API version 2026-09-16; booking,
      payment and customer events) and give them the signature key.
    - Connect in Settings → Integrations → Square.
    - Repeat with the live values when you're happy.
17. **Changing bookings from the app (optional).**
    - Square says this needs Appointments Plus or Premium. Check the price in your Square Dashboard first; the app
      shows no prices.
    - If you use no-show protection, choose "Flat fee per service" and keep the services you book from the app
      fee-free. With "Flat fee per appointment", app bookings are expected not to work.
    - Then give permission, confirm each fee-free service, run the self-test with yourself as the client, and turn
      the switch on.
    - No-shows, deposits and accepting requests always stay in Square.

**Emails and reviews (Stage C).**

18. **Email domain.** You need your own domain (for example `yourstudio.com.au`) and access to its DNS.
19. **Postmark.**
    - Create a Postmark account. Make a "Studio Assistant" server: Sandbox first, Live later.
    - Add your domain's DKIM and Return-Path records, plus a DMARC record (`p=none`).
    - Request account approval.
    - Add a Broadcast stream next to the Transactional one.
    - Add webhooks (Delivery, Bounce, Spam complaint, Subscription change) to
      `https://<app address>/api/webhooks/postmark` with a long random username and password.
    - Give the server person the server token, the stream IDs, the webhook username and password, and the "from"
      address.
    - Ask before switching to the paid plan.
20. **Square's own messages.** In Square Dashboard, see which messages Square already sends (confirmations,
    reminders, feedback) and tick them in Emails → Automations. The app never sends reminders.
21. **Permission to email.** Record each client's email permission at the counter (Emails → Clients → Record
    permission). Never email anyone to ask for permission. Add the Postmark sentence to your privacy policy.
22. **Google Postmaster Tools.** Register your domain to watch your spam rate. **(free)**
23. **Review link.** On a computer, open your Business Profile → Read reviews → Get more reviews → copy the link →
    paste it in Reviews → Review link. Every client gets the same neutral request. **(free)**
24. **Google rating on the Reviews page (optional).** In Google Cloud: turn on billing, enable "Places API (New)",
    create a key restricted to it (`GOOGLE_MAPS_API_KEY`), and enter your Place ID under Reviews.

**Google sign-in for reviews, search and performance (Stage C).**

25. **One Google Cloud OAuth setup** for both Search Console and Business Profile.
    - Set up the OAuth consent screen with the legal pages from step 1 and **publish it to Production** (in Testing,
      Google signs you out every 7 days).
    - Create a web OAuth client with the redirect `https://<app address>/api/integrations/google/callback`.
    - Give the server person `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
26. **Search Console (optional).**
    - Add your website as a Domain property (a DNS TXT record, up to 48 hours).
    - Enable "Google Search Console API".
    - Connect under Settings → Integrations and choose your site.
27. **Business Profile reviews and numbers (optional, may never be approved).**
    - Your profile must be verified for 60+ days and list your website.
    - Enable the Business Profile APIs and submit Google's "Application for Basic API Access" (about 14 days, not
      guaranteed).
    - Connect under Reviews.

**Website (Stage C).**

28. **First website check.** On the Website page, tick "This is my business's own website" and press Check my
    website. It only reads public pages. **(free)**
29. **WordPress (optional, WordPress sites only).**
    - Create an Editor user called `studio-assistant` and an Application Password for it.
    - Enter your site address, the username and that password in Settings → Integrations → Website editing.
    - Other site builders get copy-paste steps instead.

---

## 8. Costs (Stage B/C additions)

Same conventions as `docs/operating-costs.md`: USD as billed, AUD at an **assumed** 1 USD ≈ 1.50 AUD, GST and card
fees not included, and no paid service is created without the owner's approval. Only figures from the memo
(`platform-constraints.md`) are used; anything else is labelled as an assumption or "no figure".

| Item | Needed for | Figure from the memo | Monthly (assumption stated) |
| --- | --- | --- | --- |
| Postmark | Any email | Free developer plan: 100 emails/month. Basic US$15/month for 10,000 emails, overage US$1.80 per 1,000 (memo §8, search summary) | **US$15 (≈ A$22.50)** once live. *Assumption:* follow-ups + review requests + one campaign stay under 10,000/month (for example 200 + 200 + 300 = 700) |
| Resend (fallback only, not built) | — | Free 3,000/month capped at 100/day; Pro US$20/month for 50,000 (memo §8) | US$0 (not used) |
| Zernio | TikTok automatic posting (optional) | "First 2 accounts free"; US$6/month each for accounts 3–10 (memo §3; unverified, undated pricing page) | **US$0** for one TikTok account, if the free tier still holds |
| Instagram Graph API | Instagram direct posting, hashtag watch | No fee mentioned in the memo; Development mode, no App Review | No figure; *assumed* US$0 |
| Square Appointments | Tier 0 reads | Works on the Free plan, A$0 (memo §6) | A$0 |
| Square Appointments Plus / Premium | Tier 1 booking changes (optional) | A$40 / A$90 per location per month, from a page the search engine flagged as possibly stale (memo §6 and Follow-up 8: **unverified**) | Not shown in the app; the owner checks Square Dashboard before upgrading |
| Google Places API (New) | Google rating and count (optional) | Pro SKU free cap 5,000 calls/month (memo §7); needs a billing account | *Assumption:* about 40 calls/month → within the free cap, **if** the field mask bills as Pro (open question in email §14) |
| Google Business Profile APIs, Search Console API | Reviews list, performance, search data | No price in the memo | No figure; *assumed* US$0 at this volume — confirm |
| YouTube Data API | YouTube chart (optional) | 1 unit per call, default 10,000 units/day (memo §11) | About 1–5 calls/day → within the default quota; no price figure |
| Anthropic Haiku 5.5 — reference-video text estimate | Optional, per reference upload | US$0.10 input / US$0.50 output per MTok; 448 visual tokens per 432×768 frame (memo §10) | ≤ 8 frames ≈ 3.6k image tokens + prompt ≈ 5k input ≈ **US$0.0005 input per reference video**; output tokens are an assumption (small) |
| Anthropic Haiku 5.5 — website wording | Optional, per "Suggest wording" click | Same prices | About US$0.0003 per draft (website design, computed from memo prices) |
| Anthropic — shot labelling (Stage A, for context) | Video analysis | About US$0.01–0.014 per 6-clip project (memo §10; output share assumed) | 20 projects ≈ US$0.20–0.28 (see `operating-costs.md`) |
| Music library (owner's choice) | Licensed music in exports | Soundstripe Pro US$239/yr, Business US$999/yr (paid social for a "local audience"); Personal US$119/yr excludes paid social. Other libraries' prices conflict (memo §2: prices unconfirmed, AUD/GST not checked) | *If* Soundstripe Pro: ≈ US$20/month (≈ A$30). Owner chooses; any business-eligible plan works |
| Spotify, TikTok manual posting, review link, website check, trends (curated/noted) | — | No account or fee | US$0 |
| Extra storage: music-free export variants and covers | Publishing | — | *Assumption:* half of the 2 exports per project also get a `no_music` copy at ≈ 25 MB (the `operating-costs.md` export size): 20 × 25 MB ≈ 0.5 GB/month more, small next to Stage A storage |

**Rejected alternatives for reference:** Ayrshare about US$149/month for one profile (memo §3, third party); Buffer
has no upload endpoint (memo §3).

**Totals (assumptions as above).**

| Scenario | Monthly |
| --- | --- |
| Nothing paid | US$0 extra. Manual posting, review link, website check and trends all work |
| Typical Stage C | Postmark Basic **US$15 (≈ A$22.50)** + Google APIs within free quotas ≈ **US$15/month**, plus the owner's music library subscription if any |
| Optional | Square Plus/Premium (price unverified, check in Square) |

The domain the email needs is not priced in the memo (no figure).

---

## 9. Design edits made by the lead architect (2026-11-14)

Every edited file starts with a "Lead-architect reconciliation" box listing these changes.

**`publishing.md`**

- Reconciliation box added.
- §3.1: `music.ts` changes are built once, by WP1.
- §3.2: eligibility uses `musicClearanceFor`.
- §3.3: the `music_usage` row is written when a target is published, not at approval.
- §3.4: the `no_music` variant is built by WP1.
- §4.1: the caption ending is edited on the Publishing page.
- §5.1: the `publish` feedback event is written on `published`, through `recordFeedback`.
- §5.3: `IntegrationStatus` uses the shared unions.
- §6 jobs table: `webhook.process` is the WP0 dispatcher; the `render.export` re-enqueue goes through WP0's
  export-ready hook.
- §6.2: Reels bitrate limits added (≤ 25 Mbps video, AAC ≤ 128 kbps).
- §7.2: Zernio is built in Stage C (WP10).
- §7.2.5: unverified webhooks are stored under an `unverified:` key.
- §8.1 approve route: no feedback event at approval.
- §13 files: caption-ending card, legal pages to WP0, Studio extension file.
- §14 Q7 marked resolved.

**`preferences-music-trends.md`**

- Reconciliation box added.
- §4.9: "Make a music-free version" is the `no_music` export variant of the same version.
- §4.10: blocked exports offer that variant; clearance and ledger apply only to the standard variant.
- §7 `render.export` row: `variant` added; clearance only for `standard`; export-ready hooks.
- §8.1: the hashtag watch uses the `meta` connection's credential, publishing's Graph client and `mapGraphError`,
  and the same login configuration.
- §9.4: integration status fields use the shared unions; `configured` → `not_connected`, plus `unavailable`.
- §11: token location.
- §12: publishing contract updated (`checkPublishEligibility` on `musicClearanceFor`, `no_music` variant, shared
  fields, credential).
- §15: `plan-facts.ts` and `feedback.ts` come from WP0; no second Graph client.
- §16 Q7 resolved (WP0 legal pages).

**`square-appointments.md`**

- Reconciliation box added.
- §4.7: `isGenuinelyCompleted` → `deriveCompletion` (writes the columns); the reset is to `'none'`; the owner marks
  are the email design's "Mark as completed / Didn't happen".
- §5.3: `square_email_unsubscribed` is created by the WP0 migration; `purgeSquareData` always scrubs.
- §5.4: state and liveMode use the WP0 unions; function renamed.
- §15 Q10 resolved.

**`email-and-reviews.md`**

- Reconciliation box added.
- §3.6:
  - `isGenuinelyCompleted` is in `completion.ts` (WP0) and checks the stored columns.
  - The completion buttons use the Square attendance route.
  - The Square opt-out is a column read by this module, which records the ledger event itself.
- §3.7: `nextSendSlot` is in `time.ts`.
- §8.4: the Google OAuth `product` switch with two rows, built by WP0.
- §9.3: shared status fields.
- §5.2: the two `reviews` statements ship in WP9's migration.
- §13: core and worker file lists (no `zoned-time.ts`; Google OAuth helper from WP0; `business-profile.ts` is WP9).
- §14 Q7 resolved.

**`website-local-search.md`**

- Reconciliation box added.
- §10.5: `liveMode` is `read_only` for Google sources and `staging` for a WordPress staging site (no more reuse of
  `sandbox`).
- §11: the Google OAuth helper and routes come from WP0; the Business Profile parts are WP9.
- §14: reuse list and Performance files moved to WP9; the Google OAuth files belong to WP0.

## 10. Carried forward from G1 (lead, 2026-11-14)

G1 (WP1 music, WP3 trends) is merged. Before G2 started, the lead made these changes on the main branch, so every
later package builds on them:

- **Renderer frame grid (Stage A fix).** Speed-changed beat montages exported a few frames short and failed
  `verifyExport`. `segmentFrameCount` is gone; `quantiseTimeline(timeline, fps)` in
  `packages/media/src/render/video-filters.ts` snaps cut points, segment lengths and `xfade` offsets/durations to the
  frame grid cumulatively, and each segment chain pads with `tpad` before its exact `trim`. Regression test:
  "exports speed-changed hard cuts (a beat montage) at the exact timeline length" in `packages/media/test/render.test.ts`.
  **WP2:** any change to the video graph (logo end card, corner mark) must keep using `quantiseTimeline` for lengths and
  offsets, and keep that test and `verifyExport`'s one-frame duration contract passing. An end card that adds time
  must add it to the plan's timeline, not only to the filtergraph.
- **`NonRetryableError`** in `packages/core/src/errors.ts`. Throw it from a handler for a failure another attempt
  cannot fix: `runTracked` marks the `jobs` row failed with its message on the first attempt, and the worker loop
  completes the pg-boss job instead of retrying. The blocked music export now uses it (its `jobs` row reads failed).
  **WP4:** use it for error 190 → reconnect, licence changed after scheduling, deleted export, and other owner-fixable
  publish failures; keep retries for transient Graph errors and quota (requeue).
- **Music cards in the shared status list.** `buildMusicIntegrations` now returns `musicStatusEntries()`; the WP0
  wording test compares only the Stage A ids.

Requests carried to later packages (each is in that package's Owns list):

- **WP2:**
  - `apps/web/src/lib/uploads.ts` `finishAudio` passes the upload's `genres` to `createLibraryTrack` (today they are
    accepted by `CompleteUploadSchema` and dropped).
  - Add `preferences.musicGenres` and `preferences.musicArtists` (string arrays, default empty) to the
    editing-preferences schema, with "Music taste" fields in Settings → Editing preferences. `musicTasteFrom` in
    `packages/core/src/music-ranking.ts` already reads them when present.
  - `studio-status-shape.ts` `shapeMusicOption` fills `MusicOptionDto.genres`, `moods` and the licence state
    (`licenceStateOf` from core), so the Studio form stops working it out itself.
  - `SettingsPatchSchema` (`settings-merge.ts`) refuses a `music` section with a 400 that names
    `PUT /api/music/references/mode`; the Spotify mode changes only through that route, which applies the embed rules.
- **WP4:** exports are keyed `export:{id}:{variant}`; `edit_versions.variant_exports` holds the `no_music` file;
  `music_usage` rows for publishing use `purpose: 'publish'` and the platform (the unique index is
  `(edit_version_id, purpose, platform)`).
- **WP5:** add `instagram_hashtag` to `TREND_SOURCES` in `apps/worker/src/handlers/trends.ts` (refresher type in
  `apps/worker/src/modules/trends/sources.ts`); `toTrendItemDto` already labels live items with provider
  `instagram_hashtag`; add the hashtag card to `live-signals.tsx` and its entry to `trendSourceStatuses` /
  `buildTrendsIntegrations`. `trend_watches.social_account_id` already exists. `POST /api/trends/watches` with that
  provider returns 422 `UNSUPPORTED` until WP5 lands.
- **Open (no package owns it yet; lead to schedule):** let `ConnectionFacts` carry trend-watch facts in
  `getIntegrationStatuses`, so the `youtube_chart` card in Settings → Integrations shows the chart's real state
  (`youTubeChartStatus(env, watches)` already accepts them).
