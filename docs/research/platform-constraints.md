# Platform and policy research (verified 2026-11-09)

**How this was checked.** An automated research workflow did the work: twelve topic agents, one critic, and eight follow-up agents that chased the questions the critic flagged. The agents ran from 12 to 14 November 2026. Their instructions used 9 November 2026 as the reference date, which is why the heading carries that date. The build sandbox blocks most documentation hosts (DNS `ENOTFOUND`), including developer.spotify.com, community.spotify.com, developers.tiktok.com, ads.tiktok.com, www.tiktok.com, support.tiktok.com, developers.facebook.com, help.instagram.com, www.facebook.com, developer.squareup.com, squareup.com, developers.google.com, support.google.com, acma.gov.au, legislation.gov.au, austlii.edu.au, resend.com, postmarkapp.com, developers.openai.com, platform.openai.com, developers.buffer.com, zernio.com, web.archive.org and most music-library sites. For those hosts, all evidence is the agents' **web-search summaries** of the official pages. Wording may be paraphrased, and most pages showed no last-updated date (the search tool gave only approximate index ages). Some pages were **read in full**:

- Anthropic's documentation on platform.claude.com: vision, pricing, structured outputs, Files API, models, batch processing, rate limits and release notes. The fetch tool only partly summarised two long pages.
- Square's official OpenAPI specification (Square-Version 2026-09-16), the `square-nodejs-sdk` 46.0.0 source, and the npm registry metadata.
- Several community GitHub issues, pull requests and gists, mainly about Instagram Unified Login, TikTok inbox uploads and Spotify. These are community reports, not official statements.

**Before go-live, re-confirm every item marked "search summary" on the official page.** This matters most for prices, plan requirements, app-review rules and legal obligations that will be shown to the owner. Labels used below: *full page* (read directly), *search summary* (search-engine summary of the page), *community* (developer forum, GitHub or vendor blog), *third party* (review or competitor site). The storage and deployment research (Supabase, Cloudflare R2) is in `docs/research/decisions-summary.md` and is not repeated here.

**This memo supersedes `docs/research/decisions-summary.md` where they differ.** That file was written before the follow-ups. The follow-ups changed six decisions:
- Spotify: the Web API tier is dropped.
- TikTok: the stated reason for not integrating directly has changed.
- Instagram: the authentication mode and the upload method have changed.
- Meta Sound Collection: the rule for baking tracks into renders has changed.
- Square: the no-show-fee workaround has changed.
- TikTok auto-publishing: the provider choice is now Zernio, not Buffer.

---

## 1. Spotify

**Decision: Spotify serves only as the owner's private music reference. The owner pastes a Spotify link, Studio Assistant stores only that URL/URI plus the owner's own notes, and the official embed is shown unmodified on authenticated internal pages, with a link-only fallback. Do not build any Spotify Web API integration: Spotify's 2026 wording limits Development Mode to non-commercial personal projects. Spotify audio never goes into renders or exports, Spotify data never goes to AI features, and the app never implies that in-shop playback is covered.**

Confidence: medium. No official Spotify page could be read directly.

Build notes:
- Do not cache or persist oEmbed data, do not autoplay, and show Spotify attribution with a link back.
- Never show embeds on public, client-facing or promotional surfaces, including the website module, emails and social posts.
- A one-switch fallback to link-only mode (URL and notes, no iframe) must exist.
- Studio Assistant's end-user terms and privacy policy pages must exist before any embed renders.
- UI copy: "Spotify links are kept for your own music reference only. They are not licensed for playing in the shop or in your videos."

What the sources say:
- The Developer Terms are "Version 10, effective as of 15 May, 2025", and the Developer Policy is "Effective as of 15 May, 2025". Two third-party notes that read the pages in September and October 2026 still saw these versions. Searches found no Version 11. Source: https://developer.spotify.com/terms (search summary; index copy about 543 days old), corroborated by https://github.com/lucasancelmodias/spot-mixer/blob/main/docs/research_notes/Spotify%20Web%20API%20and%20mixer%20stack/spotify_access_policy_auth.md (full page, third party, read 25 Oct 2026).
- AI/ML ban: "Do not use the Spotify Platform or any Spotify Content to train a machine learning or AI model or otherwise ingest Spotify Content into a machine learning or AI model." Spotify has not said whether putting metadata into an LLM prompt counts as "ingest". This memo treats it as prohibited. Source: https://developer.spotify.com/policy (search summary; effective 15 May 2025).
- Synchronisation and mixing bans: "Do not synchronize any sound recordings with any visual media, including any advertising, film, television program, slideshow, video, or similar content". Mixing or overlapping Spotify audio with other audio is also prohibited. Source: https://developer.spotify.com/policy (search summary).
- 30-second preview URLs were withdrawn for new apps on 27 November 2024, and the Search reference marks `preview_url` as deprecated. Source: https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api (search summary; published 27 Nov 2024).
- Spotify Content may not be transferred to third parties "even if a user consents", except to data processors such as hosting providers. It may not be stored indefinitely, and caching is limited to temporary metadata and cover art. Source: https://developer.spotify.com/terms (search summary).
- Development Mode since February 2026:
  - The owner must hold Spotify Premium.
  - Each Client ID allows at most 5 authorised users.
  - Fewer endpoints are available.
  - The rules apply to new Client IDs from 11 February 2026.
  - Spotify says Development Mode "should not be relied on as a foundation for building or scaling a business on Spotify" and supports "personal projects for non-commercial use by individual developers".

  Source: https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security (search summary; posted 6 Feb 2026 with a 9 March addendum). Spotify's community index lists the post under 18 June 2026, and no reason for that was found.
- App creation was paused from about late December 2025 ("New integrations are currently on hold…") until the new rules took effect on 11 February 2026. Source: https://community.home-assistant.io/t/spotify-restricting-new-apps/979399 (community, Jan 2026).
- In July 2026 the Client ID limit rose from 1 to 25 per developer account. Quota is now pooled per account, and a quota error returns 429 with `reason: QUOTA_EXCEEDED`. No later Development Mode changes were found. Source: https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates (search summary; 23 Jul 2026).
- Refresh tokens now expire 6 months after the original authorisation, and refreshing does not extend that. Source: https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration (search summary; 18 Jun 2026).
- Since 15 May 2025, Extended Quota Mode accepts organisations only. Applicants need a launched service with at least 250k monthly active users. Source: https://developer.spotify.com/documentation/web-api/concepts/quota-modes (search summary; undated).
- Embeds need no developer account. The Widget Terms still show "Version 2.0. Effective as of 27 May 2014" and say "the Spotify Play Button may not be used for commercial purposes". They require an end-user agreement and privacy policy and permit display on "any website or webpage controlled by you". Using Embeds also means accepting the Developer Terms. Source: https://developer.spotify.com/documentation/embeds/terms (search summary; the current live page was not read).
- Spotify's consumer service is "only for personal, non-commercial use". Salons are listed as a disallowed setting, and Spotify names Soundtrack for commercial premises. Source: https://support.spotify.com/us/article/spotify-public-commercial-use/ (search summary; about 3 years old).

Account/plan/app-review requirements:
- Embed or link-only use needs no Spotify for Developers account, Client ID or Premium. The owner should read the Developer Terms v10 and the Widget Terms v2.0.
- Studio Assistant must publish an end-user agreement and a privacy policy before showing any embed.
- Revisiting the Web API would need four things: written permission from Spotify for an internal business tool (no published request channel exists), an owner account with active Premium, a Development Mode Client ID, and an allowlist of at most 5 users. Development Mode has no app review. Extended Quota is out of reach for a single shop.
- Music played in the shop needs a commercial background-music service, plus APRA AMCOS/OneMusic for public performance (see section 2). The owner's Spotify account does not cover it.

Open questions:
- The 2014 Widget Terms do not define "commercial purposes", so it is unclear whether a private reference page inside a business's own app is a commercial use. Confidence is low, which is why the link-only fallback exists.
- Re-read `/terms`, `/policy` and `/documentation/embeds/terms` live (developer.spotify.com must be allowed in network settings) and record the versions and dates here.
- Why the February post is re-dated to 18 June 2026 is unresolved. It may have been an unseen edit.

## 2. Music catalogues & permitted usage

**Decision: The source of truth is tracks the owner uploads, each with a per-track licence record (the "licence passport"). The renderer blocks export to any platform the licence does not cover. The owner buys one business-eligible subscription in the business's name and downloads tracks by hand; no library API is built in Phase 1. TikTok Commercial Sounds are added only inside the TikTok app. Meta Sound Collection tracks may be rendered into an MP4 only when that render is locked to Meta destinations. Chart or trending music is never baked into exports.**

Confidence: medium. Every vendor site was blocked, and prices conflict between sources.

Build notes:
- Make the following changes to `packages/core/src/music.ts`, which currently has no Sound Collection kind, no `facebook` platform and no destination lock:
  - Add kind `meta_sound_collection`.
  - Add a `facebook` platform.
  - Add `destinationLock: 'meta_only' | null`.
  - Force `meta_only` renders to TikTok, YouTube and website = false.
- Label downloads of `meta_only` renders "For Instagram/Facebook upload only".
- Never feed a `meta_only` render to the website module. Use the Instagram embed there instead.
- Reject CC BY-NC tracks at import. For CC BY tracks, auto-insert the stored attribution text into captions.
- Keep a usage ledger that holds a snapshot of each track's licence passport at the time of use.
- Offer a "music-free export" so the owner can add platform-native audio inside the apps.

What the sources say:
- Epidemic Sound's API needs a partnership agreement. The free developer plan is for prototyping only and carries no commercial licence. End users get a commercial licence only through their own paid Epidemic subscription. Source: https://developers.epidemicsound.com/docs/ (search summary; undated).
- Epidemic's Commercial subscription allows publishing "anywhere online", including social platforms. It covers one user and has a business turnover cap. Source: https://www.epidemicsound.com/policy/commercial-subscription-music-license/ (search summary; undated).
- Soundstripe offers a self-serve 30-day trial API key with watermarked previews. Production keys need a sales agreement. Listed plans:
  - Personal US$119/yr, which excludes paid social
  - Pro US$239/yr
  - Business US$999/yr, with paid social for a "local audience"
  - Tracks downloaded while subscribed stay licensed after cancellation.

  Source: https://www.soundstripe.com/knowledge/plans-coverage/pricing-faq (search summary; prices unconfirmed; AUD/GST not checked).
