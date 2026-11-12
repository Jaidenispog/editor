export const meta = {
  name: 'studio-assistant-platform-research',
  description: 'Verify current platform policies and API constraints (Spotify, TikTok, Instagram, Square, Google Business Profile, Supabase, music catalogues, email/Spam Act, OpenAI transcription, safe zones) before committing to integrations',
  phases: [
    { title: 'Research', detail: 'one agent per platform/policy question' },
    { title: 'Critique', detail: 'completeness and contradiction check' },
    { title: 'Follow-up', detail: 're-check flagged items' },
    { title: 'Synthesise', detail: 'write docs/research memo' },
  ],
}

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          how: { type: 'string', enum: ['webfetch_full_page', 'websearch_summary'] },
          date_note: { type: 'string' },
        },
        required: ['url', 'how'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
          source_url: { type: 'string' },
        },
        required: ['claim', 'evidence'],
      },
    },
    implementation_decision: { type: 'string' },
    account_requirements: { type: 'array', items: { type: 'string' } },
    uncertainties: { type: 'array', items: { type: 'string' } },
  },
  required: ['topic', 'confidence', 'sources', 'findings', 'implementation_decision', 'account_requirements', 'uncertainties'],
}

const COMMON = `
You are researching for "Studio Assistant", a private web app for a single barber business in Ivanhoe, Victoria, Australia (owner + at most a couple of staff). Today is 2026-11-09.
Method:
1. Load WebFetch via ToolSearch ("select:WebFetch") and try fetching the OFFICIAL documentation/policy URLs first. The sandbox network may block many hosts (DNS "ENOTFOUND" / not allowed): if a fetch fails, do NOT retry that host; fall back to WebSearch (use mode "extended" for policy/API questions, and allowed_domains for official domains where useful). Record for each source whether you read the full page or relied on a search summary.
2. Quote or closely paraphrase the exact wording that supports each claim. Do not speculate. If the current state is unknown, say so in uncertainties instead of guessing.
3. Note dates: when the policy/API doc was last updated if visible, and whether anything changed in 2025-2026.
4. Finish with a concrete implementation decision for Studio Assistant and list account/plan/app-review requirements the owner must satisfy.
Return ONLY the structured output.`

