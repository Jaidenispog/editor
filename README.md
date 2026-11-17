# Studio Assistant

A private web app for a barber studio in Ivanhoe, Victoria. The owner drops phone videos of a haircut into a
project and picks a length, style and music. **Generate 5 edits** then makes five genuinely different
vertical (9:16) previews. Each edit can be revised or regenerated on its own, with earlier versions kept, and
exported as a real 1080×1920 MP4 for Instagram and TikTok. Later stages add publishing, appointments, email
and review tools. Every integration shows an honest "needs setup" state until it is connected.

Australian English, AUD, `Australia/Melbourne`.

## Status

| Area | Completed | Verified with synthetic footage | Waiting on account access |
| --- | --- | --- | --- |
| Sign-in, owner setup, sessions, settings | Yes | Unit and route tests | — |
| Chunked, resumable uploads (8 MiB parts) | Yes | Route tests (out-of-order and duplicate parts) | — |
| Clip analysis: rotation, HDR → SDR, scenes, quality, audio | Yes | Yes (rotated HEVC HLG, silent clip, scene changes) | — |
| Five distinct edits (rules planner, no AI key) | Yes | Yes: five valid, different plans; all previews render | — |
| Revise / regenerate with version history | Yes | Yes: revise to 15 s leaves other versions intact | — |
| 1080×1920 H.264/AAC export and download | Yes | Yes | — |
| Interrupted jobs resume; cancel stops FFmpeg | Yes | Yes (simulated shutdown, kill -9 recovery) | — |
| Owner-uploaded music with licence record, beat-matched cuts | Yes | Yes (120 BPM click track) | — |
| AI planning and shot labelling (Anthropic) | Yes | Stubbed client only | Anthropic API key (owner approval for spend) |
| Speech captions (transcription) | Yes (OpenAI adapter) | Not run | OpenAI key |
| Docker images, Compose, deployment docs | Written | `docker compose config` validated; install and run steps run by hand; images not built (no Docker daemon in the build sandbox) | Hosting account |
| Music licence passport, export gates, music-free version, usage ledger (WP1) | Yes | Yes: unit, database and Stage B browser tests (120 BPM click track) | The music library's written confirmation that its plan covers organic posts, website and boosts |
| Saved preferences, reference video, brand (WP2) | Yes | Yes: unit and database tests; learned length, "Keep this" and reset in the Stage B browser test | Anthropic key for the on-screen text estimate; real use over weeks |
| Publishing: composer, "Post it yourself", Instagram direct (WP4) | Yes | Yes, against a local fake of Meta (Stage B browser test and worker tests); no real post made | Meta business app, configuration and the first real verification post |
| Trends: curated (sourced, dated), noted by staff, YouTube AU chart; no "trending" claims | Yes (WP3) | Unit and database tests with a fake YouTube API; curated and noted labels in the Stage B browser test | `YOUTUBE_API_KEY` for the chart (optional) |
| Instagram hashtag watch (WP5) | Yes | Yes, against the fake of Meta (unit, database and Stage B browser tests) | A connected Instagram account and Meta's hashtag search permission |
| Square appointments, read-only: bookings, clients, services, free times, attendance estimate and marks (WP6) | Yes | Yes, against a local fake of Square through the real SDK (unit, database and route tests); nothing written to Square | A Square developer application (sandbox first), then the live account |
| Square booking changes and self-test (WP6b) | Built, switched off in this version until the sandbox write checks are recorded | Yes, against the fake of Square (unit, database and route tests); nothing written to a real Square account | A Square sandbox account for the write checks; then Appointments Plus or Premium, fee-free services and the owner's self-test |
| Email and review requests: Postmark, consent ledger, send gate, review link and requests, Google rating (WP7) | Yes | Yes, against a fake email provider and a fake Google API (unit, database and route tests); no real email sent | A domain with DNS access, a Postmark account and its approval, the review link; optionally a Google Maps key and Place ID |
| Website check, prepared changes, WordPress apply, Search Console (WP8) | Yes | Yes, against a local fixture site, a fake WordPress REST API and a fake Google (unit, database and route tests); no real site, WordPress or Google contacted | The owner's site builder and an Application Password if it is WordPress; Search Console verification and connection; the owner's first check |
| Google Business Profile reviews and performance, read-only (WP9) | Yes | Yes, against a fake of the Business Profile APIs (unit, database and route tests); no real Google call made | A Google Cloud project with the Business Profile APIs, the consent screen in Production and Google's Basic API Access approval |
| TikTok automatic posting via Zernio (Stage C, WP10; optional, off unless `TIKTOK_PUBLISH_PROVIDER=zernio`) | Yes, built from docs.zernio.com as read on 15 Nov 2026 | Yes, against a local fake of Zernio (unit, database and route tests, and the TikTok browser test `run-stage-c-tiktok.sh`, 105 checks); no real Zernio call or TikTok post made | A Zernio account with TikTok connected (Business), an API key and the first real verification post |
| Stage C end to end (bookings, email, reviews, website, search) | Yes | Yes: two browser tests against local fakes of Square, Postmark, Google and WordPress plus a fixture website (`run-stage-c-bookings.sh`, 124 checks; `run-stage-c-website.sh`, 114 checks) | The owner's real accounts (see the rows above) |

