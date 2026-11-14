# Design: Instagram and TikTok publishing (Stage B)

Status: design only, written 2026-11-14. Nothing here is built yet. It builds on the Stage A code in this repository
and on `docs/research/platform-constraints.md` (called "the memo" below). Where the memo and
`docs/research/decisions-summary.md` disagree, the memo wins.

Owner's brief: `docs/spec.md` section 4 (Instagram and TikTok) and the last bullet of section 3 (music cross-posting).

> **Lead-architect reconciliation (2026-11-14, `docs/design/stage-bc-plan.md`).** Changed in this file:
> (1) shared pieces (`lib/http.ts`, `lib/audit.ts`, `lib/credentials.ts`, `oauth-state.ts`, `melbourneLocalToUtc`,
> `IntegrationStatus` fields, the `webhook.process` dispatcher, queue `policy`/`startAfter`, the `/privacy` and
> `/data-deletion` pages) are built once by work package WP0; (2) the memo §2 `music.ts` changes, the `no_music`
> export variant (`render.export` `variant`, `edit_versions.variant_exports`, `editExportVariant`, download kind) and
> `musicClearanceFor` are built by WP1 (music); `checkPublishEligibility` is built on `musicClearanceFor`;
> (3) the `publish` feedback event and the `music_usage` ledger row are written when a target becomes `published`,
> not at approval (matches the preferences design §12); (4) unverified Zernio webhooks are stored under an
> `unverified:` key so a forged event id can never block the real delivery; (5) `checkMediaForPlatform` also checks
> the memo §4 bitrate limits; (6) the caption ending setting lives on the Publishing page, not Settings → Business;
> (7) the Zernio adapter is built in Stage C (memo §3: "Optional Stage C auto-publishing"), as work package WP10.

---

## 1. Goal and scope

The owner picks one or more finished edits, sets a caption and a cover frame, chooses where each one goes, and then
presses **Post now**, **Schedule** or **Prepare for manual posting**. The app tracks every video on every platform
separately, and only claims something is posted when the platform or the owner has confirmed it.

| Brief requirement | Design element |
| --- | --- |
| Connect supported accounts (§4) | Settings → Integrations: Instagram connects through Meta's Unified Login with a system-user token (§7.1). TikTok has manual posting, which always works, plus an optional Zernio connection that stays off unless a flag is set (§7.2). Both always show their state (§5.3). |
| Select one or several completed edits, never all five automatically (§4) | Composer starts with **only** the edit the owner clicked, or the ones they ticked in the Content Library. There is no "select all" control, and nothing is ever preselected by the app (§4.1, §9.2). |
| Adjust captions and covers (§4) | Caption editor with a 2,200-character counter and a locked attribution line (§9.2). Cover picker scrubs the preview and stores `cover_time_sec`. The worker cuts the JPEG from the export (§6, `publish.prepare`). |
| "Post now" or schedule (§4) | Three modes on `publish_posts.mode`: `now`, `scheduled`, `draft_handoff`. Schedules are entered in Melbourne time, including daylight saving (§4.3, §5.2). |
| Check official API requirements before choosing the integration (§4) | Done in the memo. The design follows it: §2 lists what is allowed, and every unverified item gets a capability check or a live verification step. |
| Direct TikTok only if available to a private app; otherwise a provider or an honest fallback (§4) | No direct TikTok API (memo §3). Default is export, copy caption and post by hand, with a "posted" confirmation. The optional provider is Zernio, behind `TIKTOK_PUBLISH_PROVIDER=zernio`. |
| Show destination accounts and final content before posting (§4) | Required review step showing account handle, method, exact file (with or without music), caption, cover and time. TikTok via Zernio also needs a consent tick (§4.1 step 5). |
| Progress per video and platform: queued, processing, published, failed (§4) | One `publish_targets` row per (post, platform), with statuses `queued`, `processing`, `published`, `failed`, `manual_step_required` and `cancelled`. A `manual_step` code says what the owner has to do (§5.1). |
| Show a published link only after confirmation (§4) | `published_url` is written only from a platform read-back (Instagram permalink, Zernio/TikTok resolved URL) or from a link the owner pastes when confirming a manual post (§4.4). |
| Prevent duplicate posts on retry (§4) | Each target is a state machine. The non-repeatable call is protected by `submitted_at`, and the stored platform handles (container id, Zernio `postId`) are checked before anything is sent again. There is also a unique `idempotency_key`, conditional status updates and job singleton keys (§6.3). |
| Keep successful posts when another destination fails (§4) | Each target runs as its own job. The post-level status is derived from its targets (`complete` / `partial` / `failed`) and never undoes a published target (§5.1). |
| Track music source and permitted usage; automatic cross-posting only when the audio suits both destinations (§3) | `checkPublishEligibility()` in `packages/core` wraps `checkMusicForPlatforms` and adds the Meta Sound Collection lock. Automated methods need a passing check for the exact file they will post (§3.2). |
| Otherwise a silent export or draft handoff, with the remaining manual step shown (§3) | A `no_music` export variant of the same version, plus manual steps such as "Add a Commercial Sound in the TikTok app". Zernio drafts (`draft: true`) are an optional handoff once verified (§3.2, §7.2). |
| Content Library integration (§6 navigation) | Library cards show per-platform publish badges and a **Publish** action, with a multi-select mode where the owner ticks cards by hand (§9.3). |
| Live posts only through explicit owner-approved actions, never to test a connection (§8) | Connection checks are read-only. The only live "test" is a **first verification post** of a real edit that the owner chooses and approves (§4.2). |

**Out of scope:**
- Facebook, YouTube and website publishing.
- Analytics and insights.
- AI-written captions.
- Instagram library or trending music. The memo §4 says this is not supportable.
- Buffer. The memo keeps it as a documented fallback only (Follow-up 7).
- TikTok's own Content Posting API.
- `video_url` publishing to Instagram. This is the memo's fallback only "if resumable upload proves unusable". It is described in §7.1.6 but not built.

---

## 2. What the research allows

| Topic | What we do | Memo reference |
| --- | --- | --- |
| TikTok direct API | **Not built.** App review says "Apps must not be for private or personal use", and Direct Post lists "a utility tool to help upload contents to the account(s) you or your team manages" as unacceptable. Unaudited clients can only post `SELF_ONLY`. | §3 Decision; Follow-up 1; Decision summary row "TikTok direct API posting" |
| TikTok manual path | 1080×1920 export, caption of at most 2,200 characters, one-tap download or share, copy-caption button. Status text: "Post in the TikTok app; add a Commercial Sound there". The owner confirms "Posted" by hand. | §3 Build notes |
| TikTok via provider | Zernio only, behind a flag, after a live smoke test. Flow: server-to-server presigned upload, then `POST /v1/posts` with `platform: "tiktok"`, `mediaItems` type `video`, `tiktokSettings.content_preview_confirmed` and `express_consent_given` (both required, set only after the owner sees the preview and ticks consent), and `privacy_level: PUBLIC_TO_EVERYONE` (the only value the Business lane accepts). Store the Zernio `postId` so a retry never posts twice. Set states only from webhooks or polling. Limits: 15 videos per account per rolling 24 h (posts over the cap are *held*, not failed), 3 s–10 min, 4 GB or less, 2,200-character caption. `draft: true` sends to the creator's TikTok inbox. Retry a failed post with `POST /v1/posts/{postId}/retry`. | §3 Build notes and Zernio bullets; Follow-up 7; raw findings `buffer_tiktok_api_autopublish` |
| TikTok music | The API cannot attach TikTok library sounds. Business Accounts see only Commercial Sounds, which are added in the app. | §3 "What the sources say"; §2 TikTok general library |
| Instagram default | Export and post manually ("Supported now"). | §4 Decision; Decision summary |
| Instagram direct | Optional module: a new Meta app on "API setup with Unified login" (Facebook Login for Business, system-user token), kept in Development mode with Standard Access for the owner's own account. Video goes up by resumable binary upload to `rupload.facebook.com`, and the module is switched on **only after a recorded live smoke test publishes one reel**. | §4 Decision and Build notes; Follow-up 2 |
| Instagram flow | Login dialog with `config_id`, `response_type=code`, `override_default_response_type=true` and no `scope`. Server-side code exchange. `debug_token` must show `SYSTEM_USER` with `instagram_basic` and `instagram_content_publish`. Account discovery order: `/me/assigned_instagram_accounts`, then granular-scope `target_ids`, then an ID the owner enters. Publishing: `content_publishing_limit` → `POST /{ig-id}/media` (`media_type=REELS&upload_type=resumable`) → upload to `rupload.facebook.com/ig-api-upload/{v}/{container-id}` → poll `status_code` → `copyright_check_status` (do not publish if `matches_found`) → `media_publish` → read the permalink. Cover uses `thumb_offset`. `cover_url` only after a spike. | §4 Build notes |
| Instagram limits | 400 containers per 24 h. Containers expire after 24 h. Publishing quota is 50 or 100 (read the live value). Reels spec: MP4 or MOV, moov atom first, AAC ≤ 48 kHz, H.264 or HEVC, 23–60 fps, ≤ 1920 columns, ≤ 25 Mbps, 3 s–15 min, ≤ 300 MB. The resumable maximum may be 100 MB (unresolved). | §4 "What the sources say"; open questions |
| Instagram errors | Third-party meanings only (advisory): 9007/2207027 not ready, 2207026 unsupported format, 2207003 download timeout, 2207050 account restricted, 2207051 spam block, 2207042 quota reached. | §4 |
| Instagram music | The API only supports original audio ("Music tagging is only available for original audio"). The app never claims it can add library or trending music. | §4 Decision and sources; Decision summary |
| Music licence gate | The renderer blocks export to platforms the licence does not cover. A "music-free export" lets the owner add platform-native audio in the app. CC BY attribution is inserted into captions automatically. A usage ledger keeps a snapshot of the licence. | §2 Decision and Build notes |
| Meta Sound Collection | Renders that contain it are `meta_only` and may never go to TikTok, YouTube or the website. Downloads are labelled "For Instagram/Facebook upload only". Run the copyright check before publishing and do not publish on a match. | §2 Build notes; Follow-up 5 |
| Export spec | One 1080×1920 SDR H.264/AAC MP4 for both platforms, 5–180 s, rejected over 300 MB, with an ffprobe check. | §5 Decision and Build notes |

**Unverified items and how the design handles each one:**

| Unverified item | Handling |
| --- | --- |
| Unified Login publish in Development mode | First verification post; direct publishing stays off until it passes (§4.2) |
| `business_management` dropped / empty discovery | Discovery falls back to target_ids, then to an ID the owner enters; read-only `social.check` |
| Resumable maximum (100 vs 300 MB) | Pre-check against `capabilities.resumableMaxBytes` (100 MB until a larger file is proven); otherwise manual step |
| `cover_url` with resumable upload | Not used; `thumb_offset` only |
| Quota 50 vs 100 | Read `content_publishing_limit` before every publish |
| Token never vs 60 days | `debug_token` `expires_at` each day; reconnect warning 7 days before expiry |
| Graph version v26.0 vs v27.0 | `META_GRAPH_VERSION`; the check records the version that worked |
| Zernio audited lane, API host, read-post endpoint, webhook signing, idempotency header | Env-configured host; smoke test; webhooks only trigger a poll (§7.2.5) |
| Zernio drafts | Separate verification before "Send to TikTok drafts" is offered |
| Copyright matching of Sound Collection | Always run `copyright_check_status` |

---

## 3. Music rule in detail

### 3.1 Inputs

- `edit_versions.plan.audio.music?.trackId`, which gives `music_tracks.licence` (`MusicLicence`).
- The memo §2 additions to `packages/core/src/music.ts`. These overlap with the preferences/music design and are implemented **once**, by WP1 (music), before this module is built:
  - `MusicLicence.kind` gains `'meta_sound_collection'`.
  - `PUBLISH_PLATFORMS` gains `'facebook'`, and `permitted.facebook` is added.
  - A new `destinationLock: 'meta_only' | null` field, forced to `'meta_only'` when kind is `meta_sound_collection`. While it is set, `permitted.tiktok`, `youtube` and `website` are forced to `false`.