const TOPICS = [
  {
    key: 'spotify',
    prompt: `${COMMON}
TOPIC: Spotify integration feasibility.
Questions: (a) Spotify Developer Policy & Developer Terms (current version): restrictions on using Spotify content with AI/ML, on using 30-second previews or streams outside Spotify, on transferring content to third parties, and on "Spotify content in videos/exports". (b) Web API changes since Nov 2024 (deprecated endpoints for new apps: preview URLs, audio features/analysis, recommendations, related artists) and 2025-2026 changes to developer access / extended quota mode / who can get apps approved (e.g. individual developers, development mode user limits). (c) Is there ANY permitted use for a private single-owner app: e.g. letting the owner search tracks and save a link/name as a "mood/genre reference" (metadata only, no audio) under development mode? Decide: can Studio Assistant offer an optional Spotify connection, and for exactly what use, or should it clearly explain that it cannot be supported?`,
  },
  {
    key: 'tiktok',
    prompt: `${COMMON}
TOPIC: TikTok Content Posting API for a private app.
Questions: Current requirements for developers.tiktok.com apps: Login Kit + Content Posting API; "Direct Post" vs "Upload to inbox/draft" endpoints; audit/review requirements; what UNAUDITED apps can do (e.g. private/SELF_ONLY visibility only, limited test users); scopes (video.upload, video.publish); PULL_FROM_URL domain/URL prefix verification vs FILE_UPLOAD chunking rules (chunk sizes, max size); status polling endpoint; sandbox mode; whether individual (non-company) developers can register and get approved; TikTok's rules on adding music (Commercial Music Library for business accounts; copyrighted audio in uploaded files); recommended video specs for 9:16. Also check whether third-party publishing providers (e.g. Ayrshare, Late, Buffer API, Zapier) are an officially supported route and what they require. Decide: direct integration, provider, or draft/export fallback for Studio Assistant.`,
  },
  {
    key: 'instagram',
    prompt: `${COMMON}
TOPIC: Instagram Reels publishing via the Instagram Platform API (Meta).
Questions: "Instagram API with Instagram Login" vs "Instagram API with Facebook Login for Business": requirements (professional account, Facebook Page needed?), permissions (instagram_business_content_publish / instagram_content_publish), App Review / Advanced Access, and what an app in Development mode can do for users who hold a role on the app (owner's own account) WITHOUT App Review. Content publishing flow for Reels: create media container (media_type=REELS, video_url must be a publicly reachable URL, cover_url/thumb_offset, caption, share_to_feed), poll container status_code (IN_PROGRESS/FINISHED/ERROR/EXPIRED), publish, rate limits (posts per 24h via content_publishing_limit), video specs (container, codecs, aspect ratio, duration, size, frame rate, audio), and error behaviours. Also: audio/music rules for professional (business) accounts using Reels (restrictions to royalty-free / Meta Sound Collection) and whether adding music inside the app after publishing via API is possible. Decide: integration approach and the owner's required setup steps.`,
  },
  {
    key: 'square',
    prompt: `${COMMON}
TOPIC: Square Bookings API for an Australian barber using Square Appointments.
Questions: Bookings API availability in Australia; which plan is required (Appointments Free vs Plus vs Premium) for seller-level booking create/update/cancel via API versus read-only; OAuth scopes (APPOINTMENTS_READ, APPOINTMENTS_WRITE, APPOINTMENTS_ALL_READ, APPOINTMENTS_ALL_WRITE, APPOINTMENTS_BUSINESS_SETTINGS_READ, CUSTOMERS_READ, ITEMS_READ, MERCHANT_PROFILE_READ, PAYMENTS_READ); key endpoints (ListBookings, SearchAvailability, CreateBooking, UpdateBooking, CancelBooking, ListTeamMemberBookingProfiles, ListLocationBookingProfiles, RetrieveBusinessBookingProfile, Customers API, Catalog APPOINTMENTS_SERVICE items); booking status values (PENDING, CANCELLED_BY_CUSTOMER, CANCELLED_BY_SELLER, DECLINED, ACCEPTED, NO_SHOW); webhook event names (booking.created, booking.updated, payment.created/updated, customer.*) and signature verification (header x-square-hmacsha256-signature, HMAC-SHA256 over notification URL + body with the webhook signature key; SDK helper WebhooksHelper.verifySignature); sandbox support for Bookings; the current Node SDK package name/version and client construction (package "square", SquareClient, environment, token) in 2025-2026; how to determine that an appointment actually happened (payment/order/checkout linkage, NO_SHOW status). Decide: what Studio Assistant can implement and what depends on the owner's plan.`,
  },
  {
    key: 'google',
    prompt: `${COMMON}
TOPIC: Google Business Profile for reviews and local search.
Questions: How a business obtains programmatic access to reviews (Google Business Profile APIs access request/approval process, quota request form; My Business account management / business information / reviews endpoints (accounts.locations.reviews.list), Business Profile Performance API for search impressions/direction requests/calls); the official "get more reviews" review link format (e.g. https://g.page/r/<id>/review or https://search.google.com/local/writereview?placeid=...); Google's policy on soliciting reviews (allowed to ask customers; prohibited: incentives, review gating/selective solicitation, discouraging negative reviews); Google Search Console API for indexing/performance data and what verification is needed. Decide: Studio Assistant plan for review requests (link-based) and tracking, and which metrics can be shown only when an authorised integration provides them.`,
  },
  {
    key: 'supabase',
    prompt: `${COMMON}
TOPIC: Supabase as deployment target for Postgres + private storage.
Questions: Supabase Storage S3-compatible protocol (endpoint format https://<ref>.storage.supabase.co/storage/v1/s3 or https://<ref>.supabase.co/storage/v1/s3, region, S3 access keys, which S3 operations are supported incl. multipart upload and presigned GET URLs), supabase-js createSignedUrl expiry limits, private bucket behaviour, file size limits per plan (Free 50MB? Pro up to 50GB with S3 multipart/resumable uploads), storage/egress pricing on Free vs Pro (USD), database connection pooling (Supavisor session vs transaction mode ports 5432/6543) and implications for a Node worker using pg-boss (does pg-boss need session mode / LISTEN?), and whether a background worker can connect directly (direct connection IPv6 / dedicated pooler). Decide: recommended Supabase configuration for Studio Assistant and alternatives (Cloudflare R2 for media).`,
  },
  {
    key: 'music_catalogues',
    prompt: `${COMMON}
TOPIC: Commercially licensed music options for an app that renders social videos.
Questions: Which royalty-free / licensed music services offer an API usable by a small developer or business (e.g. Epidemic Sound partner API, Soundstripe API, Artlist, Uppbeat, Musicbed, Pixabay (does its API cover music?), Freesound (CC licences, API), Free Music Archive status, ccMixter, Incompetech/Kevin MacLeod CC BY, YouTube Audio Library (no API?)). For each: API availability, licence coverage for social media/commercial promotional use, whether tracks may be embedded in exported MP4s posted to Instagram/TikTok, attribution requirements, pricing. Also TikTok Commercial Music Library and Instagram/Meta Sound Collection rules for business accounts. Decide: a realistic "licensed catalogue" strategy for Studio Assistant (owner-uploaded licensed tracks + optional provider adapter) and how to record permitted usage per track.`,
  },
  {
    key: 'email_spam_act',
    prompt: `${COMMON}
TOPIC: Email sending for an Australian small business (appointment follow-ups, review requests, campaigns).
Questions: Australian Spam Act 2003 requirements for commercial electronic messages (consent: express vs inferred; sender identification; functional unsubscribe honoured within 5 business days; factual messages exemption e.g. appointment reminders) per ACMA guidance; Resend and Postmark: pricing tiers, Australian region/data residency options, support for List-Unsubscribe / one-click unsubscribe headers (RFC 8058), webhooks for delivered/bounced/complained, suppression lists, batch sending API, Node SDK names; Gmail/Yahoo bulk sender requirements (SPF/DKIM/DMARC, one-click unsubscribe). Decide: provider recommendation and the consent/unsubscribe data model Studio Assistant must implement.`,
  },
  {
    key: 'safe_zones_specs',
    prompt: `${COMMON}
TOPIC: Vertical video safe zones and export specs for TikTok and Instagram Reels (1080x1920).
Questions: Official or widely cited current guidance for UI-overlay safe zones on TikTok (top/bottom/right margins in pixels for 1080x1920, e.g. caption/username area, right-side action buttons) and Instagram Reels (top ~ 220px, bottom ~ 420px?) — cite sources and note if figures are from official creative guidelines vs third-party templates. Recommended export specs: codec H.264 High profile, level, AAC-LC 48kHz, bitrate ranges, frame rates (24/25/30/60), max durations (TikTok up to 10 min, Reels up to 3 min for API?), file size limits, colour (bt709 SDR vs HDR support). Decide: the safe-zone rectangle Studio Assistant should use so text avoids BOTH platforms' UI, and the export preset.`,
  },
  {
    key: 'transcription',
    prompt: `${COMMON}
TOPIC: Speech transcription provider options for short barber clips (only when speech is present).
Questions: OpenAI Audio API transcription endpoint (POST /v1/audio/transcriptions): current models (whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe, newer?), which support response_format=verbose_json with segment/word timestamps (timestamp_granularities), file size limit (25MB), pricing per minute; Deepgram Nova pricing and prerecorded API shape; AssemblyAI; local whisper.cpp / faster-whisper viability on a 4-vCPU worker. Also any Anthropic API audio input support (does the Claude Messages API accept audio? as of 2026). Decide: default transcription adapter for Studio Assistant and a cheap gating heuristic for "speech present".`,
  },
  {
    key: 'trends',
    prompt: `${COMMON}
TOPIC: Permitted live data sources for short-form video trends relevant to barber content.
Questions: TikTok Creative Center (trending sounds/hashtags/creators) — is there an official API or only the website with terms prohibiting scraping? TikTok Research API (academic only?) and Commercial Content API; Instagram/Meta: any official trending-audio API? YouTube Data API: trending/mostPopular Shorts? Google Trends: official API status (e.g. Google Trends API alpha 2025) and terms. Decide: what Studio Assistant can legitimately show as "current trends" with source + last-updated date, versus clearly labelled curated references; include 6-10 evergreen barber-content formats (e.g. before/after reveal, ASMR fade detail, satisfying line-up, transformation with reaction, POV, speed ramp montage, client story) with sources that describe them.`,
  },
  {
    key: 'anthropic_vision',
    prompt: `${COMMON}
TOPIC: Anthropic Claude Messages API image input constraints for frame labelling (2026).
Questions: supported image formats (JPEG/PNG/GIF/WebP), max image size per image (bytes and pixels, e.g. 5MB, 8000px, recommended ≤1568px long edge, ~1.15MP for ~1600 tokens), max images per request, base64 vs URL sources vs Files API, token cost formula (width*height/750), whether video input is supported (it is not, as far as known — confirm), structured outputs (output_config.format with JSON schema) availability on Claude Opus 5.5 / Haiku 5.5, and current pricing for claude-opus-5-5 and claude-haiku-5-5. Decide: frame sampling budget (e.g. up to N frames per clip at 768px) and request batching for Studio Assistant, with a cost estimate per project of 6 clips.`,
  },
]

