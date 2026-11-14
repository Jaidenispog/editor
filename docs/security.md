# Security notes

Studio Assistant is a private, single-business app: the owner and, optionally, a few staff accounts. This
page describes what is in place today, where it lives in the code, and what is **not** done yet.
Implementation details for the web app are in `apps/web/README.md`.

## Accounts and sign-in

- **Accounts.** Owner and staff roles. The first account is created at `/setup`, which only works while no
  account exists, or from the command line (`pnpm --filter @studio/web create-owner`, `pnpm db:seed`).
  Owner-only actions (settings, integrations) return 403 for staff.
- **Passwords.** Hashed with Argon2id (`@node-rs/argon2`, 19 MiB memory, 2 iterations), minimum 10 characters,
  never logged. Changing the password signs out the account's other sessions.
- **Login throttling.** Blocked after 8 failed attempts per email or 30 per IP address within 15 minutes, with
  a generic error message. Unknown emails still spend a full Argon2 check, so response times do not reveal
  which emails exist. Attempts are recorded in `login_attempts`, and sign-ins and changes in `audit_log`.
- **Sessions.** An opaque random token (32 bytes) in the `sa_session` cookie. The database stores only its
  SHA-256 hash, so a database leak does not expose usable sessions. Sessions have a sliding 30-day expiry and
  can be listed and signed out per device.

## Cookie flags

`sa_session` is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days, and `Secure` whenever
`NODE_ENV=production` and `APP_URL` starts with `https://`. A production build served over plain
`http://localhost` (a local Docker test) leaves `Secure` off so sign-in still works there. **Always set
`APP_URL` to the https address in a real deployment.**

## CSRF guard

Every state-changing request (anything but GET/HEAD/OPTIONS) must either carry an `Origin` header that
matches `APP_URL` or the request's own origin, or come with `Sec-Fetch-Site: same-origin`. Requests with
neither are refused with 403 (`apps/web/src/lib/csrf.ts`). Together with `SameSite=Lax` this stops other
sites from acting with the owner's cookie.

Other response headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`X-Frame-Options: DENY`, and a restrictive `Permissions-Policy`.

## Media privacy

- Uploads, proxies, previews and exports are never public.
- Browsers only receive **expiring links**, valid for `MEDIA_LINK_TTL_SECONDS` (default 1 hour):
  - S3 driver (Supabase Storage, R2, S3): presigned URLs to a private bucket.
  - Local driver: `/api/media/<token>`, where the token is HMAC-SHA256 signed with `APP_SECRET` and checked
    with a timing-safe comparison. The token carries the storage key and expiry in readable (signed, not
    encrypted) form. Keys contain only random ids, never names.
- Uploaded files and AI output are treated as data. Edit plans are validated against the real footage before
  rendering, captions must come from the transcript, and on-screen text is length-limited.

## Secrets and encryption at rest

- All secrets come from environment variables, are validated at start-up (`packages/config`), and are never
  sent to the browser. Logs redact secret fields. Docker images contain no secrets (`.dockerignore` excludes
  `.env*`).
- **OAuth and integration tokens** are encrypted with AES-256-GCM before they are stored
  (`packages/db/src/crypto.ts`): a random 96-bit IV per value, plus an authentication tag. The key is
  `APP_ENCRYPTION_KEY` (32 bytes, base64) or, if that is unset, derived from `APP_SECRET` with HKDF-SHA256.
  Set `APP_ENCRYPTION_KEY` in production, so that rotating `APP_SECRET` does not make stored tokens unreadable.
- Database and media encryption at rest is provided by the host:
  - Supabase and the cloud object stores encrypt their disks.
  - A self-managed VPS should use the provider's encrypted volumes where offered.
  - *Confirm against provider documentation.*

## Webhook signature verification

- The design: webhooks (Square first) are verified by their HMAC signature before anything is processed, and
  stored once per provider event id in `webhook_events` (unique index), so a replayed delivery is ignored.
- `SQUARE_WEBHOOK_SIGNATURE_KEY` holds the key.
- **Status:** two webhook endpoints are built. `POST /api/webhooks/square` checks Square's HMAC signature in constant
  time and only queues a re-read from Square (see "Square appointments" below); `POST /api/webhooks/postmark` checks
  long random Basic credentials in constant time and may only restrict sending (see "Email and review requests"
  below). An invalid delivery is refused and never stored; a replayed one is stored once.