**Not yet done:**

- The Stage A acceptance test on the owner's **real haircut footage**. Synthetic footage is not a substitute
  for it (`docs/testing.md`, section 5).
- Anything against the owner's **real accounts**: no real Instagram post, hashtag read, YouTube chart fetch, AI
  call, Square read or write, email, Google call or website change has been made. Stage B and Stage C pass their
  browser tests on synthetic data with local fakes only (`docs/testing.md`, "Stage B browser test" and the three
  "Stage C browser test" sections).
- TikTok via Zernio (WP10): built and tested against a fake only; it stays unverified until the first real post
  through Zernio. Square booking changes (WP6b) are built but stay switched off until the sandbox write checks are
  recorded.

## Quick start (local, no Docker)

Needs Node 22.12+, pnpm 10 (`corepack enable`), FFmpeg 6+ (with libx264, libass and zscale) and PostgreSQL 16.

```bash
git clone <repository URL> studio-assistant && cd studio-assistant
bash scripts/check-tools.sh            # tells you what is missing and how to install it
pnpm install
bash scripts/local-postgres.sh start   # PostgreSQL on 127.0.0.1:5433, database studio_assistant; prints DATABASE_URL
cp .env.example .env                   # then set APP_SECRET:  openssl rand -base64 48
bash scripts/dev.sh migrate            # create the tables (reads DATABASE_URL from .env)
bash scripts/dev.sh                    # web app + worker together, logs prefixed [web] / [worker]
```

Open **http://localhost:3000/setup** and create the owner account (or run
`OWNER_EMAIL=you@example.com OWNER_PASSWORD='…' pnpm --filter @studio/web create-owner`; pnpm prints the
command it runs, so a `--password` flag would show the password on screen).

- Synthetic test clips: `bash scripts/make-sample-footage.sh data/samples`.
- Stop the database with `bash scripts/local-postgres.sh stop`.
- To run the two processes separately: `pnpm dev` (web) and `pnpm dev:worker` (worker).

With Docker instead: `docker compose build`, then `docker compose --profile migrate run --rm migrate`, then
`docker compose up -d`. See `docs/deployment.md`.

## Project layout

```
apps/web          Next.js 16 app: UI, JSON API, signed media links. Never renders video.
apps/worker       Background jobs (pg-boss): ingest, analysis, planning, FFmpeg renders, cleanup.
packages/core     Contracts: EditPlan schema + validator, styles, timeline maths, analysis and job types.
packages/db       Drizzle schema, SQL migrations, seed, token encryption.
packages/storage  Private media storage: local disk or S3-compatible (Supabase Storage, R2, S3).
packages/queue    pg-boss wrapper with per-job retry, expiry and heartbeat settings.
packages/media    FFmpeg/ffprobe wrappers, footage analysis and the plan → filtergraph renderer.
packages/ai       Vision labelling, edit planning, transcription; Anthropic + deterministic rules planner.
packages/config   Typed environment variables (see .env.example).
assets/fonts      Inter fonts used for on-video text.
scripts/          local-postgres.sh, dev.sh, check-tools.sh, make-sample-footage.sh
docs/             Architecture, API, deployment, costs, testing, security, research.
```

## Documentation

- [docs/architecture.md](docs/architecture.md): how the pieces fit together.
- [docs/api.md](docs/api.md): JSON API.
- [docs/deployment.md](docs/deployment.md): single VPS with Docker Compose + Caddy, or Supabase + Fly.io.
- [docs/operating-costs.md](docs/operating-costs.md): storage, AI and hosting estimates in USD and AUD.
- [docs/testing.md](docs/testing.md): tests, synthetic footage and the real-footage acceptance checklist.
- [docs/security.md](docs/security.md): auth, cookies, CSRF, media links, encryption, known gaps.
- [docs/research/](docs/research/): platform policy research (Instagram, TikTok, Spotify, Square, music licensing…).
- [docs/HANDOVER.md](docs/HANDOVER.md): where development stands and what comes next.

## Music controls and licence passport (Stage B, WP1)

Built and tested on synthetic footage and a synthetic 120 BPM track: the three-step licence passport (CC BY-NC
refused, Meta Sound Collection locked to Instagram/Facebook, CC BY credit), the export clearance gate and usage
ledger, the music-free export of any version, the Sound panel (volume, fades, original sound, song section, beat
options), "Suggested for you" from the owner's own library, and private Spotify references (link-only by default).
No music library API is connected (none is built in Phase 1); tracks are downloaded from a business-eligible library
and uploaded with their licence details.