- Artlist's Music API exists only on the custom-priced Enterprise plan. Its Social plan is "exclusively for personal content creators" and does not cover business promotion. Source: https://artlist.io/help-center/privacy-terms/artlist-license/ (search summary; the licence PDF is dated 17 Aug 2021).
- Other libraries:
  - Uppbeat's API is still "in development".
  - Musicbed has no public API.
  - Pixabay's API covers images and video only, not music.
  - Freesound's API is free only for non-commercial use.
  - Free Music Archive shut down its API.
  - ccMixter has a beta query API with a licence filter.
  - Incompetech is CC BY with mandatory credit, or a paid licence.
  - YouTube Audio Library has no API and is aimed at videos on YouTube.

  Sources: https://uppbeat.io/pricing, https://freesound.org/docs/api/terms_of_use.html, https://freemusicarchive.org/app-developers, https://ccmixter.org/query-api (all search summaries; mostly undated).
- TikTok's general library is for "personal, non-commercial use". Business Accounts see only Commercial Sounds, and Commercial Music Library tracks are licensed for use on TikTok only. Source: https://www.tiktok.com/legal/page/global/commercial-music-library-user-terms/en (search summary; version date not visible).
- Meta Music Guidelines: "Use of music for commercial or non-personal purposes in particular is prohibited unless you have obtained appropriate licenses." Source: https://www.facebook.com/legal/music_guidelines (search summary; a Jan 2024 version exists).
- Meta Sound Collection licence: use "for commercial or non-commercial purposes in content you create, upload, and distribute on the Meta Company Products … only". You "may not … use the SC Audio Content separately from the Meta Company Products". Source: https://www.facebook.com/sound/collection/terms/ (search summary; a third party says last updated March 2022).
- Meta's help pages describe Sound Collection as something you download and add using "your own video editing software". Nothing restricts it to Meta's in-app tools. Source: https://en-gb.facebook.com/business/help/1821972904537292 (search summary; Creator Studio era).
- Instagram business accounts may not have the Licensed Music Library ("isn't available for your account type or in your country or region"). Boosted reels cannot use licensed music. Source: https://help.instagram.com/1612770602842742/ (search summary; undated).
- Meta added an Instagram Audio API for Facebook Login apps. It can attach Sound Collection or original audio when a Reel is created. Source: https://developers.facebook.com/documentation/instagram-platform/changelog (search summary; dated 1 June 2026 by third parties and 22 June 2026 in one summary; the container parameter is unverified).
- An APRA AMCOS/OneMusic licence covers in-shop public performance only. It "does not extend to uploading videos with music to social media". Source: https://www.apraamcos.com.au/about/help/faqs (search summary; undated).
- AI music: ElevenLabs Music API costs US$0.15/min with commercial use on Starter and higher plans, but ElevenLabs' own pages contradict each other on advertising rights. Mubert's pages contradict each other on its sublicensing tier. Source: https://elevenlabs.io/pricing/api (search summary).

Account/plan/app-review requirements:
- The owner buys one business-eligible plan in the business's name: Soundstripe Pro or Business, Epidemic Sound Commercial, Uppbeat Pro or Business, Artlist Pro or Max Business, or Musicbed Business. Personal, Social and Creator tiers do not qualify. Keep the invoices and the licence record for each track.
- The owner registers ("safelists") the shop's channels in the provider's claim-clearance tool. The owner also asks the provider to confirm in writing that the plan covers organic posts, the website and any paid boosts.
- Sound Collection: the owner downloads tracks with the business's own Meta login on a computer, accepts the terms, and keeps proof (asset link, download date, date terms were accepted).
- TikTok: keep the TikTok Business Account and add Commercial Sounds in the app.
- No platform approval is needed for owner-uploaded tracks. Provider API adapters (Soundstripe, Storyblocks, Shutterstock) would each need a sales or enterprise agreement for production keys.

Open questions:
- Prices conflict across sources for Epidemic, Uppbeat, Artlist and Musicbed. It is also unconfirmed whether Epidemic productions stay cleared after a subscription is cancelled.
- No official source says whether Sound Collection tracks are exempt from Rights Manager matching. Treat a copyright match as possible (see section 4).
- Whether YouTube Audio Library standard-licence tracks may be used off YouTube is not stated. Treat them as YouTube-only.
- The copyright status of AI-generated music under Australian law was not researched.

## 3. TikTok

**Decision: Ship export plus manual posting as the only TikTok path in Stages A and B. Do not build a direct Content Posting API integration: TikTok's App Review Guidelines say "Apps must not be for private or personal use", and its Direct Post guidelines list "a utility tool to help upload contents to the account(s) you or your team manages" as unacceptable. Optional Stage C auto-publishing goes through one already-audited provider, Zernio, behind a feature flag and only after a live smoke test.**

Confidence: medium. developers.tiktok.com was blocked, and no live test of the inbox path was found.

Build notes:
- Export a 1080×1920 MP4 (section 5) with a caption of at most 2,200 characters.
- Provide one-tap download or share and a copy-caption button.
- Show the status "Post in the TikTok app; add a Commercial Sound there", and let the owner confirm "Posted" by hand.
- Stage C (Zernio):
  - Upload server to server through Zernio's presigned media flow, so no public URL of ours is exposed.
  - Set `content_preview_confirmed` and `express_consent_given` only after the owner has seen the preview and ticked a consent box.
  - Use `privacy_level` `PUBLIC_TO_EVERYONE`, the only value Zernio's Business lane accepts.
  - Store the Zernio `postId` so a retry never posts twice.
  - Set the states queued, processing, published and failed only from Zernio webhooks or polling.

What the sources say:
- Direct Post uses scope `video.publish`. Upload-to-inbox uses scope `video.upload`: the creator receives an inbox notification and finishes the post in TikTok's editor. Source: https://developers.tiktok.com/docs/en/tiktok-api-scopes (search summary; undated).
- Unaudited clients: "Unaudited API Clients can allow up to 5 users to post in a 24 hour window. All user accounts using the API client to post must be set to private at the time of posting." They "can only post contents in SELF_ONLY viewership". These rules sit under the "Direct Post API – Developer Guidelines" heading. Source: https://developers.tiktok.com/docs/en/content-sharing-guidelines (search summary; index about 100 days old; reportedly updated 4 Aug 2026).
- App review: "The intended purpose of your app must meet our developer guidelines. Apps must not be for private or personal use. Apps that are still in development or testing will not be approved." Other requirements:
  - Verified Terms of Service, Privacy Policy and website URLs (for apps created after 9 Sep 2024)
  - A fully developed public website
  - 1–5 demo videos
  - No published timeline or guarantee of approval

  Source: https://developers.tiktok.com/docs/en/app-review-guidelines (search summary; reportedly updated 4 Aug 2026).
- Inbox upload: the `/v2/post/publish/inbox/video/init/` body has no privacy field. The error code for an unaudited client posting to a private account is documented only for Direct Post. Other limits are 5 pending drafts per 24 h and 6 init requests per minute. Video captions appear not to pre-fill. Sources: https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video (search summary) and https://app.pushrealm.com/solution/571 (community).
- No public live test was found in which an unaudited client sent a draft that was then posted publicly. Community pull requests that claim drafts are exempt are marked "not live-verified" or were tested with mocks only. Source: https://github.com/TysAIs/xPST/pull/266 (community, full page, 26 Sep 2026).
- Media limits:
  - Formats: MP4 (recommended), WebM or MOV
  - Codecs: H.264 (recommended), H.265, VP8 or VP9
  - 23–60 fps
  - 360–4096 px on each side
  - At most 4 GB and at most 10 minutes through the API
  - `PULL_FROM_URL` needs a verified domain or URL prefix and rejects 3xx redirects
  - `FILE_UPLOAD` chunks must be 5–64 MB

  Source: https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide (search summary; index about 100 days old).
- Direct Post allows "typically around 15 posts per day / creator account", shared across all API clients. Source: https://developers.tiktok.com/docs/en/content-sharing-guidelines (search summary).
- The API cannot attach TikTok-library sounds to a video. `auto_add_music` exists only for photo direct posts. Source: https://developers.tiktok.com/docs/en/content-posting-api-reference-photo-post (search summary).
- Business Accounts see only Commercial Sounds. Uploading your own audio requires agreeing to the Music Usage Confirmation (no copyrighted music, or all licences obtained). Sources: https://ads.tiktok.com/help/article/how-to-use-the-commercial-music-library and https://www.tiktok.com/legal/page/global/music-usage-confirmation/en (search summaries; undated).
- TikTok API for Business has a separate "publish a public video post to an owned account" endpoint. It needs a company-domain email and a public company website ("Individual developers and personal accounts are currently not onboarded"). From 20 March 2026 it also needs an Accounts API access application. Source: https://business-api.tiktok.com/portal/docs/publish-a-public-video-post-to-an-owned-account/v1.3 (search summary).
- No 2025–2026 Content Posting API changelog entries were found. Source: https://developers.tiktok.com/docs/en/changelog (search summary).
- Zernio:
  - Documents the full TikTok video direct-post flow: presigned upload, `POST /v1/posts`, two required consent flags, and webhooks such as `post.platform.published` and `post.platform.failed`.
  - From 10–11 September 2026, new connections use TikTok's Business API. Videos post as public only, with a cap of 15 per account per rolling 24 h.
  - Pricing: "First 2 accounts free"; then US$6/month each for accounts 3–10.

  Sources: https://docs.zernio.com/platforms/tiktok/posts and https://zernio.com/blog/september-11-2026-product-updates (search summaries; pricing pages undated).
- Buffer:
  - Its GraphQL API works on the Free plan with the organisation owner's personal key.
  - Its own roadmap says TikTok video goes only by `PULL_FROM_URL`, which needs the hosting domain verified in TikTok's developer dashboard. Buffer has no upload endpoint and no webhooks.
  - The legacy REST API shuts down on 1 February 2027.

  Sources: https://developers.buffer.com/roadmap.html (search summary; about May 2026) and https://buffer.com/api (search summary).
- Ayrshare costs about US$149/month for one profile, and Zapier has no native TikTok publish action. Sources: https://www.upload-post.com/ayrshare-pricing/ (third party) and https://help.zapier.com/hc/en-us/articles/22220317838861-How-to-get-started-with-TikTok-Lead-Generation-on-Zapier (search summary).