phase('Research')
log(`Researching ${TOPICS.length} platform/policy topics in parallel`)
const results = await parallel(TOPICS.map(t => () =>
  agent(t.prompt, { label: `research:${t.key}`, phase: 'Research', schema: RESEARCH_SCHEMA })
))
const found = results.map((r, i) => ({ key: TOPICS[i].key, result: r })).filter(x => x.result)
log(`${found.length}/${TOPICS.length} topics returned results`)

phase('Critique')
const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    gaps: { type: 'array', items: { type: 'object', properties: { topic_key: { type: 'string' }, question: { type: 'string' }, why_it_matters: { type: 'string' } }, required: ['topic_key', 'question', 'why_it_matters'] } },
    contradictions: { type: 'array', items: { type: 'string' } },
    overall_assessment: { type: 'string' },
  },
  required: ['gaps', 'contradictions', 'overall_assessment'],
}
const critique = await agent(`You are a sceptical reviewer. Below are research results (JSON) gathered for building "Studio Assistant" (barber video-editing + business tools app, Australia). Identify: (1) important unanswered questions or claims lacking evidence that would change an implementation decision (e.g. whether an unaudited TikTok app can post privately, whether Instagram dev-mode publishing works without App Review, Square plan requirements for booking writes, Spotify access status in 2026); (2) contradictions between topics; (3) claims that look like guesses. Limit gaps to the 8 most decision-relevant items, each phrased as a precise question an agent can research with web search.

RESULTS:
${JSON.stringify(found, null, 1).slice(0, 180000)}`, { label: 'critique', phase: 'Critique', schema: CRITIQUE_SCHEMA })

