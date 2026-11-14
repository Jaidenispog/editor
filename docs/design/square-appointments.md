# Design: Square appointments (Stage C)

Status: **design only, nothing built.** Written 2026-11-14 for the Stage B/C plan (`docs/design/stage-bc-plan.md`).
Area: brief §5, first bullet ("Square"). Related designs: `publishing.md` (shared `webhook.process` job, integration
states, OAuth cookie pattern, worker HTTP/audit helpers, `melbourneLocalToUtc`), the email + reviews design (consumer of
"genuinely completed" and of the "Square sends reminders" rule).

Markers used below:
- **(memo §6)** = `docs/research/platform-constraints.md` section 6 (Square), which supersedes `decisions-summary.md`.
- **(spec)** = re-read on 2026-11-14 from the same official OpenAPI file the memo used
  (`raw.githubusercontent.com/square/connect-api-specification/master/api.json`, Square-Version 2026-09-16) and from the
  published `square@46.0.0` npm package (its `reference.md`, `.d.ts` files and compiled client). These facts are not in
  the memo; they were checked so the implementer does not need to re-research.
- **⚠** = not verified from an official source. Each ⚠ item has a capability check, smoke test or honest UI state.

---

## 1. Goal and scope

Show the studio's real Square Appointments data (bookings, availability, customers, services) inside Studio Assistant.
Square stays the source of truth. Booking changes are offered only when Square's plan, the granted permissions and a
recorded self-test all allow them. Everything else gets a clear deep link to Square.

| Brief requirement (spec §5, §6, §8) | Design element |
| --- | --- |
| Connect the existing Square account | OAuth **code flow** (server holds the secret), owner only, sandbox first; read scopes first, write scopes added only when the owner turns changes on (§4.1, §7.1) |
| Show upcoming bookings | `bookings` mirror filled by `square.sync` (polling) and verified webhooks; Appointments page "Upcoming" tab (§4.2, §9) |
| Show availability | On-demand `square.availability` job → `square_availability_searches` → slot picker (§4.4, §6) |
| Show customers | `customers` mirror (full list on connect, nightly incremental, webhooks); "Customers" tab (§4.2) |
| Show services | Catalogue snapshot (APPOINTMENTS_SERVICE items, bookable team members) with a per-service "can be booked from here" label (§4.3) |
| Create / reschedule / cancel where plan and permissions allow | Tier 1 gate: write scopes + `support_seller_level_writes === true` + fee-free service + passed self-test + owner switch; every change is an owner-approved `square_booking_changes` row processed by `square.booking_change` (§4.5, §6) |
| Re-check availability before changes | `square.booking_change` re-reads the business profile, the service, the booking version and a fresh `SearchAvailability` for the exact slot just before the write (§6.3) |
| Square stays the source of truth | Local rows are only ever overwritten by Square reads; the only local overlay is the owner's attendance mark (§5) |
| Sync through verified webhooks | `POST /api/webhooks/square`: HMAC check on the raw body + exact notification URL, stored once in `webhook_events`, processed by a job that re-fetches from Square (§7.3) |
| Periodic reconciliation | Every-10-minute sync plus a nightly reconcile over 3 × 31-day windows (§6) |
| Show unavailable capabilities clearly | Integration state + Tier 1 checklist in Settings, and "Do this in Square" deep links for no-show marking, deposits, accepting pending requests and fee-bearing services (§4.6) |
| Genuinely completed appointment (for review requests) | `isGenuinelyCompleted()`: Square status ACCEPTED **and** (owner marked attended **or** a COMPLETED Square payment matched to the same customer in the booking window). Labelled as an estimate; never "time passed" alone (§4.7) |
| Times in Australia/Melbourne incl. DST | All instants stored in UTC; displayed with `Intl` in `Australia/Melbourne`; slots are exact instants returned by Square; day ranges computed with DST-safe helpers (§4.8) |
| Do not duplicate reminders Square already sends | This module never sends any message. Booking confirmations and reminders stay with Square; the email module must not create them (§4.9, §12) |
| Sandbox / test vs live | `SQUARE_ENVIRONMENT`, stored per connection and per synced row; "Sandbox — test data" banner everywhere; switching environment purges the other environment's rows (§4.1) |
| Never present simulated data as real | No fake bookings in the app. Fakes exist only in tests. Derived values are labelled "estimate" (§9.3) |
| Audit | `audit_log` entries for connect, disconnect, scope changes, switches, self-test, every booking change and attendance mark (§10) |

**Not in scope** (no speculative features): creating Square customers (needs `CUSTOMERS_WRITE`, see open question 3),
waitlists, classes, resources, booking custom attributes, buyer-level writes (memo §6 says do not build them),
deposits and card-on-file fees, SMS, linking bookings to video projects. The current Appointments placeholder copy that
promises "Open a new video project straight from a booking" is removed (not in the brief).

---

## 2. What the research allows

| Topic | What we may rely on | Source |
| --- | --- | --- |
| Tiers | Tier 0 (reads, webhooks, labelled "attended and paid?" estimate) on any plan; Tier 1 (create/reschedule/cancel) only at runtime when `support_seller_level_writes === true`, for service variations with no no-show fee, after a self-test on the owner's own AU account. Deposits, confirmations, no-show marking and fee-bearing services are never app actions | memo §6 Decision |
| SDK | `square@^46` (Node 18+), `SquareClient`; default Square-Version 2026-09-16 | memo §6 Build notes; npm registry (memo) |
| SDK details | Client options `token`, `environment` (`SquareEnvironment.Production` = `https://connect.squareup.com`, `.Sandbox` = `https://connect.squareupsandbox.com`), `baseUrl`, `timeoutInSeconds` (default 60), `maxRetries` (**default 2**); per-request `abortSignal`. Errors throw `SquareError { statusCode, errors[], body }`. Responses keep unknown fields (`unrecognizedObjectKeys: "passthrough"`), requests strip them. `Money.amount` is `bigint` | spec (SDK 46.0.0 `BaseClient.d.ts`, `environments.d.ts`, `errors/SquareError.d.ts`, compiled client) |
| Polling | `bookings.list` in windows of at most 31 days, reconcile nightly; webhooks only trigger a re-fetch | memo §6 Build notes |
| Statuses | Six read-only statuses: PENDING, ACCEPTED, DECLINED, CANCELLED_BY_CUSTOMER, CANCELLED_BY_SELLER, NO_SHOW. No "completed". Mirror exactly; derived views labelled as inferred, owner can override | memo §6 Build notes + What the sources say |
| Plan gate | CreateBooking, UpdateBooking, CancelBooking with seller-level permissions need Appointments Plus or Premium; no country exception. Reads have no plan requirement | memo §6 sources; Follow-up 8 |
| Runtime flag | `BusinessBookingProfile.support_seller_level_writes` | memo §6 sources |
| Seller-level writes | Need `APPOINTMENTS_WRITE` **and** `APPOINTMENTS_ALL_WRITE`. `APPOINTMENTS_ALL_WRITE` "grants write access to all booking details, **including double-booking a seller**" — so the app must check availability itself | memo §6 Account requirements; spec (securitySchemes, endpoint descriptions) |
| Seller-level create | Booking is ACCEPTED immediately | memo §6 sources (search summary) |
| Payment link | No API field links a booking to a payment or order; a matcher is a heuristic ("80%" anecdote) | memo §6 sources; Decision summary row "Attended and paid" |
| Heuristic shape | COMPLETED payment, same location, window [start − 30 min, end + ~3 h], `customer_id` match, prefer `application_details.square_product == 'APPOINTMENTS'` and order line `catalog_object_id == service_variation_id`, score by matches; owner override persisted | `decisions-summary.md` Square Tier 0 (not contradicted by the memo) |
| Webhooks | `booking.created`/`booking.updated` (need `APPOINTMENTS_READ`, plus `APPOINTMENTS_ALL_READ` at seller level), `payment.*`, `customer.*`; `order.*` is BETA; some missed `booking.created` events reported | memo §6 sources |
| Signature | `x-square-hmacsha256-signature` = base64(HMAC-SHA256(key, notificationUrl + rawBody)); SDK `verifySignature` is async (README omits `await`); SDK compares with `===` | memo §6 sources and Build notes; raw findings (Square uncertainties) |
| Fee classification | "Bookable from Studio Assistant": no variation `no_show_fee` and business `cancellation_fee_money` zero; "Book in Square": variation carries a fee; "Unverified": business-level fee non-zero. `no_show_fee` is **not** in the spec or SDK types, so it cannot be reliably pre-detected | memo §6 Build notes, sources; Follow-up 3; raw findings |
| Write errors | Store any 4xx verbatim; never show a booking as made unless Square confirmed it. The error for a fee-blocked write is undocumented | memo §6 Build notes, Open questions |
| Plan facts | One config record, prices null until verified; no AU price shown as fact | memo §6 Decision + Build notes; Follow-up 8 |
| OAuth | `https://connect.squareup.com/oauth2/authorize`, `POST /oauth2/token` (ObtainToken). **Code flow**: `code`, `client_id`, `client_secret`; refresh token "multi-use and never expires"; access tokens expire in 30 days. PKCE refresh tokens are single-use and expire (so not chosen). `POST /oauth2/token/status` returns `scopes`, `expires_at`, `merchant_id`. `POST /oauth2/revoke` with `Authorization: Client APPLICATION_SECRET` and `{ client_id, merchant_id }` revokes all of the app's tokens for that seller | spec (ObtainToken, RetrieveTokenStatus, RevokeToken, securitySchemes) |
| Availability | `SearchAvailability`: `start_at_range` must be **at least 24 h and at most 32 days**; `booking_id` filter for reschedules (then `location_id`/`segment_filters` cannot be set) | spec (SearchAvailabilityFilter); memo §6 (decisions-summary) |
| ListBookings | `start_at_max` defaults to `start_at_min` + 31 days; filters `location_id`, `customer_id`, `team_member_id`; cursor paging | spec |
| Payments | `ListPayments` filters on `created_at` (`begin_time`/`end_time`), `location_id`, `limit` ≤ 100; Payment has `status`, `customer_id`, `team_member_id`, `order_id`, `application_details.square_product`, `refunded_money`, `total_money` | spec |
| Customers | `customers.list`, `customers.search` (filter `updated_at`), `customers.bulkRetrieveCustomers`; `preferences.email_unsubscribed` is read-only | spec |
| Sandbox | Bookings API works once the sandbox test account is onboarded to Appointments; Plus can be subscribed with a test card; run three no-show set-ups and record real errors before Tier 1 ships | memo §6 Account requirements; decisions-summary Testing |
| App review | A private single-seller app is assumed to need no App Marketplace review ⚠ (standard practice, not re-verified) | memo §6 Account requirements |
| Open contradictions | Whether seller-level cancel covers PENDING bookings is unknown → only ACCEPTED bookings get a Cancel button | memo "Contradictions … remain open" |
| Not documented anywhere we read | Rate limits; webhook retry policy and response deadline; whether Square notifies the client about API-made bookings; Square Dashboard deep-link paths; authorisation-code lifetime; `session=false` authorize parameter | ⚠ handled in §7.5, §4.6, §4.9, §13.3 |