Account/plan/app-review requirements:
- Manual path: a TikTok Business Account for the shop. No developer account, app review or audit is needed.
- Stage C (Zernio):
  - The business opens its own Zernio account. The first two connected accounts are free, counted across invited staff; this is unverified as of November 2026.
  - The API key is kept server-side and encrypted.
  - The owner connects TikTok through Zernio's Business API flow and approves every permission.
  - Limits: 15 videos per rolling 24 h, 3 s–10 min, at most 4 GB, captions up to 2,200 characters.
- Direct integration (not recommended): a TikTok for Developers organisation, verified URLs, a public website, demo videos, a sandbox demonstration, app review (which the private-use bar is likely to fail), then a separate Direct Post audit.
- Optional, research only: a sandbox spike with the owner's account as a target user, to see whether `video.upload` drafts can go public and whether Commercial Sounds show. This does not authorise shipping.

Open questions:
- No official statement and no live test show whether TikTok enforces SELF_ONLY on inbox drafts in practice. A broad FAQ sentence ("All content posted by unaudited clients will be restricted to private viewing mode") could be read to cover drafts too.
- Zernio does not say its TikTok app is audited. Only a smoke test with one short 9:16 MP4 will show whether its flow works end to end.
- Ayrshare, Zernio and Buffer prices come from third-party or undated pages.

## 4. Instagram

**Decision: The guaranteed Instagram path is export plus manual posting. Direct Reels publishing is an optional module, set up as follows:**
- **The owner creates a new Meta app on "API setup with Unified login", configured as Facebook Login for Business with a System-user access token.**
- **The app stays in Development mode with Standard Access and serves only the owner's own account.**
- **Video goes up by resumable binary upload to `rupload.facebook.com`, so no public video URL exists.**
- **The module is switched on only after a recorded live smoke test publishes one reel.**
- **The app never claims it can add Instagram library or trending music.**

Confidence: medium. All Meta pages came through search summaries, and the Unified Login change is documented mainly by community reports from 29 October to 10 November 2026.

Build notes:
- Login dialog:
  - `facebook.com/{v}/dialog/oauth` with `client_id`, `config_id`, `response_type=code` and `override_default_response_type=true`, and no `scope`.
  - Exchange the code server-side on graph.facebook.com.
  - Require a `debug_token` type of `SYSTEM_USER` with `instagram_basic` and `instagram_content_publish`.
- Account discovery, in order:
  1. `GET /me/assigned_instagram_accounts`
  2. `debug_token` granular-scope `target_ids`
  3. An IG user ID the owner enters, checked with `GET /{id}?fields=id,username`
- Do not build the old Instagram Login fallback or a user-token configuration.
- Publishing:
  1. Read `content_publishing_limit` and block when `quota_usage >= quota_total`.
  2. `POST /{ig-id}/media` with `media_type=REELS&upload_type=resumable`.
  3. Stream the MP4 from private storage to `rupload.facebook.com/ig-api-upload/{v}/{container-id}` with `Authorization: OAuth`, `offset: 0` and `file_size` headers.
  4. Poll `status_code`.
  5. Before publishing, check `copyright_check_status`. If `matches_found` is true, do not publish; set the job to needs-attention.
  6. Call `media_publish` and read back the permalink.
- Use `thumb_offset` for the cover. Enable `cover_url` only after a spike shows it works with resumable uploads.
- Only if resumable upload proves unusable: fall back to a 24 h presigned URL on the R2 S3 API host, from a dedicated staging key, with no redirects. Delete the staging object after publishing or when the container reaches ERROR or EXPIRED.

What the sources say:
- Unified Login: "The Instagram API with Unified Login is the recommended setup for new integrations." Source: https://developers.facebook.com/documentation/instagram-platform (search summary; an earlier session saw "last updated Sep 16, 2026", not re-checked).
- The Meta App Dashboard now says "API setup with Instagram login is not available for newer apps. Your app uses API setup with Unified login instead." Several developers reported this independently. Meta has published no announcement. Sources: https://github.com/gitroomhq/postiz-app/issues/2350 (community, full page, 29 Oct–2 Nov 2026) and https://github.com/getopenpost/openpost/issues/495 (community, full page, 31 Oct–7 Nov 2026).
- On new apps, the classic dialog with explicit scopes fails with "Invalid Scopes", and standalone Instagram Login fails with "Invalid platform app". User-access-token configurations offer no Instagram permissions. Source: https://github.com/gitroomhq/postiz-app/pull/2404 (community, full page, 9–10 Nov 2026).
- App Review table: for an app "only for a business I own or manage", both the "No login or Facebook Login" and "No login or Instagram Login" rows show Standard Access with App Review not required. No "Unified Login" row was seen. Applying the Facebook Login row is an inference, because Unified Login is built on Facebook Login for Business. Source: https://developers.facebook.com/documentation/instagram-platform/app-review (search summary; undated).
- "Permissions with Standard Access can only be requested from app users who have a role on the requesting app." Business Verification is tied to Advanced Access. Source: https://developers.facebook.com/docs/graph-api/overview/access-levels/ (search summary; older page).
- System-user access token configurations require users to "log in using a business portfolio". Business integration tokens "default to never expire". The separate system-user guide says "all integrations should adopt expiring tokens" (60 days). Sources: https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business and https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/ (search summaries; undated).
- One developer reported that `business_management` was silently dropped from the token unless `public_profile` had Advanced Access. In that case `/me/assigned_instagram_accounts` returned empty and calls failed with code 100, subcode 33. No official source confirms this. Source: https://github.com/diwenne/openreply/issues/104 (community, full page, tested 31 Oct–1 Nov 2026 on Graph v26.0).
- A live run on 10 November 2026 used a Meta app created that day. The dialog, token exchange, account read and `content_publishing_limit` all worked. Publishing was not tried. When the app and the Instagram account were in the same business portfolio, `/me/assigned_instagram_accounts` came back empty. Source: https://github.com/gitroomhq/postiz-app/pull/2404 (community, full page).
- Container flow: `status_code` takes the values EXPIRED, ERROR, FINISHED, IN_PROGRESS or PUBLISHED. "Containers expire after 24 hours." Each account may create 400 containers per rolling 24 h. Meta suggests polling "once per minute, for no more than 5 minutes", a wording seen only through third-party relays. Sources: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container.md (search summary) and https://adaptlypost.com/blog/instagram-container-status-code-progress-finished (third party).
- Publishing quota: the publishing guide says 100 API-published posts per rolling 24 h. The `media_publish` reference (updated 21 Jan 2025) and the `content_publishing_limit` example say 50. Read the live value. Source: https://developers.facebook.com/docs/instagram-platform/content-publishing/ (search summary).
- Reels file spec:
  - MOV or MP4 container, moov atom first, no edit lists
  - AAC audio, at most 48 kHz, 128 kbps
  - H.264 or HEVC video, progressive, closed GOP, 4:2:0
  - 23–60 fps, at most 1920 columns, at most 25 Mbps
  - 3 s to 15 min, at most 300 MB

  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/ (search summary; index about 600 days old).
- `video_url`: "We cURL the video using the passed-in URL, so it must be on a public server." Meta says nothing about signed query strings, redirects, Range requests, Content-Length, fetch timing or how many times it fetches. The fetcher uses the `facebookexternalhit` user agent, which bot-blocking WAF rules may block. Sources: same Meta page (search summary) and https://www.ayrshare.com/docs/help-center/technical-support/meta_media_crawler_blocked (third party).
- Resumable upload: the flow is `upload_type=resumable`, then `POST https://rupload.facebook.com/ig-api-upload/<container-id>` with the file bytes. It is "available only for apps that have implemented Facebook Login for Business". One snippet gives a 100 MB maximum, which conflicts with the 300 MB Reels limit and is unresolved. Source: https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads (search summary; undated).
- Copyright detection: `copyright_check_status` on unpublished containers returns `matches_found` true or false. On published media, `copyright_check_information` reports BLOCK or MUTE per region. It is documented under the Facebook Login API variant. Source: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/copyright-detection.md (search summary).
- Music through the API: "Music tagging is only available for original audio". `audio_name` renames the reel's original audio and can be changed only once. After publishing, the only audio change is "Replace audio" on a reel whose audio was muted. Sources: the IG User Media reference above and https://help.instagram.com/825171856327681/ (search summaries).
- Error-code meanings come from third-party tables only: 9007/2207027 means not ready (keep polling); 2207026 unsupported format; 2207003 download timeout; 2207050 account restricted; 2207051 spam block; 2207042 quota reached. Source: https://www.postzen.dev/blog/instagram-graph-api-error-codes (third party).

Account/plan/app-review requirements:
- An Instagram professional account (Business or Creator) owned by the shop.
- A Meta developer account for the owner, who is an Admin on the Meta app. Anyone else who connects also needs an app role and full control of the business portfolio.
- A Meta business portfolio that the owner fully controls. The app must be connected to it, and the Instagram account added to or claimed by it.
- A new Business-type Meta app with the "Manage messaging & content on Instagram" use case and the Facebook Login for Business product.
- One configuration:
  - System-user access token, expiring Never (or 60 days plus a reconnect reminder)
  - The Instagram account as the business asset
  - `instagram_basic` and `instagram_content_publish`, plus `business_management` if discovery comes back empty
  - Record the `config_id`
  - Save an HTTPS redirect URI both in the configuration and under Valid OAuth Redirect URIs
- App settings: Privacy Policy URL, User Data Deletion URL and App Domains.
- Development mode with Standard Access. No App Review, Business Verification or Live mode is needed while only people with an app role connect the business's own account. App Review, Business Verification and Advanced Access become necessary only if the app is offered to other businesses.
- No Facebook Page is needed for Unified Login, according to community reports citing Meta.
- Outbound HTTPS from the worker to graph.facebook.com and rupload.facebook.com.

Open questions:
- **Main risk:** no public report shows an actual Reel publish from a Unified Login app created after late October 2026 in Development mode. Until the smoke test passes, Instagram stays "export and post manually".
- Whether `business_management` survives under Standard Access for people with an app role.
- The resumable upload size limit (100 MB or 300 MB) and whether `cover_url` works with resumable uploads.
- The publishing quota (50 or 100), and the Never vs 60-day token default in the configuration editor. Check with `debug_token` and the `content_publishing_limit` call.
- The current Graph API version: third parties give v26.0, and community tests also mention v27.0.
- Meta spells the permission two ways: `instagram_business_content_publish` and `instagram_business_content_publishing`. The dashboard is authoritative. This is moot under Unified Login, which uses `instagram_content_publish`.

