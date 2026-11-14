# Design: email and Google review requests (Stage C)

Status: design only, written 2026-11-14. Nothing here is built yet. It builds on the Stage A code in this repository
and on `docs/research/platform-constraints.md` (called "the memo" below; it supersedes
`docs/research/decisions-summary.md`). Memo references use its own section numbers: **§6 Square**, **§7 Google
Business Profile**, **§8 Email & Spam Act**, plus the "Decision summary" table.

Owner's brief: `docs/spec.md` §5, second bullet (Email) and third bullet (Google reviews), with §6 (interface) and
§8 (sandbox/test modes; live sends only through owner-approved actions or configured automations).

Related designs: `docs/design/publishing.md` (shares `webhook.process`, `apps/worker/src/lib/http.ts`,
`apps/worker/src/lib/audit.ts` and the `IntegrationStatus.state` fields), the Square design (owns `bookings`,
`customers` sync and the completion rule this design consumes, §3.6), and the website/local-search design (shares the
Google OAuth connection, §8.4).

---

## 1. Goal and scope

The owner can write, preview and approve emails to clients; reuse templates; have follow-ups and review requests
prepared (or, if they switch it on, sent) after a genuinely completed appointment; run an occasional campaign to
clients who agreed to it; and see exactly what was sent, to whom, and why anyone was left out. Review requests are
neutral and identical for everyone who qualifies. Google's own rating and reviews appear only when a Google
integration provides them.

| Brief requirement (spec §5) | Design element |
| --- | --- |
| Email through a suitable provider | Postmark behind an `EmailProvider` interface (§3.1, §8.1). Transactional stream for factual messages, Broadcast stream for review requests and campaigns (memo §8 Decision). Resend stays a documented fallback; only the interface allows it. |
| Editable drafts | Every message starts as an `email_messages` row with status `draft` and an editable Markdown source (`body_markdown`). Drafts can be edited until approved (§4.2). |
| Reusable templates | `email_templates` with a `message_class`, a live linter and built-in neutral defaults (§3.3, §4.5). |
| Appointment follow-ups | "Follow-up email" automation, triggered only by a genuinely completed booking (§3.6, §4.3). |
| Optional campaigns | `email_campaigns`: compose → recipient preview → approve → send with daily limit, auto-pause on complaints or bounces (§4.4). |
| Recipient previews | Per-recipient rendering, plus an included/excluded list with a reason for every exclusion, before any approval (§4.4 step 3, §7.2). |
| Sending history | Emails → Sent: every message with status, timeline, consent basis and provider id; kept at least 24 months (memo §8 Build notes). |
| Consent handling | Append-only `consent_events` ledger with the exact wording shown, the method and the evidence (memo §8). Express consent by default; the memo's conservative "inferred" rule is off unless the owner turns it on (§3.4). |
| Unsubscribe handling | Postmark Broadcast one-click headers and link plus a permanent in-app unsubscribe page; unsubscribes actioned immediately (well within 5 business days), no login, no fee, no extra information (§3.5, §4.6). |
| Suppression handling | Global `email_suppressions`: hard bounces and complaints block everything, unsubscribes block marketing only; fed by verified Postmark webhooks and by the app's own unsubscribe page (memo §8 Build notes). |
| Prevent duplicate sends | Unique `email_messages.dedupe_key` per trigger, conditional status updates, `submitted_at` marker and a provider lookup before any retry (§6.2). |
| Do not duplicate Square's reminders | The app never sends anything before an appointment: no confirmation or reminder purpose exists, factual templates that read like reminders fail the linter, and follow-ups start only after completion (§3.3, §4.3). |
| Neutral review requests after a genuinely completed appointment | `reviewEligibility()` needs Square payment evidence or an explicit owner flag; never the clock (§3.6). |
| Owner's review link | `settings.business.googleReviewLink`, validated; optional fill-in from Places API `writeAReviewUri` (memo §7). |
| Handle cancellations, no-shows, opt-outs | Re-checked when the request is created, again at send time, and by a sweep that cancels pending requests (§3.6, §6). |
| No gating, no incentives | Eligibility takes no satisfaction, spend, rating, staff or notes input; the linter blocks incentive and selective wording; skipping a request needs a reason from a fixed list (§3.3, §3.6, §4.3). |
| Track requests separately from reviews | `review_requests` (what the app sent, and link opens) versus `reviews` (only from an authorised integration). The UI never links one to the other (§4.7). |
| Show review data only from an authorised integration | Places API rating and count (Tier 1) and Business Profile reviews (Tier 2), each disabled until configured, each labelled with its source and time (§4.8). |
| Owner approval or configured automation with on/off switch and daily cap | Each automation has an off-by-default switch, a mode ("Ask me to approve each one" / "Send automatically"), a daily limit and a send window (§4.3). Campaigns always need explicit approval. |
| Sandbox/test modes; no live sends to test a connection (spec §8) | Connection checks are read-only API calls. Sandbox is a Postmark server whose delivery type is Sandbox; messages sent through it are marked "Test — not delivered" everywhere (§3.7). |

**Out of scope** (smallest design that meets the brief):
- SMS (`review_requests.channel = 'sms'` stays unused).
- Replying to Google reviews (memo §7 Tier 2 `updateReply`), Performance metrics and Pub/Sub review notifications.
  Performance metrics belong to the website design.
- Inbound email processing (Postmark Pro feature). Replies go to the business inbox via `Reply-To`.
- Postmark open and click tracking (off for privacy). The app tracks review-link opens through its own redirect only.
- A rebooking automation. A `rebooking` template can be used manually or in a campaign.
- A public sign-up form and CSV import of consents (open question §14).
- A Resend adapter (interface only).

---

## 2. What the research allows