---

## 3. Terms

- **Tier 0** — read-only module: bookings, availability, customers, services, attendance estimate, webhooks.
- **Tier 1** — booking changes from Studio Assistant.
- **Booking change** — one owner-approved create, reschedule or cancel; one `square_booking_changes` row.
- **Attendance** — Studio Assistant's view of whether a past booking happened (`bookings.attendance`), derived from
  Square status, matched payments and the owner's mark. Never written to Square (the API cannot set status).
- **Genuinely completed** — the rule in §4.7, used by review requests and follow-ups.

---

## 4. User flows

### 4.1 Connect Square (owner, Settings → Integrations → Square)

States the owner sees on the Square card (pure function `squareIntegrationState`, §5.4):

| State | When | Card shows |
| --- | --- | --- |
| Not set up | `SQUARE_APPLICATION_ID` or `SQUARE_APPLICATION_SECRET` missing | "Needs setup" + checklist link (§14). Missing variable **names** only |
| Ready to connect | env present, no connection or status `disconnected` | Environment badge ("Sandbox (test)" / "Live"), **Connect Square** button. Staff see "Ask the owner to connect Square" |
| Connected — choose location | connected, more than one active location and none chosen | Location picker (name + suburb) |
| Connected | token valid, location set | Business name, environment badge, "Last synced 3 min ago", webhooks line ("Updates arrive instantly" / "Webhooks not set up — bookings refresh every 10 minutes" / "No webhook received for 3 days — check the subscription"), Tier 1 checklist (§4.5), **Sync now**, **Disconnect** |
| Needs re-authorisation | refresh failed (`UNAUTHORIZED`, `ACCESS_TOKEN_REVOKED`, `ACCESS_TOKEN_EXPIRED`), missing read scopes, environment changed, or a different merchant | Plain reason + **Reconnect Square**. Last synced data stays visible elsewhere, greyed, with "May be out of date" |
| Error | last sync failed for another reason (network, 5xx, rate limit after retries) | `last_error` in plain words + **Try again** |

Steps:
1. Owner presses **Connect Square** → `GET /api/integrations/square/connect?access=read`.
   - Creates a 32-byte random `state`; stores `sha256(state)`, the session id and the requested access level in an
     HttpOnly, SameSite=Lax, 10-minute cookie `sa_oauth_square` (Path `/api/integrations/square`), the same pattern as
     `publishing.md` §7.1.1.
   - Audit `integration.square.connect_started { environment, access }`.
   - 302 to `{authBase}/oauth2/authorize?client_id={SQUARE_APPLICATION_ID}&scope={scopes joined by space}&session=false&state={state}&redirect_uri={APP_URL}/api/integrations/square/callback`.
     `authBase` = `https://connect.squareup.com` (production) or `https://connect.squareupsandbox.com` (sandbox).
     `session=false` ⚠ (Square OAuth docs, not in memo/spec; the sandbox smoke test confirms it is accepted).
2. Owner signs in to Square and approves the listed permissions.
3. `GET /api/integrations/square/callback?code&state` (owner session required):
   - Timing-safe check of the state cookie; clear it. `error=access_denied` → Settings with "Square connection was cancelled. Nothing was changed."
   - **Code exchange inline** (codes are short-lived ⚠; one call, 10 s timeout, no retry), plain `fetch`:
     `POST {authBase}/oauth2/token` `{ client_id, client_secret, code, grant_type: 'authorization_code', redirect_uri }`
     → `{ access_token, refresh_token, expires_at, merchant_id }`.
   - **Environment / merchant guard.** If an existing connection row has a different `config.environment` or
     `external_account_id`, delete that environment's/merchant's mirrored rows first (`purgeSquareData`, §5.3) and
     write audit `integration.square.data_purged`.
   - Encrypt both tokens (`encryptToken`), upsert `integration_connections` (provider `square`, status `connected`,
     `external_account_id = merchant_id`, `token_expires_at`, `config.environment = SQUARE_ENVIRONMENT`).
   - Audit `integration.square.connected { environment, merchantId, access }` (never tokens).
   - Enqueue `square.sync { reason: 'connect' }`. Redirect to `/settings?tab=integrations&checking=square`.
4. Settings polls the job; the card shows "Fetching your bookings, customers and services from Square…" with job
   progress, then the Connected state. If the job finds missing read scopes (token status), the state becomes
   Needs re-authorisation with "Square didn't grant all the read permissions Studio Assistant needs".

**Disconnect** (`DELETE /api/integrations/square`, owner, typed confirmation in the dialog):
- Body `{ purgeData: boolean }` (dialog default: ticked "Also remove synced bookings and client details from Studio Assistant").
- Sets tokens to null, status `disconnected`, writes audit `integration.square.disconnected`, enqueues
  `square.revoke { merchantId, environment }` (revocation needs only the app secret, so no token is kept), and, if
  `purgeData`, runs `purgeSquareData` in the same transaction.
- Pending booking changes (`queued`) become `cancelled` with "Square was disconnected".
- Copy: "Studio Assistant can no longer read or change your Square bookings. Your bookings in Square are not affected."