## Data deletion

- **Deleting a project** (typed confirmation in the UI) cancels its
  jobs, deletes its whole storage prefix (originals, proxies, frames, previews, exports) and removes its rows.
  This is permanent: there is no recycle bin.
- **Removing a clip or a music track** deletes its files as well.
- **Worker temp folders** are removed after each job. Anything left by a crash is removed by the hourly
  cleanup after 24 h, and abandoned uploads are cleaned up the same way.
- **Backups** keep deleted data until they expire (see `docs/deployment.md`). Include that in any privacy
  statement.

## Trends (Stage B, WP3)

- `YOUTUBE_API_KEY` is a server setting used only by the worker, sent only in the request URL to
  `www.googleapis.com`; `lib/http.ts` redacts the `key` parameter in logs (a test checks the logs) and status DTOs show
  only that it is set. Restrict the key to YouTube Data API v3 in Google Cloud.
- Stored from YouTube: video id, title (≤ 160 characters, control characters removed), channel title and category id.
  No thumbnails, descriptions or statistics. Items are deleted 7 days after they were fetched. YouTube's caching
  and display rules were not retrieved (memo §11); confirm them before go-live.
- Links to other services open in a new tab with `rel="noopener noreferrer"`; noted links must be http(s).
- Owner only: turning sources on/off, manual refresh (at most every 6 h), curated references. Anyone signed in may note
  a trend; only the owner or the person who noted it may delete a note. Audit actions: `trends.watch_added`,
  `trends.watch_removed`, `trends.noted`, `trends.note_deleted`, and `trends.source_<status>` from the worker when a
  source changes state.
- No trend data reaches a model or an edit plan.

## Instagram hashtag watch (Stage B, WP5)

- No new credential: the worker decrypts the `meta` connection's system-user token only for the call and sends it in
  an `Authorization: Bearer` header (never in a URL, a job payload, the audit log or a DTO; tests check the logs,
  jobs and responses). `appsecret_proof` is redacted from logs by `lib/http.ts`.
- Read-only: only `ig_hashtag_search` and `top_media` are called; nothing is posted or changed at Meta.
- Least privilege: the hashtag permission is only needed when the owner turns hashtag watch on; they add it to the
  same Facebook Login for Business configuration and reconnect (no second configuration, no `scope` parameter).
- Third-party content kept to the minimum: rank, media type, posted time, counts as reported and the permalink
  (only `https://instagram.com`/`www.instagram.com` links survive). No captions, images or account names. Items are
  deleted 7 days after they were fetched; links open in a new tab with `rel="noopener noreferrer"`.
- Owner only: adding and removing hashtags and manual refreshes. Hashtags with "trending" or "viral" are refused so
  no label carries a popularity claim. Audit: `trends.watch_added`, `trends.watch_removed`, and
  `trends.source_unavailable` / `trends.source_needs_reauth` / `trends.source_quota` from the worker.

## Not done yet (known gaps)

- **Rate limiting** applies to sign-in only. Uploads and other API routes have none beyond requiring a session.
- **Forwarded IP address.** The IP used for login throttling is the first `X-Forwarded-For` entry. Run the app
  only behind a reverse proxy that sets that header (Caddy, Fly.io), and never expose port 3000 directly.
- **No Content-Security-Policy or HSTS header** from the app. Set HSTS at the reverse proxy; a CSP still needs
  writing and testing.
- **No two-factor authentication** and no email-based password reset. A forgotten owner password is reset from
  the command line: `create-owner --reset-password`.
- **Staff access is not consistent everywhere.** Studio pages limit staff to their own projects, but the
  generic `/api/projects` routes do not apply that rule yet (noted in `docs/HANDOVER.md`).
- **Readable local-driver links.** Local media links expose the storage key in readable form (signed, not
  encrypted).
- **Integrations not built yet.** OAuth connection flows (Instagram, TikTok, Square, Google) and the Square
  webhook endpoint are not built, so no third-party tokens are stored yet.
