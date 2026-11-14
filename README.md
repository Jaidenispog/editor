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
| TikTok direct, Square, email, Google reviews, website tools (Stage C) | TikTok: manual posting only; the rest "Needs setup" screens | — | TikTok (optional Zernio route), Square, Resend, Google accounts |

**Not yet done:**

- The Stage A acceptance test on the owner's **real haircut footage**. Synthetic footage is not a substitute
  for it (`docs/testing.md`, section 5).
- Anything against the owner's **real accounts**: no real Instagram post, hashtag read, YouTube chart fetch or AI
  call has been made. Stage B passes its browser test (`bash apps/web/e2e/run-stage-b.sh`) on synthetic footage
  with a local fake of Meta only (`docs/testing.md`, "Stage B browser test").
- Stage C (Square appointments, email, reviews, website and local search).

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
  owner checklist in `docs/design/stage-bc-plan.md` §7). TikTok stays manual until the optional Zernio route (WP10).

## Instagram hashtag watch (Stage B, WP5)

- **Built**: hashtags the owner chooses in Settings → Trends → Live signals, read once a day through the Instagram
  account connected for publishing (top 9 posts each: type, posted date, counts as reported, link; no captions,
  images or names), with Instagram's 30-hashtags-a-week limit and at most 10 watched at once.
- **Verified with fakes**: every read and refusal against a fake of Meta's API on a test database (no real call).
- **Waiting on account access**: a connected Instagram account and the hashtag search permission on the Meta app.
  Whether Meta allows hashtag search for this kind of app setup is unknown until the first real read; "Not
  available" is then a valid answer.