phase('Follow-up')
const gaps = (critique && critique.gaps) ? critique.gaps.slice(0, 8) : []
log(`Critic flagged ${gaps.length} gaps; researching them`)
const followups = await parallel(gaps.map((g, i) => () =>
  agent(`${COMMON}
FOLLOW-UP QUESTION (topic ${g.topic_key}): ${g.question}
Why it matters: ${g.why_it_matters}
Answer this one question precisely with evidence.`, { label: `followup:${g.topic_key}:${i}`, phase: 'Follow-up', schema: RESEARCH_SCHEMA })
))

phase('Synthesise')
const memo = await agent(`Write the research memo for Studio Assistant as a Markdown file at /home/user/editor/docs/research/platform-constraints.md (create directories as needed; use the Write tool or bash heredoc). Audience: the business owner and the next engineer. Australian English.

Structure:
# Platform and policy research (verified 2026-11-09)
Intro paragraph: how this was verified (web search summaries; which official pages could be fetched in full vs only via search summaries because the build sandbox blocks most documentation hosts), and a caution that items marked "search summary" must be re-confirmed against the official page before go-live.
Then one section per topic with: Decision (bold, 1-3 sentences), What the sources say (bulleted, each with source URL and date note), Account/plan/app-review requirements (bullets), Open questions. Topics in this order: Spotify, Music catalogues & permitted usage, TikTok, Instagram, Safe zones & export specs, Square, Google Business Profile, Email & Spam Act, Transcription, Anthropic vision & cost, Trend sources.
End with a "Decision summary" table: Capability | Approach | Status (Supported now / Needs owner account setup / Not supportable — explain) | Key constraint.
Also include a short "Follow-up findings" section listing the critic's flagged questions and what was found.
Be precise, no marketing language, no invented statistics. Where confidence is low, say so.

RESEARCH RESULTS JSON:
${JSON.stringify(found, null, 1).slice(0, 200000)}

CRITIQUE:
${JSON.stringify(critique, null, 1).slice(0, 20000)}

FOLLOW-UP RESULTS:
${JSON.stringify(followups.filter(Boolean), null, 1).slice(0, 120000)}

After writing the file, return a 15-line plain-text summary of the key decisions (one line per topic) and the exact file path written.`, { label: 'synthesise', phase: 'Synthesise' })

return { topics: found.map(f => f.key), critique, followupCount: followups.filter(Boolean).length, memo }