- **No retention job.** No automated deletion of old projects. Retention is manual today.
- **No malware scanning** of uploaded files. Files are only processed by FFmpeg inside the worker, never
  served as HTML.
- **No external security review or penetration test** has been done.
- **Docker images not built or scanned.** The images were not built or scanned for vulnerabilities in this
  sandbox, which had no Docker daemon. Build and scan them (for example with `docker scout` or Trivy) before
  production.

## Music controls and licence passport (Stage B, WP1)

- Owner only: licence changes and confirmation, removing tracks, Spotify references and the embed switch. Staff may
  tag tracks (genres, moods), use the Sound panel and make music-free versions in projects they can open.
- New audit actions: `music.reference_added`, `music.reference_removed`, `music.spotify_mode_changed`,
  `music.export_blocked` (web and worker), `music.no_music_export_requested`; `music.licence_updated` now records the
  licence kind.
- Spotify: only the URL, type, id and notes are stored; no Spotify request, oEmbed fetch or credential exists. When a
  Content-Security-Policy is written it must allow `frame-src https://open.spotify.com` for the optional embed.
- The usage ledger keeps a licence snapshot per export; ledger rows reference the track with `ON DELETE RESTRICT`
  (tracks are soft-deleted, so this never blocks a removal).

## Saved preferences, reference video and brand (Stage B, WP2)

- Owner only: pin / "Let it learn", the learning switch, "Reset what it learned", "Try again", the reference video
  list and its suggestion decisions, and every Settings change (logo placement included). Staff see the learned
  preferences read-only, and may hide edits and add reference videos in projects they can open.
- New audit actions: `preferences.pinned`, `preferences.unpinned`, `preferences.learning_toggled`,
  `preferences.learning_reset`, `reference.uploaded`, `reference.suggestions_decided`,
  `settings.logo_placement_changed`.
- `PUT /api/settings` refuses the server-owned preference fields (`learned`, `learning`, `styleAffinity`); the
  recompute job writes only its subtree, and web writes keep it under a row lock.
- Reference videos are private like all media. The original, proxy and sampled frames are deleted once measured;
  only the numbers, the thumbnail and the file name remain. Frames go to Anthropic only with the owner's tick on that
  upload, at most 8, with a prompt that forbids reading out text or identifying people. A reference never reaches
  footage, style support, the planner or a render (excluded by kind; the validator would refuse an unknown asset).
- Feedback events hold ids, plan facts, the revision instruction and parsed hints; no media.

## Publishing (Stage B, WP4)

- **Credentials**: the Meta system-user token is stored only in `integration_connections.access_token_encrypted`
  (AES-256-GCM), decrypted in the worker per call and in the callback for the single code exchange. It never goes to
  the browser, job payloads, `provider_state`, `audit_log` or logs (the HTTP helper redacts `access_token`,
  `appsecret_proof`, `input_token`, `client_secret`, `code` and `Authorization`). Every Graph call sends
  `appsecret_proof`. `META_APP_SECRET` stays in the environment.
- **OAuth**: Unified Login dialog with `config_id` and no `scope`; state bound to the owner's session in an encrypted,
  HttpOnly, SameSite=Lax 10-minute cookie scoped to `/api/integrations/instagram`; redirect URI fixed from `APP_URL`;
  the callback requires the owner session and clears the cookie on every outcome.
- **Least privilege**: `instagram_basic` and `instagram_content_publish` only (`business_management` only if discovery
  is empty). The read-only `social.check` never posts; the only live "test" is a first verification post the owner
  chooses and approves.
- **Duplicate protection**: unique `(post_id, platform)` and `idempotency_key`, conditional status updates, the
  container id saved before the upload, `submitted_at` set before `media_publish`, `stately` queues as a second guard.
- **Untrusted input**: captions and pasted links are rendered as text; a link is stored only if it matches an exact
  Instagram or TikTok post pattern. Graph messages are shown as text.
- **Media**: uploads stream from private storage to `rupload.facebook.com` (no public URL); owner downloads use
  expiring links. Deleting a project cancels its unsent posts and removes its `publishing/{postId}/` covers.

## Square appointments (Stage C, WP6)

