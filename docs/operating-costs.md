# Operating costs (estimate)

This is a planning estimate, not a quote. All prices are in US dollars because the providers bill in USD.
AUD figures use an **assumed exchange rate of 1 USD ≈ 1.50 AUD**. The real rate moves, and card or bank
currency-conversion fees are not included. Hosting prices marked *confirm* come from research notes or
typical published price ranges, and must be checked on the provider's pricing page before signing up.

**No paid service is created without the owner's approval.** The app runs fully without any paid service:
`AI_PROVIDER=none` uses the built-in rules planner and the owner's clip tags, and media can stay on local disk.

Prices checked: Anthropic model prices on 14 Nov 2026 (current Anthropic API price list). Everything else is
marked *confirm*.

## 1. Usage assumptions

| Assumption | Value |
| --- | --- |
| Projects per month | 20 |
| Clips per project | 6 × 45 s = 4.5 min of footage |
| Footage bitrate | iPhone 4K HEVC ≈ 60 MB/min; 1080p ≈ 30 MB/min |
| Proxies (540×960 SDR, for previews) | ≈ 15 % of the originals |
| Previews | 5 per generation + about 3 revisions or regenerations ≈ 8 × 3 MB |
| Analysis frames and thumbnails | ≈ 5 MB per project |
| Exports | two 1080×1920 exports per project ≈ 25 MB each |
| Retention | 6 months, then the owner deletes the project (deleting a project removes all its media). **The app does not yet delete old projects automatically**, so this needs a manual clean-up or a future scheduled job |
| Revisions using the AI planner | 3 per project |

## 2. Storage

Per project:

| Item | 4K footage | 1080p footage |
| --- | ---: | ---: |
| Originals (4.5 min) | 270 MB | 135 MB |
| Proxies (15 %) | 40.5 MB | 20.3 MB |
| Previews (8 × 3 MB) | 24 MB | 24 MB |
| Frames and thumbnails | 5 MB | 5 MB |
| Exports (2 × 25 MB) | 50 MB | 50 MB |
| **Total per project** | **≈ 390 MB** | **≈ 234 MB** |

Growth and totals:

| | 4K footage | 1080p footage |
| --- | ---: | ---: |
| Added per month (20 projects) | ≈ 7.8 GB | ≈ 4.7 GB |
| Steady state with 6-month retention | ≈ 47 GB | ≈ 28 GB |
| After 12 months with **no** deletions | ≈ 94 GB | ≈ 56 GB |
| Database (rows, analyses, plans) | < 1 GB | < 1 GB |

What that storage costs:

| Where media lives | Steady state (4K, 47 GB) | Notes |
| --- | ---: | --- |
| VPS local disk | included | Needs an 80 GB+ disk (or an added volume) to hold 47 GB of media plus the OS, Postgres and render scratch space |
| Supabase Storage (Pro) | USD 0 extra | 100 GB included in Pro; USD 0.0213 per GB-month beyond (*confirm*) |
| Cloudflare R2 | ≈ USD 0.55/month | 10 GB free, then USD 0.015 per GB-month; no egress charges (*confirm*) |

**Egress (data out of the bucket)** per project, without caching: ingest re-reads the originals (270 MB),
8 preview renders read the proxies (≈ 320 MB), 2 exports re-read the originals (540 MB), and the owner watches
previews and downloads exports (≈ 120 MB). That is about **1.25 GB per project, or about 25 GB a month**. It
fits inside Supabase Pro's included 250 GB of uncached egress (*confirm*), and R2 egress is free. On a single
VPS it is all local disk reads.

## 3. AI cost per project (only when `AI_PROVIDER=anthropic`)

Current Anthropic list prices per million tokens (MTok):

- `claude-haiku-5-5`: USD 0.10 input and 0.50 output, for prompts up to 100K tokens.
- `claude-opus-5-5`: USD 4 input and 20 output; cache reads USD 0.20.

| Step | Tokens | Cost (USD) |
| --- | --- | ---: |
| Frame labelling, Haiku: 6 clips × 10 frames × ≈ 1,100 tokens per image, plus ≈ 1,500 prompt tokens per clip; ≈ 500 output tokens per clip | 75k in, 3k out | 0.009 |
| Planning five edits, Opus: 5 × (25k in + 6k out) | 125k in, 30k out | 1.10 |
| Revisions, Opus: 3 × (25k in + 6k out) | 75k in, 18k out | 0.66 |
| **Total per project** | | **≈ 1.77** |
| **Per month (20 projects)** | | **≈ USD 35 ≈ AUD 53** |

Notes:

- **Thinking counts as output.** The planner runs Claude Opus 5.5 with thinking always on (effort
  `AI_PLANNER_EFFORT`, default `medium`), and thinking tokens are billed as output. The 6k-output assumption
  includes them.
  - If real usage shows more, the `ai_usage` figures recorded per call (`estimatedCostUsdCents`) will say so.
  - Lowering the effort to `low` is the first lever.
- **Caching.** The planner marks its system prompt for caching, so the five styles of a generation reuse it.
  Cache reads cost USD 0.20/MTok instead of 4. The footage analysis is sent fresh with each plan, so the saving
  is modest: cents per generation. Caching the shared analysis as well could save up to ≈ USD 0.30 per
  generation.
- **Repairs.** A plan that fails validation is sent back with the errors up to twice
  (`apps/worker/src/lib/planning.ts`), then the rules planner takes over. Each repair costs about one extra
  plan (≈ USD 0.22).
- **Labelling** is almost free. Planning is where the money goes.

### Optional transcription (captions from speech)

- Only clips with likely speech are transcribed.
- OpenAI `whisper-1` is about USD 0.006 per minute (*confirm*). At most 4.5 min per project, that is
  ≤ USD 0.03 per project and ≤ USD 0.54 per month.
- The research notes that `whisper-1` is scheduled to shut down on 26 Feb 2027. A Deepgram adapter is
  suggested as the replacement, at a similar per-minute cost (*confirm*).

## 4. Hosting options

| Item | USD / month | Notes |
| --- | ---: | --- |
| VPS 2 vCPU / 4 GB | ≈ 10–15 | Works; renders are slower (*confirm*) |
| VPS 4 vCPU / 8 GB | ≈ 20–30 | Comfortable for web + worker + Postgres on one machine (*confirm*) |
| VPS backups or snapshots | ≈ 2–6 | Often about 20 % of the server price (*confirm*) |
| Supabase Pro | 25 | Includes 100 GB storage, 250 GB egress, daily backups; IPv4 add-on USD 4 only if needed (*confirm*) |
| Fly.io worker, 2 performance vCPU / 4 GB, always on | ≈ 30–65 | Depends on CPU class; shared CPUs are cheaper but slower (*confirm*) |
| Fly.io web app, shared CPU / 1 GB | ≈ 5–10 | (*confirm*) |
| Domain (.com.au) | ≈ 1–2 | Billed yearly (*confirm*) |
| Uptime monitoring | 0 | Free tiers are enough |

## 5. Scenarios

### Free / development

| Item | USD / month |
| --- | ---: |
| Local machine, local Postgres (`scripts/local-postgres.sh`), local disk storage | 0 |
| `AI_PROVIDER=none` (rules planner + owner's clip tags) | 0 |
| Optional: Supabase Free project for trying the S3 path (50 MB file cap; pauses when idle) | 0 |
| **Total** | **0** |

### Production A: one VPS (recommended to start)

| Item | USD / month |
| --- | ---: |
| VPS 4 vCPU / 8 GB / 80+ GB disk | 20–30 |
| Backups or snapshots + off-site dump storage | 3–7 |
| Domain | 1–2 |
| AI (Anthropic, 20 projects) | ≈ 35 |
| **Total with AI** | **≈ 59–74 (≈ AUD 89–111)** |
| **Total without AI** | **≈ 24–39 (≈ AUD 36–59)** |

### Production B: Supabase + Fly.io

| Item | USD / month |
| --- | ---: |
| Supabase Pro (database + media storage) | 25 |
| Fly.io worker (2 performance vCPU / 4 GB) | 30–65 |
| Fly.io web app | 5–10 |
| Domain | 1–2 |
| AI (Anthropic, 20 projects) | ≈ 35 |
| **Total with AI** | **≈ 96–137 (≈ AUD 144–206)** |
| **Total without AI** | **≈ 61–102 (≈ AUD 92–153)** |

A mixed option also works: Supabase Pro for the database, R2 for media, and one VPS for web and worker. It
costs about USD 25 + 1 + 20–30 + AI ≈ USD 81–91 a month.

## 6. What changes the numbers most

1. **AI planning volume.** Each extra generation of five edits is ≈ USD 1.10, and each revision ≈ USD 0.22.
2. **Footage resolution and length.** Footage in 4K roughly doubles storage compared with 1080p, while
   longer clips scale storage and egress linearly.
3. **Retention.** Without deleting old projects, storage keeps growing by 5–8 GB a month.
4. **Worker CPU.** Faster CPUs shorten renders. They do not change the AI cost.