## 5. Safe zones & export specs

**Decision: Render one 1080×1920 SDR H.264/AAC MP4 that suits both TikTok and Instagram Reels. Its text-safe zone is the conservative union of Meta's official percentages and the most conservative third-party reading of TikTok's template. Cap duration at 180 s and run an ffprobe check after every export.**

Confidence: medium. TikTok publishes no pixel figures, and Meta's percentages are guidance for ads.

Build notes (origin top-left):
- Areas where text, logos, CTAs and subtitles must never go:
  - top band: y < 270
  - bottom band: y ≥ 1248
  - sides: x < 120 and x > 960
  - right-hand action column: x > 780 where y ≥ 840
- `R_strict`, the default for all text: x 120–780, y 270–1248.
- `R_head`, for boxes whose bottom edge is at y ≤ 840: x 120–960, y 270–840.
- Subtitles: centred at x = 540, at most 480 px wide, box bottom at y ≤ 1248, at least 56 px type.
- The repo's current constants differ and are less conservative: `packages/core/src/safe-zones.ts` uses top 250, bottom 450, left 70, right 150. Bring them into line with these values, or record why not.
- Export preset:
  - libx264 High profile, level 4.1 (≤30 fps) or 4.2 (60 fps), yuv420p, progressive
  - Constant 30 fps. Use 60 fps only when every source is at least 50 fps.
  - Closed 2 s GOP
  - CRF 18 with `-maxrate 20M -bufsize 40M` at 30 fps, or `24M/48M` at 60 fps
  - BT.709 tags; tone-map HDR sources at ingest
  - AAC-LC, 48 kHz, stereo, 128 kbps, normalised to −14 LUFS
  - `-movflags +faststart`, no edit lists
  - Duration 5–180 s. For 90–180 s, lower maxrate to 12M; worst case 12 Mbps × 180 s ≈ 270 MB of video, under Instagram's 300 MB cap.
  - Reject any file over 300 MB.
- Previews may show a toggleable overlay of the TikTok and Reels safe zones. The exported file never contains it.

What the sources say:
- TikTok gives no fixed pixel safe zone: "The safe zone size is determined by the dimension …, ad caption length". Its organic guidance says to keep text out of the area covered by buttons and captions. Sources: https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en and https://www.tiktok.com/creator-academy/article/optimize-video-layout (search summaries; help articles about 1–2 years old).
- A third-party reading of TikTok's official 720×1280 in-feed template, scaled to 1080×1920, gives 240 px top, 660 px bottom and 120 px each side, plus a right-hand button column about 180 px wide from y ≈ 840. These are not TikTok's own figures. Other community figures (130/484/140/44, 150/440/60) are smaller and inconsistent. Sources: https://www.socialync.io/tools/safe-zones/tiktok and https://www.ezugc.ai/blog/tiktok-safe-zones-guide (third party, 2026).
- Meta Reels guidance: "leaving roughly 14% of the top, 35% of the bottom, and 6% on each side" free of text. At 1080×1920 that is 269 px, 672 px and 65 px. The figures come from the Reels image-ad spec. Meta also offers a Reels safe-zone checker template. Sources: https://www.facebook.com/business/ads-guide/update/image/instagram-reels and https://www.facebook.com/business/ads/facebook-instagram-reels-ads (search summaries; undated).
- The widely quoted "220 px top / 420 px bottom" figures trace to one third-party tool, not to Meta. Source: https://fileflippers.com/tools/instagram-reels-safe-zone (third party; undated).
- The Instagram Graph API Reels spec is as given in section 4: at most 25 Mbps, at most 1920 px wide, 3 s–15 min, at most 300 MB. Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media (search summary; about 600 days old).
- Facebook Reels Publishing API recipe: 1080×1920 recommended (minimum 540×960), 24–60 fps constant frame rate, closed GOP of 2–5 s, AAC-LC 48 kHz stereo at 128 kbps or more, 3–90 s. Source: https://developers.facebook.com/documentation/video-api/guides/reels-publishing (search summary; undated).
- H.264 level guidance comes from Meta's Live Video API: Level 4.1 for 1080p up to 30 fps and 4.2 for 1080p60. Source: https://developers.facebook.com/documentation/live-video-api/reference (search summary).
- Instagram Help Center:
  - aspect ratio 1.91:1 to 9:16
  - "minimum frame rate of 30 FPS", which conflicts with the API's 23–60
  - at least 720 px
  - Reels over 3 minutes are not recommended to new audiences
  - boosting needs 90 s or less

  Source: https://help.instagram.com/1038071743007909 (search summary; undated).
- Instagram's recommendation-eligibility guidance penalises low-resolution, watermarked or bordered reels. Source: https://creators.instagram.com/blog/instagram-recommendations-eligibility-tips-creators (search summary).
- Meta has accepted HDR phone uploads since July 2023, but the API spec says nothing about colour primaries, and TikTok's HDR handling is undocumented. Hence SDR BT.709. Source: https://about.fb.com/news/2023/07/facebook-video-keeps-getting-better/ (search summary; July 2023).
- TikTok Studio web upload: MP4 or WebM, at least 720×1280, up to 30 minutes, under 10 GB. MOV is not listed. Source: https://support.tiktok.com/en/using-tiktok/creating-videos/creator-tools-on-tiktok?lang=en (search summary; undated).

Account/plan/app-review requirements:
- None for manual posting. The owner should turn on TikTok's "Upload HD" setting where it is offered.
- If posts are boosted later, ad specs apply. TikTok in-feed ads need at least 540×960 and at most 500 MB. Instagram boosts need 90 s or less at 9:16.

Open questions:
- Nobody measured TikTok's template pixels. Download the in-feed safe-zone ZIP from TikTok Ads Help and Meta's Reels checker, re-measure, and repeat about every 6 months.
- Meta's 14/35/6 percentages are ad guidance. Organic overlays are usually smaller, so `R_strict` may place subtitles higher than some creators prefer.
- Instagram's maximum length is inconsistent: 20 min (Help), 15 min (API) and 90 s (boost). The 180 s cap avoids the conflict.
- No official TikTok audio spec exists. AAC-LC 48 kHz is inferred from Meta's spec.

## 6. Square

**Decision: Tier 0 (reads, webhooks and a labelled "attended and paid?" estimate) works on any Square Appointments plan. Tier 1 (create, reschedule and cancel from Studio Assistant) is switched on only at runtime: when `support_seller_level_writes === true`, for service variations that carry no no-show fee, and after a self-test on the owner's own Australian account. Deposits, confirmations, no-show marking and bookings of fee-bearing services are never offered as app actions. No Australian price or staff limit is shown as fact until someone has checked the live AU page.**

Confidence: medium overall. API mechanics are high, because they were checked against the full official spec and SDK source. Plans, prices and no-show-fee behaviour are low, because they come from search summaries only.

Build notes:
- Use `square@^46` (Node 18 or later) with `SquareClient`.
- Poll `bookings.list` in windows of at most 31 days and reconcile nightly. Webhooks only trigger a re-fetch.
- Mirror Square's six statuses exactly. Derived views ("Past", "Attended & paid", "No payment matched") are labelled as inferred, and the owner can override them.
- Verify webhooks with `await WebhooksHelper.verifySignature(...)` on the raw body and the exact configured URL. Square's README example leaves out `await`; a Promise is truthy, so copied code would accept every request.
- Classify each variation:
  - "Bookable from Studio Assistant": no variation `no_show_fee` and a business `cancellation_fee_money` of zero
  - "Book in Square": the variation carries a fee
  - "Unverified": the business-level fee is non-zero
- Store any 4xx response from a write verbatim. Never show a booking as made unless Square confirmed it.
- Keep plan facts in one config record with prices null until someone verifies them.

What the sources say:
- "For calls to this endpoint with seller-level permissions to succeed, the seller must have subscribed to *Appointments Plus* or *Appointments Premium*." This appears on CreateBooking, UpdateBooking and CancelBooking and on booking custom-attribute writes. There is no country exception. Read endpoints have no plan requirement. Source: https://raw.githubusercontent.com/square/connect-api-specification/master/api.json (full page, Square-Version 2026-09-16).
- `BusinessBookingProfile.support_seller_level_writes` "indicates whether the seller's subscription to Square Appointments supports creating, updating or canceling an appointment through the API". Source: same spec (full page).
- `Booking.status` is read-only. The values are PENDING, ACCEPTED, DECLINED, CANCELLED_BY_CUSTOMER, CANCELLED_BY_SELLER and NO_SHOW; there is no "completed". The Booking object has no field for deposits, payments or notification control. Source: same spec (full page).
- Bookings created with seller-level permissions are ACCEPTED immediately, while buyer-level bookings start PENDING. Source: https://developer.squareup.com/docs/bookings-api/use-the-api (search summary).
- No API field links a booking to a payment or order. Square staff: "with the APIs there isn't a way to map a booking to the payment or order". One developer's matcher was "only accurate 80% of the time". Sources: spec grep (full page) and https://developer.squareup.com/forums/t/how-to-link-a-payment-to-an-appointment-api/5266 (community).
- Webhooks:
  - `booking.created` and `booking.updated` need `APPOINTMENTS_READ`, and `APPOINTMENTS_ALL_READ` as well at seller level.
  - `payment.*`, `customer.*` and `order.*` are also available; `order.*` is marked BETA.
  - A forum thread reports some missed `booking.created` events.

  Source: spec (full page) and https://developer.squareup.com/reference/square/bookings-api/webhooks/booking.created (search summary).