- **Tokens**: Square access and refresh tokens live only in `integration_connections` (AES-256-GCM), decrypted in the
  worker per call and in the callback for the single code exchange. Never in job payloads, `bookings.raw`, audit data,
  logs or DTOs. `SQUARE_APPLICATION_SECRET` and `SQUARE_WEBHOOK_SIGNATURE_KEY` stay in the environment; the worker uses
  the secret for refresh and revoke.
- **Least privilege**: read scopes only (`APPOINTMENTS_READ`, `APPOINTMENTS_ALL_READ`,
  `APPOINTMENTS_BUSINESS_SETTINGS_READ`, `CUSTOMERS_READ`, `ITEMS_READ`, `MERCHANT_PROFILE_READ`, `PAYMENTS_READ`,
  `ORDERS_READ`). Write scopes are refused until booking changes exist (WP6b). Code flow, so the secret stays server-side.
- **OAuth**: state bound to the owner's session in an encrypted, HttpOnly, SameSite=Lax 10-minute cookie on
  `/api/integrations/square`; fixed redirect from `APP_URL`; the callback requires the owner and refuses a sign-in
  that started in the other environment.
- **Webhook endpoint (built)**: `POST /api/webhooks/square` checks `x-square-hmacsha256-signature` =
  base64(HMAC-SHA256(key, notification URL + raw body)) with a timing-safe compare before parsing (body ≤ 256 KiB).
  Invalid deliveries are refused and never stored; valid ones are stored once per event id as a minimal envelope
  (event id, type, merchant, time, the object's type and id); Square's copy of the object (names, contact details,
  address, notes, amounts) is dropped before anything is written. Payloads are hints only: the worker ignores other
  merchants and re-reads every object from Square. Processed Square deliveries are deleted after 7 days
  (`maintenance.cleanup`) and with every purge.
- **Roles**: owner only for connect, disconnect, location, service confirmations and sync. Staff see bookings, client
  names, services and free times, and may mark attendance; client email/phone and booking notes are owner-only.
- **Personal data**: only names, email, phone, Square ids and the email opt-out are copied, and bookings only for the
  studio's own Square location (none while the owner still has to choose between several; choosing one deletes the
  other locations' copied bookings). Disconnect offers a purge (bookings, searches and stored Square webhook
  deliveries deleted, customers scrubbed) under the connection row's lock: a sync, refresh or webhook job that is
  still running checks the same lock before every write and stops, so it cannot copy the removed data back. Switching
  environment or Square account purges automatically; customers are scrubbed, never deleted. A revoke queued by a
  disconnect is skipped when the owner has already reconnected the same Square account (it would revoke the new
  tokens).
- **Test data never acts as real**: a booking copied from Square's sandbox never counts as a completed visit
  (`deriveCompletion` stores none; `isGenuinelyCompleted` and every "real visit" query require `production`), so a
  sandbox test booking can never start a follow-up, a review request or an inferred-consent visit. No Square data
  goes to an AI model. Square text (names, notes, error details) is rendered as text. Audit entries hold ids, codes and
  the environment, never names, contact details, notes or tokens.

## Email and review requests (Stage C, WP7)

- **Owner only**: sending, approving, templates, settings, automations, campaigns, suppression lifts, message bodies
  and history. **Staff**: the client list, recording consent and unsubscribes, and stopping review requests (all
  fail-safe or evidence capture; turning review requests back on is owner-only).
- **Public routes** (`/api/webhooks/postmark`, `/api/public/unsubscribe/…`, `/u/…`, `/r/…`) have an in-memory per-IP
  limit (60/min for links, 300/min for webhooks) and log no addresses. The webhook checks HTTP Basic credentials in
  constant time (SHA-256 digests, `timingSafeEqual`) before storing anything; Postmark offers no payload signature, so
  nothing a webhook says can grant consent, lift a suppression or cause a send. The unsubscribe POST is CSRF-exempt by
  design because it can only reduce sending; viewing the page changes nothing (mail scanners pre-fetch links).
- **Tokens**: unsubscribe and review-link tokens are random 32 bytes (base64url), stored only as SHA-256, never expire
  and do not depend on `APP_SECRET`. When the owner sends a message again after checking an unknown outcome, the new
  attempt gets new tokens and the earlier hashes move to `email_link_tokens`, so a copy that did arrive keeps a working
  unsubscribe link. Stored message bodies hold `[unsubscribe link]` / `[review link]` markers, never a usable token.
  The unsubscribe page masks the address, and shows "You're unsubscribed" only when one is recorded.