### 3.2 `checkPublishEligibility` (new, `packages/core/src/publishing.ts`)

```ts
export type PublishMethod = 'manual' | 'instagram_api' | 'zernio';
export type MediaVariant = 'standard' | 'no_music';
export interface PlatformEligibility {
  platform: 'instagram' | 'tiktok';
  /** Variants that may be posted to this platform. Order = recommendation. */
  allowedVariants: MediaVariant[];
  /** Whether an automated method (instagram_api / zernio) may post the standard file. */
  automationAllowedForStandard: boolean;
  reasons: string[];               // plain language, shown verbatim
  manualStepHint: string | null;   // e.g. "Add a Commercial Sound in the TikTok app if you want music."
  downloadLabel: string | null;    // "For Instagram/Facebook upload only" for meta_only standard files
}
export function checkPublishEligibility(input: {
  hasMusic: boolean;
  licence: MusicLicence | null;     // null when hasMusic is false, or the track was deleted (treated as unknown)
  originalSoundEnabled: boolean;
  platforms: Array<'instagram' | 'tiktok'>;
}): { perPlatform: PlatformEligibility[]; captionSuffix: string | null; licenceSnapshot: MusicLicence | null };
```

**Rules, in order:**
1. **No music in the plan.** `standard` is allowed everywhere and automation is allowed.
2. **Music, but the licence is missing** (track deleted). `allowedVariants = ['no_music']`. Reason: "The music track was removed, so its licence can't be checked."
3. **Licence present.**
   - Run `musicClearanceFor(licence)` (preferences/music design §5.3, built by WP1; it wraps `checkMusicForPlatforms`)
     and treat the platform as cleared when it is in `platforms` and not in `blockedPlatforms`.
   - If `ok`, allow `['standard', 'no_music']`. Otherwise allow only `['no_music']` and pass on the reasons.
   - Unconfirmed, non-promotional or expired licences block every platform, because `checkMusicForPlatforms` adds those reasons whatever the platform.
4. **`destinationLock === 'meta_only'`.**
   - TikTok gets only `no_music`. Reason: "This track is from Meta's Sound Collection, which is licensed for Instagram and Facebook only."
   - Instagram `standard` stays allowed, with `downloadLabel = 'For Instagram/Facebook upload only'`.
5. **Manual step hint when only `no_music` is allowed.**
   - TikTok: "Add a Commercial Sound in the TikTok app if you want music."
   - Instagram: "Add music in the Instagram app if you want it. Reels published by Studio Assistant can only carry the sound already in the video."
6. **Caption suffix.** If `licence.attributionRequired`, `captionSuffix = licence.attributionText` (memo §2: CC BY). The caption editor shows the suffix as a locked line that is always appended. CC BY-NC is rejected when the track is imported, which is the music design's job.
7. **Original sound.** If `originalSoundEnabled`, add this note (not a block): "The video keeps the sound recorded in the shop. If music was playing while you filmed, Instagram's copyright check may flag it."

### 3.3 Where the rule is enforced

- **Composer and draft creation (API).**
  - The owner can only choose a variant listed in `allowedVariants`.
  - An automated method on the `standard` variant needs `automationAllowedForStandard`.
  - An automated method on `no_music` is always allowed, and the composer says "Posts without music".