- Signature: `x-square-hmacsha256-signature` = base64(HMAC-SHA256(key, notificationUrl + rawBody)). `verifySignature` is `async`. Source: https://raw.githubusercontent.com/square/square-nodejs-sdk/master/src/wrapper/WebhooksHelper.ts (full page, SDK 46.0.0).
- The npm package `square` 46.0.0 was published on 15 September 2026, needs Node 18 or later, and defaults to Square-Version 2026-09-16. Source: https://registry.npmjs.org/square (full page).
- No-show fee settings: "You'll have three fee options with no-show protection: to charge a flat fee per appointment, per service, or as a percentage of each service price". In per-service mode, "A cancellation fee amount must be entered for each service". An AU summary reported a $500 cap per appointment. Source: https://squareup.com/help/au/en/article/5493-set-a-custom-cancellation-policy-with-square-appointments (search summary; regional versions mixed; undated).
- "You cannot use the Bookings API to book a service that has a non-zero cancellation fee set on its no_show_fee attribute." The Concepts page words it more broadly: "You cannot currently use the Bookings API to create a booking with a non-zero cancellation fee." Sources: https://developer.squareup.com/docs/bookings-api/use-the-api and https://developer.squareup.com/docs/bookings-api/get-ready-to-use-the-api (search summaries).
- `no_show_fee` appears in a docs example response but not in the spec or the SDK types. The spec documents only the business-level `cancellation_fee_money` ("The flat-fee amount charged for a no-show booking"). Sources: spec and SDK types (full page).
- A forum thread from an Australian barbershop (about late September 2026) says the API has "no supported way to book a service with no-show protection natively". The suggested workarounds are to filter out fee-bearing variations, or to save a card with the Cards API and charge a fee with the Payments API. It was not possible to confirm whether a Square staff member wrote the reply. Source: https://developer.squareup.com/forums/t/australia-native-app-booking-while-retaining-no-show-protection/28018 (search summary).
- Australian plans: Free A$0 (single location), Plus A$40/month per location, Premium A$90/month per location, Free with "no employee limit". These come from a page the search engine flagged as possibly stale, and could not be re-checked. Source: https://squareup.com/au/en/appointments/pricing (search summary).
- Australia was in the 2022 launch set, but Square says "The Bookings API is limited in international locales" and does not list what is missing. Sources: https://developer.squareup.com/blog/build-with-bookings-api-now-generally-available/ (search summary; 12 May 2022) and the Concepts page (search summary).
- No Bookings API changes after September 2024 were found. Source: https://developer.squareup.com/forums/t/is-the-bookings-api-still-actively-being-developed/27298 (community; August 2026).

Account/plan/app-review requirements:
- A Square seller account in Australia with Square Appointments activated. Tier 0 works on the Free plan.
- Tier 1 needs an active or trial Appointments Plus or Premium subscription, priced per location. The owner checks the current AUD price in Square Dashboard or on the live AU page before buying, starts the trial, and confirms that `support_seller_level_writes = true` and the self-test passes.
- A Square Developer application.
  - Read scopes: `APPOINTMENTS_READ`, `APPOINTMENTS_ALL_READ`, `APPOINTMENTS_BUSINESS_SETTINGS_READ`, `CUSTOMERS_READ`, `ITEMS_READ`, `MERCHANT_PROFILE_READ`, `PAYMENTS_READ`, `ORDERS_READ`.
  - Tier 1 adds `APPOINTMENTS_WRITE` and `APPOINTMENTS_ALL_WRITE`.
- A webhook subscription pointing at a public HTTPS URL, with its signature key stored as a secret.
- No-show settings (Dashboard > Appointments > Settings > Payments & cancellations):
  - "Flat fee per appointment": expect app bookings not to work. Do not buy Plus just for Tier 1.
  - "Flat fee per service": choose fee-free variations for bookings staff make from the app. Those bookings carry no card hold.
- A sandbox test account onboarded to Appointments, with a test-card Plus subscription. Run three set-ups (per-service fee, per-appointment fee, no fee) and record the real error responses before Tier 1 ships.
- A private single-seller app is assumed to need no App Marketplace review. This is standard practice but was not re-verified.

Open questions:
- Square does not document the error returned when a write is refused because of a no-show fee.
- It is unknown whether a non-zero business-level fee blocks every seller-level create. The link between `cancellation_fee_money` and the per-appointment mode is an inference.
- No source says whether UpdateBooking or CancelBooking work on fee-protected bookings.
- Current AU prices, the Free-plan staff allowance and the Australia-specific gaps are all unverified.

## 7. Google Business Profile

**Decision: Build in independent tiers. Tier 0 ships now and needs no Google API: the owner pastes the official review link, and every opted-in client gets the same neutral request. Tier 1 adds rating, review count and the documented write-a-review link from Places API (New) with a Maps key. Tier 2 (reading and replying to reviews, plus Performance metrics) waits for Google to approve Business Profile API access, which is uncertain for a single shop. Tier 3 is Search Console. No placeholder numbers are ever shown.**

Confidence: medium. Both developers.google.com and support.google.com were blocked.

Build notes:
- Never build `g.page/r/…` or `writereview?placeid=` URLs; both are undocumented.
- Requests go to every opted-in client the same way: no satisfaction pre-screen, no incentive wording, no staff targets.
- Track clicks through an app-owned redirect that never branches on anything.
- Tier 1: Place Details with field mask `googleMapsLinks,rating,userRatingCount`, called once a day.
- Tier 2:
  - Use v4 `accounts.locations.reviews.list` (page size 50), re-syncing on an `updateTime` watermark, and `updateReply` (at most 4,096 bytes).
  - Show `reviewReplyState` and `policyViolation` from the list response.
  - Use `fetchMultiDailyMetricsTimeSeries`, including `MESSAGING_CLICKS`.
  - Do not reference `BUSINESS_CONVERSATIONS` (removed 31 Jan 2026) or the Q&A API (discontinued 3 Nov 2025).
- Publish the OAuth consent screen to Production; in Testing, refresh tokens expire after 7 days.

What the sources say:
- "If your quota is 0 QPM …, your project has not yet been approved. If your quota is set to 300 QPM, your project is approved." Do not request a quota increase while at 0; submit the "Application for Basic API Access" instead. Source: https://developers.google.com/my-business/content/prereqs (search summary; undated).
- Eligibility: a profile "verified and active for 60+ days" and "a website representing the business". Reviews are "typically reviewed within 14 days". One summary also mentioned an "Organization account" and an email domain matching the website; a second search did not confirm this. Source: same page (search summary).
- Google describes the APIs as "designed for developers who represent large, tech-savvy businesses and third parties". Source: https://support.google.com/business/workflow/16726127 (search summary).
- Reviews and replies use v4 `reviews.list` and `updateReply`. A known issue: "some reviews may be missing from page 2 onward". Sources: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list and https://developers.google.com/my-business/content/known-issues (search summaries).
- The v4 change log adds `ReviewReplyState` (1 Apr 2026), `ReviewMediaItems` (20 Apr 2026), `PolicyViolation` (1 Jul 2026) and `review_reply_url` (24 Jul 2026). No deprecation of the reviews endpoint was found. Source: https://developers.google.com/my-business/content/change-log (search summary).
- New and updated reviews can be pushed through the Notifications API to Pub/Sub as `NEW_REVIEW` and `UPDATED_REVIEW` events. Source: https://developers.google.com/my-business/content/notification-setup (search summary).
- Performance API daily metrics: impressions, `BUSINESS_DIRECTION_REQUESTS`, `CALL_CLICKS`, `WEBSITE_CLICKS`, `BUSINESS_BOOKINGS`, and `MESSAGING_CLICKS` (added 14 Oct 2026). "Only daily data is available." Sources: https://developers.google.com/my-business/reference/performance/rest/v1/DailyMetric and https://developers.google.com/my-business/content/performance/change-log (search summaries).
- The official way to get a review link: "Select Read Reviews and then Get more reviews". QR codes can be generated only in a desktop browser, and customers need a Google Account. Source: https://support.google.com/business/answer/16816815 (search summary; about Dec 2025–Jan 2026).
- The documented programmatic link is Places API (New) `googleMapsLinks.writeAReviewUri` (GA 21 Aug 2025), alongside `rating` and `userRatingCount`. Since 1 March 2025, per-SKU free caps have replaced the US$200 monthly credit (Place Details Pro: 5,000 calls/month). Sources: https://developers.google.com/maps/documentation/places/web-service/maps-links and https://developers.google.com/maps/billing-and-pricing/overview (search summaries).
- Google policy: merchants may not "discourage or prohibit negative reviews, or selectively solicit positive reviews", may not offer incentives, and may not set staff review quotas. Source: https://support.google.com/contributionpolicy/answer/7400114 (search summary; restructured in 2025).
- The ACCC warns that incentives offered only for positive reviews risk breaching the Competition and Consumer Act. Its December 2023 sweep flagged review gating. Source: https://www.accc.gov.au/business/advertising-and-promotions/online-reviews-for-product-and-services (search summary).
- Search Console: `searchanalytics.query` with `webmasters.readonly`. Data arrives after about 2–3 days and is kept for 16 months. Domain properties can be verified only by a DNS TXT record. Sources: https://developers.google.com/webmaster-tools/v1/searchanalytics/query and https://support.google.com/webmasters/answer/9008080 (search summaries).
- An External OAuth app left in "Testing" "is issued a refresh token expiring in 7 days". Production removes that limit, but sensitive scopes show an unverified-app warning. Source: https://developers.google.com/identity/protocols/oauth2 (search summary).

Account/plan/app-review requirements:
- Tier 0: a verified Business Profile. The owner copies the link from a desktop browser.
- Tier 1: a Google Maps Platform billing account and a restricted API key. Comply with the caching terms: the Place ID may be cached indefinitely, other content may not be stored long-term.
- Tier 2:
  - A Cloud project with the Account Management, Business Information, My Business v4, Performance and (optionally) Notifications APIs enabled.
  - The `business.manage` scope.
  - Google's Basic API Access approval, which needs the profile verified for 60+ days and a website. Approval is not guaranteed.
  - For Pub/Sub, publish rights for `mybusiness-api-pubsub@system.gserviceaccount.com`.
- Tier 3: the website verified in Search Console and the `webmasters.readonly` scope.
- Every tier: ask every client the same way, with no incentives and no gating.

Open questions:
- Whether Google will approve a single-location barber. Whether `business.manage` is a "sensitive" scope (check the Cloud Console). Whether the "Organization account" and matching email domain requirements are real.
- The Maps caching rules for keeping a history of ratings were not read.

## 8. Email & Spam Act

**Decision: Use Postmark (Basic, US$15/month, 10,000 emails) behind an `EmailProvider` interface, with Resend as the documented fallback. Factual booking messages go out on Postmark's Transactional stream. Review requests and campaigns are treated as commercial electronic messages: they go only on the Broadcast stream, only to clients with recorded consent, and always carry the business's identity and a working unsubscribe.**

Confidence: medium. ACMA, legislation and provider pages came through search summaries.

Build notes:
- Message classes:
  - `transactional_factual`: no offers, CTAs or promotional links; a linter blocks them.
  - `review_request` and `campaign`: Broadcast stream only, with the `{{{ pm:unsubscribe }}}` link and a footer showing trading name, street address, phone and email.