## Saved preferences, reference video and brand (Stage B, WP2)

Built and tested on synthetic footage with database-backed tests: the editor learns default length, style order,
pacing, on-screen text, transitions, colour and music volume from favourites, downloads, revisions, regenerations and
hidden edits (deterministic, no model training), and Settings → Editing preferences shows every value with its source
and evidence, with pin / "Let it learn" and "Reset what it learned". "Hide this edit" keeps the edit and collapses it
under the previews. Reference videos are measured for pace, length and colour (and, with the owner's tick and AI set
up, on-screen text), suggest preferences the owner accepts one by one, and are deleted once measured. The logo can
appear as an end card and/or a corner mark inside the area both apps keep clear, and exports always use their
preview's branding. Not yet checked with real use: whether learned defaults feel right after a few weeks, logo
legibility on the real logo, and the estimates on real reference videos. The on-screen text estimate has only run
against a fake (it needs the Anthropic key).

## Publishing (Stage B, WP4)

- **Built**: composer (only the edits you chose, platforms off by default, caption with a 2,200-character counter and
  locked credit line, cover picker, Melbourne scheduling with daylight saving), "Post it yourself" with download, share,
  copy caption and "I've posted it", Instagram direct publishing through Meta's Unified Login with a first verification
  post, Publishing page (Your turn, upcoming, history), Content Library badges and multi-select, Studio "Publish…".
- **Verified on synthetic footage with fakes**: the whole Instagram flow against a local fake of Meta's API (no real
  post was made), the music rule, duplicate protection and restart recovery.
- **Waiting on account access**: a Meta business app, configuration and the first real verification post (see the
  owner checklist in `docs/design/stage-bc-plan.md` §7). TikTok is manual unless the optional Zernio route is on (below).

### TikTok through Zernio (Stage C, WP10)

- **Built** (off unless the server sets `TIKTOK_PUBLISH_PROVIDER=zernio`): paste a Zernio API key and choose the TikTok
  account in Settings → Integrations; "Publish via Zernio" and "Send to TikTok drafts via Zernio" in the composer, each
  starting with its own first verification post; the review step's consent tick and Comments / Duets / Stitches
  switches; status, polling, retry and webhooks (hints only).
- **Verified on synthetic footage with fakes**: the whole flow against a local fake of Zernio, including crash
  recovery without a second post, drafts, refusals and a partial post with Instagram. No real Zernio call was made.
- **Waiting on account access**: a Zernio account with TikTok connected through the Business connection, an API key,
  and the first real verification post (it is public immediately). Open questions are listed in
  `docs/research/zernio-api.md` ("Not documented").

## Instagram hashtag watch (Stage B, WP5)

- **Built**: hashtags the owner chooses in Settings → Trends → Live signals, read once a day through the Instagram
  account connected for publishing (top 9 posts each: type, posted date, counts as reported, link; no captions,
  images or names), with Instagram's 30-hashtags-a-week limit and at most 10 watched at once.
- **Verified with fakes**: every read and refusal against a fake of Meta's API on a test database (no real call).
- **Waiting on account access**: a connected Instagram account and the hashtag search permission on the Meta app.
  Whether Meta allows hashtag search for this kind of app setup is unknown until the first real read; "Not
  available" is then a valid answer.

## Email and review requests (Stage C, WP7)

- **Built**: Emails (to approve, drafts, sent log, campaigns with recipient preview and auto-pause, templates with a
  live linter, clients with recorded email permission and unsubscribes, the follow-up automation) and Reviews (review
  link, Google rating from Places, neutral review requests after a genuinely completed appointment or the owner's
  confirmation, automatic requests). Postmark replaces Resend. Nothing is sent before an appointment (Square sends
  reminders), and every automation is off until the owner turns it on.
- **Verified with fakes**: every send path, webhook and route against a fake email provider and a fake Google API on
  a test database. No real email has been sent and no real Google call made.
- **Waiting on account access**: a domain with DNS access, Postmark servers, streams, webhooks and account approval;
  email permission recorded at the counter; the review link; optionally a Google Maps key and Place ID. Square
  completions drive the automation once Square is connected (WP6).

## Google Business Profile (Stage C, WP9)

- **Built**: "Reviews on Google" on the Reviews page (location choice, reviews with Google's reply state and policy
  flag, daily incremental and weekly full reads) and the Business Profile performance card on the Website page (calls,
  direction requests, website clicks, bookings, message clicks, views, monthly search keywords), both read-only on one
  Google sign-in, with "Waiting for Google approval" while Google's quota is 0.
- **Verified with fakes**: every read, refusal and state against a fake of the Business Profile APIs on a test
  database. No real Google call has been made.
- **Waiting on account access**: a Google Cloud project with the Business Profile APIs, the consent screen published
  to Production, and Google's Basic API Access approval, which isn't guaranteed for a single shop. The Performance
  request and response shapes are confirmed only once that approval exists.