| Topic | What we do | Memo reference |
| --- | --- | --- |
| Provider | Postmark, behind `EmailProvider`; Basic plan when live (US$15/month, 10,000 emails). Free developer plan covers 100 emails/month for testing. Prices are not shown as fact in the UI. | §8 Decision; pricing bullet |
| Streams | `transactional_factual` → Transactional stream. `review_request` and `campaign` → Broadcast stream, only to recipients with recorded consent, always with sender identity and a working unsubscribe. | §8 Decision; Build notes "Message classes" |
| Factual messages | No offers, CTAs or promotional links; a linter blocks them. Promotional content turns a factual message into a commercial one. Sender identification still applies to factual ("designated") messages. | §8 Build notes; sources (Ticketek; s 17) |
| Review requests | Treated as commercial (memo's open question resolved "treated as yes"). | §8 Open questions |
| Consent | Express by default, unticked checkbox, exact wording kept. Never email anyone to ask for consent. A one-off purchase, enquiry or receipt address is not inferred consent. The app's optional "inferred" rule: at least 2 completed visits in 12 months, lapsing after 12 months without one; off by default. | §8 Build notes; sources (ACMA, SpinTel); Account requirements |
| Unsubscribe | Clear instructions; actioned within 5 working days (we do it immediately); no fee, no login, no extra personal information; the facility works for at least 30 days after sending. In-person, phone and reply unsubscribes actioned the same day. | §8 sources (ACMA fact sheet); Account requirements |
| One-click unsubscribe | Postmark Broadcast streams add RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers and a link (`{{{ pm:unsubscribe }}}`) automatically. Gmail requires one-click for bulk senders and a spam rate under 0.10%. | §8 sources (Postmark, Gmail) |
| Suppression | Global table: hard bounces and complaints block everything; unsubscribes block marketing only. Postmark suppression lists are per stream, so the app keeps its own global list. | §8 Build notes; Postmark bullet |
| Send log | Kept at least 24 months (Postmark keeps 45 days on Basic). | §8 Build notes |
| Single gate | `assertCanSend(client, messageClass)` in the worker; the UI cannot bypass it. | §8 Build notes |
| Auto-pause | Pause a campaign when complaints exceed 0.1% or bounces exceed 5%. | §8 Build notes |
| Domain | Own domain with DKIM, custom Return-Path, SPF and DMARC (`p=none` to start). Register in Google Postmaster Tools. | §8 Build notes; Account requirements |
| Account approval | New Postmark accounts can only mail their own domain until approved (HTTP 412 "Account Pending Approval"). Shown as its own state. | §8 Postmark bullet |
| Data location | Postmark stores data in the US; the consent wording and privacy notice say so. | §8 Postmark bullet; Account requirements |
| Privacy Act | Small-business exemption probably applies; we still minimise data and log access. | §8 last source bullet |
| Review link | Tier 0: the owner pastes the official link ("Read Reviews" → "Get more reviews"; desktop browser). Never build `g.page/r/…` or `writereview?placeid=` URLs. | §7 Decision; Build notes; sources |
| Uniform requests | Every opted-in client the same way: no satisfaction pre-screen, no incentive wording, no staff targets. Click tracking through an app-owned redirect that never branches. Google policy and ACCC. | §7 Build notes; sources (Google policy, ACCC) |
| Rating and count | Tier 1: Places API (New) Place Details, field mask `googleMapsLinks,rating,userRatingCount`, once a day. `writeAReviewUri` is the documented programmatic review link. Place ID may be cached indefinitely; other content not long-term. Pro SKU free cap 5,000 calls/month. | §7 Build notes; sources; Account requirements |
| Reviews | Tier 2: v4 `accounts.locations.reviews.list` (page size 50) re-synced on an `updateTime` watermark; show `reviewReplyState` and `policyViolation`. Needs `business.manage`, Basic API Access approval (profile verified 60+ days, a website), quota 0 until approved, ~14 days review, not guaranteed. Known issue: some reviews missing from page 2 onward. | §7 Build notes; sources; Account requirements |
| Google OAuth | Consent screen published to Production (Testing gives 7-day refresh tokens). | §7 Build notes; sources |
| Completion | Square has no "completed" status; `Booking.status` is read-only with six values; no API link from booking to payment; any "attended & paid" view is inferred and labelled, with owner override. | §6 Build notes; sources |

**Unverified items and how the design handles each one:**

| Unverified item (memo or this design) | Handling |
| --- | --- |
| Whether Postmark unsubscribe links keep working 30+ days (memo §8 open question) | The app adds its own permanent unsubscribe link (random token, no expiry, no secret dependency) to every commercial email (§3.5). |
| Postmark endpoints, error codes, `DeliveryType`, outbound search by metadata, webhook payload fields | Not covered by the memo (postmarkapp.com was blocked). Written from Postmark's public API reference as known at design time; each one is exercised by the sandbox smoke test (§11.3) before live use, and unknown error codes are stored verbatim as `failed`. |
| Postmark webhook authentication | Postmark offers HTTP Basic credentials on webhook URLs, not an HMAC signature (to confirm in smoke test). Design: Basic auth checked in constant time **and** webhooks may only ever *restrict* sending (§8.1.5); nothing a webhook says can re-enable an address. |
| `{{{ pm:unsubscribe }}}` substitution in non-template API sends | Smoke test confirms the rendered link; the app's own link is present regardless. |
| Places field-mask SKU (rating and count may bill above "Pro") | The connect screen links to the Cloud Console billing page; calls are capped at 1/day plus owner refresh at most every 10 minutes (~40/month). Open question §14. |
| Places attribution requirements | Show "Rating from Google Maps" with the fetch time next to the numbers; confirm exact wording against Google's policy before go-live (§14). |
| Business Profile approval and `business.manage` sensitivity | Tier 2 shows "Waiting for Google approval" while the API returns quota 0 / 429 (memo §7); everything else keeps working. |
| Square payment match accuracy (~80%, memo §6) | Payment-based completion is labelled inferred by the Square design; automatic sends wait at least `delayHours` (default 3) so the owner can mark "Didn't happen" first (§3.6). |
| Square customer `preferences.email_unsubscribed` | Used only in the fail-safe direction (imported as an unsubscribe, never as consent), and only if the Square design confirms the field (§3.6). |

---

## 3. Core rules (pure functions in `packages/core`, unit tested)

New file `packages/core/src/email.ts` (exported from `index.ts`). No I/O; the worker and web app load facts and call
these.

### 3.1 Message classes, streams and the provider interface

```ts
export const MESSAGE_CLASSES = ['transactional_factual', 'review_request', 'campaign'] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];
export const isCommercial = (c: MessageClass) => c !== 'transactional_factual';
export const streamFor = (c: MessageClass): 'transactional' | 'broadcast' => (isCommercial(c) ? 'broadcast' : 'transactional');

export type EmailOrigin = 'manual' | 'automation' | 'campaign' | 'preview';
export type EmailPurpose = 'follow_up' | 'review_request' | 'campaign' | 'rebooking' | 'custom' | 'preview';
```

The provider interface lives in `apps/worker/src/lib/email/provider.ts` (worker only; the web app never calls the
provider):

```ts
interface OutboundEmail {
  emailMessageId: string; to: string; from: string; replyTo: string | null;
  subject: string; html: string; text: string; stream: 'transactional' | 'broadcast';
  tag: string; metadata: Record<string, string>;
}
type SendResult =
  | { ok: true; providerMessageId: string; submittedAt: string }
  | { ok: false; kind: 'transient' | 'unknown_outcome' | 'inactive_recipient' | 'invalid_recipient'
        | 'pending_approval' | 'sender_not_verified' | 'auth' | 'rejected'; code: string; message: string };
interface ProviderCheck {
  state: 'connected' | 'needs_attention' | 'error';
  deliveryType: 'live' | 'sandbox' | 'unknown';
  streams: { transactional: boolean; broadcast: boolean };
  webhooks: { configured: boolean | null };   // null = could not tell
  approved: boolean | null;                   // null = not known until a send outside the domain
  serverName: string; message: string;
}
interface NormalisedEmailEvent {
  type: 'delivered' | 'bounced' | 'complained' | 'subscription_change' | 'ignored';
  providerMessageId: string | null; email: string | null; occurredAt: string;
  hard: boolean; suppressSending: boolean | null; suppressionReason: string | null; stream: string | null;
}
interface EmailProvider {
  readonly name: 'postmark';
  check(signal: AbortSignal): Promise<ProviderCheck>;
  send(msg: OutboundEmail, signal: AbortSignal): Promise<SendResult>;
  /** Looks for an already-accepted message by our metadata (duplicate protection after an unknown outcome). */
  findSent(emailMessageId: string, to: string, signal: AbortSignal): Promise<string | null>;
  suppress(email: string, stream: 'transactional' | 'broadcast', signal: AbortSignal): Promise<void>;
  parseWebhook(body: unknown): NormalisedEmailEvent[];
}
```

`createEmailProvider(env, fetchImpl)` returns `PostmarkProvider` when `EMAIL_PROVIDER=postmark` and the token is
set, otherwise `null`. Tests inject `FakeEmailProvider` (records calls, scripted results).

### 3.2 Rendering — `renderEmail(input)`

- Source is a Markdown **subset**: paragraphs, line breaks, `**bold**`, `*italic*`, `- ` bullet lists, and links
  `[text](url)` where `url` is `https://…` or one of the link variables. Everything else is escaped. No raw HTML
  passes through (no `<`-tags in the output except those the renderer writes).
- Variables (`{{name}}`): `first_name` (fallback "there"), `business_name` (brand), `visit_date` (Melbourne date,
  e.g. "Friday 14 November"), `service_name`, `sender_name` (`settings.email.senderName`), `review_link` (the app's
  tracked redirect, §4.7), `booking_link` (`settings.business.bookingLink`). Unknown variables are a lint error.
  Values are HTML-escaped.
- Layout: single-column HTML with inline styles (charcoal text on white, accent colour for the link button and the
  business-name header), plus a plain-text alternative. No images (the logo lives in private storage).
- **Footer** (appended by the renderer, never editable):
  - Every class: trading name (`brand.businessName`), street address (`business.addressLine, suburb STATE postcode`),
    phone and email. This is the sender identification (memo §8, s 17).
  - Commercial classes add: "You're getting this because you agreed to hear from {business}. To stop marketing
    emails: [Unsubscribe]({{{ pm:unsubscribe }}}). If that link ever stops working, use {APP_URL}/u/{token}, or reply
    to this email or call {phone} and we'll remove you the same day."
- Output `{ subject, html, text, storedHtml, storedText }`. The stored copies replace the two personal token URLs
  with the markers `[unsubscribe link]` and `[review link]`, so the database never holds a usable token (only its
  SHA-256 hash, §5.2).

### 3.3 Linter — `lintEmail({ messageClass, subject, bodyMarkdown })` → `{ errors: Issue[]; warnings: Issue[] }`

Run on every template save, draft edit, approval and again in the worker. Errors block approval and sending.

| Class | Errors | Warnings |
| --- | --- | --- |
| all | Subject empty or > 120 chars; body empty or > 10,000 chars; unknown `{{variable}}`; a link that is not `https://` or a link variable; raw HTML tags | Subject in ALL CAPS; more than 3 links |
| `transactional_factual` | Any link at all, `{{review_link}}` or `{{booking_link}}`; promotional words (`offer`, `discount`, `% off`, `special`, `deal`, `promo`, `sale`, `book now`, `rebook`, `voucher`, `gift card`, `free`, `limited time`, `refer a friend`); reminder or confirmation wording (`reminder`, `your appointment is (on\|at\|tomorrow)`, `see you (tomorrow\|on)`, `confirm your`) with the message "Square already sends booking confirmations and reminders" | — |
| `review_request` | Missing `{{review_link}}`; incentive words (`discount`, `% off`, `voucher`, `gift`, `free`, `prize`, `win`, `draw`, `reward`, `points`, `credit`, `in exchange`, `in return`); selective or diverting wording (`5 star`, `five star`, `5-star`, `positive review`, `good review`, `great review`, `if you (were\|are) happy`, `if you enjoyed`, `if you liked`, `if you loved`, `if you('re\| are) satisfied`, `unhappy`, `not happy`, `not satisfied`, `contact us first`, `let us know first`, `before (leaving\|posting)`); staff targets (`help .* reach`, `target`, `quota`) | `{{booking_link}}` present ("keep review requests about the review only") |
| `campaign` | — | No `{{first_name}}` (fine, just informative) |

Word lists are case-insensitive whole-word regexes in `packages/core/src/email-lint.ts`, each with a plain-English
reason ("Google and the ACCC don't allow rewards for reviews").

### 3.4 Consent — `foldConsent(events, suppressions, opts)` → `ConsentState`

```ts
type ConsentState =
  | { status: 'express'; since: string; consentEventId: string }
  | { status: 'inferred'; visits12m: number; lastVisitAt: string }   // only when settings.email.allowInferredConsent
  | { status: 'withdrawn'; at: string; source: string }
  | { status: 'none' };
```

- Consent is per **email address** (`email_lower`), not per customer: if a client's address changes, the new
  address has no consent until recorded again.
- Events are sorted by `occurred_at`. The latest `granted` versus the latest `withdrawn` (ledger) or active
  marketing/all suppression wins; ties go to withdrawal.
- `inferred` is computed only when the owner has turned on `allowInferredConsent`, there has never been a
  withdrawal for the address, and the address belongs to a customer with **at least 2 genuinely completed visits
  (§3.6) in the last 12 months**, the latest within 12 months (memo §8: the app's own conservative rule, not a
  statutory test). Default off.

### 3.5 Send gate — `evaluateSendPolicy(input)` → `{ decision: 'send' | 'defer' | 'block'; reasons: Reason[]; deferUntil?: Date; consentBasis }`

This is the memo's `assertCanSend`. The worker loads facts and calls it immediately before the provider call
(§6.2); the API calls it only to show blockers early. Inputs: message class, origin, recipient address, customer
(deleted? review opt-out?), `ConsentState`, active suppressions, business identity, provider state, booking
eligibility (for automation and review requests), review-link validity, lint result, automation enabled flag,
counters (sent today per automation, commercial sent today, automated emails to this customer today), send window
and `now`.

| Code | Decision | Applies to | Plain message |
| --- | --- | --- | --- |
| `provider_not_ready` | block (stays approved; retried by dispatch when the provider becomes ready) | all | "Email sending isn't set up yet." |
| `webhooks_missing` | block (stays approved, like `provider_not_ready`) | commercial | "Postmark isn't telling the app about bounces and unsubscribes yet, so marketing emails are on hold." |
| `business_identity_missing` | block | all | "Add your business address, phone and email in Settings → Business. Every email must say who it's from." |
| `invalid_address` | block | all | "This email address doesn't look valid." |
| `suppressed_all` | block → `suppressed` | all | "This address bounced or reported spam. Nothing can be sent to it." |
| `unsubscribed` | block → `suppressed` | commercial | "This client unsubscribed from marketing emails." |
| `no_consent` | block | commercial | "No marketing permission recorded for this address." |
| `review_opt_out` | block | `review_request` | "This client asked not to get review requests." |
| `review_link_missing` / `review_link_invalid` | block | `review_request` | "Add your Google review link in Reviews → Review link." |
| `booking_not_completed` / `booking_cancelled` / `booking_no_show` | block → `cancelled` | follow-ups and review requests tied to a booking | "The appointment is no longer marked as completed." |
| `recently_asked` | block → `skipped` | `review_request` | "Already asked within the last {n} days." (same rule for everyone) |
| `lint_errors` | block | all | the lint messages |
| `automation_off` | block → `cancelled` | origin `automation` with no human approver | "The automation was switched off before this was sent." |
| `outside_window` | defer to next window start | origin `automation` and `campaign` | — |
| `daily_cap` | defer to next day's window | automation (own cap) and all commercial (global cap) | "Daily limit reached; sends tomorrow at 9:00 am." |
| `customer_daily_limit` | defer to next day | origin `automation` | at most one automated email per client per Melbourne day |
| `sandbox` | send (label only) | all | "Test server: not delivered to the client." |

`origin = 'preview'` is allowed only to the signed-in owner's own email address and skips consent rules (it still
lints and still carries the footer).

### 3.6 Genuine completion and review eligibility

**Contract with the Square design** (it owns `bookings`; if its column names differ, only `isGenuinelyCompleted`
changes):

- `bookings.status` mirrors Square's six statuses exactly (memo §6).
- `bookings.completion_source` is `'payment'` only when the Square design's matcher found a payment for this booking,
  `'owner_marked'` when the owner pressed "Mark as completed", and `'none'` otherwise. `'square_status'` is never
  accepted, because Square has no completed status (memo §6).
- The owner can override to "Didn't happen". The Square design stores that so sync does not re-infer completion,
  and sets `completion_source = 'none'`.
- `bookings.completed_at` is set with the source.
- Square sync imports `customers.email`. If Square's `preferences.email_unsubscribed` is confirmed in the SDK, the
  sync writes a `withdrawn` consent event with method `square_preference` (never a grant).

```ts
export function isGenuinelyCompleted(b: { status: string; completionSource: string; completedAt: Date | null }): boolean {
  return b.status === 'ACCEPTED' && (b.completionSource === 'payment' || b.completionSource === 'owner_marked') && b.completedAt !== null;
}
```

The start time passing is never evidence (spec §5).

`reviewEligibility({ booking | attestation, customer, priorRequests, settings, now })` →
`{ eligible: true } | { eligible: false; skipReason }`, checked in this order:

1. Evidence: `isGenuinelyCompleted(booking)`, **or** a manual request with the owner's attestation (§4.3).
2. Automation only: `completedAt >= automation.enabledAt` and `completedAt >= now − maxAgeDays` (default 7). This
   stops a back-catalogue blast when the switch is turned on.
3. Customer exists, not deleted, has an email address → else `no_email`.
4. `reviewRequestsOptOut` is false → else `opted_out`.
5. No review request **sent** to this customer in the last `minDaysBetweenRequests` days (default 365) → else
   `recently_asked`.
6. Review link valid (§3.8) → else `no_review_link`.
7. Then the send gate (consent, suppression) → `no_consent`, `unsubscribed`, `suppressed`.

The function's parameter type has **no** rating, spend, feedback, notes, staff or satisfaction field. A unit test
pins the parameter keys so a future change cannot add gating silently.

Skip reasons (fixed list, also used when the owner skips by hand): `no_email`, `opted_out`, `recently_asked`,
`no_review_link`, `no_consent`, `unsubscribed`, `suppressed`, `booking_cancelled`, `booking_no_show`,
`not_completed`, and owner-only `asked_in_person`, `wrong_client_details`, `other` (with a note). There is
deliberately no "client unhappy" reason.

### 3.7 Scheduling in Melbourne time

`nextSendSlot(earliest: Date, window = { start: '09:00', end: '19:00' }, tz = 'Australia/Melbourne')` uses
`Intl.DateTimeFormat` offsets (no new dependency) and is tested across both daylight-saving changes (first Sunday in
October, first Sunday in April). "Today" for daily caps is the Melbourne calendar day.

### 3.8 Review link validation — `validateReviewLink(url)`