- **Approval.**
  - The result, including `licenceSnapshot` (the usage-ledger snapshot from memo §2), is stored in `publish_posts.music_check`.
  - The usage ledger (`music_usage`, preferences/music design §5.2) gets its row **when the target becomes
    `published`** (`purpose 'publish'`, `platform`, the licence snapshot from the worker's pre-publish re-check),
    `ON CONFLICT DO NOTHING`. Approval writes no ledger row, because nothing has been used yet.
- **Again at publish time (worker).** If the live licence no longer allows the target's variant (edited, expired or deleted after scheduling), the target becomes `manual_step_required` / `music_licence_changed`. **Nothing is posted.**
- **Downloads.**
  - Manual targets always download the exact `media_key` that the eligibility rule picked.
  - Studio and Library downloads of a `meta_only` standard export carry the label.
  - The website module must never receive a `meta_only` render. Publishing only exposes the label and the lock; the website design consumes it.

### 3.4 The music-free export (`no_music` variant)

Built by WP1 (music) and only consumed here; the preferences/music design's "Make a music-free version" action in
the export dialog uses the same variant.

- This is the same edit version rendered again with `plan.audio.music = null`. Original sound follows the plan: if original sound is off, the file is silent.
- It reuses `render.export` with a new payload field `variant`.
- It is stored at `projects/{p}/edits/{e}/v{n}/export-no-music.mp4` and recorded in `edit_versions.variant_exports.no_music`.
- No new version is created, because the cuts, text and colour are identical. The plan stays validated: removing music never invalidates a plan that `validateEditPlan` accepted. A unit test asserts this.

---

## 4. User flows

### 4.1 Compose and approve (any mode)

1. **Entry points.** Each is a link to `/publishing/new?versions=<id>[,<id>…]`:
   - Video Studio edit card: **Publish…**, available once the preview is ready.
   - Content Library card: **Publish**.
   - Content Library multi-select: **Publish selected (n)**, after the owner ticks cards one by one.
2. **Videos step.**
   - One row per chosen version, with a preview player, style name, project title and duration.
   - The owner can remove a row. They add more from a picker of completed edits in which nothing is preselected.
   - At most 5 videos per batch.
   - If a version already has a target that is `published` or in progress on a platform, the row shows: "Already posted to Instagram on 12 Nov. Posting again will create a second post." Re-posting needs the explicit `allowRepeat` tick.
3. **Caption and cover step (per video).**
   - **Caption.** A textarea prefilled with `settings.publishing.captionFooter` (edited in a "Publishing settings"
     card on the Publishing page, owner only), which is empty by default and never generated by AI. A live counter shows `n / 2,200`, and a soft warning appears over 30 hashtags (common Instagram guidance, not in the memo; a warning only). The locked attribution line shows under the caption when one is required.
   - **Cover.** A scrubber over the preview (540×960), with **Use this frame** and a thumbnail of the chosen frame. The default is the midpoint of the last plan segment, which is usually the finished result, so no new content is invented.
   - **Platform notes.**
     - Instagram (direct): applied with `thumb_offset`.
     - Instagram (manual): "Download cover image" is offered.
     - TikTok: "Choose the cover in the TikTok app". Zernio's cover parameter is unverified, so nothing is sent.
4. **Destinations step (per video).**
   - Instagram and TikTok switches, both **off** by default. The composer remembers the last choice per platform only after the owner has posted once.
   - Each switch shows the account (e.g. "@studio · Instagram") and a method choice:
     - **Instagram.**
       - **Publish from Studio Assistant** shows only when the account is `connected`, verified and `direct_publish_enabled`.
       - **First verification post** shows only when connected but not yet verified (§4.2).
       - **Post it yourself** is always available.
     - **TikTok.**
       - **Post it yourself** is always available.
       - **Publish via Zernio** and **Send to TikTok drafts via Zernio** show only when the flag is on, an account is connected, and that method is verified (or this is its verification post).
   - The variant comes from `checkPublishEligibility`. A greyed method shows its reason, e.g. "Can't publish automatically: the music licence doesn't cover TikTok. Post without music, or post it yourself and add a sound in TikTok."
   - When only `no_music` is allowed, the row reads "Will post **without music**" plus the manual step hint.
   - Quota hints: Instagram shows "x of y posts used in the last 24 h (checked 9:41 am)" from the last check. Zernio shows "n of 15 TikTok videos in the last 24 h", counted from our own published Zernio targets.
5. **Timing step (per video).**
   - **Post now.**
   - **Schedule.** Date and time inputs, labelled "Melbourne time (AEDT)", with the label switching to AEST by date. A time that does not exist on the night clocks go forward shows an inline error. The ambiguous hour when clocks go back shows "2:30 am AEDT (the first 2:30 am)". The time must be at least 10 minutes ahead and at most 90 days ahead.
   - **Prepare for manual posting.** Allowed only when every destination is "Post it yourself", or it switches them all to that.
6. **Review step** (from `POST /api/publish-posts`, which creates drafts and returns the resolved server view).
   - One card per video × destination: account handle, method, exact file ("1080×1920 MP4, with music" / "without music"), final caption including the attribution line, cover thumbnail and time.
   - **Zernio cards.** These also show the TikTok username and need a tick: "I've watched this video and checked the caption. Post it publicly to TikTok as @handle." TikTok direct posts via Zernio are public only (memo §3). Without the tick the API refuses approval.
   - **First verification post cards.** These show a warning box: "This is a real, public post on @handle. Choose an edit you're happy to share."
   - The buttons read **Post now (n posts)**, **Schedule (n posts)** or **Prepare (n videos)**. These call `POST /api/publish-posts/approve` (owner only), and the page then goes to `/publishing`.

### 4.2 What happens after approval (states the owner sees)

The Publishing page and post detail show one status pill per destination, with a plain message.

| Situation | Pill | Message example |
| --- | --- | --- |
| Approved, export not ready yet | Queued | "Preparing the full-quality video…" |
| Scheduled, media ready | Queued | "Scheduled for Sat 15 Nov, 10:00 am AEDT" |
| Due but still preparing | Queued | "Will post as soon as the video is ready (was due 10:00 am)" |
| Instagram uploading or processing | Processing | "Uploading to Instagram…" / "Instagram is processing the video" |
| Instagram copyright check pending | Processing | "Instagram is checking the music" |
| Zernio over the 24 h cap (held) | Queued | "TikTok's daily limit is reached; Zernio will post it when allowed" |
| Published, link known | Published | "Published 10:02 am", with a link |
| Published, link not yet resolved (TikTok) | Published | "Published. The TikTok link appears in a few minutes." No link is shown. |
| Manual destination, media ready | Your turn | "Post this in the Instagram app" with numbered steps (§4.4) |
| Zernio draft delivered | Your turn | "Sent to your TikTok drafts. Open TikTok, add a sound if you like, and post." |
| Copyright match | Your turn | "Instagram found copyrighted audio. Nothing was posted." Choices: **Post without music** / **Post it yourself** |
| Unclear outcome after a crash | Your turn | "We can't tell whether TikTok received this. Check your TikTok profile first." Choices: **It's posted** (paste link) / **It's not there – try again** |
| Licence changed after scheduling | Your turn | "The music licence no longer covers TikTok. Nothing was posted." Choices: **Post without music** / **Post it yourself** |
| Account needs re-authorisation | Your turn | "Reconnect Instagram in Settings to post this." Shows a link and **Post it yourself** |
| Failed | Failed | The platform's own message plus a plain summary, a **Retry** button (when retryable) and **Post it yourself** |
| Cancelled | Cancelled | "Cancelled before posting" |

- **Post-level summary.** Complete, Partly posted (n of m) or Failed. A failed destination never changes a published one.
- **First verification post (Instagram direct or Zernio).**
  - When the verification target reaches `published` with a permalink, the target card asks: "Can you see the reel on @handle?" with **Yes, it's there** or **No / something's wrong**.
  - **Yes** sets `capabilities.verifiedDirectAt` (or `verifiedDraftAt`) on the social account and shows the switch "Publish directly from Studio Assistant" in Settings. The switch stays off until the owner turns it on.
  - **No** records the result in the audit log and keeps direct publishing off.

### 4.3 Scheduling in Melbourne time

- The browser sends `{ date: 'YYYY-MM-DD', time: 'HH:mm' }` in Melbourne local time. The server converts it with `melbourneLocalToUtc` (new, in `packages/core/src/time.ts`).
- The algorithm uses only `Intl`:
  1. Try offsets +11 h and +10 h.
  2. Keep each candidate UTC instant whose Melbourne wall-clock time formats back to the same local date and time.
- Results:
  - **0 candidates.** The time does not exist (the 02:00–02:59 gap on the first Sunday of October). Return `{ ok: false, reason: 'nonexistent' }`.
  - **2 candidates.** The hour is ambiguous (02:00–02:59 on the first Sunday of April). Choose the earlier instant (AEDT) and return `ambiguous: true`.
- Stored as UTC in `publish_posts.scheduled_for`. Always displayed with `formatDateTime` plus the zone abbreviation from `Intl` `timeZoneName: 'short'`.
- Dispatch: the `publish.dispatch` job runs every minute (§6).
- **Rescheduling.**
  - Allowed while every target is still `queued` and none has `submitted_at`.
  - Changing the caption, cover or destinations moves the post back to `draft`, and it must be approved again.
  - Changing only the time keeps the approval.
- **Cancelling.** Allowed for any target without `submitted_at`. A target that has already been submitted cannot be withdrawn; the owner deletes the post in the platform app.

### 4.4 Manual posting (the default path) and confirmation

The post detail shows one card per manual destination (built for a phone):

1. **Download video.** An expiring link to `media_key`, with a file name like `studio-cinematic-reveal-v2.mp4`. For a `meta_only` standard file the button reads "Download (for Instagram/Facebook upload only)".
2. **Share…** Uses the Web Share API with the file when `navigator.canShare({ files })` is true (mobile Safari or Chrome). The browser fetches the file first, and the button shows "Getting video ready (45 MB)…".
3. **Copy caption.** Copies the final caption, including attribution.
4. **Download cover image.** Instagram only, from `cover_key`.
5. **Numbered steps.**
   - TikTok: "Open TikTok → + → Upload → choose the video → Sounds: add a Commercial Sound if you want music → paste caption → Post."
   - Instagram: "Open Instagram → + → Reel → choose the video → Cover: pick the frame or 'Add from camera roll' → paste caption → Share."
   - When the file is `no_music`, the music step is highlighted.
6. **I've posted it.**
   - Opens a dialog with an optional "Paste the link to the post" field.
   - Links are validated: Instagram `https://www.instagram.com/(reel|p)/…`; TikTok `https://www.tiktok.com/@…/video/…` or `https://vm.tiktok.com/…`.
   - On save: status `published`, `confirmed_by` / `confirmed_at` are set, and `published_url` is set only if a valid link was pasted. Without a link the card reads "Posted (you confirmed)".
   - **Undo** returns the target to `manual_step_required` (audited).

### 4.5 Connecting accounts (Settings → Integrations)

- **Instagram card states:** §5.3.
  - **Connect Instagram** (owner only) goes to the Meta dialog and back, then shows "Checking your account…". The `social.check` job runs.
  - Possible outcomes:
    - "Connected as @handle. Direct posting is off until your first verification post."
    - The account-ID form, when discovery comes back empty: "Instagram didn't tell us which account to use. Enter your Instagram account ID (Meta Business Settings → Accounts → Instagram accounts)." The ID is checked with `GET /{id}?fields=id,username`.
    - An error, with the plain reason.
  - Buttons: **Check connection** (read-only), **Disconnect**, and the switch "Publish directly from Studio Assistant", which is available only after verification.
  - Labels: "Meta app in Development mode (expected for a single business). Posts are real and public." and "Token expires 13 Jan 2027", or "Token does not expire".
- **TikTok card.**
  - Always shows: "Post it yourself: download, copy caption, post in the TikTok app."
  - With `TIKTOK_PUBLISH_PROVIDER=zernio`, an "Automatic posting via Zernio (optional)" section:
    1. Paste a Zernio API key (owner only). The key is validated by a read-only `social.check`.
    2. Choose the TikTok account Zernio reports.
    3. Shows "Not verified. Your first post through Zernio is a real, public TikTok post."
    4. After the verification post: a switch "Publish directly via Zernio" and, once a draft verification has been done, "Send to TikTok drafts".
  - Without the flag, nothing about Zernio is shown, except one line in the setup checklist on the Publishing page.

---

## 5. Data model

### 5.1 Existing tables used

| Table | Use |
| --- | --- |
| `publish_posts` | One row per video per compose action. `edit_version_id`, `project_id`, `caption` (final, including attribution), `cover_time_sec`, `cover_key`, `mode` (`now` / `scheduled` / `draft_handoff`), `scheduled_for` (UTC), `music_check` (eligibility result plus licence snapshot) and `status`. |
| `publish_targets` | One row per (post, platform). Statuses: `queued` / `processing` / `published` / `failed` / `manual_step_required` / `cancelled`. Also `external_container_id` (Instagram container), `external_post_id` (Instagram media id or Zernio postId), `published_url`, `error`, `attempts`, `last_attempt_at` and `idempotency_key`. |
| `social_accounts` | Destination accounts that platform APIs discovered (Instagram via Meta; TikTok via Zernio). The `capabilities` JSON holds verification and limits. Manual destinations have **no** row: their handle comes from `settings.business.instagramHandle` / `tiktokHandle`. |
| `integration_connections` | Holds the credential: provider `meta` (system-user token, encrypted) or `zernio` (API key, encrypted). Also `status`, `last_error`, `last_sync_at` and `config` (`graphVersion`, `debugToken` summary, `zernioBaseUrlHost`). |
| `webhook_events` | Zernio webhook deliveries, stored once per (provider, external event id). |
| `audit_log` | Connect, disconnect, approve, submit, published, failed, manual confirm, undo, override and toggle actions. |
| `feedback_events` | Type `publish`, written through `recordFeedback` (WP0) when a target becomes `published` (platform read-back or the owner's "I've posted it"), with `data.planFacts` and `data.platform`, so the preferences design can learn from it (its §6.1 counts each version once). Undoing a manual confirmation does not delete it. |
| `jobs` | UI mirror of the new job types (§6). |

**Status derivation.** `publish_posts.status` is derived and written by the worker after every target transition (helper `refreshPostStatus`):
- `draft` until approved.
- `approved` while every target is `queued` and none has started.
- `in_progress` while any target is `processing`, or `queued` with media being prepared.
- `complete` when every target is `published`.
- `partial` when at least one is `published` and the rest have settled (`failed` / `manual_step_required` / `cancelled`) or are waiting on the owner.
- `failed` when none is published and all have settled as failed.
- `cancelled` when every target is cancelled.

A manual target waiting for the owner counts as "waiting on owner", not as failed.

### 5.2 Additive schema changes (one migration, `packages/db/drizzle/00NN_publishing.sql`, generated with `drizzle-kit generate`)

Text enums in `schema.ts` are TypeScript-only: the initial migration has no CHECK constraints. Adding enum values therefore needs no SQL.

**`social_accounts`**

| Change | SQL | Why |
| --- | --- | --- |
| Make the token nullable | `ALTER TABLE social_accounts ALTER COLUMN access_token_encrypted DROP NOT NULL;` | The credential moves to `integration_connections`; rows keep it null. Relaxing a constraint is backwards compatible. |
| Provider | `ADD COLUMN provider text NOT NULL DEFAULT 'meta_graph'` (enum `meta_graph` / `zernio`) | Which adapter serves the account |
| Connection link | `ADD COLUMN connection_id text REFERENCES integration_connections(id) ON DELETE SET NULL` + `CREATE INDEX social_accounts_connection_idx ON social_accounts(connection_id)` | Credential lookup |
| Owner switch | `ADD COLUMN direct_publish_enabled boolean NOT NULL DEFAULT false` | Can only be set to true when `capabilities.verifiedDirectAt` is set (enforced in the API) |
| Check results | `ADD COLUMN last_checked_at timestamptz`, `ADD COLUMN last_error text` | Honest error state |
| Status enum | add `'error'` (TS only) | |
| `capabilities` type | widen to `Record<string, boolean \| string \| number \| null>` (TS only) | Keys: `contentPublish`, `resumableUpload`, `resumableMaxBytes` (default 104857600), `quotaTotal`, `quotaUsage`, `quotaCheckedAt`, `graphVersion`, `verifiedDirectAt`, `verifiedDraftAt`, `tokenExpiresAt`, `businessApiLane` (Zernio) |

**`integration_connections`**
- `provider` enum: add `'meta'` and `'zernio'` (TS only).
- `status` enum: add `'disconnected'` (TS only).
- No SQL change.

**`publish_posts`**

| Change | SQL |
| --- | --- |
| Approval | `ADD COLUMN approved_by text REFERENCES users(id) ON DELETE SET NULL`, `ADD COLUMN approved_at timestamptz` |
| Message | `ADD COLUMN status_message text NOT NULL DEFAULT ''` |
| Indexes | `CREATE INDEX publish_posts_version_idx ON publish_posts(edit_version_id)`; `CREATE INDEX publish_posts_project_idx ON publish_posts(project_id, created_at)` |
| `music_check` type | TS only: `{ ok: boolean; reasons: string[]; perPlatform: PlatformEligibility[]; licenceSnapshot: MusicLicence \| null; checkedAt: string }` |

**`publish_targets`**

| Change | SQL | Notes |
| --- | --- | --- |
| Account optional | `ALTER COLUMN account_id DROP NOT NULL` | Manual targets have no account row |
| One destination per platform per post | `CREATE UNIQUE INDEX publish_targets_post_platform_idx ON publish_targets(post_id, platform)` | Replaces the role of `(post_id, account_id)`, which allows several NULLs. The old index stays. |
| Idempotency key unique | `CREATE UNIQUE INDEX publish_targets_idempotency_idx ON publish_targets(idempotency_key)` | Value `pt_<targetId>` (set at insert) |
| Method | `ADD COLUMN method text NOT NULL DEFAULT 'manual'` | `manual` / `instagram_api` / `zernio` |
| Zernio sub-mode | `ADD COLUMN delivery text NOT NULL DEFAULT 'publish'` | `publish` / `draft` (Zernio `draft: true`); ignored for the other methods |
| Variant and file | `ADD COLUMN media_variant text NOT NULL DEFAULT 'standard'`, `ADD COLUMN media_key text` | `media_key` is filled by `publish.prepare` |
| Manual step | `ADD COLUMN manual_step text` | `post_in_app`, `finish_in_tiktok_app`, `review_copyright_match`, `check_before_retry`, `music_licence_changed`, `reconnect_account`, `file_too_large_for_upload` |
| Message | `ADD COLUMN status_message text NOT NULL DEFAULT ''` | Plain language |
| Verification | `ADD COLUMN is_verification boolean NOT NULL DEFAULT false` | The first live post for a method |
| Non-repeatable call marker | `ADD COLUMN submitted_at timestamptz` | Set **before** `media_publish` or Zernio `POST /v1/posts` |
| Times and confirmation | `ADD COLUMN published_at timestamptz`, `ADD COLUMN confirmed_by text REFERENCES users(id) ON DELETE SET NULL`, `ADD COLUMN confirmed_at timestamptz` | |
| Adapter state | `ADD COLUMN provider_state jsonb NOT NULL DEFAULT '{}'` | e.g. `{ uploadDone, statusCode, copyright: {status, matchesFound}, quota: {usage,total}, zernioMediaUrl, zernioStatus, graphErrors: [...] }`. Never contains tokens. |
| Lookup | `CREATE INDEX publish_targets_external_post_idx ON publish_targets(platform, external_post_id)` | Webhook to target |

**`edit_versions`**
- `ADD COLUMN variant_exports jsonb NOT NULL DEFAULT '{}'`.
- Type: `{ no_music?: { status: 'queued'|'rendering'|'ready'|'failed'; key: string|null; byteSize: number|null; message: string; updatedAt: string } }`.

**`AppSettings`** (no SQL; stored in the `settings` jsonb)
- Add `publishing: { captionFooter: string (max 500, default '') }` with a schema default, so existing rows parse unchanged.

**Storage keys** (`packages/storage/src/keys.ts`)
- Add `editExportVariant(projectId, editId, versionNo, 'no_music')` → `projects/{p}/edits/{e}/v{n}/export-no-music.mp4`.
- Reuse `publishCover(postId)` → `publishing/{postId}/cover.jpg`. Because the cover sits outside the project prefix, project deletion must also delete `publishing/{postId}/` for that project's posts (see Files).

### 5.3 Integration states (pure function, unit tested)

`IntegrationStatus` (in `apps/web/src/lib/shared/integration-types.ts`) gains these optional fields. The unions
below are the single contract for every module (WP0 in `stage-bc-plan.md`); this module uses the values it needs:
- `state: 'not_configured' | 'not_connected' | 'connected' | 'awaiting_approval' | 'unavailable' | 'needs_reauth' | 'error'`
- `liveMode: 'live' | 'development_live' | 'sandbox' | 'staging' | 'read_only' | null`
- `verified: boolean`

The existing `configured` / `connected` fields stay.

| State | Instagram (direct) | TikTok via Zernio |
| --- | --- | --- |
| Manual posting | Always available, shown first | Always available, shown first |
| `not_configured` | `META_APP_ID`, `META_APP_SECRET` or `META_LOGIN_CONFIG_ID` missing | `TIKTOK_PUBLISH_PROVIDER` ≠ `zernio` (section hidden) or `ZERNIO_API_BASE_URL` missing |
| `not_connected` | Env present, no `meta` connection | Flag on, no key saved |
| `connected`, not verified | Account discovered, `verifiedDirectAt` null | Key valid, TikTok account chosen, not verified |
| `connected`, verified | Switch available (on or off) | Switches available |
| `needs_reauth` | Graph error 190, token expired, or `debug_token` invalid; warning from 7 days before `expires_at` | Zernio 401, or Zernio reports the account disconnected |
| `error` | Last check failed (missing permission, empty discovery, network). Shows `last_error` | Same |
| Live or sandbox label | "Development mode, posts are real and public" (`development_live`) | "Live: posts are public immediately" |

There is no simulated or sandbox posting mode at runtime. Fakes exist only in tests (§11). No platform offers a private sandbox for this account type: Instagram API publishing is public, and the Zernio Business lane is public only (memo §3–§4). The honest labels above replace a "test mode".

---

## 6. Jobs

All new types go in `packages/core/src/jobs.ts` (`JOB_TYPES`, payload schemas) and `packages/queue` (`QUEUE_SETTINGS`), with a `refIdFor` / `defaultRefId` case in **both** `apps/worker/src/lib/jobs.ts` and `apps/web/src/lib/jobs.ts`.

**Duplicate protection.** The authoritative guard is a conditional update on `publish_targets`, for example:

```sql
UPDATE … SET status='processing' WHERE id=$1 AND status IN ('queued','failed') RETURNING *
```

If no row comes back, another attempt owns the target, and the job exits successfully. The pg-boss `singletonKey` is a second guard. The new publish queues are created with policy `stately` (one queued and one active per key). The integration test must confirm this behaviour on pg-boss 12.38.1.

| Type | Payload (zod) | Dedupe / singletonKey | Retries / expiry | Does |
| --- | --- | --- | --- | --- |
| `publish.prepare` | `{ postId: string, projectId: string \| null }` | `publish-prepare:{postId}` | 3, 30 s backoff; 10 min; hb 60 s | Makes sure each target's media exists. If an export is missing, enqueue `render.export` (`variant` as needed, singletonKey `export:{versionId}:{variant}`) and exit. The render handler re-enqueues `publish.prepare` for waiting posts when it finishes. When the media exists: ffprobe **preflight** (`checkMediaForPlatform`, §6.2); cut the cover JPEG with `extractFrames(export, [coverTimeSec])` and store it at `publishCover(postId)`; set `media_key`. Manual targets go to `manual_step_required` / `post_in_app` (mode `now`/`draft_handoff`) or wait until due (scheduled). For mode `now`, enqueue `publish.target` for automated targets. |
| `publish.target` | `{ targetId, postId, projectId \| null }` | `publish-target:{targetId}` (= `idempotency_key` family) | 3, 60 s backoff, transient errors only; 45 min; hb 60 s; concurrency 1 | Adapter state machine (§7.1.4, §7.2.4). Permanent errors are written to the row and the job **completes** (no pg-boss retry). Transient errors are rethrown. Re-checks eligibility, account status and quota first. |
| `publish.poll` | `{ targetId, postId, projectId \| null, pollNo: int ≥ 0 }` | `publish-poll:{targetId}` | 5, 60 s backoff; 15 min | Reads the authoritative status: Instagram container `status_code` / copyright, Zernio post. It re-enqueues itself with `startAfter` on a schedule: Instagram every 60 s for 5 polls, then every 5 min until the container is 24 h old; Zernio at 1, 2, 5 and 10 min, then every 15 min up to 24 h. |
| `publish.dispatch` | `{}` | cron `* * * * *` | 0; 2 min | Finds targets that are `queued`, not manual, have `media_key` set and `scheduled_for <= now()` on an `approved`/`in_progress` post, and enqueues `publish.target`. Manual scheduled targets that are due become `manual_step_required` / `post_in_app` ("Due now"). Posts still preparing are left alone, and the message says they are late. |
| `social.check` | `{ connectionId: string \| null, reason: 'connect'\|'manual'\|'daily'\|'pre_publish' }` (null = all) | `social-check:{connectionId ?? 'all'}` | 2, 60 s; 5 min | **Read-only.** Meta: `debug_token`, discovery, `/{ig-id}?fields=id,username`, `content_publishing_limit`. Zernio: key validity and account list. Updates `social_accounts` and `integration_connections` (status, capabilities, `last_error`). Daily cron `23 4 * * *` (Melbourne time). **Never posts.** |
| `webhook.process` | `{ webhookEventId }` | `webhook:{webhookEventId}` | 5, 10 s backoff; 2 min | Built once by WP0 as a dispatcher that calls the handler a module registers for the event's `provider`. This module's `zernio` handler (WP10) loads the stored event, finds the target by `(platform='tiktok', external_post_id)`, and enqueues `publish.poll`. Sets `processed_at`. **Never changes target state from the payload** (§7.2.5). |
| `render.export` (existing; `variant` added by WP1) | add `variant: z.enum(['standard','no_music']).default('standard')` | `export:{versionId}:{variant}` | unchanged | `no_music` clones the plan with `audio.music = null`, writes `editExportVariant`, and updates `variant_exports.no_music`. On success the render handler calls the worker's export-ready hooks (WP0); this module registers a hook that enqueues `publish.prepare` for posts in `approved`/`in_progress` whose targets use this version and variant. |

### 6.1 Worker additions
- `apps/worker/src/main.ts`:
  - Register the six handlers.
  - Schedule `publish.dispatch` every minute and the daily `social.check`.
  - `ALL_JOB_TYPES` must include them, otherwise start-up fails, which is the existing guard.
- `apps/worker/src/lib/audit.ts`: a worker-side twin of `apps/web/src/lib/audit.ts`.
- `apps/worker/src/lib/http.ts`: `fetch` with an `AbortSignal` tied to the run, a per-call timeout (default 30 s; uploads 15 min), and a redacting logger that strips the `access_token` query and `Authorization` headers.

### 6.2 `checkMediaForPlatform` (new, core, pure)

Input: the ffprobe result of `media_key` plus the byte size. Output: issues per platform.

- **Instagram:**
  - container mp4 or mov
  - video h264 or hevc, progressive
  - 23–60 fps
  - width ≤ 1920
  - video bitrate ≤ 25 Mbps (memo §4)
  - audio AAC ≤ 48 kHz and ≤ 128 kbps (if present; memo §4 Reels spec)
  - 3 s ≤ duration ≤ 900 s
  - size ≤ 300 MB
  - for `instagram_api`, also size ≤ `capabilities.resumableMaxBytes` (else manual step `file_too_large_for_upload`)
- **TikTok:**
  - mp4, mov or webm
  - h264, h265, vp8 or vp9
  - 23–60 fps
  - 360–4096 px each side
  - 3 s–600 s
  - ≤ 4 GB

  Sources: memo §3 media limits; Zernio limits.
- Applies to all methods. A failure blocks automation, and a manual target shows the issue too ("TikTok may reject this file: …").
- The Stage A export preset already targets these values (memo §5). This check is a guard, not a transcode.

### 6.3 Duplicate-post protection (complete rules)

1. **Database.**
   - Unique `(post_id, platform)` and unique `idempotency_key`.
   - All target transitions use conditional updates.
   - Approving the same post twice: the second approval is a no-op.
2. **Repeat posting of the same version.** The API refuses (409 `CONFLICT`) to approve a post whose version already has a `published` / `processing` / `submitted` target on the same platform, unless the draft was created with `allowRepeat: true`. That flag is only set after the owner ticks "Post again" (§4.1 step 2).
3. **Instagram.**
   - The container id is saved immediately after `POST /{ig-id}/media`.
   - On any retry:
     - If a container exists, read its `status_code`.
     - `PUBLISHED` means it already went out: never call `media_publish` again. Recover the media id (§7.1.4 step 8).
     - `FINISHED` means it is safe to call `media_publish`.
     - `EXPIRED`/`ERROR` means it is safe to create a new container, because nothing was published.
   - `submitted_at` is set just before `media_publish`.
4. **Zernio.**
   - If `external_post_id` is set, never `POST /v1/posts` again. For a failed post, use `POST /v1/posts/{postId}/retry` (memo §3).
   - If `submitted_at` is set but `external_post_id` is null (crash or timeout in between), the target goes to `manual_step_required` / `check_before_retry`. It is re-sent only when the owner chooses **It's not there, try again**, which is audited as `publish.target.override_retry`.
   - Before that, the handler lists recent Zernio posts and matches on our `idempotency_key`, if Zernio supports a metadata or external-reference field (to confirm, §13). If a match is found, it adopts that `postId` without asking.
5. **Manual.** Nothing is sent, so there is no duplicate risk. "I've posted it" is idempotent.

---

## 7. External API calls

### 7.1 Instagram (Meta Graph API, Unified Login)

Hosts used by the worker are `graph.facebook.com` and `rupload.facebook.com`. The login dialog runs in the browser on `www.facebook.com`. The version is `META_GRAPH_VERSION` (default `v26.0`, memo §4 open question; v27.0 is also reported). Every Graph call sends `appsecret_proof = HMAC_SHA256(app_secret, access_token)`. This is standard Graph hardening, not from the memo; if Meta rejects it, the check reports that.

#### 7.1.1 Connect (web, owner only)

1. **`GET /api/integrations/instagram/connect`**
   - Creates a 32-byte random `state` and stores `sha256(state)+sessionId` in an HttpOnly, SameSite=Lax, 10-minute cookie `sa_oauth_meta`.
   - Writes audit `integration.meta.connect_started`.
   - Redirects (302) to `https://www.facebook.com/{v}/dialog/oauth?client_id={META_APP_ID}&redirect_uri={APP_URL}/api/integrations/instagram/callback&config_id={META_LOGIN_CONFIG_ID}&response_type=code&override_default_response_type=true&state={state}`. There is **no `scope`** (memo §4).
2. **`GET /api/integrations/instagram/callback?code&state`**
   - Requires the owner session.
   - Checks the state cookie with a timing-safe comparison, then clears it.
   - If the redirect carries `error`, shows Settings with "Instagram connection was cancelled".
   - **Code exchange**, done inline because codes are single-use and short-lived. It is one call with a 10 s timeout and **no retry**: `GET https://graph.facebook.com/{v}/oauth/access_token?client_id&client_secret&redirect_uri&code` → `{ access_token }`.
   - Encrypts the token (`encryptToken`) and upserts `integration_connections` (provider `meta`, status `connected`).
   - Writes audit `integration.meta.connected` (no token in the data).
   - Enqueues `social.check` with reason `connect`.
   - Redirects to `/settings?tab=integrations&checking=meta`.

#### 7.1.2 `social.check` (Meta part, read-only)

| Step | Call | Result handling |
| --- | --- | --- |
| a | `GET /{v}/debug_token?input_token={token}&access_token={APP_ID}\|{APP_SECRET}` | Require `is_valid`, `type == 'SYSTEM_USER'`, and `scopes` ⊇ {`instagram_basic`, `instagram_content_publish`}. Store `expires_at` (0 = never) in the connection `config` and on accounts as `tokenExpiresAt`. Invalid → `needs_reauth`. Wrong type or missing scopes → `error` with "Your Meta configuration must use a System-user access token with instagram_basic and instagram_content_publish." |
| b | `GET /{v}/me/assigned_instagram_accounts` (fields `id,username` where supported) | Upsert a `social_accounts` row for each (platform `instagram`, provider `meta_graph`, `connection_id`). |
| c | If (b) is empty: the `granular_scopes[].target_ids` for `instagram_content_publish` from (a) | For each id, `GET /{v}/{id}?fields=id,username` |
| d | If still empty | Connection `error`, `last_error = 'discovery_empty'`. The UI shows the account-ID form, and `POST /api/integrations/instagram/account` runs `GET /{v}/{id}?fields=id,username` (in this same job, reason `manual`, payload in `integration_connections.config.pendingIgUserId`). |
| e | `GET /{v}/{ig-id}/content_publishing_limit?fields=quota_usage,config` | Stores `quotaUsage` and `quotaTotal` (`config.quota_total`), plus `quotaCheckedAt`. |

Error 100 / subcode 33 during discovery shows: "Meta didn't share the Instagram account with this app. In Business Settings, assign the Instagram account to the system user, or add `business_management` to the configuration." (memo §4: community report).

#### 7.1.3 Disconnect

`DELETE /api/integrations/meta`:
- Sets the connection token to null and status to `disconnected`.
- Sets every `meta_graph` account to `disconnected` with `direct_publish_enabled=false`.
- Moves queued automated Instagram targets to `manual_step_required` / `reconnect_account`.
- Writes audit `integration.meta.disconnected`.
- UI copy: "To fully revoke access, remove the system user's token in Meta Business Settings."

#### 7.1.4 `publish.target` state machine (`method = instagram_api`)

1. **Claim.** Conditional update to `processing` (§6). Load the account and connection, and decrypt the token.
   - Account not `connected` → `manual_step_required` / `reconnect_account`.
   - Not verified and not `is_verification` → `failed` ("Direct publishing is not switched on").
   - Re-run `checkPublishEligibility` against the live licence → `music_licence_changed` on failure.
2. **Quota.** `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config`. If `quota_usage >= quota_total` → back to `queued`, message "Instagram's daily posting limit is reached; trying again at 3:40 pm", and re-enqueue with `startAfter` 60 min.
3. **Container.**
   - If `external_container_id` is set → `GET /{container-id}?fields=status_code,status`:
     - `PUBLISHED` → go to step 8.
     - `FINISHED` → go to step 6.
     - `IN_PROGRESS` → go to step 5.
     - `EXPIRED`/`ERROR` → clear it and create a new one.
   - Otherwise `POST /{ig-id}/media` with form `media_type=REELS`, `upload_type=resumable`, `caption={caption}`, `thumb_offset={round(coverTimeSec*1000)}` → `{ id }`. Save it to `external_container_id` **before** continuing.
   - Containers count toward 400 per 24 h, which is far above our use.
4. **Upload.** Unless `provider_state.uploadDone`:
   - `POST https://rupload.facebook.com/ig-api-upload/{v}/{container-id}` with headers `Authorization: OAuth {token}`, `offset: 0`, `file_size: {bytes}`.
   - The body is streamed from `store.getStream(media_key)` (private storage; no public URL; memo §4 / Follow-up 4).
   - On success, set `uploadDone`. A retry re-uploads from offset 0 to the same container.
   - Size was pre-checked in §6.2.
5. **Processing.** Enqueue `publish.poll` and exit the job, so the worker is not held while Meta processes. The poll reads `GET /{container-id}?fields=status_code,status`:
   - `IN_PROGRESS`, or error 9007/2207027 → poll again.
   - `ERROR` → `failed`, keeping `status` and Meta's message.
   - `EXPIRED` → `failed` "Instagram's upload expired. Retry to upload again."
   - `FINISHED` → step 6.
6. **Copyright.** `GET /{container-id}?fields=copyright_check_status`:
   - Still in progress → poll.
   - `matches_found: true` → `manual_step_required` / `review_copyright_match`. **Do not publish** (memo §4, Follow-up 5).
   - No matches → enqueue `publish.target`, which resumes at step 7.
7. **Publish.**
   - Conditional update to set `submitted_at = now()`.
   - `POST /{ig-id}/media_publish` with `creation_id={container-id}` → `{ id }`. Save `external_post_id` and `published_at`.
   - Timeout or 5xx → rethrow. The retry starts at step 3, and the container status decides.
8. **Read back.**
   - `GET /{media-id}?fields=permalink` → `published_url`; status `published`.
   - If the media id is unknown (status `PUBLISHED` found on retry), `GET /{ig-id}/media?fields=id,permalink,timestamp&limit=5` and match the newest item after `submitted_at` whose caption equals ours. This edge is not in the memo, so verify it in the smoke test.
   - If there is no match: `published` with no link, message "Instagram reports this reel was published. Open Instagram to see it, or paste the link." The owner can add the link with `confirm-posted`.
   - Writes audit `publish.target.published` and runs `refreshPostStatus`.

#### 7.1.5 Error mapping (advisory, memo §4: third-party tables; always keep Meta's `error.message` and `error_user_msg`)

| Graph code / subcode | Meaning | Action |
| --- | --- | --- |
| 190 (any) | Token invalid or expired | Account and connection `needs_reauth`; target `manual_step_required` / `reconnect_account` |
| 10, 200–299 | Permission missing | Connection `error`; target `failed` (not retryable) |
| 4, 17, 32, 613 | Rate limited | Transient: rethrow (pg-boss backoff) |
| 9007 / 2207027 | Media not ready | Keep polling |
| 2207042 | Publishing quota reached | Back to `queued`, `startAfter` 60 min |
| 2207026 | Unsupported format | `failed` "Instagram couldn't use this video file" (not retryable) |
| 2207050 | Account restricted | `failed` (not retryable) "Instagram has restricted this account" |
| 2207051 | Spam block | `failed` (not retryable); suggest posting manually later |
| 2207003 | Download timeout (`video_url` only) | Not expected with resumable upload; treated as transient |
| 100 / 33 | Object not accessible | `error` with the discovery hint |
| HTTP 5xx, network | Transient | Rethrow |

#### 7.1.6 Not built: `video_url` fallback

Built **only** if the smoke test shows resumable upload is unusable (memo §4 / Follow-up 4).
- Needs `STORAGE_DRIVER=s3`.
- Copy the file to a dedicated staging key `publishing/staging/{targetId}.mp4`.
- Make a presigned 24 h GET URL on the S3 API host (no redirects) and send it as `video_url` instead of `upload_type=resumable`.
- Delete the staging object after publish or on `ERROR`/`EXPIRED`.
- Meta's fetcher (`facebookexternalhit`) must not be blocked by a WAF.

The README must note that this path exposes a time-limited public URL.

### 7.2 Zernio (TikTok provider, flag `TIKTOK_PUBLISH_PROVIDER=zernio`)

Built in Stage C as its own work package (WP10), as the memo §3 Decision places it ("Optional Stage C
auto-publishing goes through one already-audited provider, Zernio, behind a feature flag and only after a live smoke
test"). Stage B ships manual TikTok posting only.

All paths below come from search summaries of docs.zernio.com (memo §3, raw findings). **Before implementing**, allow `docs.zernio.com` in network settings and confirm:
- the API base host (`ZERNIO_API_BASE_URL`)
- the presign endpoint path ("Get upload URL" page)
- the account-list endpoint
- the post-read endpoint
- the webhook signature scheme
- whether an idempotency header or external-reference field exists

Each unconfirmed item is marked ⚠ below.

#### 7.2.1 Connect (owner only)

- `POST /api/integrations/zernio` `{ apiKey }`:
  - Encrypt the key and upsert `integration_connections` (provider `zernio`, status `connected`, `last_error` null).
  - Write audit `integration.zernio.connected`.
  - Enqueue `social.check`.
- The key never returns to the browser, which only sees "Key saved (ends …abcd)". Store the last 4 characters in `config.keyHint`.
- `social.check` (Zernio):
  - ⚠ `GET {base}/v1/accounts` with `Authorization: Bearer {key}` lists the connected accounts.
  - Each TikTok account becomes a candidate in `config.candidates` (id, username, connected date).
  - 401 → `needs_reauth` ("Zernio didn't accept this key").
  - If no TikTok account → `error` "Connect TikTok inside Zernio first (Business connection)".
  - Record `businessApiLane=true` only if Zernio says the account was connected after 10 Sep 2026 or uses the Business lane; otherwise the UI asks the owner to reconnect it in Zernio (memo §3: new connections use the Business API lane).
- `POST /api/integrations/zernio/account` `{ zernioAccountId }`:
  - Upserts `social_accounts` (platform `tiktok`, provider `zernio`, `external_id` = Zernio account id, username).
  - Writes audit `social_account.selected`.
- `DELETE /api/integrations/zernio`: clears the key and marks accounts `disconnected`, as for Meta.

#### 7.2.2 Limits enforced

- 15 videos per account per rolling 24 h. The composer counts `published`/`processing` Zernio targets in the last 24 h and warns at 15; Zernio holds over-cap posts rather than failing them.
- 3 s–10 min, ≤ 4 GB, caption ≤ 2,200.
- Zernio's rate limit is 60 requests per minute on the free tier. The poll schedule (§6) stays well under it.

#### 7.2.3 Consent

- `content_preview_confirmed` and `express_consent_given` are sent as `true` **only** when the target's post was approved with `consent.tiktokPublic === true` (stored in `provider_state.consent = { at, userId }`).
- `privacy_level` is always `PUBLIC_TO_EVERYONE`.
- AI-generated disclosure is not set: these are edits of real footage. See open question 5.

#### 7.2.4 `publish.target` state machine (`method = zernio`)

1. **Claim and checks** as for Instagram (account, verification, licence). `media_variant` for TikTok is never `standard` on a `meta_only` render; the rule enforces this.
2. **Existing post.** If `external_post_id` is set → enqueue `publish.poll` and exit. If `submitted_at` is set without a post id → §6.3 rule 4.
3. **Upload.** If `provider_state.zernioMediaUrl` is missing:
   - ⚠ presign call (search summary: "presign, PUT the file to the upload URL (expires after an hour), then reference the returned public URL").
   - `PUT` the bytes streamed from `store.getStream(media_key)` with `Content-Type: video/mp4` and `Content-Length`.
   - Save the returned URL to `provider_state.zernioMediaUrl`. Zernio keeps temporary uploads for 7 days, so it is reused on retry within that time.
4. **Create the post.**
   - Conditional update to set `submitted_at`.
   - `POST {base}/v1/posts` with:
     ```json
     { "content": "<caption>",
       "platforms": [{ "platform": "tiktok", "accountId": "<zernioAccountId>" }],
       "mediaItems": [{ "type": "video", "url": "<zernioMediaUrl>" }],
       "tiktokSettings": { "privacy_level": "PUBLIC_TO_EVERYONE", "content_preview_confirmed": true, "express_consent_given": true },
       "publishNow": true }
     ```
   - `delivery = 'draft'` → `"draft": true` instead of `publishNow` (memo raw: "draft: true sends the video to the creator's TikTok inbox").
   - ⚠ The field names `content` and `accountId` and the shape of `platforms` must be confirmed. The memo only names `platform "tiktok"`, `mediaItems` type `video`, `tiktokSettings` flags, `privacy_level`, `publishNow` and `draft`.
   - ⚠ Send `Idempotency-Key: {idempotency_key}` if Zernio supports it.
   - Save `postId` to `external_post_id` and enqueue `publish.poll` at 60 s.
5. **Poll** (⚠ expected `GET {base}/v1/posts/{postId}`). Map Zernio state:
   - scheduled or held → `queued` ("Held by TikTok's daily limit").
   - Publishing → `processing`.
   - Platform published → `published`, `published_at`. Link only once Zernio reports `platformPostUrl` (TikTok exposes the id "some minutes after publishing"; event `post.tiktok.url_resolved`). Until then, no link.
   - Platform failed or partial → `failed` with Zernio's error message, retryable via `POST /v1/posts/{postId}/retry`.
   - Draft delivered → `manual_step_required` / `finish_in_tiktok_app`. Exact draft status naming is ⚠.
6. **Retry of a failed Zernio target.** `POST {base}/v1/posts/{postId}/retry`, never a new post.

**Error mapping:**
- 401/403 → `needs_reauth`.
- 429 → transient.
- "direct posting is at capacity" → `queued` with `startAfter` 30 min.
- Partial permission grant ("refused") → `error` "Reconnect TikTok in Zernio and approve every permission".
- Validation 4xx → `failed`, not retryable.
- 5xx/network → transient.

#### 7.2.5 Webhooks (`POST /api/webhooks/zernio`)

- **Route.** Public route (`handlePublicApi`, `csrf: false`). Body limit 256 KB. Reply 200 within 5 s (Zernio's requirement): store and enqueue only.
- **Signature.**
  - If `ZERNIO_WEBHOOK_SECRET` is set **and** the scheme is confirmed (⚠), verify the signature with a timing-safe comparison and set `signatureValid`.
  - Otherwise `signatureValid=false`.
- **Storage.** Insert into `webhook_events` with provider `zernio`. `external_event_id` = the payload's event id (⚠)
  **only when the signature was verified**; otherwise `unverified:` + `sha256(rawBody)`. This way an unsigned or
  forged delivery can never take the unique `(provider, external_event_id)` slot of a real event (the Square design
  §7.3 avoids the same problem by not storing unverified events at all). On conflict, do nothing (a duplicate
  delivery); enqueue `webhook.process` only when a row was inserted.
- **Processing.** The payload is **only a hint**. `webhook.process` reads `postId`, finds the matching target and enqueues `publish.poll`, which asks Zernio with our key. A forged or replayed event can at most trigger an extra read.
- **Unconfirmed read-post endpoint.** If smoke testing shows Zernio has no read-post endpoint, webhooks become authoritative. That is allowed **only** with a verified signature; otherwise the module stays disabled.
- **Events used:** `post.platform.published`, `post.platform.failed`, `post.partial`, `post.failed`, `post.tiktok.url_resolved`, `post.published`.
- **Registration.** The owner copies `{APP_URL}/api/webhooks/zernio` into Zernio's dashboard (checklist). Polling works without it.

---

## 8. API routes

All routes are under `/api` and follow the existing conventions in `docs/api.md`:
- JSON error envelope.
- `handleApi` with session and CSRF on state-changing methods.
- Owner-only routes call `requireOwner`.
- Project access goes through `getAccessibleVersion`, so staff see only their own projects.

### 8.1 Publishing

| Method | Route | Auth | Body → Response |
| --- | --- | --- | --- |
| GET | `/api/publishing/eligibility?versions=a,b` | session | → `{ items: [{ versionId, projectTitle, styleName, previewUrl, durationSec, exportStatus, noMusicExportStatus, defaultCoverTimeSec, captionSuffix, eligibility: PlatformEligibility[], methods: { instagram: MethodOption[], tiktok: MethodOption[] }, priorTargets: [{ platform, status, publishedAt }] }], quota: { instagram?: { usage, total, checkedAt }, zernio?: { last24h: number } } }`. `MethodOption = { method, delivery?, available: boolean, reason?: string, isVerification: boolean, accountId?: string, handle: string }` |
| POST | `/api/publish-posts` | session | `{ items: [{ editVersionId, caption: string ≤ 2200, coverTimeSec: number ≥ 0, mode: 'now'\|'scheduled'\|'draft_handoff', schedule?: { date: 'YYYY-MM-DD', time: 'HH:mm' }, targets: [{ platform, method, delivery?: 'publish'\|'draft', variant }] (1–2, unique platform) }] (1–5), allowRepeat?: boolean }` → `{ posts: PublishPostDto[] }` (status `draft`, with server-resolved caption, schedule (UTC plus a Melbourne label), variants and eligibility). Validates: eligibility, method availability, DST (`VALIDATION` with "That time doesn't exist…"), the 10 min to 90 days window, and the duplicate rule (409 unless `allowRepeat`). |
| POST | `/api/publish-posts/approve` | **owner** | `{ postIds: string[], consent?: { tiktokPublic: boolean } }` → `{ posts }`. Refuses a Zernio target without `tiktokPublic` (`VALIDATION`). Sets `approved_by`/`approved_at`, `status=approved`, writes `music_check` (re-run now), writes audit `publish.approved` (per post), and enqueues `publish.prepare`. (The `publish` feedback event and the `music_usage` row are written later, when a target is published, §3.3 and §5.1.) Idempotent for posts that are already approved. |
| GET | `/api/publish-posts?view=queue\|history&cursor` | session | → `{ posts: PublishPostDto[], nextCursor }`. Queue = draft/approved/in_progress or any `manual_step_required` target. History = everything else. Newest first; scheduled posts sorted by time. |
| GET | `/api/publish-posts/[id]` | session | → `PublishPostDto` with targets, messages and `actions` allowed per target |
| PATCH | `/api/publish-posts/[id]` | session (owner if approved) | `{ caption?, coverTimeSec?, schedule?, targets? }`. Changing anything but `schedule` on an approved post returns it to `draft` (409 if any target has `submitted_at`). |
| POST | `/api/publish-posts/[id]/cancel` | **owner** | → post. Targets without `submitted_at` become `cancelled`. Audit `publish.cancelled`. |
| DELETE | `/api/publish-posts/[id]` | session | Drafts only (409 otherwise). Deletes the cover. |
| GET | `/api/publish-targets/[id]/media` | session | → `{ videoUrl, videoFilename, coverUrl?, caption, label? }` with expiring links (`MEDIA_LINK_TTL_SECONDS`). 409 until `media_key` is set. |
| POST | `/api/publish-targets/[id]/confirm-posted` | session | `{ url?: string }` (validated per platform) → target. Allowed in `manual_step_required` (`post_in_app`, `finish_in_tiktok_app`, `check_before_retry`), or `published` without a link (to add one). Audit `publish.target.confirmed_manual`. |
| POST | `/api/publish-targets/[id]/undo-confirm` | session | Only for manual confirmations → back to `manual_step_required`. Audit. |
| POST | `/api/publish-targets/[id]/retry` | **owner** | `failed` only → `queued` (same `idempotency_key`), then enqueue `publish.target`. Audit `publish.target.retry`. |
| POST | `/api/publish-targets/[id]/resolve` | **owner** | `{ action: 'post_without_music' \| 'post_manually' \| 'retry_anyway' \| 'mark_posted' }`. Allowed per `manual_step`. `post_without_music` → variant `no_music`, clears the container, re-prepares. `post_manually` → method `manual`. `retry_anyway` (only for `check_before_retry`) → clears `submitted_at`, audit `publish.target.override_retry`. |
| POST | `/api/social-accounts/[id]/verification` | **owner** | `{ result: 'seen' \| 'not_seen', targetId }`. Only for a `published` target with `is_verification`. `seen` sets `capabilities.verifiedDirectAt` or `verifiedDraftAt`. Audit. |
| PATCH | `/api/social-accounts/[id]` | **owner** | `{ directPublishEnabled?: boolean, draftsEnabled?: boolean }`. 409 unless the matching verification is set. Audit `social_account.direct_publish.enabled/disabled`. |

### 8.2 Integrations

| Method | Route | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/integrations/instagram/connect` | **owner** | 302 to the Meta dialog (§7.1.1) |
| GET | `/api/integrations/instagram/callback` | **owner** session + state | 302 to Settings |
| POST | `/api/integrations/instagram/account` | **owner** | `{ igUserId: /^\d{5,30}$/ }` → enqueues `social.check` (manual) |
| DELETE | `/api/integrations/meta` | **owner** | Disconnect (§7.1.3) |
| POST | `/api/integrations/zernio` | **owner**, flag on | `{ apiKey: string 10–200 }` → `{ status }` |
| POST | `/api/integrations/zernio/account` | **owner** | `{ zernioAccountId }` |
| DELETE | `/api/integrations/zernio` | **owner** | Disconnect |
| POST | `/api/integrations/[provider]/check` | **owner** | Enqueues `social.check` (manual) → `{ jobId }`. Read-only. |
| GET | `/api/integrations/status` (existing) | session | Adds `state`, `liveMode` and `verified`, plus the new Instagram/TikTok wording |
| POST | `/api/webhooks/zernio` | public, signature | §7.2.5 |

### 8.3 Changed existing routes

- `POST /api/edit-versions/[id]/export` accepts `?variant=no_music`. Default behaviour is unchanged.
- `GET /api/edit-versions/[id]/download` accepts `kind=export_no_music`, and adds `label` for `meta_only` standard exports.
- `DELETE /api/projects/[id]` cancels the project's approved or scheduled posts (targets without `submitted_at`) and deletes `publishing/{postId}/` covers before the prefix delete.

`PublishPostDto` (in `apps/web/src/lib/shared/publishing-dto.ts`):
- `{ id, versionId, projectId, projectTitle, styleName, previewThumbUrl, caption, coverUrl, mode, scheduledFor, scheduledForLabel, status, statusMessage, approvedAt, targets: TargetDto[] }`
- `TargetDto = { id, platform, method, delivery, handle, variant, status, manualStep, statusMessage, publishedUrl, publishedAt, confirmedByName, attempts, isVerification, actions: Array<'retry'|'cancel'|'confirm'|'undo'|'post_without_music'|'post_manually'|'retry_anyway'|'download'> }`

---

## 9. UI

Follows `apps/web/src/components/ui`: `Card`, `Badge`/`StatusPill`, `Button`, `Dialog`, `Field`, `Switch`, `Tabs`, `EmptyState`, `Alert` and `Toast`. Charcoal and white with the brand accent, mobile first, Australian English, and no technical words in business flows ("container", "token" and "webhook" appear only in Settings details).

### 9.1 Pages

- **`/publishing`** (replaces the current `SectionOverview` page). Server component plus a polling client list (every 5 s while anything is active, using the same pattern as `use-studio-status`).
  - **Your turn.** Targets in `manual_step_required`, the most urgent first, each with its primary action (Download / Copy caption / I've posted it / Reconnect).
  - **Tabs.**
    - **Upcoming and in progress:** cards with a thumbnail, project and style, a caption excerpt, the time ("Sat 15 Nov, 10:00 am AEDT") and one pill per platform.
    - **History:** published, partly posted, failed and cancelled. Published targets show **View on Instagram/TikTok ↗** only when `published_url` is set.
  - **Connections.** A compact `IntegrationStatusList` for the publishing area, with honest copy:
    - "Instagram: post it yourself (works now) · Direct publishing: needs setup"
    - "TikTok: post it yourself (works now)"
  - **Empty state.** "Nothing to post yet. Open an edit in the Video Studio or the Content Library and choose Publish." with a button to the Library.
- **`/publishing/new`.** Client stepper, as in §4.1. On a phone the steps are stacked accordions; on desktop there is a two-column layout (preview left, form right).
- **`/publishing/[postId]`.** Detail page:
  - The video, the final caption (copy button) and the cover.
  - One `TargetCard` per destination (status, message, manual steps, actions).
  - A small "History" list from `audit_log` for this post's entities (times in Melbourne).
- **Settings → Integrations.**
  - Instagram card: connect, account-ID form, check, verification state, direct switch, token expiry, disconnect.
  - TikTok card: the manual line, plus the Zernio section when the flag is on.
  - Existing `integrations-tab.tsx` is extended.
- **Settings → Business.** Add a "Default caption ending" field (`publishing.captionFooter`), next to the existing Instagram and TikTok handles that manual destinations display.

### 9.2 Components (new, `apps/web/src/components/publishing/`)

- `composer.tsx`: stepper state, which calls `eligibility` → `publish-posts` → `approve`.
- `video-row.tsx`: preview, remove button, repeat-post warning and `allowRepeat` tick.
- `caption-editor.tsx`: textarea, `n / 2,200` counter (graphemes via `Intl.Segmenter`), hashtag count warning over 30, locked attribution line, and **Use default ending** button.
- `cover-picker.tsx`: `<video>` plus a range input (step 1/30 s), a frame thumbnail (canvas draw of the current frame), **Use this frame**, and keyboard support (arrow keys step one frame).
- `destination-picker.tsx`: platform switches (default off), method radio group with disabled reasons, variant line ("with music" / "without music: add a sound in TikTok"), and quota hint.
- `schedule-input.tsx`: date and time inputs, a zone label from `Intl` (AEDT/AEST for that date), and inline DST errors from the shared `melbourneLocalToUtc`. The function runs in the browser for instant feedback and again on the server.
- `review-card.tsx`: the final summary per video × destination, the consent checkbox (Zernio) and the verification warning.
- `target-card.tsx`, `manual-steps.tsx`, `confirm-posted-dialog.tsx`, `publish-badges.tsx` (small per-platform badges for Library and Studio cards).
- `StatusPill` additions:
  - `manual_step_required` → label "Your turn", tone amber (the same tone as `needs_setup`).
  - `published` → green, label "Posted".

### 9.3 Content Library and Video Studio

- **Library cards.**
  - `publish-badges` per version, for example "Instagram · Posted", "TikTok · Your turn" and "Scheduled 15 Nov".
  - A **Publish** link to `/publishing/new?versions={id}`.
  - A `meta_only` download label.
- **Library header.** A **Select** button turns on checkboxes. Nothing is ticked and there is no "select all". The sticky bar reads "**Publish selected (n)**", disabled at 0 and capped at 5. The query adds a left join on `publish_targets` and `publish_posts` per version.
- **Studio edit card.**
  - A **Publish…** button next to Download (enabled when `preview_ready`), opening the composer with that version.
  - The same badges under the version switcher.
  - Video Studio stays the primary destination: publishing adds one button and never changes the upload or preview layout.
- **Dashboard** (optional, small). One line, "2 posts need you", linking to `/publishing`. It shows nothing when there are none.

### 9.4 Copy rules

- **Plain words.** Use "Post it yourself", "Your turn", "Posted (you confirmed)" and "Publish from Studio Assistant".
- **What we never say.**
  - Never claim that a post "went viral" or that a song is "trending".
  - Never show a link we have not confirmed.
  - Never call manual steps "automatic".
- **Instagram music.** Shown once in the composer: "Instagram's library music can't be added from here. Add it in the Instagram app if you want it."
- **TikTok music.** "Add a Commercial Sound in the TikTok app."

---

## 10. Security and privacy

- **Credentials.**
  - The Meta system-user token and the Zernio API key are stored only in `integration_connections.access_token_encrypted` (AES-256-GCM, `packages/db/src/crypto.ts`).
  - They are decrypted only in the worker, and in the web callback for the single code exchange.
  - They never go to the browser, `jobs.payload`, `provider_state`, `audit_log` or logs.
  - `META_APP_SECRET` stays in the environment.
- **Least privilege.**
  - Meta: `instagram_basic` and `instagram_content_publish` only. Add `business_management` only if discovery is empty (memo §4).
  - Zernio: an account-level key. The owner connects only TikTok there, which keeps them inside the 2 free accounts.
- **OAuth.**
  - The state is bound to the session cookie and lasts 10 minutes.
  - The redirect URI is fixed from `APP_URL`, which must be https in production. Meta requires an HTTPS redirect.
  - The callback requires the owner session.
- **CSRF and roles.**
  - Every state-changing route uses `handleApi` (same-origin check). The webhook route is the only public POST and needs no session.
  - Integrations, approval, retry, resolve, cancel and the switches are owner-only.
  - Staff can draft and confirm manual posts on their own projects.
- **Audit log entries:**
  - `integration.meta.connect_started` / `connected` / `disconnected`
  - `integration.zernio.connected` / `disconnected`
  - `social_account.selected`, `social_account.verification`, `social_account.direct_publish.enabled` / `disabled`
  - `publish.approved`, `publish.cancelled`
  - `publish.target.submitted` (worker, at `submitted_at`), `publish.target.published`, `publish.target.failed`
  - `publish.target.confirmed_manual`, `publish.target.undo_confirm`, `publish.target.retry`, `publish.target.override_retry`, `publish.target.resolve`

  The data carries ids, platform, method and variant. Captions are trimmed to 200 characters. Tokens are never included.
- **Media.**
  - Instagram uploads stream from private storage over the server (`rupload`), so no public URL exists (memo Follow-up 4).
  - Zernio receives the file through its own presigned URL. The video becomes public when posted, which is the owner's intent.
  - Owner downloads use expiring links only.
  - The `video_url` fallback is not built (§7.1.6).
- **Webhooks.**
  - Each event is stored once (unique index).
  - The payload is treated as untrusted data and only triggers an authenticated poll.
  - There is a body size limit, and the provider's raw body is never echoed back.
- **Untrusted input.** Captions and pasted links are user input, rendered as text. Pasted links must match a platform URL pattern before they are stored or shown as links. Graph and Zernio responses are data: messages are shown as text and never as HTML.
- **Meta app requirements.** The app needs a Privacy Policy URL and a User Data Deletion URL (memo §4). Add public static pages `/privacy` and `/data-deletion`, both plain text and both owner-editable in a later iteration. The Spotify embed rules in memo §1 need the privacy page too, so it is shared.
- **Logging.** The new HTTP helper redacts `access_token`, `appsecret_proof`, `input_token`, `client_secret` and `code` query parameters and `Authorization` headers.
- **Deletion.**
  - Deleting a project removes its covers and cancels unsent posts.
  - Disconnecting removes stored credentials.
  - Published posts stay on the platforms. The owner deletes them in the apps, and the UI says so.

---

## 11. Testing

### 11.1 Unit (vitest, no network)

- `packages/core`:
  - **`checkPublishEligibility` matrix.** No music; a licence covering both platforms; `tiktok:false`; unconfirmed; non-promotional; expired; deleted track; `meta_sound_collection` (TikTok gets `no_music` only even if `permitted.tiktok` was true; Instagram standard is labelled); `cc_by` caption suffix; the original-sound note.
  - **`melbourneLocalToUtc`.**
    - Normal AEDT and AEST dates.
    - 2026-10-04 02:30 is nonexistent.
    - 2027-04-04 02:30 is ambiguous: first occurrence, 15:30Z on 3 April.
    - 2027-04-04 03:30 → AEST.
    - Invalid strings.
    - Past times are rejected by the caller.
  - **`checkMediaForPlatform`.** Boundaries: 2.9 s / 3 s, 61 fps, 1921 width, 300 MB, the resumable 100 MB cap, and a webm file sent to Instagram.
  - **Removing music keeps a valid plan.** `validateEditPlan` still passes with `audio.music = null`.
  - **Caption validation.** 2,200 graphemes, emoji counting, and the attribution suffix appended once.
  - **`refreshPostStatus` derivation** for each mix of target states.
  - **Manual link validators.**
  - **Error mappers.** `mapGraphError` and `mapZernioError` return `{ kind: 'transient'|'reauth'|'quota'|'permanent'|'not_ready', message }`.
- `apps/web`:
  - `buildIntegrationStatuses` with the new states and wording (no TikTok developer app; manual always available).
  - DTO `actions` per state.
  - The approve route refuses a missing consent.
- Composer logic: no platform or video preselected, and a cap of 5.

### 11.2 Integration (worker, `TEST_DATABASE_URL` + ffmpeg, fakes)

**Fakes.** A local HTTP server per test plays Graph, rupload and Zernio. Base URLs come from `META_GRAPH_BASE_URL`, `META_RUPLOAD_BASE_URL` and `ZERNIO_API_BASE_URL`. The two `META_*_BASE_URL` overrides are honoured only when `NODE_ENV=test`. A synthetic export comes from `scripts/make-sample-footage.sh`, rendered through the Stage A pipeline.

**Cases:**
1. **Instagram happy path.** Container → upload (the fake checks `offset`, `file_size` and the byte count) → IN_PROGRESS twice → FINISHED → no copyright match → publish → permalink. The target is `published` with the URL, and the post is `complete`.
2. **Crash after `media_publish`, before saving.** The fake publishes, then the handler is killed (throw after the call). On retry the container says `PUBLISHED`, so there is no second `media_publish` (the fake counts calls). The media id is recovered from the `/{ig-id}/media` fake.
3. **Container ERROR** → `failed` with Meta's message, and **Retry** creates a new container.
4. **Copyright `matches_found: true`** → `review_copyright_match`, and `media_publish` is never called. `post_without_music` renders the `no_music` variant (real ffmpeg) and publishes it.
5. **Quota reached** → requeued with `startAfter`, and no container is created.
6. **Error 190** → account `needs_reauth`, target `reconnect_account`.
7. **Two destinations.** Instagram fails permanently while Zernio TikTok is published. The post is `partial`, and the published target is unchanged after an Instagram retry.
8. **Zernio happy path.** Presign → PUT → `POST /v1/posts` (fake asserts both consent flags, `PUBLIC_TO_EVERYONE`, `mediaItems` type `video`) → poll processing → published without a URL → URL resolved → link shown.
9. **Zernio crash between `POST /v1/posts` and saving the `postId`** → `check_before_retry`, and no second POST until `retry_anyway`.
10. **Zernio failed** → **Retry** calls `/v1/posts/{id}/retry` and does not create a new post.
11. **Webhooks.** The same event delivered twice gives one `webhook_events` row and one poll. A forged event for an unknown post changes nothing. An event never sets status by itself.
12. **Scheduling.** A scheduled post at now+2 min is dispatched by `publish.dispatch` only after it is due. Cancel before due → no external calls. Reschedule → only the time changes.
13. **Licence changed after approval** (`permitted.tiktok` set to false) → `music_licence_changed`, no external calls.
14. **`meta_only` track.** The API refuses a TikTok standard variant (`VALIDATION`), and TikTok gets a `no_music` export file with no music stream (ffprobe on the audio level / track count).
15. **Restart recovery.** `kill -9` the worker during the rupload stream. After restart the job resumes, the upload is repeated against the same container, and there is exactly one publish.
16. **Concurrency.** Two `publish.target` jobs for the same target (singleton bypassed on purpose) → exactly one claims it; the other exits.
17. **pg-boss `stately` policy plus `singletonKey`.** Behaviour is checked on 12.38.1.

### 11.3 Live checks with the owner's accounts (only with the owner present; no test posts without approval)

| Check | How | Pass criteria |
| --- | --- | --- |
| Meta read-only check (safe any time) | Settings → Check connection | `debug_token` shows `SYSTEM_USER` and both scopes; account discovered (or entered); `content_publishing_limit` read; Graph version recorded |
| **First Instagram verification post** (live, public) | Owner composes a real edit with "First verification post", approves it, and the target publishes | Container → resumable upload → FINISHED → copyright check → published → permalink opens the reel. The owner taps **Yes, it's there**. Record in `docs/HANDOVER.md`: date, Graph version, file size, quota total, token expiry, whether discovery needed the manual ID. |
| Zernio read-only check | Paste key → Check | Key valid, TikTok account listed, Business lane |
| **First TikTok verification post via Zernio** (live, public) | As above, with the consent tick | Post published, URL resolves, webhook (if registered) received and stored once; the owner confirms. Record the confirmed endpoint paths and field names. |
| Zernio draft verification (optional) | A "Send to TikTok drafts" target | The draft appears in the TikTok inbox. Record whether the caption pre-fills (memo §3 says probably not) and whether the draft can be posted publicly. |

### 11.4 Only verifiable with the owner's real accounts

- Whether a Unified Login, Development-mode app can publish at all (memo §4 "Main risk").
- Whether `business_management` is needed for discovery.
- The real resumable size limit (100 MB vs 300 MB).
- Quota 50 vs 100, and token expiry (never vs 60 days).
- Whether `thumb_offset` is honoured with resumable upload.
- How `copyright_check_status` behaves for Sound Collection tracks.
- Zernio:
  - audited lane end to end
  - real endpoint paths and field names
  - webhook signing
  - held-over-cap behaviour
  - URL resolution delay
  - draft behaviour
- How the manual steps feel on the owner's phone, including Web Share with a 60 MB file on iOS.

---

## 12. Owner setup checklist (plain language)

**Works today, nothing to set up.**
1. Fill in your Instagram and TikTok handles in Settings → Business, so the app shows where each post goes.
2. Use **Post it yourself**: download the video, copy the caption, post it in the app, then tap **I've posted it**.
3. Keep your TikTok account as a **Business Account** and add music from **Commercial Sounds** inside TikTok.

**Music.**
- Mark each uploaded track's licence in Settings → Music, including which platforms it covers. A track that doesn't cover TikTok is posted to TikTok without music, and you add a Commercial Sound in the app.
- Tracks from Meta's Sound Collection can only go to Instagram or Facebook. Download them with the shop's own Meta login, and keep the download date and the date you accepted the terms.

**Optional: post Reels to Instagram directly from Studio Assistant.** About 30–60 minutes at a computer.
1. Make sure the shop's Instagram is a **professional account** (Business or Creator).
2. In **Meta Business Suite / Business Settings**, use a business portfolio you fully control. Add or claim the Instagram account there.
3. At developers.facebook.com, create a **Business-type app** with the use case "Manage messaging & content on Instagram" and the **Facebook Login for Business** product. You are the app's Admin. Leave the app in **Development mode**; App Review and Business Verification are not needed for your own account.
4. In Facebook Login for Business, create **one configuration**:
   - **System-user access token**, expiry **Never** (or 60 days, and the app will remind you to reconnect).
   - Asset: your Instagram account.
   - Permissions: `instagram_basic` and `instagram_content_publish`.
   - Copy the **Configuration ID**.
5. Add the redirect address `https://<your app address>/api/integrations/instagram/callback` both in the configuration and under **Valid OAuth Redirect URIs**.
6. In App settings, add:
   - Privacy Policy URL `https://<your app address>/privacy`
   - User Data Deletion URL `https://<your app address>/data-deletion`
   - your App Domain
7. Give the person running the server:
   - the **App ID**
   - the **App Secret** (keep it private)
   - the **Configuration ID**

   They set `META_APP_ID`, `META_APP_SECRET` and `META_LOGIN_CONFIG_ID`, and allow the server to reach `graph.facebook.com` and `rupload.facebook.com`.
8. In Studio Assistant, go to Settings → Integrations → **Connect Instagram**, sign in and approve. If it asks for your Instagram account ID, it is in Business Settings → Accounts → Instagram accounts.
9. Do the **first verification post**:
   - Choose a finished edit you're happy to share. This is a real, public reel.
   - When it's live, confirm you can see it.
   - Then turn on **Publish directly from Studio Assistant**.

**Optional: automatic TikTok posting via Zernio.** This costs nothing for up to 2 connected accounts across your whole team, according to Zernio's pricing pages (unverified as of Nov 2026).
1. Create a **Zernio** account in the business's name. Connect **only TikTok** (a Business connection; approve every permission). Don't connect X unless you have added a card, because X is billed from the first post.
2. Ask the person running the server to set `TIKTOK_PUBLISH_PROVIDER=zernio` and `ZERNIO_API_BASE_URL`, and to allow the Zernio API and upload hosts.
3. Create an API key in Zernio and paste it into Settings → Integrations → TikTok. Choose your TikTok account.
4. Optional: add the webhook address `https://<your app address>/api/webhooks/zernio` in Zernio, so updates arrive faster.
5. Do the **first verification post**:
   - Posts via Zernio are **public immediately**.
   - TikTok allows 15 videos per 24 hours this way.
   - Music still has to be added in TikTok, so use **Send to TikTok drafts** if you want a sound.

---

## 13. Files to create or modify

**`packages/core`**
- `src/publishing.ts` (new): `PublishMethod`, `MediaVariant`, `checkPublishEligibility`, `checkMediaForPlatform`, `validateCaption`, `derivePostStatus`, `validatePostLink`, `MANUAL_STEPS`, DTO-independent schemas `CreatePublishPostsSchema` and `ScheduleInputSchema`.
- `src/publishing.test.ts` (new).
- `src/time.ts`: `melbourneLocalToUtc`, `melbourneZoneLabel(date)`; plus tests.
- `src/music.ts`: memo §2 additions (`meta_sound_collection`, `facebook`, `destinationLock`). These are **shared with the preferences/music design**, so implement them once.
- `src/jobs.ts`: six new job types, payload schemas, and `variant` on `RenderExportPayloadSchema`.
- `src/settings.ts`: `publishing.captionFooter`.
- `src/index.ts`: export `publishing.js`.

**`packages/db`**
- `src/schema.ts`: the columns, indexes and enum or type widenings in §5.2.
- `drizzle/00NN_publishing.sql` and its snapshot (generated).

**`packages/queue`**
- `src/index.ts`:
  - `QUEUE_SETTINGS` for the new types.
  - Optional per-type `policy` (`stately` for `publish.*`).
  - `EnqueueOptions.startAfter?: Date`.
  - Cron registration stays as is.

**`packages/storage`**
- `src/keys.ts`: `editExportVariant`.

**`packages/config`**
- `src/index.ts`:
  - `META_LOGIN_CONFIG_ID`, `META_GRAPH_VERSION` (default `v26.0`)
  - `TIKTOK_PUBLISH_PROVIDER` (`none` | `zernio`, default `none`)
  - `ZERNIO_API_BASE_URL`, `ZERNIO_WEBHOOK_SECRET`
  - test-only `META_GRAPH_BASE_URL`, `META_RUPLOAD_BASE_URL`
  - `describeCapabilities` updated

  `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` stay optional but are documented as unused (no direct TikTok API).
- `.env.example`: the same, with comments. Remove the TikTok developer-app lines.

**`apps/worker`**
- `src/handlers/publish-prepare.ts`, `publish-target.ts` (dispatches to the adapters), `publish-poll.ts`, `publish-dispatch.ts`, `social-check.ts`, `webhook-process.ts` (new).
- `src/publishing/instagram.ts` (Graph client plus state machine steps), `src/publishing/zernio.ts`, `src/publishing/errors.ts` (`mapGraphError`, `mapZernioError`), `src/publishing/post-status.ts` (`refreshPostStatus`) (new).
- `src/lib/http.ts`, `src/lib/audit.ts`, `src/lib/credentials.ts` (decrypt the connection credential with `deriveEncryptionKey`) (new).
- `src/handlers/render.ts`: `variant` support, `variant_exports` updates, and re-enqueue `publish.prepare` after an export.
- `src/lib/jobs.ts`: `refIdFor` cases.
- `src/main.ts`: register the handlers and schedule the two cron jobs.
- `test/publishing.integration.test.ts` and `test/fakes/{graph,zernio}-server.ts` (new).

**`apps/web`**
- `src/lib/publishing.ts` (new): eligibility assembly, create/approve/patch/cancel, target actions, DTO mapping, `refreshPostStatus` reuse via core.
- `src/lib/shared/publishing-dto.ts` (new).
- `src/lib/oauth-state.ts` (new).
- `src/lib/integrations.ts`: new Instagram and TikTok statuses (§5.3), `state` / `liveMode` / `verified`.
- `src/lib/shared/integration-types.ts`: optional fields.
- `src/lib/jobs.ts`: `defaultRefId` cases.
- `src/lib/studio-edits.ts`: export `variant`, download kind and label.
- `src/lib/projects.ts`: delete covers and cancel unsent posts.
- API routes (new): `api/publishing/eligibility/route.ts`, `api/publish-posts/route.ts`, `api/publish-posts/approve/route.ts`, `api/publish-posts/[id]/route.ts`, `api/publish-posts/[id]/cancel/route.ts`, `api/publish-targets/[id]/{media,confirm-posted,undo-confirm,retry,resolve}/route.ts`, `api/social-accounts/[id]/route.ts`, `api/social-accounts/[id]/verification/route.ts`, `api/integrations/instagram/{connect,callback,account}/route.ts`, `api/integrations/meta/route.ts`, `api/integrations/zernio/route.ts`, `api/integrations/zernio/account/route.ts`, `api/integrations/[provider]/check/route.ts`, `api/webhooks/zernio/route.ts`.
- Pages:
  - `app/(app)/publishing/page.tsx` (rewrite)
  - `app/(app)/publishing/new/page.tsx`, `app/(app)/publishing/[postId]/page.tsx` (new)
  - `app/(app)/library/page.tsx` (badges, select mode, Publish)
  - `app/(app)/settings/_components/integrations-tab.tsx` (Instagram and TikTok cards)
  - `components/publishing/publishing-settings-card.tsx` (caption ending, on the Publishing page; not in
    `business-tab.tsx`)
  - `app/privacy/page.tsx`, `app/terms/page.tsx` and `app/data-deletion/page.tsx` and the public-route list: built
    by WP0, not here.
- Components:
  - `components/publishing/*` (§9.2), new.
  - `components/studio/extensions/publishing.tsx` (the edit-card extension slot WP0 adds to `edit-grid.tsx`):
    **Publish…** button and badges, with badge data from this module's own API rather than the Studio status DTO.
  - `components/ui/status-pill.tsx`: labels and tones.
- Tests:
  - `src/lib/integrations.test.ts`: new cases.
  - `src/lib/publishing.test.ts` (new).

**Docs**
- `docs/api.md`: the publishing and integration routes.
- `docs/architecture.md`: a publishing data-flow paragraph.
- `docs/security.md`: OAuth, webhook and token storage are now built.
- `docs/deployment.md`: egress hosts and the new environment variables.
- `docs/HANDOVER.md`: the smoke-test record.

---

## 14. Open questions

1. **Zernio specifics** (⚠ in §7.2): API base host, presign path, account-list and post-read endpoints, `content` / `accountId` field names, webhook signature scheme and event id field, idempotency support, and draft status naming. Allow `docs.zernio.com` in network settings and confirm them before building the adapter. The adapter stays disabled until then.
2. **Meta Graph version.** v26.0 or v27.0, and whether the `/{ig-id}/media` listing (used only for crash recovery) and `appsecret_proof` behave as expected under a Unified Login system-user token. Confirm during the first verification post.
3. **Resumable upload size limit (100 MB vs 300 MB).** Default to 100 MB and route larger files to manual posting. Should the export preset instead aim for a smaller file when a post is meant for direct Instagram publishing? The suggestion is no, unless real exports exceed 100 MB.
4. **Manual-post reminders.** Should due manual posts also trigger a reminder email to the owner, through the email design's transactional stream? The design shows them in-app only.
5. **TikTok AI-generated content disclosure.** These edits are cuts of real footage with text overlays, so the design sets no AI-generated flag. The owner or a later policy check should confirm this is right for TikTok's AIGC label.
6. **Per-platform captions.** The design keeps one caption per video for both platforms, because the brief asks to "adjust captions" without asking for platform-specific ones. Add a per-target override only if the owner asks.
7. **Ownership of the shared pieces.** Resolved in `docs/design/stage-bc-plan.md`: `music.ts`, `musicClearanceFor` and
   the `no_music` variant → WP1; `webhook.process` dispatcher, HTTP/audit/credential helpers, OAuth state cookie,
   Melbourne time helpers, integration status fields and the public legal pages (`/privacy`, `/terms`,
   `/data-deletion`) → WP0; Instagram publishing → WP4; Zernio → WP10.