- Data:
  - an append-only consent ledger recording the exact wording shown, the method and the evidence
  - a global suppression table: hard bounces and complaints block everything; unsubscribes block marketing only
  - a send log kept for at least 24 months (Postmark keeps 45 days)
  - idempotent storage of webhook events
- One `assertCanSend(client, messageClass)` gate in the worker that the UI cannot bypass.
- Process unsubscribes immediately.
- Auto-pause a campaign if complaints exceed 0.1% or bounces exceed 5%.
- Send only from the business's own domain, with DKIM, a custom Return-Path, SPF and DMARC (start at `p=none`).
- "Inferred" consent (at least 2 completed visits in 12 months, lapsing after 12 months without one) is this app's own conservative rule, not a statutory test. Express consent is the default.

What the sources say:
- Consent may be express or "reasonably inferred". A one-off purchase, an enquiry, a receipt address or an ended relationship does not establish inferred consent. The sender must prove consent, and you cannot email someone to ask for it. Sources: https://www.acma.gov.au/avoid-sending-spam (search summary; undated) and https://www.acma.gov.au/articles/2026-11/spintel-pays-653k-penalty-spamming-former-customers (search summary; Nov 2026).
- Every commercial message must identify the sender and include contact details (s 17). This also applies to "designated" factual messages. Source: https://www.acma.gov.au/avoid-sending-spam (search summary).
- Unsubscribe rules: clear instructions; actioned within 5 working days; no fee; no login; no extra personal information asked for; the facility must keep working for at least 30 days after sending. Source: https://www.acma.gov.au/sites/default/files/2024-05/Fact%20sheet%20-%20email%20and%20SMS%20unsubscribe%20rules.pdf (search summary; May 2024).
- Purely factual messages are exempt from the consent and unsubscribe rules. Promotional content or links turn them into commercial messages, and ACMA enforces this. Source: https://www.acma.gov.au/articles/2023-10/ticketek-pays-500000-penalty-repeat-spam-breaches (search summary; Oct 2023).
- Secondary sources attribute to ACMA the view that surveys and free offers fall within the Spam Act. No ACMA ruling on review requests was found. Source: https://www.corrs.com.au/insights/acma-spam-act-enforcement-and-the-implications-for-business (law-firm commentary; undated).
- No amendment to the Act or the 2021 Regulations was found for 2024–2026. Enforcement has stepped up instead: penalties reported for Lululemon (Dec 2025, $702,900), Latitude (Apr 2026, $3.96m), TAB (Jul 2026, $2.7m) and SpinTel (Nov 2026, $653,400). Source: https://www.acma.gov.au/articles/2026-07/tab-pays-27m-telemarketing-and-spam-breaches (search summary).
- Postmark pricing:
  - Free developer plan: 100 emails/month
  - Basic: US$15/month for 10,000 emails, 45-day retention, overage US$1.80 per 1,000
  - Pro: US$16.50/month, with inbound email and up to 365-day retention

  Source: https://postmarkapp.com/pricing (search summary).
- Postmark's Broadcast streams add RFC 8058 one-click unsubscribe headers and an unsubscribe link automatically. Suppression lists are per stream. New accounts must be manually approved before mailing outside the sender's own domain (HTTP 412 "Account Pending Approval"). All data is stored in the US. Sources: https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header, https://postmarkapp.com/developer/api/overview and https://postmarkapp.com/support/article/1218-gdpr-faq (search summaries).
- Resend pricing: Free covers 3,000 emails/month but is capped at 100/day; Pro is US$20/month for 50,000. There is no Australian region, and account data is stored in the US. On API sends, the app must add the one-click unsubscribe headers itself. Sources: https://resend.com/pricing and https://resend.com/docs/dashboard/domains/regions (search summaries; Resend changed pricing several times in 2025–2026).
- Gmail: every sender needs SPF or DKIM. Bulk senders (about 5,000+/day) also need DMARC and one-click unsubscribe. Keep the spam rate below 0.10% and never reach 0.30%. Yahoo's rules are similar, and Outlook.com added requirements for 5,000+/day senders from 5 May 2025. Sources: https://support.google.com/mail/answer/81126, https://senders.yahooinc.com/best-practices/ and the Microsoft tech-community post (search summaries).
- The Privacy Act small-business exemption (annual turnover of $3M or less) probably applies. Reforms that would remove it have been recommended but not enacted. Source: https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business (search summary).

Account/plan/app-review requirements:
- A business-owned domain with DNS access for DKIM, Return-Path, SPF and DMARC records.
- A Postmark account and its manual approval request. Basic once live. Webhooks for Delivery, Bounce, SpamComplaint and SubscriptionChange.
- Operational duties:
  - collect express consent with an unticked checkbox and keep the exact wording
  - never email anyone to ask for consent
  - action in-person, phone and reply unsubscribes the same day
  - keep consent records
- Register the domain in Google Postmaster Tools.
- The privacy notice says delivery data is processed by Postmark in the US.

Open questions:
- Whether a bare review request is a commercial message (treated as yes).
- Whether Postmark's unsubscribe links stay working for 30 days or more. Confirm this, or host a non-expiring unsubscribe page in the app.
- The exact current wording of s 18 and of Schedule 2 clause 6 was not read verbatim.

## 9. Transcription

**Decision: The default transcriber is Deepgram Nova-3 pre-recorded. It returns word and utterance timestamps in one synchronous request and has no announced shutdown date. OpenAI `whisper-1` is an optional second adapter only until 26 February 2027, and the newer OpenAI models are rejected for captions because no documented timestamps are returned. Audio never goes to Claude, and transcription runs only after voice activity detection (VAD) has found real speech.**

Confidence: medium. OpenAI and Deepgram pages came through search summaries.

Build notes:
- Repo changes needed. The config enum currently allows only `none` and `openai`, the model defaults to `whisper-1`, and no transcriber exists in `packages/ai`.
  - Add `deepgram` (and later `whispercpp`) to `TRANSCRIPTION_PROVIDER`.
  - Add `DEEPGRAM_API_KEY`, server-side only.
- Request: `POST https://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true&utterances=true`.
  - Map `utterances` to `TranscriptSegment` and keep the words for word-timed captions.
  - Key results by asset plus a hash of the audio, so a retried job does not pay twice.
  - Write the parser against a recorded live response; sources disagree on where `utterances` sits.
- Gating:
  1. The existing DSP heuristic.
  2. Silero VAD through onnxruntime-node, requiring at least 1.0 s of speech at probability 0.5 or higher.
  3. Drop low-confidence words and segments before any caption is made from them.

  These thresholds are starting points to tune on real clips, not documented values.

What the sources say:
- `/v1/audio/transcriptions` models: gpt-transcribe, gpt-4o-transcribe, gpt-4o-mini-transcribe, gpt-4o-mini-transcribe-2025-12-15, whisper-1 and gpt-4o-transcribe-diarize. Source: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create (search summary; current).
- "The timestamp_granularities[] parameter is only supported for whisper-1." Source: https://developers.openai.com/api/docs/guides/speech-to-text (search summary).
- whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe and gpt-4o-transcribe-diarize shut down on 26 February 2027 (notice dated 26 August 2026). The replacements are gpt-transcribe and gpt-live-transcribe. No replacement for timestamps has been announced. Source: https://developers.openai.com/api/docs/deprecations (search summary).
- OpenAI limits and prices: uploads up to 25 MB. gpt-transcribe US$0.0045/min, whisper-1 US$0.006/min. gpt-transcribe is not on the free tier. Sources: https://developers.openai.com/api/docs/models/gpt-transcribe and https://platform.openai.com/docs/models/whisper-1 (search summaries).
- Deepgram's pre-recorded API is one synchronous `POST /v1/listen` call that returns word timestamps in seconds and, when requested, utterances. Source: https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded (search summary).
- Deepgram Nova-3 costs US$0.0043–0.0048/min, billed per second, with a non-expiring US$200 credit. The official cached page shows $0.0048 and several 2026 guides show $0.0043. At $0.0048/min a 30 s clip costs about US$0.0024, and the credit covers roughly 42,000–46,000 minutes depending on which price applies. Source: https://deepgram.com/pricing (search summary; cached).
- AssemblyAI is asynchronous (submit, then poll). Universal-3.5 Pro costs US$0.21/hr and Universal-2 US$0.15/hr. Source: https://www.assemblyai.com/pricing.md (search summary).
- Claude does not accept audio input. The Messages API takes text, images and documents. Source: https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk (search summary; also consistent with the full-page reads in section 10).
- Whisper-large-v3 hallucinated on "99.97%" of UrbanSound8K non-speech clips. Source: https://export.arxiv.org/pdf/2501.11378 (search summary; January 2025).
- Silero VAD processes a 30+ ms chunk in under 1 ms on one CPU thread. Source: https://github.com/snakers4/silero-vad (search summary).
- whisper.cpp has had built-in Silero VAD since May 2025, but its word timestamps are marked experimental. No benchmark for a 4-vCPU machine was found. Sources: https://github.com/ggml-org/whisper.cpp/ and https://github.com/SYSTRAN/faster-whisper (search summaries).

Account/plan/app-review requirements:
- Deepgram: a Console account and a project API key, stored only on the worker. No approval step.
- OpenAI (optional, until 26 Feb 2027): a Platform account with billing and `OPENAI_API_KEY`.
- Local whisper.cpp (optional): no account. It needs a native build, ggml models and about 1–1.5 GB of spare RAM.
- Anthropic: nothing unlocks audio input.
- Not researched but recommended: tell clients and staff that clip audio may be processed by a US speech-to-text provider.

Open questions:
- Whether OpenAI will add timestamps to gpt-transcribe before February 2027.
- Deepgram's exact price ($0.0043 or $0.0048), whether `en-AU` is supported, the response nesting, and the auth header format (from prior knowledge, not re-verified).
- No provider's accuracy on Australian accents with clippers and music in the background has been measured.
- Deepgram's data retention and region were not researched.

## 10. Anthropic vision & cost

**Decision: Label shots with `claude-haiku-5-5` at `effort: "low"`, using structured outputs. Send base64 JPEG frames of 768 px on the long edge, at most 12 per clip by default with a hard ceiling of 20. If the model refuses, runs out of tokens or the parse fails, fall back to the heuristic labeller's "unknown" labels and never invent labels. Expected cost is about one US cent per 6-clip project; measure it from `response.usage`.**

