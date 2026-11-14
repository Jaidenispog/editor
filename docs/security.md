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
- **Status:** the `webhook_events` table exists, but **no webhook endpoint is built yet** (Square is a Stage C
  integration). Until it is, the app accepts no webhooks at all.

## Data deletion

- **Deleting a project** (typed confirmation in the UI) cancels its
  jobs, deletes its whole storage prefix (originals, proxies, frames, previews, exports) and removes its rows.
  This is permanent: there is no recycle bin.
- **Removing a clip or a music track** deletes its files as well.
- **Worker temp folders** are removed after each job. Anything left by a crash is removed by the hourly
  cleanup after 24 h, and abandoned uploads are cleaned up the same way.
- **Backups** keep deleted data until they expire (see `docs/deployment.md`). Include that in any privacy
  statement.

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