`https:` only; host in `g.page`, `search.google.com`, `www.google.com`, `google.com`, `maps.google.com`,
`maps.app.goo.gl`, `www.google.com.au`, `google.com.au`; ≤ 500 characters. The app never constructs these URLs
(memo §7); it only accepts what the owner pastes or what Places returns as `writeAReviewUri`.

---

## 4. User flows

All text below is final UI copy unless marked otherwise. Staff can view Clients and record consent or unsubscribes;
everything else is owner-only (§10).

### 4.1 Setting up email (Settings → Integrations → "Email (Postmark)")

States the owner can see:

| State | Shown when | Owner sees |
| --- | --- | --- |
| Not set up | `EMAIL_PROVIDER` ≠ `postmark`, or `POSTMARK_SERVER_TOKEN` / `EMAIL_FROM` missing | "Needs setup: emails can be written and saved as drafts, but nothing is sent until Postmark is connected." + missing setting names + link to the checklist (§12). |
| Set up, not checked | Env present, no successful check yet | "Ready to check. This only reads your Postmark settings; no email is sent." [Check connection] |
| Waiting for Postmark approval | Check OK, last send got 412 / `approved=false` | "Postmark is still reviewing your account. Until it's approved you can only email addresses at your own domain." |
| Connected — Test server | Check OK, `deliveryType=sandbox` | Badge "Test server": "Emails are processed but not delivered to clients. Everything sent shows as 'Test — not delivered'." |
| Connected — Live | Check OK, `deliveryType=live` (or `unknown`, labelled live to be safe) | Badge "Live": "Approved emails reach real clients." |
| Connected, webhooks missing | Check OK but no webhook found on a stream | Warning: "Bounces and unsubscribes made through Postmark won't reach the app. Add the webhook (step 6 of the checklist)." Commercial sends are **blocked** in this state; factual sends allowed. |
| Token rejected | Postmark 401 / ErrorCode 10 | "Postmark rejected the server token. Replace POSTMARK_SERVER_TOKEN on the server." (state `needs_reauth`) |
| Problem | Check failed for another reason (stream missing, network) | `last_error` in plain words + [Check again] |

The check runs as a job (`email.provider.check`), daily at 04:37 Melbourne time and on demand. It also does two
advisory DNS look-ups for the `EMAIL_FROM` domain (DMARC TXT at `_dmarc.<domain>`; Return-Path CNAME
`pm-bounces.<domain>`) and shows "We couldn't find …" hints, never errors, because selectors and names can differ.

### 4.2 One-off email to a client (Emails → Clients → client → "Write email")

1. Owner picks a template or starts blank, and chooses the type: **Information only** (factual), **Marketing**.
   (Review requests use the Reviews flow, §4.3.)
2. Editor: subject, body with variable chips, live lint panel, and a preview pane rendering exactly what this
   client will get (sandboxed iframe). Header shows: "Marketing email — needs permission: ✔ Express permission
   since 3 Nov 2026" or the blocker in red.
3. **Save draft** (status `draft`) or **Approve and send**. Approve opens a confirmation: recipient name and
   address, type, stream ("Marketing stream with unsubscribe"), "Live — this goes to the client" or "Test server —
   not delivered", and optional "Send at" (Melbourne time). Confirm → status `approved` → dispatch.
4. Optional **Email me a preview**: sends this exact draft (with "[Preview]" in the subject) to the owner's own
   address only. It is recorded with origin `preview` and audited.
5. History shows the message moving through Queued → Sending → Sent → Delivered (or Bounced / Spam complaint /
   Not sent — unsubscribed / Failed / Test — not delivered).

### 4.3 Automations: follow-ups and review requests

Two cards with the same shape: **Emails → Automations → Follow-up email** and **Reviews → Automatic requests**.

- Switch **Off** by default. Turning it on shows what will happen in one sentence and records `enabledAt`
  (audited). Only appointments completed **after** this moment are considered.
- **Mode:** "Ask me to approve each one" (default) or "Send automatically". Switching to automatic needs a
  confirmation ("Emails will go out without you looking at each one. You can switch this off any time.").
- **Template** (filtered by class), **delay after completion** (default 3 hours, 1–72), **daily limit** (default 10;
  1–100), shared **send window** (default 9:00 am–7:00 pm Melbourne time).
- Follow-up card note: "Square already sends booking confirmations and reminders, so Studio Assistant never sends
  them. Follow-ups go only after an appointment is completed." plus three checkboxes the owner ticks to say what
  Square sends for them (confirmations / reminders / feedback or review requests). If "feedback or review
  requests" is ticked, the review automation cannot be turned on and shows "Square is already asking your clients
  for feedback; turn that off in Square first to avoid asking twice."
- Review card rule text: "Every client with a completed appointment and email permission gets the same request.
  We never filter by how happy they seem, and requests never offer anything in return (Google's rules and
  Australian consumer law)."

What happens (sweep every 10 minutes, §6):
1. A booking becomes genuinely completed (payment matched, or the owner pressed "Mark as completed" on the
   Appointments page).
2. Sweep creates, at most once per booking (dedupe keys `review:{bookingId}`, `follow_up:{bookingId}`):
   - a `review_requests` row and an `email_messages` row, or
   - a `review_requests` row with status `skipped` and the reason (so the owner sees why a client wasn't asked).
3. Approve mode: status `pending_approval` / `draft`; appears under **To approve** with the client, appointment
   (service, date), the full email, and any blockers. Actions: **Approve**, **Approve all ready (n)**, **Skip**
   (reason from the fixed list, §3.6), **Edit**.
4. Automatic mode: status `scheduled` / `approved` with `approved_by = null`, `origin = 'automation'`.
5. `scheduled_for = nextSendSlot(completedAt + delay)`. Dispatch sends when due; the gate re-checks everything.
6. Booking cancelled, no-show, declined or marked "Didn't happen" before sending → request `cancelled`
   (`booking_cancelled` / `booking_no_show` / `not_completed`), message `cancelled`. Already sent → the row says
   "Sent before the booking changed"; nothing else happens.
7. Turning the automation off cancels automatically approved messages that have not been submitted; drafts
   waiting for approval stay (the owner can still approve them by hand).

**Manual review request** (works without Square, memo §7 Tier 0): Reviews → **Send a request** → choose a client →
visit date (today or earlier, up to 7 days) → tick "I confirm {name} had an appointment on {date} that went ahead."
(this is the explicit completed flag) → the same eligibility and template → draft → approve. Dedupe key
`review:manual:{customerId}:{visitDate}`.

### 4.4 Campaign (Emails → Campaigns → New campaign)

1. **Write:** name, subject, body (template or blank; class is always `campaign`), live lint, preview with a
   chosen real client or the labelled "Sample client (not a real person)".
2. **Audience:** "Clients who gave email permission" (fixed) with one optional filter "visited in the last
   [3/6/12] months" (genuinely completed visits only).
3. **Recipient preview:** "42 will receive this · 17 left out" with a searchable list. Left-out rows show the reason
   (No permission recorded · Unsubscribed · Bounced or spam complaint · No email · Deleted client). Click any
   included client to see their exact rendering.
4. **Review and approve:** totals, "Sent over 2 days because of your daily limit of 30", Live/Test label, and a
   checkbox "These clients agreed to receive marketing emails from {business}". Approve sends the `audienceHash`
   from the preview; if the audience changed since, the API answers 409 and the owner previews again.
5. **Sending:** progress (queued / sent / delivered / bounced / complaints), **Pause**, **Resume**, **Cancel
   remaining**. Auto-pause banner when complaints > 0.1% or bounces > 5% of sent (memo §8): "Paused automatically:
   1 spam complaint out of 42 sent. Check the list before resuming."

### 4.5 Templates (Emails → Templates)

- Built-in, editable templates seeded on first use (`ensureDefaultTemplates`, fixed ids, idempotent):
  - **Google review request** (`review_request`) — subject "A quick favour from {{business_name}}"; body: "Hi
    {{first_name}}, thanks for coming in to {{business_name}} on {{visit_date}}. If you have a minute, we'd
    appreciate an honest review on Google. Every review helps people nearby find the right barber. [Leave a Google
    review]({{review_link}}) Thanks, {{sender_name}}".
  - **Aftercare note** (`transactional_factual`, purpose `follow_up`) — subject "Looking after your cut"; plain
    aftercare text, no links.
  - **Thanks and rebook** (`campaign`, purpose `follow_up`) — thanks plus `{{booking_link}}`.
- Editor: class selector (Information only / Marketing / Review request), purpose, live lint and preview. Archive
  instead of delete (`enabled = false`); sent messages keep their own rendered copy.

### 4.6 Consent and unsubscribes

**Record permission** (Emails → Clients → client, staff or owner):
1. Choose the method: **"Client ticks on this device"** (default) or **"Client told me (in person or by phone)"**.
2. Device mode: a full-screen card with the current wording (`settings.email.consentWording`) and an **unticked**
   checkbox the client ticks themselves, then [Save]. Verbal mode: the owner reads the wording and ticks "I read
   this wording to the client and they said yes".
3. Saves a `consent_events` row (`granted`, `express`, method, exact wording, wording hash, recorded-by, user agent,
   time). If the address had an active **unsubscribe** suppression, it is lifted in the same transaction (an
   unsubscribe can be reversed by new express consent; bounces and complaints cannot be lifted this way).
4. The app never emails anyone to ask for permission (memo §8). There is no "send consent request" button.

**Unsubscribe paths** (all immediate):
- Postmark one-click or Postmark link → `SubscriptionChange` webhook → suppression `marketing` + ledger `withdrawn`.
- App link `/u/{token}` → page "Unsubscribe {masked email} from marketing emails from {business}?" [Unsubscribe] →
  "Done. You won't get marketing emails from {business} any more. Messages about appointments you book may still
  arrive." The page works without login, asks for nothing, never expires, and the GET does not change anything
  (mail scanners pre-fetch links). It also accepts an RFC 8058 `List-Unsubscribe=One-Click` POST.
- Owner or staff **Record unsubscribe** (in person, phone, reply email) → same writes, method recorded.
- Invalid or unknown token → "This link isn't valid. Reply to any email from us or call {phone} and we'll remove you
  the same day." (no form asking for details).
- On every unsubscribe, approved/queued commercial messages to that address flip to `suppressed` in the same
  transaction, and `email.suppression.push` adds the address to Postmark's Broadcast suppression list.

**Stop review requests only** (owner or staff): sets `customers.review_requests_opt_out = true` (audited).

**Lifting a suppression** (owner only, Emails → Clients → client): hard bounce or provider-inactive → "The address
was corrected" with a note; spam complaint → requires new express consent recorded after the complaint and a typed
confirmation. All audited.

### 4.7 Review requests and link opens (Reviews → Requests)

- Columns: client, appointment, status (Waiting for approval · Scheduled · Sent · Link opened · Skipped — reason ·
  Cancelled — reason · Failed), sent time.
- "Link opened" comes from `/r/{token}`: every token redirects to the same saved review link; an invalid token
  redirects there too (nothing branches, memo §7). Label: "Opened the review link (may include email security
  scanners)".
- Monthly counts: requests sent, links opened. A permanent note: "Requests are tracked separately from reviews.
  Google doesn't tell us who left a review, so we never match the two."

### 4.8 Google rating and reviews (Reviews page, top and "Reviews on Google" tab)

**Review link card** (Tier 0, always available): saved link, validity, [Test link] (opens in a new tab; the server
never fetches it), help text "In Google Business Profile on a computer: Read reviews → Get more reviews → copy the
link." When Tier 1 is connected and returns `writeAReviewUri`: [Use Google's review link] (explicit owner action,
audited).

**Rating card** (Tier 1, Places API):

