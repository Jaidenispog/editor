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
| Instagram, TikTok, Square, email, Google reviews | "Needs setup" screens only | — | Meta, TikTok, Square, Resend, Google accounts |

**Not yet done:**

- The Stage A acceptance test on the owner's **real haircut footage**. Synthetic footage is not a substitute
  for it (`docs/testing.md`, section 5).
- A browser end-to-end test.
- Stage B/C integrations.

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
`pnpm --filter @studio/web create-owner --email you@example.com --password '…'`).

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