Confidence: high. The Anthropic documentation was read in full on 14 November 2026.

Build notes:
- Extract frames with ffmpeg after rotation correction and tone mapping: 432×768 for portrait (448 visual tokens) and 768×432 for landscape.
- Set `transformations: { oversized_image: "error" }` on every image block.
- Normalise focus coordinates by the dimensions actually sent, not the padded ones.
- Skip frames under 200 px.
- Send base64 only. The Files API is not ZDR-eligible and stores files until deleted. URL sources would need a public link to private media.
- Use `output_config.format` with a Zod schema:
  - every property required, enums for label and framing
  - check confidence ranges and `shotId` values in Zod after parsing, because the API rejects min/max constraints
  - compare enums case-insensitively
- Make one synchronous request per clip, with at most 3 clips in flight per project. Pass the job's AbortSignal through.
- Lower `AI_VISION_MAX_FRAMES_PER_CLIP` from its current maximum of 40 to 20.
- The prompt never asks Claude to identify people.

What the sources say (all full-page reads of platform.claude.com, 14 Nov 2026, no last-updated dates shown):
- Formats: JPEG, PNG, GIF and WebP. Only the first frame of an animated GIF is used. Source: https://platform.claude.com/docs/en/build-with-claude/vision.md
- Limits:
  - 10 MB per image (base64) on the Claude API (5 MB on Amazon Bedrock)
  - 8000×8000 px, with a stricter per-image limit when a request has more than 20 images
  - up to 600 images per request on 1M-context models
  - 128 MB per request

  Source: the same Vision page. A search summary still quoted 5 MB, probably from a stale index.
- Token cost is ⌈w/28⌉ × ⌈h/28⌉ visual tokens. The high-resolution tier ("Claude 4.7 and later models") allows a 2,576 px long edge and 4,784 tokens; the standard tier allows 1,568 px and 1,568 tokens. Images are padded to multiples of 28 px. Sources: the Vision page and https://platform.claude.com/docs/en/build-with-claude/vision-coordinates.md
- There is no video or audio input: "Text and images → text". Source: https://platform.claude.com/docs/en/about-claude/models/overview.md
- Structured outputs (`output_config.format`) are generally available on every model. Limits: 20 strict tools, 24 optional parameters and 16 union-type parameters per request. minimum/maximum are unsupported. `additionalProperties` must be false. Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md
- Pricing:
  - Haiku 5.5 (prompts up to 100k tokens): US$0.10 input, US$0.50 output per MTok; a cache hit costs $0.01
  - Opus 5.5: US$4 input, US$20 output per MTok
  - Batch is half price
  - `inference_geo: "us"` costs 1.1×; no Australian inference option is documented

  Source: https://platform.claude.com/docs/en/about-claude/pricing.md
- Message Batches: most finish within an hour, the maximum is 24 h, results are kept for 29 days, and batches are not ZDR-eligible. Source: https://platform.claude.com/docs/en/build-with-claude/batch-processing.md
- On the Start tier, Haiku 5.5 and Opus 5.5 allow 4,000 RPM and 2,000,000 input tokens per minute, with a US$500/month spend cap. New organisations may start in an Evaluation tier. Source: https://platform.claude.com/docs/en/api/rate-limits.md
- Haiku 5.5 runs adaptive thinking by default, billed as output tokens. Omit `temperature`, `top_p` and `top_k`. Source: https://platform.claude.com/docs/en/models/haiku-5-5/overview.md
- "Claude cannot be used to name people in images". Accuracy drops below 200 px and on rotated frames. Source: the Vision page.
- Cost arithmetic: 6 clips × 12 frames × 448 tokens = 32,256 visual tokens, or about 45k input tokens per project once prompts are included. Input on Haiku 5.5 is therefore about US$0.0045. Output, including thinking, adds an assumed US$0.0045–0.009. The total is about US$0.01–0.014 per project, about 40 times less than Opus 5.5. The output-token figures are assumptions, not documented values. Source: computed with the documented formula and pricing.

Account/plan/app-review requirements:
- A Claude Console account with an organisation and an API key, kept server-side and encrypted. Preferably use a dedicated workspace with a workspace-scoped key.
- Billing in USD. Set a low monthly spend limit (for example US$10–20) as a guard.
- No app review or beta access is needed.
- Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Until both are set, the UI shows "needs setup" and the heuristic labeller is used.
- The owner tells filmed clients that frames are processed by an overseas AI provider.

Open questions:
- How well Haiku 5.5 labels barbershop footage compared with Opus 5.5 is unmeasured. Run a small evaluation on the owner's own clips.
- Neither the supported-regions page (is Australia supported?) nor the standard API data-retention page was fetched.
- Output-token usage at low effort is assumed and must be measured.

## 11. Trend sources

**Decision: The Trends view has two sections that never mix. "Live signals" shows only data from official APIs, each item with its source, its fetch time in Australia/Melbourne time and a staleness limit. "Curated references" is a static, dated list of sourced barber content formats. TikTok contributes no live data at all: it has no permitted API for trends, and its terms forbid scraping.**

Confidence: medium. Official pages came through search summaries, and the search budget ran out before the last queries.

Build notes:
- Live signals:
  1. Instagram hashtag watch: at most 30 hashtags per rolling 7 days per account, using `ig_hashtag_search` then `top_media`, labelled "Top posts under #tag — Instagram, fetched <date>".
  2. The Instagram Audio API, behind a flag. Do not call it "trending" unless the live reference confirms it returns a ranking.
  3. YouTube `videos.list chart=mostPopular regionCode=AU`, labelled "YouTube AU popular chart (music/movies/gaming)".
  4. Google Trends: a deep link to trends.google.com only.
- TikTok: a button that opens Creative Center in the owner's own TikTok for Business login, plus a "Note a trend" form whose entries are labelled "Noted by staff".
- Curated formats are stored as static JSON with a "last reviewed" date and are never worded as "trending now".

What the sources say:
- TikTok Creative Center has no official public API. Every "Creative Center API" found is a third-party scraper. Source: https://www.admapix.com/blog/ad-intelligence/tiktok-creative-center-tutorial (third party).
- TikTok's Terms of Service bar users from scraping, crawling, exporting or otherwise extracting data from the Platform without written approval. Source: https://www.tiktok.com/legal/page/us/terms-of-service/en (search summary, paraphrased; regional variants differ in date).
- The TikTok Research API is for academic and non-profit research in listed regions (US, EEA, UK, Canada, Switzerland; Brazil for youth safety). Australia is not listed. Source: https://developers.tiktok.com/products/research-api/ (search summary; undated).
- The TikTok Commercial Content API is a Europe-only ads transparency library and exposes no trending sounds or hashtags. Source: https://developers.tiktok.com/products/commercial-content-api (search summary; related page about 1,354 days old).
- Creative Center reportedly removed trending Songs and some trend endpoints in 2025–2026, and Trend Discovery may need a login. Source: https://dev.to/meng_xipeng_139608bde0640/tiktok-creative-center-trends-changed-how-to-get-this-weeks-trending-tiktoks-with-transcripts-3ell (community, Oct 2026; unverified).
- Instagram hashtag search: "you can query a maximum of 30 unique hashtags within a 7 day period", per professional account. Source: https://developers.secure.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-hashtag-search (search summary).
- Meta's Instagram Audio API (2026) searches and retrieves original sounds and Sound Collection music. Whether it returns a "trending" ranking is unconfirmed. Source: https://developers.facebook.com/documentation/instagram-platform/changelog (search summary; date ambiguous).
- From 21 July 2025, YouTube's `mostPopular` chart shows Trending Music, Movies and Gaming instead of general trending. It costs 1 unit per call against a default quota of 10,000 units/day. No parameter identifies Shorts. Sources: https://developers.google.com/youtube/data/revision_history (search summary; entry dated 10 Jul 2025) and https://developers.google.com/youtube/data/guides/quota_and_compliance_audits (search summary).
- The Google Trends API is an invite-only alpha announced on 24 July 2025 and was still in alpha in late 2026. The terms for the Trending Now RSS feed were not retrieved. Sources: https://developers.google.com/search/apis/trends (search summary; about 15 months old) and https://developers.google.com/search/blog/2025/07/trends-api (search summary).
- Sourced evergreen formats, all from marketing blogs whose performance claims are unverified:
  - before/after reveal with the barber commentating
  - ASMR fade process with no voiceover
  - satisfying line-up / 360° finish walk-around
  - transformation with client reaction (with permission)
  - educational technique explainer
  - ultra-fast cut montage
  - timelapse with trending audio, cross-posted

  Sources: https://academy.cadmen.ca/post/barbershop-tiktok-content-ideas, https://flowshorts.app/instagram-reels-ideas/hair-salon, https://dingg.app/blogs/what-us-salons-need-to-post-on-tiktok-and-instagram-reels-checklist, https://www.youtube.com/watch?v=aQHtTLYf25c (community/vendor blogs, 2026). "Speed-ramp montage", "POV" and "client story" had no source and may only be tagged "editor suggestion — no external source".

Account/plan/app-review requirements:
- YouTube: a Cloud project with YouTube Data API v3 and an API key. Stay within the default quota so no compliance audit is needed.
- Instagram hashtag watch: the owner's professional account connected to a Meta app with the hashtag-search permissions and the "Instagram Public Content Access" feature. The research assumed Facebook Login with a linked Page (third-party summary), and this was not checked against the Unified Login setup in section 4.
- Google Trends API: the owner may apply for the alpha. Access is not guaranteed.
- TikTok: a free TikTok for Business login for browsing by hand. No TikTok API applies.
- Client consent before posting transformation or reaction clips.

Open questions:
- Whether `ig_hashtag_search` and the Audio API are available to a Unified Login system-user configuration under Standard Access. Not researched.
- YouTube's rules on caching and displaying API data were not retrieved. `search.list` quota cost needs checking.
- Whether the higgsfield `tiktok_music_trending` tool available in this build session is an official TikTok feed is unknown. Do not treat it as one.

---

## Decision summary

"Supported now" means the approach works without any third-party account or approval. It does **not** mean the feature is already built in this repository.