**Sandbox vs live.** `SQUARE_ENVIRONMENT` (existing env, default `sandbox`) decides the hosts. In sandbox every page
that shows Square data has an amber banner: "Sandbox — these are Square test bookings and test clients, not real ones."
Changing the env var while connected makes the state Needs re-authorisation ("Studio Assistant is now set to live
Square. Reconnect to load your real bookings; the test data will be removed.").

### 4.2 Viewing bookings and customers (owner and staff)

`/appointments` (tabs; mobile: segmented control):
- **Upcoming** (default): grouped by Melbourne day ("Today · Sat 14 Nov", "Tomorrow", …) for the next 31 days; each
  card shows time range ("10:30–11:15 am"), client name, service, barber, Square status badge and, for non-ACCEPTED
  statuses, a plain explanation. PENDING cards say "Waiting for you to accept — do this in Square" with a deep link.
- **To confirm**: past ACCEPTED bookings from the last 14 days whose attendance is not settled (awaiting payment,
  possible match, no payment matched). Each card has **Attended** / **Didn't attend** buttons and the evidence label.
- **Past**: last 90 days, read-only, with attendance labels.
- **Clients**: search by name, email or phone over the local mirror; client detail lists their bookings. Email and
  phone are shown to the owner only (staff see names).
- **Services**: services, durations, prices (AUD via `formatCurrencyAud`), bookable barbers, the "Bookable here / Book
  in Square / Not confirmed" label (§4.3), and an availability finder (§4.4).

Header strip (all tabs): environment badge, "Synced 3 min ago" (from `last_sync_at`), **Refresh** (owner; enqueues
`square.sync { reason: 'manual' }`), and the Tier 1 summary ("Changes from here: on/off/not available — why").

Empty and error states:
- Not set up / not connected: existing `SectionOverview` with updated requirements and a Connect button for the owner.
- First sync running: skeleton list + "Fetching your bookings from Square…".
- Connected, no bookings in range: "No bookings in the next 31 days in Square."
- Sync stale (connected but last successful sync older than 30 min): warning "Bookings may be out of date — last
  synced at 9:42 am." + Refresh.
- Needs re-authorisation / error: the data stays visible with "May be out of date" and the reason; nothing is hidden or
  invented.

Booking detail (dialog, `?booking=<id>` for deep linking): all fields above, customer note and seller note (owner
only), "Created in: Square / online booking / Studio Assistant" from `source` / `creator_details`, attendance evidence
with its label, change history (from `square_booking_changes`), actions allowed for this booking, and "Open in Square".

### 4.3 Services and the per-service label

From the catalogue snapshot (§6.2). Each service variation gets `classifyVariation()` (pure, §5.4):

| Label | Rule | Owner sees |
| --- | --- | --- |
| `book_in_square` | the variation JSON carries a non-zero `no_show_fee` (read from the SDK's passthrough fields), **or** a previous API write for this variation was rejected with a fee-related or unexplained 4xx | "Book in Square — this service has a no-show fee, which Square doesn't allow apps to book." |
| `unverified` | business-level `cancellation_fee_money` is non-zero (per-appointment fee mode, memo Follow-up 3) | "Not available from here — your Square no-show fee applies to every appointment. Book in Square." |
| `not_bookable` | `available_for_booking` false, item archived, or no bookable team member | "Not open for booking in Square." |
| `needs_confirmation` | none of the above, but the owner has not confirmed it (the spec cannot show per-service fees, so absence of `no_show_fee` proves nothing) | "Confirm in Square that this service has no no-show fee" + **I've checked: no no-show fee** (owner) |
| `bookable` | none of the above **and** owner confirmed at the current variation `version` | "Bookable from Studio Assistant" |

The owner's confirmation is stored with the variation `version`; a new version (price, duration or fee edits in
Square) resets it to `needs_confirmation`. Audit `integration.square.service_confirmed`.

### 4.4 Availability (owner and staff)

1. Owner/staff picks a service, optionally a barber, and a start date + span (1–14 days; default 7).
2. `POST /api/appointments/availability` creates a `square_availability_searches` row and enqueues
   `square.availability`. The UI shows "Checking Square for free times…" and polls every 1 s (max 30 s).
3. Results: slots grouped by Melbourne day, each "10:30 am · Sam", from `fetched_at`. Copy: "Free times from Square
   at 10:02 am. Times can be taken at any moment; Studio Assistant checks again before booking."
4. Failure: "Square didn't answer. Try again." Results older than 5 minutes are shown greyed with **Check again**.

Availability is read-only and available in Tier 0. Square's search returns "buyer-accessible" availability (spec), so
it follows the studio's online-booking rules (lead times, hours). The finder says so: "Same times your clients see
online."

### 4.5 Turning on changes from Studio Assistant (Tier 1, owner)

Settings → Integrations → Square → "Booking changes from Studio Assistant" checklist, each line with a tick, cross or
"not checked yet" and a plain explanation:

1. **Square plan allows it** — `support_seller_level_writes === true` from the last sync. Cross: "Your Square
   Appointments plan doesn't allow apps to change bookings. Square says Appointments Plus or Premium is required.
   Check the current price in your Square Dashboard before upgrading." Plan prices come from `SQUARE_PLAN_FACTS`
   (all null until verified, memo §6) and are therefore **not shown**.
2. **Permission to change bookings** — token scopes include `APPOINTMENTS_WRITE` and `APPOINTMENTS_ALL_WRITE`.
   Cross → **Give permission** = `GET /api/integrations/square/connect?access=write` (same OAuth flow with the write
   scopes added; audit `integration.square.scopes_upgraded`).
3. **At least one bookable service** — any variation `bookable` (§4.3).
4. **Self-test passed** (this environment, this Square account) — §4.5.1.
5. **Switch: "Allow booking changes from Studio Assistant"** — default off; enabled only when 1–4 are ticks. Audit
   `integration.square.writes_enabled` / `writes_disabled`.

If any of 1–4 later becomes false (sync sees the flag drop, a write returns 403 / `MERCHANT_SUBSCRIPTION_NOT_FOUND`
/ `INSUFFICIENT_SCOPES`), the worker sets `capabilities.writesSuspendedReason`, the switch shows "Paused: <reason>",
and the Appointments page hides change buttons (memo §6: "on a 403 from a write, flip the module to read-only").

#### 4.5.1 Self-test (owner-approved, never automatic)

The brief forbids live booking changes "to test a connection", so the self-test is an explicit owner action with its
own confirmation, and it is never run by a job, a sync or a connect.

1. Owner presses **Run self-test** (enabled when checklist items 1–3 are ticks).
2. Dialog asks for: a client (search the mirror; copy recommends choosing **yourself**), a `bookable` service, a barber,
   and a free slot (§4.4) at least 2 days ahead.
3. Summary shown before approval, live mode wording:
   "This makes **three real changes** in your Square account: book <client> for <service> with <barber> on
   <Sat 21 Nov, 10:30 am AEDT>, move it by one free slot, then cancel it. Square may send that client its own
   confirmation and cancellation messages. Choose yourself as the client to avoid messaging a real customer."
   Sandbox wording: "This makes three changes in your Square sandbox (test) account."
4. Owner ticks "I understand these are real bookings in Square" (live only) and presses **Run self-test**.
5. `POST /api/integrations/square/self-test` → creates a `selfTestId` and the first change row; enqueues
   `square.self_test`. Steps run as normal booking changes (§6.3), each flagged `self_test_id`.
6. Progress: "Booking… ✓ Moving… ✓ Cancelling… ✓". Result stored in `capabilities` (§5.2).
7. Afterwards (live only) the card asks: "Did <client> receive a confirmation from Square for the test booking?
   Yes / No / Not sure" → `capabilities.squareNotifiesApiBookings` (used in §4.9 copy).
8. Failure at any step: stores Square's response verbatim, marks the test failed with the step and plain reason; if the
   create succeeded but a later step failed, the card says "A test booking may still be in Square for <time>. Cancel
   it in Square." with a deep link. Audit `integration.square.self_test_requested` / `passed` / `failed`.

### 4.6 Making a booking change (owner only, Tier 1 enabled)

Buttons appear only when `tier1Ready` (switch on, not suspended) **and** the specific booking/service allows it:

| Action | Where | Allowed when | Otherwise |
| --- | --- | --- | --- |
| **New booking** | Appointments header, Services availability results | service `bookable`, client in mirror | "Book in Square" link with the reason |
| **Move** | booking detail | Square status ACCEPTED, start in the future, service `bookable` | reason + "Open in Square" |
| **Cancel** | booking detail | status ACCEPTED, start in the future | PENDING: "Accept or decline in Square" |
| Mark no-show, deposits, accept/decline PENDING, fee-bearing services, notes for the client's confirmation | — | never (no API, memo §6) | "Do this in Square Appointments" + deep link + one-line instruction |

Flow (create; move and cancel are the same shape):
1. Pick client → service → barber (or any) → slot from a fresh availability search (§4.4).
2. Confirmation dialog: "Book **Jordan Lee** for **Skin fade (45 min)** with **Sam** on **Sat 21 Nov, 10:30–11:15 am
   (AEDT)**. This creates a real booking in Square." Plus the §4.9 notification sentence. Optional "Note for the
   studio (not shown to the client)" → `seller_note` (max 4,096, spec).
3. **Book in Square** → `POST /api/appointments/changes` → change row `queued` → `square.booking_change`.
4. Live progress (poll `GET /api/appointments/changes/[id]` every 1 s): "Checking the time is still free…" →
   "Sending to Square…" → one of:
   - **Booked in Square** ✓ (only after Square returned the booking; the booking card appears from Square's data).
   - **That time was just taken** — shows fresh slots from the re-check; nothing was sent.
   - **The booking changed in Square** (version differs) — "Someone changed this booking in Square. Here is the latest; try again if you still want to move it."
   - **Not allowed by Square** — Square's message verbatim under a plain summary; module may be paused (§4.5).
   - **Couldn't confirm with Square** (timeout/5xx after sending, retries exhausted) — "Square may or may not have made this change. Check Square before trying again." The next sync settles it; the row moves to `confirmed` if Square shows the change (matched by booking id or, for creates, by start/customer/team member).

Deep links (⚠ paths not documented; constants in `packages/core/src/square.ts`, verified during owner setup and
editable there): production `https://app.squareup.com/dashboard/` and sandbox: open the Sandbox Dashboard from the
Developer Console. Every link carries a one-line instruction ("Appointments → Calendar → open the booking → Mark as
no-show"). The location's documented `booking_site_url` (LocationBookingProfile, spec) is shown as "Your Square
online booking page".

### 4.7 Attendance and "genuinely completed"

Square has no completed status and no booking-to-payment link (memo §6). Studio Assistant therefore keeps an
**estimate** and the owner's word, never a fact it does not have.

`bookings.attendance` (derived by `deriveAttendance()`, pure, §5.4):

| Value | Condition | Label shown |
| --- | --- | --- |
| `upcoming` | end in the future, status ACCEPTED | — |
| `pending` | status PENDING | "Waiting for acceptance in Square" |
| `cancelled` / `declined` / `no_show` | Square status | "Cancelled by client" / "Cancelled by studio" / "Declined" / "No-show (from Square)" |
| `awaiting_payment` | ACCEPTED, ended < 7 days ago, no match yet | "Finished? Waiting for a Square payment" |
| `payment_matched` | strong payment match (below) | "Paid — matched to a Square payment (estimate)" with confidence high/medium |
| `possible_match` | only weak evidence (payment in window without the same customer, or a payment that could belong to two bookings) | "Possible payment found — please confirm" |
| `no_payment_matched` | ACCEPTED, ended ≥ 7 days ago, no strong match | "No payment found — did they attend?" |
| `owner_attended` / `owner_not_attended` | owner/staff mark (wins over the estimate, not over Square NO_SHOW/cancel) | "Attended — marked by Sam, 14 Nov" / "Didn't attend — marked by …" |

**Payment matching** (`matchPayments(bookings, payments, orders)`, pure):
- Candidates: Square payments with `status === 'COMPLETED'`, same `location_id`, `created_at` within
  [start − 30 min, end + 3 h], and `refunded_money < total_money` (memo-derived window; refund rule is ours).
- **Strong** = `payment.customer_id === booking.square_customer_id` (required) → `payment_matched`. Confidence
  **high** if at least one of: `application_details.square_product === 'APPOINTMENTS'`, `team_member_id` equal, or an
  order line item `catalog_object_id` equal to the booking's `service_variation_id`; otherwise **medium**.
- **Weak** = no customer match but time window plus team member or service match → `possible_match`.
- Each payment is assigned to at most one booking: the booking with the highest score; on a tie the earliest start
  wins and the other bookings become `possible_match`.
- Evidence stored in `bookings.attendance_evidence`: `{ paymentId, score, signals: string[], confidence, matchedAt }`.
  Never the card details.

**`isGenuinelyCompleted(booking, now)`** (pure, exported from core for the reviews/email designs):

```ts
status === 'ACCEPTED'
&& endAt <= now
&& missingFromSquareAt === null
&& ownerAttendance !== 'not_attended'
&& (ownerAttendance === 'attended' || attendance === 'payment_matched')
```

- The worker writes `completed_at` (first time it becomes true) and `completion_source` (`owner_marked` or `payment`);
  it clears both when it becomes false again (Square later says NO_SHOW or cancelled, payment fully refunded, owner
  marks "didn't attend", booking disappears). `completion_source = 'square_status'` is never used (Square has no
  completed status).
- Time passing alone never qualifies. A booking with no evidence stays `awaiting_payment` / `no_payment_matched`
  until the owner marks it.
- Owner mark on a booking Square shows as NO_SHOW or cancelled is refused: "Square says this was a no-show. Change it
  in Square first." If Square changes after an owner mark, Square wins and the card says so.
- Marks are allowed for owner and staff (audit `booking.attendance_marked { value, previous }`), and can be cleared.

### 4.8 Time zone rules (Australia/Melbourne incl. DST)

- Storage: every instant is `timestamptz` (UTC). Square sends RFC 3339 strings; parse with `new Date()` only after
  checking the format; never parse local strings.
- Display: `formatDateTime` / `Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne' })`; time ranges with
  the zone abbreviation on dialogs that change bookings ("10:30 am AEDT").
- Bookings are only ever created or moved to a **slot instant returned by Square**, so no local-time conversion
  happens on writes, and no ambiguous or skipped time can be chosen.
- Day grouping and ranges: `melbourneDayRange('YYYY-MM-DD')` = [`melbourneLocalToUtc(date,'00:00')`,
  `melbourneLocalToUtc(date+1,'00:00')`) (shared helper from `publishing.md`; midnight always exists in Melbourne
  because transitions are at 2–3 am). Days are 23, 24 or 25 hours long.
- `SearchAvailability` needs ≥ 24 h: `availabilityRange(fromDate, days)` returns the Melbourne range and, if it is
  shorter than 24 h (a single 23-hour DST day), extends the end to start + 24 h; slots outside the requested Melbourne
  dates are filtered out after the call. Maximum 14 days (< 32-day limit).
- The location's Square `timezone` is read at sync; if it is not `Australia/Melbourne` the Settings card warns "Your
  Square location is set to <zone>. Studio Assistant shows Melbourne time." (no conversion games).

### 4.9 Reminders and messages

- This module **sends no email, SMS or notification**. Square sends booking confirmations and reminders according to
  the studio's Square settings (Plus adds client confirmation texts and emails per the AU pricing summary, memo §6 raw
  findings ⚠).
- Contract for the email design: it must not create booking confirmations or reminders for Square bookings; its
  appointment follow-ups start only from `completed_at` (§4.7).
- Whether Square notifies the client when **an app** creates, moves or cancels a booking is undocumented ⚠. The
  change dialog uses `capabilities.squareNotifiesApiBookings` from the self-test question: `yes` → "Square will send
  its usual confirmation."; `no` → "Square didn't send a confirmation for the test booking, so let the client know
  yourself."; `unknown` → "Square decides whether the client is notified."

---

## 5. Data model

### 5.1 Existing tables used

| Table | Use |
| --- | --- |
| `integration_connections` (provider `square`) | Encrypted access and refresh tokens, `token_expires_at`, `scopes` (from token status), `external_account_id` (merchant id), `status`, `config` (§5.2), `capabilities` (§5.2), `last_sync_at`, `last_error` |
| `bookings` | Mirror of Square bookings (+ additive columns, §5.3) |
| `customers` | Mirror of Square customers (+ additive columns). Consent columns belong to the email design and are **never** set from Square data |
| `webhook_events` | Square deliveries, stored once per `(provider='square', external_event_id=event_id)` |
| `audit_log` | §10 |
| `jobs` | UI mirror of the new job types (`project_id` null; `ref_id` = change id, search id or booking id) |

### 5.2 JSON contracts (Zod in `packages/core/src/square.ts`; no SQL)

`integration_connections.config` for provider `square` → `SquareConnectionConfigSchema`:
```ts
{
  environment: 'sandbox' | 'production',
  locationId: string | null,                    // chosen location
  snapshot: {
    fetchedAt: string,
    merchantName: string,
    locations: { id, name, timezone, status, bookingSiteUrl: string | null }[],
    businessProfile: { bookingEnabled, bookingPolicy, allowUserCancel, supportSellerLevelWrites: boolean,
                       cancellationWindowSeconds: number | null, cancellationFee: { amount: string, currency: string } | null,
                       cancellationPolicy: string | null, minLeadSeconds: number | null, maxLeadSeconds: number | null } | null,
    teamMembers: { id, displayName, isBookable }[],
    services: { itemId, itemName, variationId, variationName, version: string, durationMinutes, price: { amount: string, currency } | null,
                availableForBooking, teamMemberIds: string[], archived: boolean, noShowFeeSeen: { amount: string, currency } | null }[],
  } | null,
  serviceConfirmations: Record<variationId, { version: string, confirmedBy: string, confirmedAt: string }>,
  serviceWriteRejections: Record<variationId, { changeId: string, code: string, at: string }>,
  lastWebhookAt: string | null,
  customersSyncedAt: string | null,             // incremental customer sync watermark
}
```
`version` and money amounts are strings (Square uses int64; the SDK returns `bigint`).

`integration_connections.capabilities` (type stays `Record<string, boolean | string>`; widened like publishing to
allow `null`/number if needed):
`readScopesOk`, `writeScopesOk`, `sellerLevelWrites` (from profile), `writesEnabled` (owner switch),
`writesSuspendedReason` (`''` or a code: `plan`, `scopes`, `forbidden`, `env_changed`), `selfTestStatus`
(`none|running|passed|failed`), `selfTestId`, `selfTestAt`, `selfTestEnvironment`, `selfTestMerchantId`,
`selfTestFailure`, `squareNotifiesApiBookings` (`yes|no|unknown`). The self-test counts only when
`selfTestEnvironment` and `selfTestMerchantId` equal the current connection.

`SQUARE_PLAN_FACTS` constant (memo §6 "one config record with prices null"):
`{ free: { label: 'Free', audPerLocationMonthly: null, writesViaApi: false }, plus: { label: 'Plus', audPerLocationMonthly: null, writesViaApi: true }, premium: { …, writesViaApi: true }, verifiedAt: null, source: 'memo §6, search summary' }`.

TS-only enum changes: `integration_connections.status` adds `'disconnected'` (shared with `publishing.md` §5.2).

### 5.3 Additive schema changes (one migration `packages/db/drizzle/00NN_square.sql`, `drizzle-kit generate`)

**`bookings`**

| Column / index | SQL | Why |
| --- | --- | --- |
| Environment | `ADD COLUMN square_environment text NOT NULL DEFAULT 'sandbox'` | Filter and purge per environment (no rows exist yet; code always sets it) |
| Square customer id | `ADD COLUMN square_customer_id text` | Keep the link when the customer row isn't mirrored yet |
| End time | `ADD COLUMN end_at timestamptz` (set on every upsert = start + sum of segment durations) | Range queries, matching window |
| Square timestamps | `ADD COLUMN square_updated_at timestamptz` | Ignore stale reads (apply only if `version` ≥ stored) |
| Attendance | `ADD COLUMN attendance text NOT NULL DEFAULT 'upcoming'` | §4.7 |
| Evidence | `ADD COLUMN attendance_evidence jsonb NOT NULL DEFAULT '{}'::jsonb` | §4.7 |
| Owner mark | `ADD COLUMN owner_attendance text` (`attended`/`not_attended`), `ADD COLUMN owner_attendance_by text REFERENCES users(id) ON DELETE SET NULL`, `ADD COLUMN owner_attendance_at timestamptz` | Override, persisted (memo §6 decisions-summary) |
| Missing | `ADD COLUMN missing_from_square_at timestamptz` | Square returns NOT_FOUND for a booking we hold |
| Indexes | `CREATE INDEX bookings_end_idx ON bookings(end_at)`; `CREATE INDEX bookings_attendance_idx ON bookings(attendance, end_at)`; `CREATE INDEX bookings_env_start_idx ON bookings(square_environment, start_at)` | Lists, matching, attendance sweep |

Existing `status` keeps Square's value verbatim; `completion_source`/`completed_at` are written as in §4.7; `raw` holds
the last Square booking JSON (snake_case as returned).

**`customers`**

| Column | SQL |
| --- | --- |
| `square_environment` | `ADD COLUMN square_environment text` (null for customers created locally by other modules) |
| `square_version` | `ADD COLUMN square_version integer` |
| `square_synced_at` | `ADD COLUMN square_synced_at timestamptz` |
| `square_email_unsubscribed` | `ADD COLUMN square_email_unsubscribed boolean` — Square's read-only marketing opt-out (spec `CustomerPreferences`); the email design may treat `true` as an extra suppression, **never** `false`/null as consent |

**New table `square_booking_changes`**

```sql
CREATE TABLE square_booking_changes (
  id text PRIMARY KEY,
  kind text NOT NULL,                       -- 'create' | 'reschedule' | 'cancel'
  environment text NOT NULL,                -- 'sandbox' | 'production'
  booking_id text REFERENCES bookings(id) ON DELETE SET NULL,
  square_booking_id text,                   -- known for reschedule/cancel; filled after create
  request jsonb NOT NULL,                   -- what the owner approved (see below)
  idempotency_key text NOT NULL,            -- sent to Square; stable across retries
  status text NOT NULL DEFAULT 'queued',    -- queued|checking|submitted|confirmed|slot_unavailable|changed_in_square|not_allowed|rejected|unknown|cancelled
  status_message text NOT NULL DEFAULT '',
  http_status integer,
  error_code text,                          -- Square errors[0].code, verbatim
  square_response jsonb,                    -- Square's body verbatim (success or 4xx), memo §6
  fresh_slots jsonb,                        -- alternatives found by the re-check
  self_test_id text,
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz,                 -- set immediately before the write call
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX square_booking_changes_idem_idx ON square_booking_changes(idempotency_key);
CREATE INDEX square_booking_changes_booking_idx ON square_booking_changes(booking_id, created_at);
CREATE INDEX square_booking_changes_status_idx ON square_booking_changes(status, created_at);
CREATE INDEX square_booking_changes_selftest_idx ON square_booking_changes(self_test_id);
```
`request` (Zod `BookingChangeRequestSchema`): `{ locationId, squareCustomerId?, serviceVariationId?, serviceVariationVersion?,
teamMemberId?, durationMinutes?, startAt?, expectedVersion?, sellerNote?, availabilitySearchId? }`.
`idempotency_key` = `sabc_<id>` (≤ 255 chars, spec). Never contains tokens.

**New table `square_availability_searches`**

```sql
CREATE TABLE square_availability_searches (
  id text PRIMARY KEY,
  environment text NOT NULL,
  params jsonb NOT NULL,                    -- { serviceVariationId, teamMemberId|null, fromDate:'YYYY-MM-DD', days, bookingId|null }
  status text NOT NULL DEFAULT 'queued',    -- queued|running|done|failed
  slots jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ startAt, teamMemberId, durationMinutes, serviceVariationId, serviceVariationVersion }]
  error text,
  fetched_at timestamptz,
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX square_availability_searches_created_idx ON square_availability_searches(created_at);
```
Rows older than 24 h are deleted by the existing hourly `maintenance.cleanup`.

**`purgeSquareData(db, { environment?, merchantId? })`** (packages/db helper, one transaction): deletes
`square_availability_searches` and `square_booking_changes` of that environment, deletes `bookings` of that
environment, and for `customers` of that environment either deletes them or, when another module references them
(email messages, review requests, consent rows), scrubs `square_customer_id`, names, email and phone and sets
`deleted_at`. Writes audit `integration.square.data_purged { environment, bookings, customers }`.

### 5.4 Pure functions (`packages/core/src/square.ts`, unit tested)

- `squareScopes(access: 'read' | 'write'): string[]` — read: `APPOINTMENTS_READ, APPOINTMENTS_ALL_READ,
  APPOINTMENTS_BUSINESS_SETTINGS_READ, CUSTOMERS_READ, ITEMS_READ, MERCHANT_PROFILE_READ, PAYMENTS_READ, ORDERS_READ`
  (memo §6); write adds `APPOINTMENTS_WRITE, APPOINTMENTS_ALL_WRITE`.
- `squareIntegrationState(envPresent, connection, now)` → `{ state: 'not_configured'|'not_connected'|'connected'|'needs_reauth'|'error', liveMode: 'sandbox'|'live'|null, needsLocation, stale, webhooks: 'off'|'ok'|'quiet', tier1: Tier1Status }`.
- `tier1Status(connection, snapshot)` → `{ ready: boolean, checklist: { plan, scopes, bookableService, selfTest, switch }: 'ok'|'missing'|'unknown', suspendedReason }`.
- `classifyVariation(service, businessProfile, confirmations, rejections)` → §4.3 label.
- `mapBookingStatus(status)` → plain label + tone (unknown values pass through as "Square status: X").
- `deriveAttendance(booking, now)` and `isGenuinelyCompleted(booking, now)` → §4.7.
- `matchPayments(bookings, payments, orderLines)` → assignments with evidence.
- `availabilityRange(fromDate, days)` and `melbourneDayRange(date)` (in `time.ts`).
- `mapSquareError(err)` → `{ kind: 'reauth'|'not_allowed'|'conflict'|'invalid'|'rate_limited'|'transient'|'not_found', code, message }` (§7.5).

---

## 6. Jobs

New `JOB_TYPES` in `packages/core/src/jobs.ts`, `QUEUE_SETTINGS` in `packages/queue`, `refIdFor`/`defaultRefId`
cases in both `apps/worker/src/lib/jobs.ts` and `apps/web/src/lib/jobs.ts`. Every handler:
- loads the `square` connection; if it is not `connected`, or `config.environment !== env.SQUARE_ENVIRONMENT`, it
  records a plain message and **completes** without calling Square (nothing to retry);
- builds the client with `createSquareClient(ctx, connection)` (§7.2), which refreshes the token first if it expires
  within 3 days;
- passes `run.signal` as `abortSignal` on every call;
- is idempotent: upserts by Square id, writes only when the incoming `version` ≥ stored (bookings) or
  `updated_at` newer (customers).

| Type | Payload (zod) | singletonKey / dedupe | Retries; expiry | Does |
| --- | --- | --- | --- | --- |
| `square.sync` | `{ reason: z.enum(['connect','schedule','manual','reconcile']) }` | `square-sync` (queue policy `stately`: one queued + one active) | 3, 30 s backoff; 15 min; hb 60 s | 1) `oAuth.retrieveTokenStatus` → scopes, expiry (connect/manual/reconcile only). 2) Snapshot (connect/manual/reconcile, or older than 6 h): `merchants.get`, `locations.list`, `bookings.getBusinessProfile`, `bookings.locationProfiles.list`, `bookings.teamMemberProfiles.list`, `catalog.searchItems({ productTypes: ['APPOINTMENTS_SERVICE'] })`. Updates `capabilities` (`sellerLevelWrites`, scope flags, suspension). 3) Bookings: `bookings.list({ locationId, startAtMin, startAtMax })` — schedule/manual: [now − 2 h, now + 31 d); connect/reconcile: [now − 31 d, now + 62 d) as three ≤ 31-day windows. Upsert, derive attendance. 4) Reconcile only: bookings we hold in the window but Square did not return → `bookings.get`; NOT_FOUND → `missing_from_square_at`. 5) Customers: connect → full `customers.list` (cursor, 100/page); otherwise `customers.search` with `filter.updatedAt.startAt = customersSyncedAt − 1 day`; plus `bulkRetrieveCustomers` for booking customer ids not yet mirrored (≤ 100 per call). 6) Enqueue `square.attendance`. Sets `last_sync_at`, clears `last_error`. Cron `*/10 * * * *` (`schedule`) and `47 2 * * *` (`reconcile`), Melbourne tz |
| `square.refresh` | `{ entity: z.enum(['booking','customer','payment']), squareId: z.string().max(192) }` | `square-refresh:{entity}:{squareId}` | 5, 10 s backoff; 2 min | booking → `bookings.get` → upsert (+ customer) → attendance for it; customer → `customers.get` (NOT_FOUND → scrub as deleted); payment → `payments.get` → if `customer_id`, enqueue `square.attendance` for that customer's bookings in [created_at − 3 h − longest service, created_at + 30 min] |
| `square.attendance` | `{ squareCustomerId?: string, fromIso?: string, toIso?: string }` | `square-attendance:{squareCustomerId ?? 'all'}` | 3, 30 s; 10 min | Candidate bookings: ACCEPTED, `end_at` in [now − 7 d, now] (default) without an owner mark, plus bookings currently `payment_matched` in that range (to catch refunds). `payments.list({ locationId, beginTime, endTime, sortOrder: 'ASC', limit: 100 })` over the windows' union; `orders.batchGet` (≤ 100 ids) only for payments with an `order_id` that are candidates. `matchPayments` → update `attendance`, evidence, `completed_at`/`completion_source`. Cron `*/30 * * * *` |
| `square.availability` | `{ searchId: z.string() }` | `square-availability:{searchId}` | 1, 5 s; 2 min | `bookings.searchAvailability({ query: { filter: { startAtRange, locationId, segmentFilters: [{ serviceVariationId, teamMemberIdFilter: teamMemberId ? { any: [teamMemberId] } : undefined }] } } })` or, for a reschedule, `filter: { startAtRange, bookingId }`. Filters to requested Melbourne dates; writes `slots`, `fetched_at`, `status` |
| `square.booking_change` | `{ changeId: z.string() }` | `square-change:{changeId}`; authoritative guard = conditional update (§6.3) | 2, 20 s backoff, transient only; 5 min | §6.3 |
| `square.self_test` | `{ selfTestId: z.string() }` | `square-self-test:{selfTestId}` | 0; 10 min | Runs create → reschedule → cancel by calling the §6.3 routine directly for each step (step rows are created up front, so a crash resumes at the first non-final step). Writes `capabilities.selfTest*` |
| `square.token_refresh` | `{}` | `square-token-refresh` | 3, 5 min; 2 min | Daily cron `13 3 * * *`: if `token_expires_at − now < 23 days` (≈ weekly refresh), `oAuth.obtainToken({ clientId, clientSecret, grantType: 'refresh_token', refreshToken })` → store new access token + expiry (code flow returns the same refresh token, spec). `UNAUTHORIZED`/`ACCESS_TOKEN_REVOKED`/`CLIENT_DISABLED`/`APPLICATION_DISABLED` → `needs_reauth`, audit `integration.square.needs_reauth` |
| `square.revoke` | `{ merchantId: z.string(), environment: z.enum(['sandbox','production']) }` | `square-revoke:{merchantId}` | 3, 60 s; 2 min | `POST {base}/oauth2/revoke` `{ client_id, merchant_id }` with `Authorization: Client {SQUARE_APPLICATION_SECRET}` (spec). Result in audit `integration.square.revoked` / `revoke_failed` (the UI then tells the owner to remove the app in Square's "App integrations" ⚠) |
| `webhook.process` (shared, `publishing.md` §6) | `{ webhookEventId }` | `webhook:{webhookEventId}` | 5, 10 s; 2 min | `provider === 'square'` branch, §7.3 |

### 6.1 Worker additions

- `apps/worker/src/main.ts`: register the handlers (concurrency 1 each), schedule the three crons, keep the
  `ALL_JOB_TYPES` start-up guard.
- `apps/worker/src/square/*` (§15). The SDK is used only in the worker.

### 6.2 Upsert rules

- Booking: key `square_booking_id`. Skip if stored `square_version` > incoming `version`. Set `start_at`, `end_at`,
  `duration_minutes` (sum of segments), `team_member_id` (first segment), `service_variation_id` (first segment),
  `service_name` (from snapshot, else ''), `location_id`, `status`, `square_customer_id`, `customer_id` (local row if
  mirrored), `square_updated_at`, `raw`, `synced_at`, `square_environment`; recompute attendance/completion.
- Customer: key `square_customer_id`. Fields: given/family name, email, phone, `square_version`,
  `square_email_unsubscribed`, `square_synced_at`, `square_environment`. Never touches `marketing_consent*`,
  `review_requests_opt_out`, `unsubscribed_at` or `notes`.
- Square-deleted customer: scrub as in `purgeSquareData` for that one row.

### 6.3 `square.booking_change` (the only code that writes to Square)

1. **Claim**: `UPDATE square_booking_changes SET status='checking' WHERE id=$1 AND status IN ('queued','checking') AND submitted_at IS NULL RETURNING *`.
   If no row: if `status='submitted'` (crash after sending) go to step 7 (re-send with the same idempotency key);
   otherwise exit (already final).
2. **Gate** (`tier1Status` on fresh data): connection connected, environment matches, `writesEnabled` (or the row is
   a self-test with checklist 1–3 met), not suspended, write scopes present. Else `not_allowed`.
3. **Plan**: `bookings.getBusinessProfile()`; `supportSellerLevelWrites !== true` → `not_allowed` ("Your Square plan
   no longer allows this"), set `writesSuspendedReason='plan'`.
4. **Service** (create/reschedule): `catalog.object.get({ objectId: serviceVariationId })`; must be
   `available_for_booking`, not archived, team member in `team_member_ids`, `classifyVariation(...) === 'bookable'`
   with the fresh version; business fee zero. Else `not_allowed` with the reason.
5. **Booking** (reschedule/cancel): `bookings.get({ bookingId })`; `version !== expectedVersion` or status not
   ACCEPTED or start in the past → `changed_in_square` (store the fresh booking, upsert it).
6. **Availability re-check** (create/reschedule): `searchAvailability` for `availabilityRange(dateOf(startAt), 1)`
   (create: location + segment filter with the team member; reschedule: `bookingId` filter). Require a slot with the
   **same `start_at`** and team member. Else `slot_unavailable` with `fresh_slots` = the returned slots (≤ 20 nearest).
7. **Send**: set `submitted_at = now()` and `status='submitted'` (conditional update), audit
   `booking.change_submitted`, then (SDK `maxRetries: 0`, 20 s timeout):
   - create: `bookings.create({ idempotencyKey, booking: { locationId, startAt, customerId, sellerNote, appointmentSegments: [{ teamMemberId, serviceVariationId, serviceVariationVersion, durationMinutes }] } })`
   - reschedule: `bookings.update({ bookingId, idempotencyKey, booking: { version, startAt, appointmentSegments: slot.appointmentSegments } })`
   - cancel: `bookings.cancel({ bookingId, idempotencyKey, bookingVersion: version })`
8. **Result**:
   - 2xx → `status='confirmed'`, `square_response` = response booking, upsert the booking, link `booking_id`,
     audit `booking.change_confirmed`. **Double-booking check**: if another ACCEPTED booking for the same team member
     overlaps (local mirror after a targeted `bookings.list` for that day), set `status_message` "Square accepted
     this, but it overlaps another booking for Sam. Check Square." (`APPOINTMENTS_ALL_WRITE` allows double-booking, spec).
   - 4xx → store body verbatim, `http_status`, `error_code`; `mapSquareError`:
     `not_allowed` (403 `FORBIDDEN`, `INSUFFICIENT_SCOPES`, `MERCHANT_SUBSCRIPTION_NOT_FOUND`, category
     `MERCHANT_SUBSCRIPTION_ERROR`) → status `not_allowed`, suspend writes with reason; `conflict` (409, `CONFLICT`)
     → `changed_in_square` and enqueue `square.refresh`; `invalid` (400/422 other) → `rejected`, and for
     create/reschedule record `serviceWriteRejections[variationId]` so the service becomes `book_in_square` until the
     owner re-confirms (covers the undocumented no-show-fee error, memo §6 Open questions); `reauth` (401) →
     `needs_reauth` and `rejected`. Audit `booking.change_rejected { code }`.
   - Timeout / 5xx / 429 / network → rethrow (pg-boss retries with the **same** idempotency key, so Square will not
     apply it twice). On the last attempt → `status='unknown'`, audit `booking.change_unknown`, enqueue `square.sync`.
     The next sync settles `unknown` rows: reschedule/cancel by booking id + version/status; create by a booking with
     the same customer, team member and `start_at` created after `submitted_at` → `confirmed`; else after 24 h
     → stays `unknown` with "Not found in Square — it was probably not made."

Owner cancellation of a change is possible only while `queued` (→ `cancelled`); once `checking` starts, it completes.

---

## 7. External API calls

### 7.1 OAuth (web, plain `fetch`, no SDK)

| Call | Request | Notes |
| --- | --- | --- |
| Authorize (browser) | `GET {authBase}/oauth2/authorize?client_id&scope&session=false&state&redirect_uri` | Space-separated scopes (URLSearchParams); `session=false` ⚠ |
| Code exchange | `POST {authBase}/oauth2/token` JSON `{ client_id, client_secret, code, grant_type: 'authorization_code', redirect_uri }` | Code flow (spec). 10 s timeout, no retry. Response `access_token`, `refresh_token`, `expires_at`, `merchant_id`; `errors[]` on failure → "Square didn't accept the connection (<code>). Try again." |

Redirect URL registered in the Developer Console (OAuth page) for each environment:
`{APP_URL}/api/integrations/square/callback` (https in production).

### 7.2 Worker client (`apps/worker/src/square/client.ts`)

```ts
new SquareClient({
  token: decryptSecret(conn.accessTokenEncrypted, key),
  environment: env.SQUARE_ENVIRONMENT === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
  ...(env.NODE_ENV === 'test' && env.SQUARE_API_BASE_URL ? { baseUrl: env.SQUARE_API_BASE_URL } : {}),
  timeoutInSeconds: 20,
  maxRetries: 0,           // pg-boss owns retries; SDK default is 2 (spec)
});
```
Exposed through a narrow interface `SquareApi` (the methods below) so integration tests can swap a fake HTTP server.

| Purpose | SDK method (square@46.0.0, verified in `reference.md`) | Scope |
| --- | --- | --- |
| Token status | `client.oAuth.retrieveTokenStatus()` | any |
| Refresh | `client.oAuth.obtainToken({ clientId, clientSecret, grantType: 'refresh_token', refreshToken })` | — |
| Merchant | `client.merchants.get({ merchantId })` | MERCHANT_PROFILE_READ |
| Locations | `client.locations.list()` | MERCHANT_PROFILE_READ |
| Business profile | `client.bookings.getBusinessProfile()` | APPOINTMENTS_BUSINESS_SETTINGS_READ |
| Location profiles | `client.bookings.locationProfiles.list({})` | APPOINTMENTS_BUSINESS_SETTINGS_READ |
| Team profiles | `client.bookings.teamMemberProfiles.list({ bookableOnly: false, locationId })` | APPOINTMENTS_BUSINESS_SETTINGS_READ |
| Services | `client.catalog.searchItems({ productTypes: ['APPOINTMENTS_SERVICE'], archivedState: 'ARCHIVED_STATE_NOT_ARCHIVED' })`, `client.catalog.object.get({ objectId })` | ITEMS_READ |
| Bookings | `client.bookings.list({ locationId, startAtMin, startAtMax, limit })` (async-iterable `Page`), `client.bookings.get({ bookingId })` | APPOINTMENTS_READ + APPOINTMENTS_ALL_READ |
| Availability | `client.bookings.searchAvailability({ query })` | APPOINTMENTS_READ |
| Writes | `client.bookings.create`, `.update`, `.cancel` | APPOINTMENTS_WRITE + APPOINTMENTS_ALL_WRITE |
| Customers | `client.customers.list`, `.search`, `.get`, `.bulkRetrieveCustomers` | CUSTOMERS_READ |
| Payments | `client.payments.list({ locationId, beginTime, endTime, sortOrder, limit })`, `client.payments.get({ paymentId })` | PAYMENTS_READ |
| Orders | `client.orders.batchGet({ locationId, orderIds })` | ORDERS_READ |
| Revoke | plain `fetch` `POST {base}/oauth2/revoke`, header `Authorization: Client {secret}` | — |

Exact request field names follow the SDK's camelCase types (`startAtMin`, `appointmentSegments`, …); the
implementer checks each against `node_modules/square/api/resources/**/requests/*.d.ts` at build time (typecheck).
`no_show_fee`, if Square sends it, arrives as an unknown passthrough key on the variation; read it defensively from
both `noShowFee` and `no_show_fee`.

### 7.3 Webhooks (`POST /api/webhooks/square`, public, no session, CSRF off)

1. Reject if `SQUARE_WEBHOOK_SIGNATURE_KEY` is unset (404 "not enabled") or `content-length` > 256 KB (413).
2. `rawBody = await req.text()` (never parse first).
3. Verify: `expected = base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody))`; compare with
   `x-square-hmacsha256-signature` using `crypto.timingSafeEqual` on equal-length buffers (memo §6: the SDK compares
   with `===` and its README omits `await`, so we implement the documented algorithm ourselves).
   `notificationUrl` = `SQUARE_WEBHOOK_NOTIFICATION_URL` if set, else `${APP_URL}/api/webhooks/square` — it must be
   **byte-identical** to the URL in the Developer Console (trailing slash matters, memo §6).
4. Invalid → 401, **not stored** (storing unverified events would let a forged `event_id` block the real one via the
   unique index); log a counter only.
5. Valid → parse JSON; require `event_id`, `type`, `merchant_id`. Insert `webhook_events` `{ provider: 'square',
   external_event_id: event_id, event_type: type, payload, signature_valid: true }` `ON CONFLICT DO NOTHING`. If a row
   was inserted → enqueue `webhook.process`. Update `config.lastWebhookAt`. Respond 200 `{ ok: true }` immediately
   (no Square calls in the request; Square's response deadline and retry schedule are not in the memo ⚠).
6. `webhook.process` (square branch): ignore if `merchant_id` ≠ connected merchant (`processed_at` + error
   `merchant_mismatch`); map `booking.created|booking.updated` → `square.refresh {booking, data.id}`;
   `payment.created|payment.updated` → `square.refresh {payment, data.id}`; `customer.created|customer.updated|customer.deleted`
   → `square.refresh {customer, data.id}`; other types → processed, ignored. **Never trusts the payload's object.**

Subscription (owner checklist): events `booking.created`, `booking.updated`, `payment.created`, `payment.updated`,
`customer.created`, `customer.updated`, `customer.deleted` (memo §6 decisions-summary); API version 2026-09-16.
`order.*` is not subscribed (BETA, memo §6).

### 7.4 Rate limits and volume

Square rate limits are not in the memo ⚠. Expected volume is tiny: every 10 min 1–2 `bookings.list` pages; every
30 min 1–3 `payments.list` pages; snapshot ≤ 8 calls every 6 h; webhook-driven `get`s. `RATE_LIMITED` (429) is
`transient`: pg-boss backoff; the sync job's singleton prevents pile-ups.

### 7.5 Error mapping (`mapSquareError`)

| Square | Kind | Effect / owner message |
| --- | --- | --- |
| 401 `UNAUTHORIZED`, `ACCESS_TOKEN_EXPIRED` (after one refresh attempt), `ACCESS_TOKEN_REVOKED`, `CLIENT_DISABLED`, `APPLICATION_DISABLED` | `reauth` | connection `needs_reauth`: "Square needs you to reconnect." |
| 403 `INSUFFICIENT_SCOPES` | `reauth` (reads) / `not_allowed` (writes) | "Studio Assistant doesn't have permission for this. Reconnect and approve the permissions." |
| 403 `FORBIDDEN`, `MERCHANT_SUBSCRIPTION_NOT_FOUND`, category `MERCHANT_SUBSCRIPTION_ERROR` | `not_allowed` | writes suspended (`plan`): "Square refused because of your Appointments plan." |
| 404 `NOT_FOUND` | `not_found` | booking → `missing_from_square_at`; customer → scrub |
| 409 `CONFLICT` | `conflict` | `changed_in_square` |
| 400/422 (`BAD_REQUEST`, `INVALID_VALUE`, `INVALID_TIME`, `INVALID_TIME_RANGE`, `CONFLICTING_PARAMETERS`, `LOCATION_MISMATCH`, `UNPROCESSABLE_ENTITY`, `IDEMPOTENCY_KEY_REUSED`, others) | `invalid` | write → `rejected` with Square's `detail` shown verbatim as text; read → job failure with the code |
| 429 `RATE_LIMITED` | `rate_limited` | retry with backoff |
| 5xx, `INTERNAL_SERVER_ERROR`, `SERVICE_UNAVAILABLE`, `GATEWAY_TIMEOUT`, network, timeout | `transient` | retry; writes as §6.3 step 8 |

All codes above exist in the spec's `ErrorCode` enum (checked 2026-11-14).

---

## 8. API routes

Conventions from `docs/api.md`: JSON error envelope, `handleApi` (session + same-origin check on state changes),
`requireOwner` where marked. All dates in responses are ISO UTC plus a `…Label` in Melbourne time.

| Method | Route | Auth | Body → Response |
| --- | --- | --- | --- |
| GET | `/api/integrations/square/connect?access=read\|write` | **owner** | 302 to Square (§4.1). 409 if not configured |
| GET | `/api/integrations/square/callback?code&state[&error]` | **owner** session + state cookie | 302 to `/settings?tab=integrations…` |
| DELETE | `/api/integrations/square` | **owner** | `{ purgeData: boolean }` → `{ status }` |
| PATCH | `/api/integrations/square` | **owner** | `{ locationId?: string, writesEnabled?: boolean, serviceConfirmation?: { variationId: string, confirmed: boolean } }` → `SquareStatusDto`. `writesEnabled: true` → 409 unless `tier1Status` checklist 1–4 ok |
| POST | `/api/integrations/square/sync` | **owner** | → `{ jobId }` (`square.sync` manual) |
| POST | `/api/integrations/square/self-test` | **owner** | `{ squareCustomerId, serviceVariationId, teamMemberId, startAt, availabilitySearchId, acknowledgeLive: boolean }` → `{ selfTestId, jobId }`. 409 if a test is running; `VALIDATION` if live and not acknowledged, or slot not in that search, or < 48 h ahead |
| POST | `/api/integrations/square/self-test/notification` | **owner** | `{ answer: 'yes'\|'no'\|'unknown' }` → `SquareStatusDto` |
| GET | `/api/integrations/square` | session | `SquareStatusDto` = `{ state, liveMode, needsLocation, locations, lastSyncAt, lastSyncLabel, stale, webhooks, tier1, services: ServiceDto[], selfTest, lastError }` (never tokens or secrets) |
| GET | `/api/integrations/status` (existing) | session | Square entry gains `state`, `liveMode`, new wording |
| GET | `/api/appointments?view=upcoming\|confirm\|past&from=YYYY-MM-DD&days=1..62&cursor` | session | `{ bookings: BookingDto[], nextCursor, environment, syncedAt }` |
| GET | `/api/appointments/[id]` | session | `BookingDetailDto` incl. `changes`, `actions`, `deepLink`, `attendance` with evidence label |
| POST | `/api/appointments/[id]/attendance` | session | `{ value: 'attended'\|'not_attended'\|null }` → `BookingDto`. 409 when Square status is NO_SHOW/cancelled/declined or start is in the future |
| GET | `/api/appointments/clients?q&cursor` | session | `{ clients: ClientDto[], nextCursor }` (email/phone only for owner) |
| GET | `/api/appointments/clients/[id]` | session | `ClientDto` + bookings |
| GET | `/api/appointments/services` | session | `{ services: ServiceDto[], teamMembers }` with label and reason |
| POST | `/api/appointments/availability` | session | `{ serviceVariationId, teamMemberId?: string\|null, fromDate: 'YYYY-MM-DD', days: 1..14, bookingId?: string }` → `{ searchId, jobId }`. Rejects unknown service, `fromDate` before today (Melbourne) |
| GET | `/api/appointments/availability/[searchId]` | session | `{ status, slots: [{ startAt, startLabel, endLabel, dayLabel, teamMemberId, teamMemberName, durationMinutes }], fetchedAt, error }` |
| POST | `/api/appointments/changes` | **owner** | `{ kind: 'create', squareCustomerId, serviceVariationId, teamMemberId, startAt, availabilitySearchId, sellerNote?: string ≤ 4096 }` \| `{ kind: 'reschedule', bookingId, startAt, teamMemberId, availabilitySearchId, expectedVersion }` \| `{ kind: 'cancel', bookingId, expectedVersion }` → `{ change: BookingChangeDto, jobId }`. Server checks: `tier1Status.ready`, slot exists in that search (≤ 5 min old) with same team member, service `bookable`, booking ACCEPTED and in the future. Refusals: `UNSUPPORTED` (422) with the plain reason. Writes audit `booking.change_requested` |
| GET | `/api/appointments/changes/[id]` | session | `BookingChangeDto = { id, kind, status, statusMessage, squareDetail?: string, freshSlots?, bookingId, createdAt, finishedAt }` |
| POST | `/api/appointments/changes/[id]/cancel` | **owner** | only `queued` → `cancelled` |
| POST | `/api/webhooks/square` | public, HMAC | §7.3 |

`docs/api.md` gains an "Appointments (Square)" table with these routes.

---

## 9. UI

Design system: `apps/web/src/components/ui` (`Card`, `Badge`, `StatusPill`, `Button`, `Dialog`, `Field`, `Switch`,
`Tabs`, `EmptyState`, `Alert`, `Skeleton`, `Spinner`, `Toast`, `PageHeader`). Charcoal/white with the accent colour,
mobile first (cards stack, 44 px touch targets, dialogs full-screen on small screens), Australian English, no
technical words in business flows ("token", "webhook", "scope" only in the Settings details disclosure). Video Studio
remains the first navigation item and the default landing page; nothing here adds dashboard prominence.

### 9.1 Pages

- `apps/web/src/app/(app)/appointments/page.tsx` — server component: loads `SquareStatusDto`; if not connected
  renders `SectionOverview` (updated features/requirements copy); else renders `AppointmentsView` (client) with tabs
  Upcoming · To confirm · Past · Clients · Services.
- Settings → Integrations: replace the generic Square row with `SquareIntegrationCard`.

### 9.2 Components (`apps/web/src/components/appointments/`)

| Component | Purpose / states |
| --- | --- |
| `square-banner.tsx` | Environment badge, "Synced … ago", stale/reauth/error alerts, Refresh button (owner) |
| `booking-list.tsx`, `booking-card.tsx` | Day-grouped list; status badge from `mapBookingStatus`; attendance label with an "Estimate" tag where inferred; skeleton while loading; empty states per tab |
| `booking-dialog.tsx` | Detail, history, actions, deep link; attendance buttons |
| `attendance-control.tsx` | Attended / Didn't attend / Clear; disabled with reason when Square status forbids |
| `availability-finder.tsx` | Service/barber/date controls, polling, slot grid by day, "Check again", freshness line |
| `change-dialog.tsx` | Create/move/cancel steps, confirmation summary (with AEDT/AEST label and §4.9 sentence), progress and the five outcomes of §4.6 |
| `client-list.tsx`, `client-dialog.tsx` | Search, client bookings |
| `service-list.tsx` | Labels and the owner's "I've checked: no no-show fee" action |
| `square-integration-card.tsx` (Settings) | §4.1 states, location picker, webhook line, Tier 1 checklist, switch, self-test dialog and result, disconnect dialog, details disclosure (scopes granted, merchant id, token expiry date) |

### 9.3 Copy rules

- Square's status always shown as Square's fact; derived attendance always carries "estimate" or "marked by <name>".
- Never "completed" as a Square status; never a price for Square plans; never "Booked" before Square confirms.
- Sandbox banner on every Square-backed view while `liveMode === 'sandbox'`.
- Deep-link instructions say what to do in Square in one line.

---

## 10. Security and privacy

- **Tokens.** Access and refresh tokens only in `integration_connections` (AES-256-GCM via `packages/db/src/crypto.ts`).
  Decrypted only in the worker and in the callback for the single exchange. Never in `jobs.payload`, `raw`,
  `square_response`, audit data, logs or DTOs. `SQUARE_APPLICATION_SECRET` and `SQUARE_WEBHOOK_SIGNATURE_KEY` stay in
  the environment (web needs both; worker needs the application secret for refresh/revoke).
- **Least privilege.** Read scopes at connect; write scopes only when the owner asks for Tier 1. No
  `CUSTOMERS_WRITE`, `PAYMENTS_WRITE` or `ORDERS_WRITE`. Code flow keeps the client secret server-side.
- **OAuth.** State bound to the session cookie, 10 minutes, single use, timing-safe compare; fixed redirect URI from
  `APP_URL`; callback requires the owner session.
- **CSRF and roles.** All state changes via `handleApi`. Owner only: connect, disconnect, location, switches, service
  confirmations, sync, self-test, every booking change. Staff: view bookings, availability, services, client names,
  mark attendance. The webhook route is the only public POST.
- **Webhooks.** HMAC on raw body + exact URL, timing-safe; unverified bodies never stored; dedupe by unique index;
  body size limit; payload treated as untrusted and only triggers authenticated re-fetches; merchant id checked.
- **Writes.** Only from `square.booking_change`, only for an owner-created change row; availability, version, plan and
  service re-checked immediately before; idempotency key per change; no automatic writes of any kind (sync never
  writes to Square).
- **Audit log** (`apps/web/src/lib/audit.ts`, worker twin from `publishing.md` §6.1):
  `integration.square.connect_started`, `connected`, `scopes_upgraded`, `needs_reauth`, `disconnected`, `revoked`,
  `revoke_failed`, `data_purged`, `location_selected`, `writes_enabled`, `writes_disabled`, `writes_suspended`,
  `service_confirmed`, `service_unconfirmed`, `self_test_requested`, `self_test_passed`, `self_test_failed`;
  `booking.change_requested`, `booking.change_submitted`, `booking.change_confirmed`, `booking.change_rejected`,
  `booking.change_unknown`, `booking.change_cancelled`, `booking.attendance_marked`. Data: ids, kind, environment,
  Square error code, start time; never names, contact details, notes or tokens.
- **Personal data.** Mirror only names, email, phone, Square ids and preferences needed by the brief; customer/seller
  notes stay in `bookings.raw` and are shown to the owner only. No Square data is sent to an AI model or any third
  party. Logs redact `Authorization`, `client_secret`, `code`, `refresh_token`, `access_token`, email and phone.
  Deleted Square customers are scrubbed. Disconnect offers purge; environment switches purge automatically.
  `docs/security.md` and the privacy notice mention that client details are copied from Square.
- **Untrusted input.** Square strings (names, notes, error `detail`) are rendered as text, never HTML.

---

## 11. Testing

### 11.1 Unit (vitest, no network)

- `packages/core/square.test.ts`:
  - `squareScopes` exact lists; `squareIntegrationState` for every row of §4.1 incl. env switch and stale; `tier1Status` checklist combinations and suspension.
  - `classifyVariation`: passthrough `no_show_fee` (both casings), business fee non-zero, archived, unavailable, no team, confirmation at old version, write rejection.
  - `mapBookingStatus`: six values + unknown value.
  - `deriveAttendance` / `isGenuinelyCompleted`: future booking; time passed with no evidence (**must be false**); owner attended; owner not attended overriding a match; Square NO_SHOW overriding owner attended; cancelled after match; refund removing the match; missing from Square.
  - `matchPayments`: strong/medium/high; outside window (−31 min, +3 h 1 min); other location; FAILED/CANCELED status; fully refunded; no customer → possible match; one payment, two bookings same customer same day → earliest wins; two payments one booking.
  - `mapSquareError` per §7.5 row.
- `packages/core/time.test.ts`: `melbourneDayRange` on 2026-04-05 (25 h), 2026-10-04 (23 h), 2027-04-04, 2027-10-03 and a normal day; `availabilityRange` extends a 23 h day to 24 h and caps at 14 days; label shows AEDT/AEST correctly.
- `apps/web`: webhook verifier with a computed vector (key, URL, body → base64), wrong URL (trailing slash), tampered body, length mismatch (no throw); OAuth state cookie round trip; `buildIntegrationStatuses` Square wording; DTO `actions` per booking state and role; changes route refusals.

### 11.2 Integration (worker + web, `TEST_DATABASE_URL`, fake Square)

A local HTTP fake (`apps/worker/test/fakes/square-server.ts`) implements the endpoints in §7.2 from fixtures; the
client uses `SQUARE_API_BASE_URL` (honoured only when `NODE_ENV=test`). Cases:
1. Connect sync: snapshot, three windows, customers, attendance; second run makes no changes (idempotent).
2. Version ordering: older `booking.updated` after newer data does not overwrite.
3. Webhook route: valid event stored once and processed once on redelivery; invalid signature not stored; merchant mismatch ignored; payload object ignored in favour of the fake's `GET`.
4. Missed `booking.created`: booking appears from the 10-minute sync anyway.
5. Reconcile: booking deleted in fake → `missing_from_square_at`.
6. Attendance: payment webhook → match → `completed_at` set; refund webhook → cleared.
7. Change create happy path: re-check called, `create` called once with the stored idempotency key, booking upserted, audit rows.
8. Slot taken between search and change → `slot_unavailable`, no write call.
9. Version changed → `changed_in_square`, no write call.
10. `support_seller_level_writes` false at write time → `not_allowed`, writes suspended.
11. 403 `MERCHANT_SUBSCRIPTION_NOT_FOUND` on write → suspended; 400 on a variation → `book_in_square`.
12. Crash after `submitted_at` (handler throws after the fake records the call) → retry re-sends the same key; the fake returns the same booking; one booking total.
13. Timeout on all attempts → `unknown`; sync later finds it → `confirmed`.
14. Token refresh near expiry; `ACCESS_TOKEN_REVOKED` → `needs_reauth`, sync jobs no-op.
15. Environment switch → purge leaves no sandbox rows; customers referenced by email rows are scrubbed, not deleted.
16. Self-test: three steps; failure in step 2 still attempts cancel and reports the leftover booking.

### 11.3 Sandbox smoke test (developer, sandbox only, before Tier 1 ships — memo §6)

Script `pnpm --filter @studio/worker square:smoke` (refuses to run unless `SQUARE_ENVIRONMENT=sandbox`), against a
sandbox test account onboarded to Appointments with a test-card Plus subscription:
1. OAuth connect with `session=false`; read scopes then write scopes; token status scopes recorded.
2. Snapshot + list + availability (incl. a 23 h DST day range extended to 24 h).
3. Three no-show set-ups (memo §6): no fee; flat fee per service on one service; flat fee per appointment. For each:
   create, reschedule and cancel a booking of a fee-free and a fee-bearing service. Record HTTP status, `errors[]`
   and whether `no_show_fee` appears in the catalogue JSON. Save to `docs/research/square-sandbox-results.md`.
4. Cancel a PENDING (buyer-created) booking at seller level → record result (open contradiction).
5. Webhook delivery via Developer Console test events and real sandbox changes; signature verified; note the API
   version shown on the subscription.
6. Free plan in sandbox (if switchable): `support_seller_level_writes` false and write → error code recorded.
Tier 1 stays disabled in code (`SQUARE_TIER1_AVAILABLE = false` in core) until these results are recorded and the
error mapping is updated.

### 11.4 Only verifiable with the owner's real account

- Australian plan, price and whether `support_seller_level_writes` is true (owner reads Square Dashboard; we show
  only the flag).
- Real no-show settings and which services are fee-free (owner confirms each service).
- The live self-test (owner-approved, §4.5.1) and whether Square notified the client of an API booking.
- Webhook delivery to the production URL; Dashboard deep-link paths.
- Attendance match quality on real payments (owner reviews the "To confirm" tab for the first weeks; we report the
  share of past bookings matched vs owner-marked in Settings details, labelled as a count, not an accuracy claim).

---

## 12. Contracts with other modules

- **Email + reviews design**: read `bookings.completed_at`, `completion_source`, `attendance`, `customer_id`; call
  `isGenuinelyCompleted()` again at send time; cancel pending requests when `completed_at` becomes null. This module
  sends nothing and the email module must not send booking confirmations or reminders (§4.9). `customers.marketing_consent*`
  is owned by the email design; `square_email_unsubscribed` is advisory input only.
- **Publishing design**: shares `webhook.process`, `integration_connections.status 'disconnected'`, the
  `IntegrationStatus.state/liveMode` fields, the OAuth cookie pattern, worker `audit.ts`/`http.ts` helpers and
  `melbourneLocalToUtc`. One work package should own each shared piece.

---

## 13. Owner setup checklist (plain language)

Start with a test (sandbox) account; nothing real changes.

1. **Square developer account.** Sign in at developer.squareup.com with your Square login and create an application
   called "Studio Assistant".
2. **Sandbox first.** In the Developer Console open *Sandbox test accounts*, open the default test account's
   dashboard, and turn on Square Appointments there (add a couple of services and a bookable team member). Keep that
   sandbox dashboard open in the same browser when you connect.
3. **Copy the sandbox keys to the server** (whoever runs your server does this): `SQUARE_APPLICATION_ID`,
   `SQUARE_APPLICATION_SECRET` (both from the OAuth page, sandbox tab), `SQUARE_ENVIRONMENT=sandbox`.
4. **Redirect address.** On the OAuth page add `https://<your app address>/api/integrations/square/callback`.
5. **Webhook (optional but recommended).** In *Webhooks → Subscriptions* add
   `https://<your app address>/api/webhooks/square`, API version 2026-09-16, events: booking.created, booking.updated,
   payment.created, payment.updated, customer.created, customer.updated, customer.deleted. Copy the *signature key*
   to `SQUARE_WEBHOOK_SIGNATURE_KEY`. Without it, bookings still refresh every 10 minutes.
6. **Connect** in Studio Assistant → Settings → Integrations → Square. Check bookings appear with the "Sandbox" banner.
7. **Go live**: repeat steps 3–5 with the *production* values, set `SQUARE_ENVIRONMENT=production`, restart, and
   reconnect. Test data is removed automatically.
8. **Booking changes from Studio Assistant (optional).**
   - Square must allow apps to change bookings: Square says this needs Appointments **Plus or Premium**. Check the
     current price in your Square Dashboard before upgrading; Studio Assistant does not show prices.
   - If you use no-show protection, choose **"Flat fee per service"** and keep the services you book from Studio
     Assistant fee-free. With "Flat fee per appointment", app bookings are expected not to work — don't upgrade just
     for this.
   - Press **Give permission**, tick each fee-free service ("I've checked: no no-show fee"), run the **self-test**
     with yourself as the client, then turn on the switch.
9. **Always in Square**: marking no-shows, deposits, accepting or declining requests, and booking services with a
   no-show fee. Studio Assistant links you there.

---

## 14. Files to create or modify

**packages/core**
- `src/square.ts` (new): Zod schemas (§5.2), `SQUARE_PLAN_FACTS`, `SQUARE_TIER1_AVAILABLE`, deep-link constants,
  pure functions (§5.4). Export from `src/index.ts`.
- `src/time.ts`: `melbourneDayRange`, `availabilityRange` (+ `melbourneLocalToUtc`, `melbourneZoneLabel` if the
  publishing package has not added them yet).
- `src/jobs.ts`: job types and payload schemas (§6).
- tests: `src/square.test.ts`, additions to `src/time.test.ts`.

**packages/db**
- `src/schema.ts`: `bookings`/`customers` columns, `squareBookingChanges`, `squareAvailabilitySearches`, TS enum and
  typed `config` for provider `square`, relations, exported types.
- `drizzle/00NN_square.sql` + meta (generated).
- `src/square-purge.ts` (new): `purgeSquareData`.

**packages/queue**
- `src/index.ts`: `QUEUE_SETTINGS` for the new types; `stately` policy for `square.sync`.

**packages/config**
- `src/index.ts`: optional `SQUARE_WEBHOOK_NOTIFICATION_URL` (url), `SQUARE_API_BASE_URL` (url, test only).
- `.env.example`: the two new optional variables with comments.

**apps/worker**
- `package.json`: `square@46.0.0` (exact).
- `src/square/client.ts` (factory, token refresh, `SquareApi` interface), `src/square/map.ts` (Square → row mappers),
  `src/square/sync.ts`, `src/square/attendance.ts`, `src/square/change.ts` (§6.3), `src/square/errors.ts`.
- `src/handlers/square-sync.ts`, `square-refresh.ts`, `square-attendance.ts`, `square-availability.ts`,
  `square-booking-change.ts`, `square-self-test.ts`, `square-token.ts` (refresh + revoke); square branch in the shared
  `webhook-process.ts`.
- `src/lib/jobs.ts` (`refIdFor`), `src/main.ts` (register + crons), `src/handlers/cleanup.ts` (old availability rows).
- `scripts/square-smoke.ts` + `package.json` script `square:smoke`.
- tests: `test/fakes/square-server.ts`, `test/square.integration.test.ts`.

**apps/web**
- `src/lib/square/oauth.ts` (authorize URL, state cookie, code exchange), `src/lib/square/webhook.ts` (verify),
  `src/lib/square/appointments.ts` (queries, DTO mapping), `src/lib/shared/square-dto.ts`.
- `src/lib/integrations.ts` (Square state/wording), `src/lib/shared/integration-types.ts` (shared optional fields),
  `src/lib/jobs.ts` (`defaultRefId`).
- Routes: `app/api/integrations/square/{route.ts, connect/route.ts, callback/route.ts, sync/route.ts, self-test/route.ts, self-test/notification/route.ts}`,
  `app/api/appointments/{route.ts, [id]/route.ts, [id]/attendance/route.ts, clients/route.ts, clients/[id]/route.ts, services/route.ts, availability/route.ts, availability/[searchId]/route.ts, changes/route.ts, changes/[id]/route.ts, changes/[id]/cancel/route.ts}`,
  `app/api/webhooks/square/route.ts`.
- Pages/components: `app/(app)/appointments/page.tsx`, `components/appointments/*` (§9.2), Settings integrations tab
  uses `square-integration-card.tsx`.
- tests for the units in §11.1.

**docs**
- `docs/api.md` (Appointments table), `docs/security.md` (OAuth, webhook endpoint now built, Square data), 
  `docs/architecture.md` (Stage C Square data flow), `docs/testing.md` (fake server, smoke script), README status
  ("Square: built, verified in sandbox / waiting on owner account").

---

## 15. Open questions

1. **Undocumented write behaviour** (memo §6 Open questions): the error for a fee-blocked create; whether update and
   cancel work on fee-protected bookings; whether a non-zero business-level fee blocks every create; whether seller
   cancel covers PENDING. Answered by the sandbox smoke test (§11.3); Tier 1 ships behind `SQUARE_TIER1_AVAILABLE`
   until then.
2. **Does Square notify the client about app-made bookings?** Unknown; captured by the self-test question and shown
   in the change dialog (§4.9).
3. **New clients from Studio Assistant.** Creating bookings for a client not yet in Square needs `CUSTOMERS_WRITE`.
   Default: not requested (owner adds the client in Square first). Owner to decide if the extra permission is worth it.
4. **Staff booking changes.** Default owner-only (brief: owner-approved live changes). Owner may want barbers to
   book; that would need a staff-approval rule.
5. **Deep-link paths** into Square Dashboard and the "App integrations" page for manual revocation are not
   documented; confirmed with the owner during setup.
6. **Payment window** (start − 30 min, end + 3 h) and the 7-day give-up are from the research heuristic and our choice;
   tune after a few weeks of owner confirmations.
7. **AU plan prices, staff limits and AU-specific Bookings API gaps** remain unverified (memo Follow-up 8); re-run that
   research with squareup.com reachable. No price is shown meanwhile.
8. **Webhook delivery details** (retry schedule, response deadline, whether the subscription's API version changes
   payload shapes) — irrelevant to correctness because payloads only trigger re-fetches, but confirm in the smoke test.
9. **`session=false`** on the authorize URL and the authorisation-code lifetime are from general Square OAuth docs,
   not the memo; confirm in the smoke test.
10. **Ownership of shared pieces** with `publishing.md` (`webhook.process`, integration state fields, `melbourneLocalToUtc`,
    worker audit/http helpers, `'disconnected'` status) — the lead plan assigns each to one work package.