- **Webhook credentials**: `POSTMARK_WEBHOOK_PASSWORD` must be at least 32 characters and set together with
  `POSTMARK_WEBHOOK_USERNAME`; otherwise the app and worker refuse to start (they are the webhook's only
  authentication).
- **Owner-supplied links in emails**: `{{booking_link}}` becomes a link only when `business.bookingLink` is https
  (otherwise its label is plain text), and Settings → Business accepts only an https booking link.
- **Secrets**: `POSTMARK_SERVER_TOKEN` and `GOOGLE_MAPS_API_KEY` are read by the worker only; the web app needs only the
  webhook credentials. Logs redact `X-Postmark-Server-Token`, `X-Goog-Api-Key` and hash email addresses; job payloads
  and audit entries hold ids and reason codes, never addresses or bodies.
- **Rendering**: a Markdown subset with full escaping; previews in `<iframe sandbox srcdoc>` with no scripts.
- **Withdrawn approval wins**: campaign expansion locks the campaign row before every insert and stops once the owner
  pauses or cancels; pausing hands queued, unsubmitted messages back to `approved`; `email.send` re-checks the campaign
  (under a share lock at the claim) and never sends while it is paused or cancelled.
- **Retention**: `email_messages`, `consent_events` and `email_suppressions` are kept at least 24 months and survive a
  client's soft delete (suppressions must keep working). Processed Postmark webhook payloads are blanked after 90 days
  (`maintenance.cleanup`); their effects stay.

## Website and local search (Stage C, WP8)

- **Owner only**: every website route and the Website page; staff see a plain notice.
- **Ownership binding**: checks run only against the host the owner confirmed ("This is my business's own website");
  the confirmation is server-set (`PUT /api/settings` drops it) and is cleared in effect when the website address
  changes host.
- **SSRF guard** (`apps/worker/src/website/ssrf.ts`, `fetcher.ts`): the crawler resolves every host and refuses it if
  any address is in 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, multicast,
  reserved, ::1, fc00::/7, fe80::/10 or an IPv4-mapped private address; it connects to the checked address only (no
  DNS rebinding), uses ports 80/443 only and re-validates every redirect. WordPress REST calls go through the same
  guard (`guarded-fetch.ts`): resolved, checked and pinned on every call, https on 443 only, redirects never followed
  (a 3xx is refused, so page content and the password are never re-sent elsewhere); the apply job checks the address
  again before writing. Saving the WordPress address refuses private and reserved IP literals, `localhost` and local
  network names. The ranges live in `packages/core/src/address-ranges.ts` (server-only). Only test code can allow
  loopback; no setting turns the guard off.
- **Fetched pages are data**: parsed with cheerio into capped fields, never executed; nothing on a page is followed
  except plain links in scope; React renders every string as text. The optional AI step wraps page text in a JSON
  field declared untrusted, uses structured output and drops options with ranking claims, other phone numbers or
  addresses; AI text is never applied without the owner choosing it and confirming Apply.
- **WordPress credential**: `username:applicationPassword` encrypted with AES-256-GCM in `integration_connections`,
  decrypted only in the worker, never echoed, logged or audited; HTTPS only. A dedicated Editor user is recommended
  (an Administrator gets a note). Disconnect wipes it; deleting the Application Password in WordPress revokes it.
- **No live change without the owner**: connection checks are read-only; apply needs `approved_by` from the explicit
  confirmation; a retry never writes twice: a durable marker (`apply_result.writeSentAt` and the SHA-256 of the content
  the write was computed from) is stored before the write, and only that record, never the page text alone, decides
  `already_applied`. Edits, AI drafts and audit refreshes change a prepared change only while it is still open, and an
  approval holds only for the wording the dialog showed. Search Console is read-only (`webmasters.readonly`).
- **Privacy**: checks store extracted facts, never page HTML or images. Search queries stay server-side and owner-only
  and can be deleted on disconnect ("Also delete stored search data").