| State | Owner sees |
| --- | --- |
| Not set up (`GOOGLE_MAPS_API_KEY` missing) | "Optional: add a Google Maps key to show your Google rating here." |
| No place chosen | "Enter your Place ID." Link to Google's Place ID Finder; input; [Look up] |
| Checking / confirm | "Is this your business? {displayName}, {formattedAddress}" [Yes, that's us] [No] |
| Connected | "4.8 ★ · 123 reviews — Rating from Google Maps, updated Sat 14 Nov, 5:23 am" [Refresh] (at most every 10 min) |
| Error | "Google refused the request: {plain reason}" (key restricted, API not enabled, billing off, place not found) |

**Reviews on Google** (Tier 2, Business Profile):

| State | Owner sees |
| --- | --- |
| Not set up (`GOOGLE_CLIENT_ID`/`SECRET` missing) | "Optional: needs a Google Cloud project and Google's approval. Review requests work without it." |
| Not connected | [Connect Google Business Profile] |
| Choose location | list of locations from Google → owner picks one |
| Waiting for Google approval | "Google hasn't approved API access for this project yet (it usually takes about 14 days and isn't guaranteed). Your review requests still work." |
| Connected | list: stars, reviewer name, date, text, owner reply if any, reply state / policy flag from Google, "Synced 14 Nov, 5:41 am". Note: "Google's API can occasionally miss reviews; check Google Maps for the full list." |
| Reconnect needed | "Google needs you to sign in again." [Reconnect] |
| Error | plain reason + [Try again] |

Reviews are never typed in by hand; there is no add or edit control.

---

## 5. Data model

### 5.1 Existing tables used

| Table | Use |
| --- | --- |
| `customers` | Recipient identity (`email`, names), `review_requests_opt_out`. `marketing_consent`, `marketing_consent_source`, `marketing_consent_at`, `unsubscribed_at` become a **display cache** updated in the same transaction as ledger/suppression writes; the gate always reads `consent_events` + `email_suppressions`. Manual clients (no Square) have `square_customer_id = null`. Soft delete only. |
| `bookings` | Read-only here: status, `completion_source`, `completed_at`, `service_name`, `start_at`, `customer_id` (§3.6). |
| `email_templates` | Templates; `purpose`, `subject`, `body_markdown`, `is_commercial` (kept equal to `message_class != 'transactional_factual'`), `enabled` (archive). |
| `email_messages` | Drafts, approvals, the send log (≥ 24 months) and delivery status. `dedupe_key` unique. |
| `review_requests` | One per booking (existing unique `booking_id`) or per manual attestation; status and skip reason. |
| `reviews` | Only rows from `google_business_profile` sync. |
| `integration_connections` | Rows for `postmark` (no secret stored; status, `capabilities`, `last_error`), `google_places` (`config.placeId`, latest snapshot in `capabilities`), `google_business_profile` (encrypted OAuth tokens, `config.account`, `config.location`). |
| `webhook_events` | Postmark deliveries, stored once per `(provider, external_event_id)`. |
| `audit_log` | All connect/disconnect, approve/skip/cancel, send, consent, unsubscribe, suppression-lift, automation and template changes. |
| `settings` | `AppSettings.email` and `AppSettings.reviews` (§5.3). |
| `jobs` | UI mirror of the new job types. |

### 5.2 Additive schema changes (one migration `packages/db/drizzle/00NN_email_reviews.sql`, generated with `drizzle-kit generate`)

Text enums in `schema.ts` are TypeScript-only (the initial migration has no CHECK constraints), so new enum values
need no SQL. Order in the migration: new tables first (FK targets), then column additions.

**New table `email_campaigns`**

```sql
CREATE TABLE email_campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  template_id text REFERENCES email_templates(id) ON DELETE SET NULL,
  subject text NOT NULL,
  body_markdown text NOT NULL,
  audience jsonb NOT NULL DEFAULT '{}',            -- { lastVisitWithinDays: number | null }
  audience_hash text,                               -- sha256 of sorted customer ids + content hash at preview
  recipient_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',             -- draft|approved|sending|paused|sent|cancelled
  paused_reason text NOT NULL DEFAULT '',
  sent_count integer NOT NULL DEFAULT 0,
  delivered_count integer NOT NULL DEFAULT 0,
  bounce_count integer NOT NULL DEFAULT 0,
  complaint_count integer NOT NULL DEFAULT 0,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_campaigns_created_idx ON email_campaigns(created_at);
```

**New table `consent_events`** (append-only: no update or delete route; the only writer is `recordConsentEvent`)

```sql
CREATE TABLE consent_events (
  id text PRIMARY KEY,
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  email_lower text NOT NULL,
  kind text NOT NULL,                  -- granted | withdrawn
  basis text NOT NULL DEFAULT '',      -- 'express' for granted; '' for withdrawn
  scope text NOT NULL DEFAULT 'marketing',
  method text NOT NULL,                -- in_person_device | verbal_owner_recorded | unsubscribe_page | one_click
                                       -- | postmark_unsubscribe | reply_email | phone | in_person | square_preference | owner_other
  wording text NOT NULL DEFAULT '',    -- exact wording shown (granted)
  wording_hash text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}',-- { userAgent?, emailMessageId?, webhookEventId?, note? } (no IP address)
  recorded_by text REFERENCES users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_events_email_idx ON consent_events(email_lower, occurred_at);
CREATE INDEX consent_events_customer_idx ON consent_events(customer_id, occurred_at);
```

**New table `email_suppressions`**

```sql
CREATE TABLE email_suppressions (
  id text PRIMARY KEY,
  email_lower text NOT NULL,
  scope text NOT NULL,                 -- all | marketing
  reason text NOT NULL,                -- hard_bounce | spam_complaint | unsubscribe | provider_inactive | manual_block
  source text NOT NULL,                -- postmark_webhook | unsubscribe_page | one_click | owner | send_error | square_preference
  stream text,
  email_message_id text REFERENCES email_messages(id) ON DELETE SET NULL,
  webhook_event_id text REFERENCES webhook_events(id) ON DELETE SET NULL,
  pushed_to_provider_at timestamptz,
  lifted_at timestamptz,
  lifted_by text REFERENCES users(id) ON DELETE SET NULL,
  lift_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_suppressions_active_idx ON email_suppressions(email_lower, scope, reason) WHERE lifted_at IS NULL;
CREATE INDEX email_suppressions_email_idx ON email_suppressions(email_lower);
```

Inserts use `ON CONFLICT DO NOTHING` (idempotent).

**`email_templates`**

| Change | SQL |
| --- | --- |
| Class | `ADD COLUMN message_class text NOT NULL DEFAULT 'campaign'` |
| Built-in marker | `ADD COLUMN built_in boolean NOT NULL DEFAULT false` |
| Backfill | `UPDATE email_templates SET message_class = CASE WHEN purpose='review_request' THEN 'review_request' WHEN is_commercial = false THEN 'transactional_factual' ELSE 'campaign' END;` |

**`email_messages`**

| Change | SQL | Notes |
| --- | --- | --- |
| Editable source | `ADD COLUMN body_markdown text NOT NULL DEFAULT ''` | Drafts edit this; `body_html`/`body_text` hold the rendered, token-free copy |
| Class and stream | `ADD COLUMN message_class text NOT NULL DEFAULT 'campaign'`, `ADD COLUMN stream text` | `stream` set at send |
| Origin | `ADD COLUMN origin text NOT NULL DEFAULT 'manual'` | `manual` / `automation` / `campaign` / `preview` |
| Campaign | `ADD COLUMN campaign_id text REFERENCES email_campaigns(id) ON DELETE SET NULL` + `CREATE INDEX email_messages_campaign_idx ON email_messages(campaign_id, status)` | |
| Approval | `ADD COLUMN approved_by text REFERENCES users(id) ON DELETE SET NULL`, `ADD COLUMN approved_at timestamptz` | `approved_by` null + origin `automation` = approved by the automation setting |
| Non-repeatable call marker | `ADD COLUMN submitted_at timestamptz` | Set in the claim update, before the provider call |
| Delivery | `ADD COLUMN delivered_at timestamptz` | |
| Messages | `ADD COLUMN status_message text NOT NULL DEFAULT ''`, `ADD COLUMN owner_action text` | `owner_action = 'check_before_retry'` after an unknown outcome |
| Consent snapshot | `ADD COLUMN consent_basis jsonb` | `{ status, consentEventId?, visits12m?, checkedAt }` |
| Sandbox | `ADD COLUMN is_sandbox boolean NOT NULL DEFAULT false` | |
| Unsubscribe token | `ADD COLUMN unsubscribe_token_hash text` + `CREATE UNIQUE INDEX email_messages_unsub_token_idx ON email_messages(unsubscribe_token_hash) WHERE unsubscribe_token_hash IS NOT NULL` | SHA-256 of a random 32-byte token |
| Webhook lookup | `CREATE UNIQUE INDEX email_messages_provider_msg_idx ON email_messages(provider_message_id) WHERE provider_message_id IS NOT NULL` | |
| History and caps | `CREATE INDEX email_messages_customer_idx ON email_messages(customer_id, created_at)`; `CREATE INDEX email_messages_to_idx ON email_messages(lower(to_email), created_at)`; `CREATE INDEX email_messages_sent_idx ON email_messages(origin, sent_at)` | |
| Status enum | add `'sending'`, `'cancelled'` (TS only) | |

**`review_requests`**

| Change | SQL |
| --- | --- |
| Origin | `ADD COLUMN origin text NOT NULL DEFAULT 'manual'` (`manual` / `automation`) |
| Evidence | `ADD COLUMN completion_evidence text NOT NULL DEFAULT ''` (`payment` / `owner_marked` / `owner_attested`), `ADD COLUMN attested_by text REFERENCES users(id) ON DELETE SET NULL`, `ADD COLUMN attested_visit_date date` |
| Dedupe | `ADD COLUMN dedupe_key text` + `CREATE UNIQUE INDEX review_requests_dedupe_idx ON review_requests(dedupe_key) WHERE dedupe_key IS NOT NULL` (always set by the app) |
| Timing | `ADD COLUMN scheduled_for timestamptz` |
| Link opens | `ADD COLUMN click_token_hash text` + `CREATE UNIQUE INDEX review_requests_click_token_idx ON review_requests(click_token_hash) WHERE click_token_hash IS NOT NULL`; `ADD COLUMN first_clicked_at timestamptz`; `ADD COLUMN click_count integer NOT NULL DEFAULT 0` |
| Frequency rule | `CREATE INDEX review_requests_customer_idx ON review_requests(customer_id, created_at)` |

**`reviews`**: `ADD COLUMN review_updated_at timestamptz`; `CREATE INDEX reviews_provider_created_idx ON reviews(provider, review_created_at)`.

**`integration_connections`** (TS only): `provider` enum adds `'postmark'`, `'google_places'`; `capabilities`
type widened to `Record<string, boolean | string | number | null>` (the publishing design makes the same change).

**`bookings`, `customers`, `webhook_events`**: no SQL change here.

### 5.3 Settings (Zod in `packages/core/src/settings.ts`; no SQL)

```ts
const AutomationSchema = z.object({
  enabled: z.boolean().default(false),
  enabledAt: z.string().datetime().nullable().default(null),
  mode: z.enum(['approve_each', 'send_automatically']).default('approve_each'),
  templateId: z.string().nullable().default(null),
  delayHours: z.number().int().min(1).max(72).default(3),
  dailyCap: z.number().int().min(1).max(100).default(10),
});
export const EmailSettingsSchema = z.object({
  senderName: z.string().max(80).default(''),          // '' → brand.businessName
  replyTo: z.string().max(120).default(''),            // '' → business.email
  consentWording: z.string().min(20).max(600).default(
    "Yes, I'd like emails from {business_name} with news, offers and the occasional request for feedback. " +
    'I can unsubscribe at any time. Emails are sent through our email provider, Postmark, in the United States.'),
  allowInferredConsent: z.boolean().default(false),
  sendWindow: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'), end: z.string().regex(/^\d{2}:\d{2}$/).default('19:00') }).default({ start: '09:00', end: '19:00' }),
  dailyCommercialCap: z.number().int().min(1).max(500).default(50),
  squareSends: z.object({ confirmations: z.boolean().nullable().default(null), reminders: z.boolean().nullable().default(null), feedbackOrReviews: z.boolean().nullable().default(null) }).default({ confirmations: null, reminders: null, feedbackOrReviews: null }),
  followUp: AutomationSchema.default(AutomationSchema.parse({})),
});
export const ReviewSettingsSchema = z.object({
  automation: AutomationSchema.default(AutomationSchema.parse({})),
  minDaysBetweenRequests: z.number().int().min(30).max(730).default(365),
  maxAgeDays: z.number().int().min(1).max(14).default(7),
});
// AppSettingsSchema gains: email: EmailSettingsSchema.default(...), reviews: ReviewSettingsSchema.default(...)
```

Existing settings rows parse unchanged because of the defaults. `{business_name}` in the wording is substituted
when shown and the **substituted** text is what the ledger stores.

---

## 6. Jobs

New types in `packages/core/src/jobs.ts` (`JOB_TYPES`, payload schemas), `packages/queue` (`QUEUE_SETTINGS`), and
`refIdFor` / `defaultRefId` cases in both `apps/worker/src/lib/jobs.ts` and `apps/web/src/lib/jobs.ts`. All have
`projectId = null`. Crons are scheduled in `apps/worker/src/main.ts` with `queue.schedule` (Melbourne time). Job
payloads contain ids only, never email addresses or tokens.

| Type | Payload (zod) | singletonKey / idempotency | Retries; expiry; heartbeat; concurrency | Does |
| --- | --- | --- | --- | --- |
| `email.send` | `{ emailMessageId: string }` | `email-send:{id}`; authoritative guard is the conditional claim (§6.2) | 3, 60 s backoff (transient only); 5 min; 60 s; 1 | State machine §6.2. Calls `provider.send` / `findSent`. |
| `email.dispatch` | `{}` | cron `* * * * *` | 0; 2 min | Finds `approved` messages with `scheduled_for <= now()` (or null), campaign not paused, provider ready; sets `queued`; enqueues `email.send`. Also re-queues `approved` messages blocked earlier by `provider_not_ready` once the provider is ready. |
| `email.automation.sweep` | `{}` | cron `*/10 * * * *` | 1, 60 s; 5 min | For each enabled automation: bookings completed since `max(enabledAt, now − maxAgeDays)` with no row for the dedupe key → create request/message (insert … `ON CONFLICT (dedupe_key) DO NOTHING`), or a `skipped` request with reason. Cancels pending requests/messages whose booking is no longer genuinely completed. |
| `email.campaign.expand` | `{ campaignId: string }` | `campaign-expand:{id}` | 2, 30 s; 10 min | Recomputes the audience; inserts one message per recipient with `dedupe_key = campaign:{campaignId}:{customerId}` (`ON CONFLICT DO NOTHING`), status `approved`, `scheduled_for` spread by the daily cap; campaign → `sending`. Re-running adds nothing new. |
| `email.provider.check` | `{ reason: z.enum(['manual','daily','startup']) }` | `email-check` | 2, 60 s; 2 min | **Read-only**: `GET /server`, `GET /message-streams`, `GET /webhooks` per stream, DMARC and Return-Path DNS look-ups. Upserts the `postmark` connection row. Never sends. |
| `email.suppression.push` | `{ suppressionId: string }` | `suppress-push:{id}` | 5, 60 s backoff; 1 min | Adds the address to Postmark's suppression list on the Broadcast stream (`marketing`) or both streams (`all`); sets `pushed_to_provider_at`. Skips if already set. |
| `webhook.process` (shared with publishing/Square) | `{ webhookEventId: string }` | `webhook:{id}` | 5, 10 s backoff; 2 min | `provider = 'postmark'` branch: `parseWebhook` → apply each event (§8.1.5) in one transaction; set `processed_at`. Re-processing is a no-op (all writes conditional or `ON CONFLICT DO NOTHING`). |
| `reviews.places.sync` | `{ reason: z.enum(['connect','daily','manual']) }` | `places-sync` | 2, 5 min; 2 min | Place Details (§8.2); writes the latest snapshot to the `google_places` row (overwrites; no history). Cron `41 5 * * *`. |
| `reviews.gbp.sync` | `{ reason: z.enum(['connect','daily','manual','weekly_full']) }` | `gbp-sync` | 2, 10 min; 10 min | Refresh token if needed → discovery on `connect` → reviews list (incremental on `review_updated_at` watermark; full on `weekly_full`) → upsert `reviews`. Maps quota 0 to "waiting for approval". Cron daily `53 5 * * *`, weekly full `7 6 * * 1`. |
| `google.disconnect` (shared with the website design) | `{ connectionId: string }` | `google-disconnect:{id}` | 3, 60 s; 1 min | Revokes the refresh token (`POST https://oauth2.googleapis.com/revoke`), then nulls the encrypted tokens. |
| `maintenance.cleanup` (existing) | unchanged | unchanged | unchanged | Adds: blank `payload` of processed `postmark` `webhook_events` older than 90 days (`payload = '{}'`; the row and its effects stay). |

### 6.1 Worker additions

- `apps/worker/src/main.ts`: register the handlers above; schedule the crons; `ALL_JOB_TYPES` must include them
  (the existing start-up guard fails otherwise). Kick `email.provider.check` with `reason: 'startup'` once.
- `apps/worker/src/context.ts`: add `email: EmailProvider | null` and `fetch` (injectable for tests).
- `apps/worker/src/lib/http.ts` (from the publishing design): fetch with the run's `AbortSignal`, 30 s timeout, and
  a redacting logger that strips `X-Postmark-Server-Token`, `X-Goog-Api-Key` and `Authorization`. Email addresses in
  logs are replaced by `sha256(email).slice(0,12)`.
- `apps/worker/src/lib/audit.ts` (from the publishing design).

### 6.2 `email.send` state machine (duplicate protection)

1. Load the message. If `status` is not `approved` or `queued` → exit (done or cancelled elsewhere).
2. **Unknown-outcome recovery.** If `submitted_at` is set and `provider_message_id` is null (a previous attempt
   crashed or timed out after calling Postmark): `findSent(id, to)`. Found → adopt the MessageID, status `sent`.
   Not found → status `failed`, `owner_action = 'check_before_retry'`, message "We couldn't confirm whether this
   email went out. Check the client's inbox or Postmark Activity before sending again." Exit without retry. The
   owner's **Send again** (audited `email.message.override_retry`) clears `submitted_at` and re-approves.
3. Load facts and run `evaluateSendPolicy`.
   - `block` → status per §3.5 (`suppressed` / `cancelled` / `failed`), `status_message`; linked review request →
     `skipped` / `cancelled` with the reason. Exit.
   - `defer` → `status = 'approved'`, `scheduled_for = deferUntil`. Exit.
4. **Claim**: `UPDATE email_messages SET status='sending', submitted_at=now(), stream=$s, consent_basis=$c,
   unsubscribe_token_hash=$h, body_html=$storedHtml, body_text=$storedText, is_sandbox=$sb WHERE id=$1 AND status
   IN ('approved','queued') AND submitted_at IS NULL RETURNING id`. No row → another attempt owns it; exit. Review
   requests get `click_token_hash` in the same transaction.
5. `run.checkCancelled()` (last point where cancel applies), then `provider.send`.
6. Result:
   - `ok` → `status='sent'`, `provider_message_id`, `sent_at`; review request `sent`, `sent_at`; campaign
     `sent_count + 1`; audit `email.message.sent` (worker).
   - `inactive_recipient` (Postmark ErrorCode 406) → `suppressed`; insert suppression `provider_inactive` (scope
     `marketing` on the Broadcast stream, `all` on Transactional).
   - `invalid_recipient` (300) → `failed` "This address was rejected as invalid."
   - `pending_approval` (HTTP 412) → `failed`; connection `capabilities.approved = false`.
   - `sender_not_verified` (400/401 codes for sender signature/domain) and `auth` (ErrorCode 10 / HTTP 401) →
     `failed`; connection state updated; dispatch stops sending until the next successful check.
   - `transient` with a response received (HTTP 429/5xx) → nothing was accepted: reset `submitted_at = null`,
     `status = 'queued'`, rethrow (pg-boss retries).
   - `unknown_outcome` (network error or timeout after the request left) → keep `submitted_at`, rethrow; the
     retry goes to step 2.
   - anything else → `failed` with Postmark's `ErrorCode` and `Message` stored verbatim.

Dedupe keys (unique `email_messages.dedupe_key`): `review:{bookingId}` · `review:manual:{customerId}:{yyyy-mm-dd}` ·
`follow_up:{bookingId}` · `campaign:{campaignId}:{customerId}` · `manual:{messageId}` · `preview:{messageId}`.
`review_requests.dedupe_key` uses the same value as its message.

---

## 7. API routes

All under `/api`, JSON, errors in the standard envelope (`docs/api.md`). "Owner" = `requireOwner`; "Staff+" =
signed-in owner or staff. Every state-changing route goes through `handleApi` (CSRF guard). Validation with Zod
schemas from `packages/core/src/email.ts`. Routes never call Postmark or Google except the OAuth callback token
exchange (§8.4).

### 7.1 Email: messages and templates

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| GET | `/api/email/messages` | query `status?`, `origin?`, `purpose?`, `customerId?`, `campaignId?`, `cursor?` | `{ items: EmailMessageDto[], nextCursor }` (no token data) | Owner |
| GET | `/api/email/messages/[id]` | — | `{ message, renderedHtml, timeline, consentBasis, blockers }` | Owner |
| POST | `/api/email/messages` | `{ customerId, templateId?, messageClass: 'transactional_factual'\|'campaign', subject, bodyMarkdown }` | `{ message }` (status `draft`, `dedupe_key = manual:{id}`) | Owner |
| PATCH | `/api/email/messages/[id]` | `{ subject?, bodyMarkdown? }` (only while `draft`) | `{ message, lint }` | Owner |
| POST | `/api/email/messages/[id]/approve` | `{ scheduledFor?: string \| null }` (ISO; Melbourne input converted client-side) | `{ message, blockers }`; 422 `UNSUPPORTED` with blockers when the gate would block | Owner |
| POST | `/api/email/messages/approve-batch` | `{ ids: string[] (≤ 100) }` | `{ approved: string[], blocked: Array<{ id, reasons }> }` | Owner |
| POST | `/api/email/messages/[id]/cancel` | — | `{ message }`; 409 if already `sending`/`sent` | Owner |
| POST | `/api/email/messages/[id]/send-again` | `{ confirm: true }` (only when `owner_action='check_before_retry'`) | `{ message }` | Owner |
| POST | `/api/email/messages/[id]/preview-to-me` | — | `{ previewMessageId }` (to the owner's own email) | Owner |
| POST | `/api/email/lint` | `{ messageClass, subject, bodyMarkdown, customerId? }` | `{ errors, warnings, preview: { subject, html, text } }` (no side effects) | Owner |
| GET | `/api/email/templates` | — | `{ items }` (seeds built-ins on first call) | Owner |
| POST | `/api/email/templates` | `{ name, purpose, messageClass, subject, bodyMarkdown }` | `{ template, lint }`; 400 on lint errors | Owner |
| PATCH | `/api/email/templates/[id]` | partial of the above, `enabled?` | `{ template, lint }` | Owner |
| PUT | `/api/email/automations/[name]` | `name ∈ follow_up \| review_request`; `{ enabled, mode, templateId, delayHours, dailyCap }` | `{ automation }`; 422 if enabling while blocked (no template, review link invalid, Square already sends feedback) | Owner |
| PUT | `/api/email/settings` | partial `EmailSettings` minus automations | `{ email }` | Owner |
| GET | `/api/email/status` | — | `{ state, liveMode, approved, webhooks, lastCheckedAt, message }` | Staff+ |
| POST | `/api/email/check` | — | `{ jobId }` (enqueues `email.provider.check`) | Owner |

### 7.2 Campaigns

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| GET / POST | `/api/email/campaigns` | POST `{ name, templateId?, subject, bodyMarkdown, audience: { lastVisitWithinDays: 90\|180\|365\|null } }` | list / `{ campaign }` | Owner |
| GET / PATCH | `/api/email/campaigns/[id]` | PATCH partial (only while `draft`) | `{ campaign, lint }` | Owner |
| POST | `/api/email/campaigns/[id]/audience-preview` | `{ cursor?, search? }` | `{ included: n, excluded: n, byReason, rows: Array<{ customerId, name, email, included, reason? }>, audienceHash, schedule: Array<{ date, count }> }` | Owner |
| POST | `/api/email/campaigns/[id]/approve` | `{ audienceHash, confirmConsent: true }` | `{ campaign, jobId }`; 409 if the hash changed | Owner |
| POST | `/api/email/campaigns/[id]/pause` · `/resume` · `/cancel` | — | `{ campaign }`; cancel sets unsent messages `cancelled` | Owner |

### 7.3 Clients, consent and suppressions

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| GET | `/api/customers` | query `q?`, `permission?` (`express`/`none`/`unsubscribed`/`suppressed`), `cursor?` | `{ items: Array<{ id, name, email, permission, reviewOptOut, lastEmailedAt }> }` | Staff+ |
| POST | `/api/customers` | `{ givenName, familyName?, email, phone? }` (manual client) | `{ customer }`; 409 if the email matches an existing client | Owner |
| PATCH | `/api/customers/[id]` | `{ givenName?, familyName?, email?, phone?, notes? }` (manual clients only; Square clients are edited in Square) | `{ customer }` | Owner |
| GET | `/api/customers/[id]/consent` | — | `{ state, events, suppressions }` | Staff+ |
| POST | `/api/customers/[id]/consent` | `{ method: 'in_person_device'\|'verbal_owner_recorded', wordingHash, clientConfirmed: true, note? }` (hash must equal the current wording's) | `{ state }` | Staff+ |
| POST | `/api/customers/[id]/unsubscribe` | `{ method: 'in_person'\|'phone'\|'reply_email'\|'owner_other', note? }` | `{ state }` | Staff+ |
| POST | `/api/customers/[id]/review-opt-out` | `{ value: boolean }` | `{ customer }` | Staff+ (setting `false` is Owner) |
| POST | `/api/email/suppressions/[id]/lift` | `{ note, confirm: string }` (rules §4.6) | `{ suppression }` | Owner |

### 7.4 Review requests and Google data

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| GET | `/api/reviews/requests` | query `status?`, `cursor?` | `{ items, counts: { sentThisMonth, openedThisMonth } }` | Owner |
| POST | `/api/reviews/requests` | `{ customerId, visitDate: 'YYYY-MM-DD', attest: true }` | `{ request, message }` or `{ request }` with `skipped` + reason | Owner |
| POST | `/api/reviews/requests/[id]/approve` | `{ scheduledFor?: string \| null }` | `{ request, message, blockers }` | Owner |
| POST | `/api/reviews/requests/approve-batch` | `{ ids: string[] }` | `{ approved, blocked }` | Owner |
| POST | `/api/reviews/requests/[id]/skip` | `{ reason: 'asked_in_person'\|'wrong_client_details'\|'other', note? }` (`note` required for `other`) | `{ request }` | Owner |
| POST | `/api/reviews/requests/[id]/cancel` | — | `{ request }` | Owner |
| PUT | `/api/reviews/link` | `{ url }` → validated, saved to `settings.business.googleReviewLink` | `{ url, valid }` | Owner |
| POST | `/api/reviews/link/use-google` | — (copies `writeAReviewUri` from the Places snapshot) | `{ url }` | Owner |
| GET | `/api/reviews/google` | — | `{ places: { state, rating, userRatingCount, fetchedAt, attribution } \| null, profile: { state, reviews, syncedAt, message } \| null }` | Owner |
| POST | `/api/reviews/google/refresh` | — | `{ jobIds }`; 429 within 10 minutes of the last refresh | Owner |
| PUT | `/api/integrations/google-places` | `{ placeId }` (`^[A-Za-z0-9_-]{10,300}$`) | `{ state: 'checking', jobId }` | Owner |
| POST | `/api/integrations/google-places/confirm` | `{ confirm: boolean }` | `{ state }` | Owner |
| DELETE | `/api/integrations/google-places` | — | 204 (deletes the snapshot and Place ID) | Owner |
| GET | `/api/integrations/google/connect` | query `product=business_profile` | 302 to Google (state + PKCE in a signed, HttpOnly, 10-minute cookie) | Owner |
| GET | `/api/integrations/google/callback` | query `code`, `state` | 302 to `/reviews?tab=google` (or Settings) with result | Owner (session required; state checked) |
| PUT | `/api/integrations/google-business-profile/location` | `{ locationName }` (one of the discovered list) | `{ state }` + enqueues `reviews.gbp.sync` | Owner |
| DELETE | `/api/integrations/google-business-profile` | — | 202 (status `disconnected`, enqueues `google.disconnect`) | Owner |

The two Google OAuth routes are shared with the website design; only the `product` value and scope differ.

### 7.5 Public routes (no session)

`apps/web/src/proxy.ts`: add `/api/webhooks/`, `/api/public/` and `/u/`, `/r/` to the public lists.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/webhooks/postmark` | `handlePublicApi(…, { csrf: false })`. Basic auth (§8.1.5); body ≤ 256 KB; stores the event once, enqueues `webhook.process`; 200 for stored or duplicate; 401 bad auth; 503 when webhook credentials are not configured. |
| GET | `/u/[token]` (page) | Unsubscribe confirmation page; no state change. |
| POST | `/api/public/unsubscribe/[token]` | `csrf: false`. Form post (`application/x-www-form-urlencoded`, no JS needed) or RFC 8058 body `List-Unsubscribe=One-Click`. Looks up `sha256(token)`; idempotent; 303 to `/u/[token]?done=1`. Unknown token → 303 to `/u/[token]?invalid=1`. |
| GET | `/r/[token]` (route handler) | Looks up `sha256(token)`; increments `click_count`, sets `first_clicked_at` once; always 302 to the current saved review link (same for every token, valid or not). If no valid link is saved: a plain page "Search for {business} on Google Maps to leave a review." |

Public routes have an in-memory per-IP limit (60/min for `/r` and `/u`, 300/min for webhooks) and log no email
addresses.

---

## 8. External API calls

### 8.1 Postmark (`apps/worker/src/lib/email/postmark.ts`, plain `fetch`, no SDK)

Base `https://api.postmarkapp.com`. Headers: `Accept: application/json`, `Content-Type: application/json`,
`X-Postmark-Server-Token: ${POSTMARK_SERVER_TOKEN}`. Only the **server** token is used (least privilege; no account
token). Endpoint details are from Postmark's public API reference, not the memo (postmarkapp.com was blocked);
§11.3 verifies each one.

#### 8.1.1 Send — `POST /email`

```json
{ "From": "\"Studio Name\" <hello@studio.com.au>", "To": "client@example.com", "ReplyTo": "hello@studio.com.au",
  "Subject": "…", "HtmlBody": "…", "TextBody": "…",
  "MessageStream": "<POSTMARK_TRANSACTIONAL_STREAM | POSTMARK_BROADCAST_STREAM>",
  "Tag": "review_request", "Metadata": { "emailMessageId": "…", "purpose": "review_request", "campaignId": "…" },
  "TrackOpens": false, "TrackLinks": "None" }
```

Success: HTTP 200 `{ "To", "SubmittedAt", "MessageID", "ErrorCode": 0, "Message": "OK" }`.

| Response | Mapped to |
| --- | --- |
| 200, `ErrorCode` 0 | `ok` |
| 422, `ErrorCode` 406 (inactive recipient) | `inactive_recipient` |
| 422, `ErrorCode` 300 (invalid email request) | `invalid_recipient` |
| 422, `ErrorCode` 400 / 401 (sender signature not found / not confirmed) | `sender_not_verified` |
| 401 or `ErrorCode` 10 (bad server token) | `auth` |
| 412 ("Account Pending Approval", memo §8) | `pending_approval` |
| 429, 500, 503 | `transient` |
| network error / timeout after the request was written | `unknown_outcome` |
| other 4xx/422 codes | `rejected`, stored verbatim |

Rate limits: Postmark publishes no per-second limit in the memo; we send one at a time (`email.send` concurrency 1)
and back off on 429. Volume is bounded by the daily caps (§5.3).

#### 8.1.2 Duplicate lookup — `GET /messages/outbound?count=10&offset=0&recipient={to}&metadata_emailMessageId={id}`

`TotalCount ≥ 1` → adopt `Messages[0].MessageID`. Called only in `email.send` step 2. If metadata filtering does not
work in the smoke test, fall back to `recipient` + `tag` + a ±10 min window around `submitted_at`, and treat more
than one match as "not sure" (owner check).

#### 8.1.3 Check — `GET /server`, `GET /message-streams`, `GET /webhooks?MessageStream={id}`

- `/server`: `Name` and `DeliveryType` (`Live` / `Sandbox`) → `deliveryType`; a missing field → `unknown` (shown
  as Live).
- `/message-streams`: both configured IDs exist, not archived; `MessageStreamType` is `Transactional` and
  `Broadcasts` respectively.
- `/webhooks`: at least one webhook per stream whose URL path is `/api/webhooks/postmark` with Bounce,
  SpamComplaint, SubscriptionChange (and Delivery) enabled. If the endpoint is unavailable to a server token →
  `webhooks.configured = null` and the UI asks the owner to tick "I added the webhook" (stored in the connection
  `config`).

#### 8.1.4 Suppression push — `POST /message-streams/{streamId}/suppressions`

Body `{ "Suppressions": [{ "EmailAddress": "…" }] }`; response lists `Status` per address (`Suppressed` /
`Failed`). `Failed` is logged and retried. The app **never** calls the suppression delete endpoint.

#### 8.1.5 Webhooks — `POST /api/webhooks/postmark`

- Configured by the owner in Postmark per stream (checklist §12) with the URL `https://{host}/api/webhooks/postmark`
  and HTTP Basic credentials `POSTMARK_WEBHOOK_USERNAME` / `POSTMARK_WEBHOOK_PASSWORD` (random, ≥ 32 characters).
  The route compares `Authorization: Basic …` with `timingSafeEqual` on SHA-256 digests. Postmark offers no
  payload signature (to confirm, §11.3), so the trust rule is: **webhooks can only restrict sending or update
  delivery display; nothing in a webhook can grant consent, lift a suppression or cause a send.**
- `external_event_id` (deterministic, no raw addresses):
  - `Bounce` → `bounce:{ID}`
  - `SpamComplaint` → `complaint:{ID}`
  - `Delivery` → `delivery:{MessageID}:{sha256(Recipient).slice(0,16)}`
  - `SubscriptionChange` → `subscription:{MessageID ?? 'none'}:{sha256(Recipient).slice(0,16)}:{ChangedAt}:{SuppressSending}`
  - anything else (`Open`, `Click`, unknown) → `other:{sha256(rawBody)}`, stored, processed as a no-op.
- `webhook_events.signature_valid = true` (only authenticated deliveries are stored). Insert
  `ON CONFLICT (provider, external_event_id) DO NOTHING`; enqueue `webhook.process` only for new rows.
- Processing (`webhook.process`, provider `postmark`):

| Event | Effect |
| --- | --- |
| `Delivery` | Message `sent` → `delivered`, `delivered_at`; campaign `delivered_count + 1` (only on that transition). |
| `Bounce` with `Type = HardBounce` or `Inactive = true` | Message → `bounced`; suppression `hard_bounce`, scope `all`; consent unchanged; campaign `bounce_count + 1`; auto-pause check. |
| `Bounce` other types (soft, transient) | Message keeps `sent`/`delivered`; `status_message` "Temporary delivery problem ({Type})". No suppression. |
| `SpamComplaint` | Message → `complained`; suppression `spam_complaint`, scope `all`; ledger `withdrawn` (method `postmark_unsubscribe`); campaign `complaint_count + 1`; auto-pause check. |
| `SubscriptionChange`, `SuppressSending = true` | Reason `ManualSuppression` (recipient unsubscribed) → suppression `unsubscribe`, scope `marketing`, ledger `withdrawn`; `HardBounce` → as hard bounce; `SpamComplaint` → as complaint. Pending commercial messages to the address → `suppressed`. |
| `SubscriptionChange`, `SuppressSending = false` | Recorded only. The app's suppression stays; the client's row shows "Postmark reactivated this address; the app still blocks it until you record new permission (or confirm the address was fixed)." |

Auto-pause: after any campaign bounce/complaint, if `complaint_count / sent_count > 0.001` or
`bounce_count / sent_count > 0.05` → campaign `paused`, `paused_reason`, audit `email.campaign.auto_paused`
(memo §8).

### 8.2 Google Places API (New) — Tier 1 (`apps/worker/src/lib/google/places.ts`)

- `GET https://places.googleapis.com/v1/places/{placeId}?languageCode=en-AU&regionCode=AU`
  - Headers: `X-Goog-Api-Key: ${GOOGLE_MAPS_API_KEY}`, `X-Goog-FieldMask`.
  - Field mask on `connect`: `id,displayName,formattedAddress,googleMapsLinks,rating,userRatingCount`.
    Daily and manual: `googleMapsLinks,rating,userRatingCount` (memo §7 Build notes).
  - Response used: `rating`, `userRatingCount`, `googleMapsLinks.writeAReviewUri`,
    `googleMapsLinks.readReviewsUri`, and on connect `displayName.text`, `formattedAddress`.
- Storage: `config.placeId` (cacheable indefinitely, memo §7); `capabilities` holds only the **latest** snapshot
  `{ rating, userRatingCount, writeAReviewUri, readReviewsUri, fetchedAt }`, overwritten each sync (no history,
  because the caching rules for rating history were not read; memo §7 open question).
- Volume: 1 call/day + owner refresh ≤ 1 per 10 min → about 30–60 calls/month, far below the 5,000/month free cap the
  memo cites for Place Details Pro.
- Key: server-side only, restricted in Cloud Console to "Places API (New)" (and to the server's IP where the host
  allows). Never sent to the browser.
- Errors: 400 `INVALID_ARGUMENT` → "That Place ID isn't valid"; 403 `PERMISSION_DENIED` → "The key isn't allowed to
  use Places API (New), or billing is off"; 404 `NOT_FOUND` → "Google no longer recognises this Place ID; look it up
  again"; 429 `RESOURCE_EXHAUSTED` → transient, retry next day; 5xx → transient. Status `error` with `last_error`.

### 8.3 Google Business Profile APIs — Tier 2 (`apps/worker/src/lib/google/business-profile.ts`)

- Scope: `https://www.googleapis.com/auth/business.manage` only (memo §7).
- Discovery (`connect`):
  `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts` →
  `GET https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations?readMask=name,title,storefrontAddress&pageSize=100`.
  One location → chosen automatically; several → stored in `config.locations` for the owner to choose.
- Reviews: `GET https://mybusiness.googleapis.com/v4/{account}/{location}/reviews?pageSize=50&orderBy=updateTime%20desc&pageToken=…`
  (memo §7: v4 `reviews.list`, page size 50). Incremental sync stops at the first review with
  `updateTime <= max(review_updated_at)`; `weekly_full` reads all pages. Upsert into `reviews` on
  `(provider, external_review_id)`: `rating` from `starRating` (`ONE`…`FIVE` → 1–5), `reviewer_name` from
  `reviewer.displayName` ("Anonymous" when `isAnonymous`), `comment`, `review_created_at = createTime`,
  `review_updated_at = updateTime`, `reply_text = reviewReply.comment`, and `raw` keeping `reviewReplyState` and
  `policyViolation` for display (memo §7). Never reference `BUSINESS_CONVERSATIONS` or the Q&A API.
- Rate limits: 300 QPM once approved, 0 before (memo §7). We make fewer than 20 calls/day.
- Token refresh: `POST https://oauth2.googleapis.com/token` (`grant_type=refresh_token`); new access token encrypted
  with `encryptSecret`.
- Error mapping: HTTP 429 or 403 mentioning quota with a 0 limit → state `awaiting_approval` (not an error); 403
  `SERVICE_DISABLED` / "has not been used" → "Enable the {API name} in Google Cloud"; 401 or `invalid_grant` on
  refresh → `needs_reauth` (hint: "If this happens every 7 days, the Google consent screen is still in Testing —
  publish it to Production", memo §7); 404 location → "This location is no longer available; choose again".

### 8.4 Google OAuth (shared with the website design)

- Authorise: `https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri={APP_URL}/api/integrations/google/callback&response_type=code&scope=https://www.googleapis.com/auth/business.manage&access_type=offline&prompt=consent&include_granted_scopes=false&state=…&code_challenge=…&code_challenge_method=S256`.
- Callback: checks `state` against the signed cookie, then exchanges the code at `POST https://oauth2.googleapis.com/token`
  **inside the request** with a 10 s timeout. This is the one synchronous external call in this design: the code is
  single-use and short-lived, so a job would add nothing. Tokens are encrypted (`encryptToken`) into the
  `google_business_profile` row; `scopes` stored; then `reviews.gbp.sync` (`connect`) is enqueued.
- Disconnect: `google.disconnect` job revokes and wipes tokens.

### 8.5 DNS (advisory, `node:dns/promises`)

`resolveTxt('_dmarc.<domain>')` (expects a `v=DMARC1` record) and `resolveCname('pm-bounces.<domain>')` (custom
Return-Path). Results are hints only.

---

## 9. UI

Follows the existing design system (`apps/web/src/components/ui`: `Card`, `Tabs`, `StatusPill`, `Switch`,
`Dialog`, `Field`, `EmptyState`, `Alert`, `Badge`, `Toast`), charcoal and white with the one accent colour, mobile
first (lists become stacked cards under `md`), plain language, no technical ids in normal views. Video Studio stays
the main destination; nothing here is added to the mobile primary bar.

### 9.1 Pages

- **`/emails`** (replaces the current `SectionOverview` page; the overview is kept as the "not set up" header card).
  Header: title, provider status pill (Not set up · Test server · Live · Waiting for approval · Problem) and "n to
  approve". Tabs (`?tab=`): **To approve** · **Sent** · **Campaigns** · **Templates** · **Clients** · **Automations**.
  Drafts, templates, clients and consent work while the provider is not set up; Approve buttons are disabled with
  the reason.
- **`/reviews`** (replaces the current page). Top row: Review link card and Rating card (§4.8). Tabs: **Requests**
  (approval queue, list, "Send a request", Automatic requests card) · **Reviews on Google**.
- **`/u/[token]`** public page: business name and accent only, no app navigation, works without JavaScript.
- **Settings → Integrations**: three cards from `buildIntegrationStatuses` — "Email (Postmark)", "Google rating
  (Places)", "Google Business Profile" — with `state` and `liveMode` (§9.3).
- **Appointments** (Square design): each past booking row shows a small "Review request: Waiting for approval /
  Sent / Skipped — no permission / Cancelled" badge linking to Reviews, next to the Square design's "Mark as
  completed" / "Didn't happen" buttons.
- **Dashboard**: one line in the existing "In progress"/attention area: "3 emails and 2 review requests waiting for
  your approval" (links), shown only when non-zero.

### 9.2 Components (new, `apps/web/src/components/email/` and `…/reviews/`)

`EmailStatusPill`, `ApprovalQueue` (shared by both pages, filters by purpose), `MessageRow` / `MessageDetailDrawer`
(timeline, sandboxed `<iframe sandbox="" srcdoc>` preview), `EmailEditor` (subject, body, variable chips,
`LintPanel`, live preview through `/api/email/lint` debounced 400 ms), `TemplateList`, `CampaignWizard` (Write →
Audience → Review → Sending), `RecipientPreviewTable`, `ClientList`, `ConsentDialog` (device and verbal modes),
`UnsubscribeDialog`, `SuppressionLiftDialog`, `AutomationCard` (switch, mode, template, delay, cap, window,
Square-sends checkboxes), `ReviewLinkCard`, `GoogleRatingCard`, `GoogleReviewsList`, `ManualReviewRequestDialog`,
`SkipReasonDialog`.

### 9.3 States and copy rules

- `IntegrationStatus` gains (as in the publishing design) `state`, `liveMode` — extended with `'sandbox'` — and
  `verified`. Email card replaces "Email sending (Resend)".
- Status words through `statusLabel`/`toneForStatus`, adding: `sending` (info), `delivered` (success), `bounced`
  (danger), `complained` (danger, label "Spam complaint"), `suppressed` (warning, label "Not sent"), `skipped`
  (neutral), `pending_approval` (warning, "Waiting for approval"), `scheduled` (neutral), `awaiting_approval`
  (warning, "Waiting for Google").
- Any message with `is_sandbox = true` shows "Test — not delivered" instead of Sent/Delivered.
- Empty states: To approve — "Nothing waiting. Follow-ups and review requests appear here after appointments are
  completed." Sent — "No emails sent yet." Clients — "No clients yet. Connect Square or add a client." Reviews on
  Google — the tier state, never a placeholder number.
- Copy to fix in existing files: Reviews page says "Ask happy clients for a Google review" (selective wording,
  memo §7) → "Ask every client after a completed appointment, the same way". Business tab hint "Ask for reviews" →
  "Read reviews → Get more reviews (on a computer)". Emails page requirements mention Resend → Postmark.

---

## 10. Security and privacy

- **Owner-only**: everything that sends, approves, edits templates or settings, connects/disconnects, lifts
  suppressions, or reads message bodies and history. **Staff+**: client list, consent state, recording consent,
  recording unsubscribes, setting review opt-out to true (fail-safe actions plus evidence capture).
- **CSRF**: all state-changing session routes through `handleApi`. Public POSTs (`/api/webhooks/postmark`,
  `/api/public/unsubscribe/…`) are exempt by design: the first authenticates with Basic credentials, the second can
  only ever reduce sending.
- **Secrets** server-side only: `POSTMARK_SERVER_TOKEN`, webhook credentials and `GOOGLE_MAPS_API_KEY` in env (worker
  and web as needed: the web app needs only the webhook credentials and Google OAuth client; the server token and
  Maps key go to the worker only). Google OAuth tokens encrypted at rest with `packages/db` AES-256-GCM. Logs redact
  tokens, keys and email addresses (§6.1).
- **Least privilege**: Postmark server token (no account token); Places key restricted to one API; Google scope
  `business.manage` only.
- **Tokens in links**: unsubscribe and review-click tokens are random 32 bytes (base64url), stored only as SHA-256,
  never expire, and do not depend on `APP_SECRET` (rotating secrets cannot break the 30-day unsubscribe rule).
  Stored message bodies hold markers, not tokens (§3.2). A token reveals nothing; the unsubscribe page masks the
  address (`j•••@gmail.com`).
- **Rendering safety**: Markdown subset with full escaping; previews in a sandboxed iframe without scripts; client
  names and template text are data, never HTML. AI is not used to write emails in this design.
- **Webhook data**: only authenticated deliveries stored; payloads blanked after 90 days; effects (suppressions,
  ledger) kept.
- **Retention**: `email_messages` (the send log), `consent_events` and `email_suppressions` are kept at least 24
  months and are not deleted when a client is soft-deleted (suppressions must keep working; ledger is evidence).
  The privacy notice text in §12 says so.
- **Audit log** actions: `email.provider.check_requested`, `email.message.create|edit|approve|cancel|override_retry|preview`,
  `email.message.sent` (worker), `email.template.create|update|archive`, `email.automation.update`,
  `email.settings.update`, `email.campaign.create|approve|pause|resume|cancel|auto_paused`, `consent.granted`,
  `consent.withdrawn`, `suppression.lifted`, `review_request.manual_create|approve|skip|cancel`,
  `review_link.update|use_google`, `integration.google_places.connect|confirm|disconnect`,
  `integration.google.connect|disconnect`. Entries hold ids and reasons, not message bodies.
- **Data in the US**: Postmark (memo §8). Google data stays with Google; only the latest rating snapshot and
  Business Profile review text are stored locally.

---

## 11. Testing

### 11.1 Unit (vitest, no network, no DB) — `packages/core/test/email*.test.ts`

- `renderEmail`: escaping (`<script>` in a name), Markdown subset, unknown variable error, footer always present,
  commercial footer only for commercial classes, stored copy has markers not tokens.
- `lintEmail`: every word list (positive and negative cases, e.g. "free" blocks a review request; "freedom" doesn't),
  factual message with a link fails, reminder wording fails, missing `{{review_link}}` fails.
- `foldConsent`: grant then unsubscribe then grant; tie goes to withdrawal; per-address change; inferred off by
  default; inferred with 2 visits in 12 months and lapsing at 12 months; withdrawal ever → no inferred.
- `evaluateSendPolicy`: one test per reason code; preview only to the owner's address; sandbox label.
- `isGenuinelyCompleted` / `reviewEligibility`: `square_status` rejected; time-passed booking with `none` rejected;
  cancelled/no-show rejected; `enabledAt` and `maxAgeDays` boundaries; `recently_asked`; **parameter-key pin test**
  (no satisfaction or rating input).
- `nextSendSlot` across both DST changes (e.g. 4 Oct 2026 and 4 Apr 2027) and the window edges; Melbourne-day caps.
- `validateReviewLink`; webhook `external_event_id` derivation; Basic-auth comparison; `parseWebhook` for each
  `RecordType` (fixtures in `apps/worker/test/fixtures/postmark/`).
- `buildIntegrationStatuses` for every email/Places/Business Profile state.

### 11.2 Integration (`TEST_DATABASE_URL`; `FakeEmailProvider` and fake `fetch` for Google)

- Sweep: completed booking → exactly one request + message, even when the sweep runs twice concurrently; booking
  completed before `enabledAt` ignored; cancellation after creation → request and message `cancelled`.
- `email.send` run twice for the same message → one provider call. Crash after claim (provider fake throws
  `unknown_outcome`) → retry calls `findSent`; found → `sent`; not found → `check_before_retry`, no second send.
- 429 → re-queued and sent on retry; 406 → `suppressed` + suppression row; 412 → connection `approved=false`.
- Unsubscribe page POST → suppression, ledger row, queued campaign messages to that address `suppressed`, push job
  enqueued; repeated POST idempotent; GET changes nothing.
- Webhook route: wrong credentials → 401 and nothing stored; replayed delivery → one row, one job; `SpamComplaint`
  on a campaign of 42 → auto-pause; `SuppressSending=false` does not lift the suppression.
- Daily cap: 12 eligible with cap 10 → 10 today, 2 tomorrow at 9:00 Melbourne; one automated email per client per day.
- Campaign approve with stale `audienceHash` → 409; expand twice → no duplicates.
- Places sync writes only the latest snapshot; 404 → `error`. GBP sync: quota-0 429 → `awaiting_approval`;
  incremental watermark; `invalid_grant` → `needs_reauth`.
- Web routes: staff gets 403 on approve/send/settings; CSRF guard on all session POSTs; public routes reachable
  without a cookie (proxy).

### 11.3 Sandbox smoke test (owner present; no client ever emailed)

Script `apps/worker/scripts/email-smoke.ts` (manual, documented in `docs/testing.md`), run with a Postmark server
whose delivery type is **Sandbox** (or the `POSTMARK_API_TEST` token for request validation only):
1. `email.provider.check` → records `DeliveryType`, streams, webhooks list.
2. Send one transactional and one broadcast message to the owner's own address; record the real response shapes and
   the rendered `{{{ pm:unsubscribe }}}` link.
3. `findSent` by metadata finds both.
4. Postmark's "send test webhook" for each trigger → stored, processed, effects visible.
5. Click the app's `/u/` link and Postmark's link on the broadcast message → both suppress the owner's address
   (then lift it as owner).
6. Record results (date, response samples with addresses removed) in `docs/research/email-smoke-YYYY-MM-DD.md`.

Places: one Place Details call on the owner's Place ID (read-only). Business Profile: discovery call (read-only).

### 11.4 Only verifiable with the owner's real accounts

- Postmark account approval, DKIM/Return-Path verification, and real delivery to Gmail/Outlook (one-click
  unsubscribe button shown by Gmail, spam-folder placement).
- Whether Postmark's unsubscribe links still work after 30 days (the app's own link covers it either way).
- Real Square completions driving the automation (depends on the Square design's matcher on real payments).
- Places billing SKU for the field mask; Google Business Profile API approval for this profile.
- The owner's first live send: a manual one-off email to a consenting client, approved by the owner.

---

## 12. Owner setup checklist (plain language)

**Email (needed before anything is sent):**
1. Make sure you own your business domain (e.g. `yourstudio.com.au`) and can edit its DNS records.
2. Create a Postmark account. Create a server called "Studio Assistant". Start it as a **Sandbox** server for
   testing; make a **Live** one when you're ready. Ask before signing up for the paid plan (about US$15/month for
   10,000 emails when the research was done — check the current price on Postmark's site).
3. In Postmark, add your domain and add the DKIM and Return-Path records it shows you to your DNS. Add a DMARC record
   (`v=DMARC1; p=none; rua=mailto:you@yourstudio.com.au`) if you don't have one.
4. Request account approval in Postmark (until then you can only email addresses at your own domain).
5. Make sure the server has a **Transactional** stream and add a **Broadcast** stream. Note their IDs.
6. In each stream, add a webhook to `https://<your app address>/api/webhooks/postmark` with a username and password
   (ask your developer to generate long random values), and tick Delivery, Bounce, Spam complaint and Subscription
   change. Leave Open and Click off.
7. Give your developer, for the server settings: `EMAIL_PROVIDER=postmark`, the server API token, the two stream IDs,
   the webhook username and password, and the "from" address (e.g. `"Your Studio" <hello@yourstudio.com.au>`).
8. Fill in Settings → Business: street address, phone and email. Every email shows these.
9. In Square Dashboard, check which automatic messages Square sends (confirmations, reminders, feedback requests) and
   tick the matching boxes in Emails → Automations.
10. Register your domain in Google Postmaster Tools (free) to watch your spam rate.
11. Add a line to your privacy notice: "We send emails through Postmark, which stores delivery data in the United
    States. We keep records of emails we send and of your email preferences for at least two years."
12. Start recording email permission at the counter (Emails → Clients → Record permission). Never email anyone to ask
    for permission.

**Google review requests (works straight away):**
13. On a computer, open your Google Business Profile → Read reviews → Get more reviews → copy the link. Paste it in
    Reviews → Review link and press Test link.

**Optional — your Google rating on the Reviews page:**
14. In Google Cloud, create a project, turn on billing, enable "Places API (New)", and create an API key restricted
    to that API. Give it to your developer as `GOOGLE_MAPS_API_KEY`. Find your Place ID with Google's Place ID
    Finder and enter it under Reviews.

**Optional — your Google reviews listed in the app (may never be approved):**
15. Your profile must have been verified for 60+ days and you need a website. In the same Google Cloud project enable
    the Business Profile APIs, set up the OAuth consent screen and **publish it to Production**, create an OAuth
    client (web) with the redirect `https://<your app address>/api/integrations/google/callback`, and submit
    Google's "Application for Basic API Access". It takes about 14 days and isn't guaranteed. Then press Connect in
    Reviews → Reviews on Google.

---

## 13. Files to create / modify

**packages/core**
- Create `src/email.ts` (classes, streams, `renderEmail`, `evaluateSendPolicy`, `foldConsent`, schemas for routes),
  `src/email-lint.ts`, `src/reviews.ts` (`isGenuinelyCompleted`, `reviewEligibility`, `validateReviewLink`, skip
  reasons), `src/zoned-time.ts` (`nextSendSlot`, Melbourne day bounds); export from `src/index.ts`.
- Modify `src/settings.ts` (`EmailSettingsSchema`, `ReviewSettingsSchema` in `AppSettingsSchema`), `src/jobs.ts` (new
  types and payloads; `webhook.process` and `google.disconnect` shared — add once).
- Tests: `test/email-render.test.ts`, `test/email-lint.test.ts`, `test/email-policy.test.ts`,
  `test/consent.test.ts`, `test/reviews.test.ts`, `test/zoned-time.test.ts`.

**packages/db**
- Modify `src/schema.ts` (new tables, columns, indexes, enum values, relations, types); create
  `drizzle/00NN_email_reviews.sql` + meta snapshot via `drizzle-kit generate`.

**packages/queue**
- Modify `src/index.ts` `QUEUE_SETTINGS` for every new type; `test/queue-settings` expectations in the worker.

**packages/config**
- Modify `src/index.ts`: `EMAIL_PROVIDER` (`none|postmark`, default `none`), `POSTMARK_SERVER_TOKEN`,
  `POSTMARK_TRANSACTIONAL_STREAM` (default `outbound`), `POSTMARK_BROADCAST_STREAM` (default `broadcast`),
  `POSTMARK_WEBHOOK_USERNAME`, `POSTMARK_WEBHOOK_PASSWORD`, `GOOGLE_MAPS_API_KEY`; validation (postmark requires token
  and `EMAIL_FROM`); `describeCapabilities.integrations.email` uses Postmark. `RESEND_API_KEY` stays, unused
  (documented fallback). `.env.example` updated with comments.

**apps/worker**
- Create `src/lib/email/provider.ts`, `src/lib/email/postmark.ts`, `src/lib/email/facts.ts` (loads policy inputs),
  `src/lib/email/tokens.ts`, `src/lib/google/places.ts`, `src/lib/google/business-profile.ts`,
  `src/lib/google/oauth.ts` (refresh/revoke; shared), `src/handlers/email-send.ts`, `src/handlers/email-dispatch.ts`,
  `src/handlers/email-sweep.ts`, `src/handlers/email-campaign.ts`, `src/handlers/email-check.ts`,
  `src/handlers/email-suppression.ts`, `src/handlers/webhook.ts` (or add the `postmark` branch if publishing created
  it), `src/handlers/reviews-places.ts`, `src/handlers/reviews-gbp.ts`, `src/handlers/google-disconnect.ts`;
  `scripts/email-smoke.ts`.
- Modify `src/main.ts` (register + crons), `src/context.ts` (`email`, `fetch`), `src/lib/jobs.ts` (`refIdFor`),
  `src/handlers/cleanup.ts` (webhook payload blanking). Reuse `src/lib/http.ts`, `src/lib/audit.ts` from publishing.
- Tests: `test/email-send.integration.test.ts`, `test/email-sweep.integration.test.ts`,
  `test/email-webhook.integration.test.ts`, `test/reviews-google.integration.test.ts`, `test/helpers/fake-email.ts`,
  `test/fixtures/postmark/*.json`, `test/fixtures/google/*.json`.

**apps/web**
- Create routes: `src/app/api/email/**` (messages, approve, approve-batch, cancel, send-again, preview-to-me, lint,
  templates, automations, settings, status, check, campaigns/**, suppressions/[id]/lift),
  `src/app/api/customers/**` (list, create, [id], consent, unsubscribe, review-opt-out),
  `src/app/api/reviews/**` (requests, approve, approve-batch, skip, cancel, link, link/use-google, google, google/refresh),
  `src/app/api/integrations/google-places/**`, `src/app/api/integrations/google/{connect,callback}/route.ts`,
  `src/app/api/integrations/google-business-profile/{route.ts,location/route.ts}`,
  `src/app/api/webhooks/postmark/route.ts`, `src/app/api/public/unsubscribe/[token]/route.ts`,
  `src/app/r/[token]/route.ts`, `src/app/u/[token]/page.tsx` (outside the `(app)` group, own minimal layout).
- Create libs: `src/lib/email.ts` (server-side queries, `recordConsentEvent`, `recordUnsubscribe`,
  `ensureDefaultTemplates`), `src/lib/reviews.ts`, `src/lib/public-rate-limit.ts`, `src/lib/google-oauth.ts`.
- Create components under `src/components/email/` and `src/components/reviews/` (§9.2).
- Modify: `src/app/(app)/emails/page.tsx`, `src/app/(app)/reviews/page.tsx` (new pages; fix selective copy),
  `src/app/(app)/settings/_components/business-tab.tsx` (review-link hint),
  `src/app/(app)/page.tsx` (approval counts line), `src/lib/integrations.ts` (Postmark, Places, Business Profile
  states), `src/lib/shared/integration-types.ts` (`state`, `liveMode` incl. `'sandbox'`, `verified` — shared with
  publishing), `src/lib/jobs.ts` (`defaultRefId`), `src/proxy.ts` (public paths), `src/components/ui/status-pill.tsx`
  (new statuses).
- Tests: `test/email-routes.integration.test.ts`, `test/reviews-routes.integration.test.ts`,
  `test/public-routes.integration.test.ts`, `test/integrations.test.ts` (extend).

**docs**
- Modify `docs/api.md` (new routes), `docs/security.md` (webhook auth, public routes, tokens, retention),
  `docs/architecture.md` (email flow), `docs/testing.md` (smoke test), `docs/deployment.md` (env vars, public
  paths must be reachable), `README.md` (feature status: email/reviews "waiting on account access" until verified).

---

## 14. Open questions

1. **Square completion rule.** This design assumes the Square design sets `completion_source = 'payment'` from its
   matcher and offers "Mark as completed" / "Didn't happen". If the matcher's confidence is low on real data, should
   payment-only completions always go to the approval queue even in automatic mode? (Default here: they follow the
   owner's mode, with a 3-hour minimum delay for correction.)
2. **Square's own messages.** Does the owner's Square account send feedback or review prompts (e.g. on receipts)? The
   owner ticks this in Automations; the answer decides whether review automation can be switched on.
3. **Postmark specifics not covered by the memo**: `DeliveryType` on `GET /server`, `GET /webhooks` with a server
   token, outbound search by `metadata_` filter, `{{{ pm:unsubscribe }}}` in non-template sends, and the absence of
   webhook signatures. All are checked in the smoke test (§11.3); the design has fallbacks for each.
4. **Places billing**: which SKU `rating,userRatingCount` triggers (the memo cites Pro, 5,000 free/month) and the
   exact attribution text required next to the rating.
5. **Existing consents**: does the owner already hold email permissions with records (wording, date)? If so, a
   one-off import with the original wording and evidence could be added; without records they cannot be imported.
6. **Unsubscribe scope**: one button stops all marketing, review requests included. Should the page also offer "only
   stop review requests"? (Not built; simpler for clients and safer legally.)
7. **Shared Google OAuth**: the website design also needs Google sign-in (Search Console, Performance). The lead plan
   should build the connect/callback routes once and decide whether one connection holds both scopes or two
   connections are kept (this design assumes a separate `google_business_profile` row with `business.manage` only).
8. **Privacy**: confirm the Privacy Act small-business exemption applies (turnover ≤ $3M, memo §8) and that the
   owner is comfortable keeping the send log and consent records for 24 months.
9. **Whether a bare review request is a commercial message** (memo §8 open question): treated as yes here, so review
   requests need email permission. If the owner wants requests sent to clients without marketing permission, that
   needs legal advice first; the design does not offer it.