| Capability | Approach | Status | Key constraint |
| --- | --- | --- | --- |
| Spotify music reference | Owner pastes link; URL and notes stored; official embed on internal pages, link-only fallback | Supported now | 2014 Widget Terms bar "commercial purposes" (undefined); never public, never AI, never exported |
| Spotify search via Web API | Not built | Not supportable — Development Mode is officially for non-commercial personal projects, and no business carve-out or approval route exists | Would need written permission from Spotify plus Premium |
| Spotify audio in videos or in-shop playback | None | Not supportable — Policy bans syncing recordings with video; consumer licence is personal only | Use licensed music and a commercial background-music service |
| Licensed music in exports | Owner-uploaded tracks with a licence passport; export blocked to platforms the licence does not cover | Needs owner account setup (a business-eligible library subscription) | Personal/Social tiers do not cover business use; prices unverified |
| Meta Sound Collection in renders | Render locked to Instagram/Facebook; copyright check before publishing | Needs owner account setup (owner downloads and accepts terms) | Licensed "only" on Meta products; never TikTok, YouTube or website |
| TikTok Commercial Sounds | Added by the owner inside the TikTok app | Supported now | The API cannot attach library sounds |
| TikTok posting | 1080×1920 export, copy caption, manual post | Supported now | Owner confirms "posted" by hand |
| TikTok direct API posting | Not built | Not supportable — app review bars apps "for private or personal use"; unaudited posts are private-only | — |
| TikTok auto-publish via provider | Zernio adapter behind a flag (Stage C) | Needs owner account setup (Zernio account, TikTok connected) | Public-only video posts, 15 per 24 h; needs a live smoke test |
| Instagram posting | Export and manual post | Supported now | — |
| Instagram direct Reels publishing | Unified Login (system-user token), Development mode, resumable upload | Needs owner account setup (Meta app, business portfolio, configuration) | No published proof that it works without App Review; switched on only after a smoke test |
| Instagram library or trending music via API | None | Not supportable — the API only names original audio | Music must be in the file or added in-app before posting |
| Safe zones and export preset | Union safe zone; H.264/AAC 1080×1920 SDR; 180 s cap; ffprobe check | Supported now | TikTok pixel values are third-party readings; repo constants need reconciling |
| Square bookings read and webhooks | Polling plus verified webhooks; six statuses mirrored | Needs owner account setup (Square developer app) | Works on the Free plan; webhooks can be missed, so reconcile |
| Square create/reschedule/cancel | Gated on `support_seller_level_writes`, fee-free variations and a self-test | Needs owner account setup (Plus or Premium) | Services with a no-show fee cannot be booked by API; error code undocumented |
| Square no-show marking, deposits, confirmations | Deep link "Do this in Square Appointments" | Not supportable — no API for these | `status` is read-only |
| "Attended and paid" | Labelled heuristic (customer, service, time); owner override | Needs owner account setup (same Square app) | No booking-to-payment link in the API; inferred only |
| Google review requests | Owner pastes the official link; uniform, neutral requests | Supported now | No gating, no incentives (Google policy and ACCC) |
| Google rating, count and documented review link | Places API (New) Place Details, daily | Needs owner account setup (Maps billing and key) | Caching terms; Pro SKU free cap 5,000 calls/month |
| Google reviews, replies and performance metrics | Business Profile APIs | Needs owner account setup (Google API access approval) | Approval uncertain for a single location; quota 0 until approved |
| Search Console metrics | `searchanalytics.query`, read-only | Needs owner account setup (site verification) | 2–3 day lag; 16 months of history |
| Booking emails (factual) | Postmark Transactional stream | Needs owner account setup (domain DNS, Postmark approval) | No promotional content allowed |
| Review-request and campaign emails | Postmark Broadcast stream with consent ledger | Needs owner account setup (as above, plus recorded consent) | Spam Act consent, identity and unsubscribe rules |
| Speech transcription | Deepgram Nova-3 with VAD gating | Needs owner account setup (Deepgram key) | Captions only from real transcript timings |
| OpenAI transcription | whisper-1 adapter (optional) | Needs owner account setup (OpenAI key) | Shuts down 26 Feb 2027; newer models give no documented timestamps |
| Audio or video sent to Claude | None | Not supportable — Messages API accepts text, images and documents only | Transcribe elsewhere; extract frames |
| Shot labelling | Haiku 5.5, 768 px base64 frames, structured outputs | Needs owner account setup (Anthropic key); heuristic fallback is supported now | At most 20 images per request; no person identification |
| Curated barber formats | Static, dated, sourced list | Supported now | Never labelled "trending" |
| Instagram hashtag watch | `ig_hashtag_search` / `top_media` | Needs owner account setup (Meta app with hashtag access) | 30 hashtags per 7 days; Unified Login availability unconfirmed |
| YouTube AU popular chart | `videos.list chart=mostPopular` | Needs owner account setup (Cloud API key) | Music/movies/gaming only since 21 Jul 2025; no Shorts filter |
| Google Trends | Deep link only; optional alpha application | Needs owner account setup (alpha approval, not guaranteed) | RSS feed terms not checked |
| TikTok trend data | Manual "Note a trend" plus link to Creative Center | Not supportable — no permitted API; terms forbid scraping | Research API is academic-only and does not list Australia |

## Follow-up findings

The critic flagged eight decision-relevant questions. Each was researched once more, but the official hosts were still blocked, so most answers are still based on search summaries and community reports.

1. **Can TikTok inbox uploads (`video.upload`) avoid the unaudited-client limits for a single business's own account?**
   - TikTok documents the private-account, SELF_ONLY and 5-user rules, and their error code, only for Direct Post. The inbox init call has no privacy field. No public live test shows an unaudited draft being posted publicly.
   - The real blocker comes earlier: the App Review Guidelines, which grant `video.upload`, say "Apps must not be for private or personal use". A single-business tool is therefore unlikely to get the scope at all.
   - Video inbox drafts probably cannot pre-fill the caption, and only 5 unfinished drafts are allowed per 24 h.
   - Result: keep manual posting. An optional sandbox spike may record the behaviour for research only.
2. **Can a new Meta app (Unified Login only) publish to the admin's own account in Development mode without App Review?**
   - Official text allows it (Standard Access for a business you own or manage, under Facebook Login), but nobody has publicly shown it working.
   - A community live run on 10 November 2026 got as far as token exchange, account read and the publishing-limit call; publishing itself was not tried.
   - The claim that `business_management` is dropped rests on one report. User-token configurations reportedly offer no Instagram permissions.
   - Meta has not officially said Instagram Login is gone for new apps; the evidence is dashboard text and errors reported by several developers.
   - Result: manual export is the default; direct publishing goes behind a smoke test.
3. **Is Square's no-show fee per service or business-wide, and does it block API bookings?**
   - Both exist: a flat fee per appointment (business-wide), a flat fee per service, and in some regions a percentage. Australia reportedly offers both flat options.
   - Square's docs block API bookings of services with a non-zero `no_show_fee`. A second docs page words the block more broadly.
   - The error code is undocumented, and nothing covers rescheduling or cancelling fee-protected bookings.
   - Result: classify each variation at runtime, treat the per-appointment mode as "unverified", and run a sandbox test with all three set-ups before Tier 1 ships.
4. **Does Meta's `video_url` fetcher accept expiring signed URLs from Supabase or R2, and how and when does it fetch?**
   - Meta documents only "must be on a public server". Signed query strings, redirects, Range requests, Content-Length, fetch count and timing are all undocumented.
   - Community advice is to give a direct file URL with no redirects. One report mentions three retry attempts; it is unverified.
   - Meta documents a resumable binary upload to `rupload.facebook.com` for Facebook Login for Business apps.
   - Result: use resumable upload as the primary method (no public URL). The fallback is a 24 h presigned R2 URL on the S3 host. The "valid for at least 2 hours" guess is dropped.
5. **May Meta Sound Collection tracks be mixed into an MP4 with FFmpeg and published through the Graph API?**
   - The licence is tied to where content is distributed (content you "create, upload, and distribute on the Meta Company Products … only"), not to which tool added the audio. Meta's help pages tell users to download tracks and use their own editing software.
   - The binding restriction is that the audio may not be used "separately from the Meta Company Products".
   - No official source says whether Sound Collection tracks are exempt from copyright matching.
   - Result: `meta_only` renders are allowed. Poll `copyright_check_status` before publishing and do not publish if a match is found. This replaces the earlier "never bake it into exported files" line.
6. **Is Spotify Development Mode open in November 2026, and have the Terms changed?**
   - App creation was paused from late December 2025 to 11 February 2026 and has been open since under stricter rules: Premium owner, 5 users per Client ID, 25 Client IDs per account, pooled quota.
   - No Developer Terms or Policy revision after 15 May 2025 was found, and no document addresses internal business tools.
   - The Widget Terms are still the 2014 text.
   - Result: drop the Web API tier; keep a narrower embed or link-only reference.
7. **Can Buffer's API, or Zernio, auto-publish video to a TikTok Business account end to end?**
   - Buffer: not proven. It has no upload endpoint, and its roadmap says TikTok video goes only by `PULL_FROM_URL`, which needs a verified hosting domain. That conflicts with the private-media rule. (`createPost` was not, in fact, labelled experimental.)
   - Zernio documents the whole flow (presigned upload, consent flags, webhooks). Since September 2026 its TikTok connections publish public-only videos. Its official pages still say "First 2 accounts free".
   - Result: Zernio is the only Stage C provider. Buffer is a documented fallback only.
8. **What are current Square Appointments AU prices, staff limits and locale gaps?**
   - Not verifiable this session: squareup.com was blocked and the search budget ran out. The A$40 and A$90 figures and "no employee limit" remain unverified.
   - The Plus/Premium gate on writes is confirmed in the 2026-09-16 spec, with no country exception.
   - Deposits, confirmation control, status changes and bookings of fee-bearing services are missing from the API in every country, not only Australia.
   - Result: show no prices as fact, gate writes at runtime, and re-run this item with squareup.com allowed.

Contradictions the critic raised that remain open:
- Instagram's publishing quota (50 or 100 per 24 h): read `content_publishing_limit` at runtime.
- Whether Unified Login system-user tokens default to never expiring or to 60 days: check `debug_token`.
- The TikTok `spam_risk_too_many_posts` HTTP status (200 or 403).
- The Instagram permission spelling: the dashboard is authoritative.
- The re-dating of Spotify blog posts.
- Whether Square's seller-level cancel covers PENDING bookings.
- TikTok's daily caps: TikTok's own guidelines give about 15 Direct Posts per creator per day, shared across all API clients, while Buffer cites 25 posts per 24 h. TikTok's creator cap presumably binds whichever tool is used. Both figures need re-checking.
