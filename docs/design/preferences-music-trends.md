# Design: saved preferences, music controls and trends (Stage B)

Status: design only, written 2026-11-14. Nothing here is built yet. It builds on the Stage A code on
`claude/blissful-lamport-f1lndn` and on two hardening branches that are not merged yet:

- `worktree-wf_56f21c16-d62-1`: the new safe-zone model (`SafeZone.strict` / `.head` / `.forbidden` / `.subtitle`)
  and `packages/media/src/render/verify.ts`.
- `worktree-wf_56f21c16-d62-2`: `GenerationSettings.musicStartSec`, `PlannerInput.musicStartSec`, `snapMusicStart`
  and `beatGrid(…, fixedStartSec)` in `packages/ai/src/rules/music.ts`, and Settings-side library music uploads.

This design assumes both are merged first. References such as "memo §2" mean
`docs/research/platform-constraints.md`, which supersedes `docs/research/decisions-summary.md`.

> **Lead-architect reconciliation (2026-11-14, `docs/design/stage-bc-plan.md`).** Changed in this file:
> (1) "Make a music-free version" in the export dialog and card menu is the publishing design's `no_music` **export
> variant of the same version** (no new version); WP1 builds that variant. Choosing "No music" in the Sound panel
> is still a revision that creates a new version; (2) `render.export` checks clearance only for the `standard`
> variant; (3) the hashtag watch reads the Meta credential from `integration_connections` (provider `meta`), where
> the publishing design stores it, not from `social_accounts`, and reuses the publishing module's Graph client and
> `mapGraphError`; (4) integration statuses use the shared WP0 contract (`state` incl. `not_connected` and
> `unavailable`; field `liveMode`, not `mode`); (5) `termsUrl`/`privacyUrl` default to the app's own public
> `/terms` and `/privacy` pages, built by WP0 (answers open question 7); (6) `plan-facts.ts` and the
> `recordFeedback` helper are built by WP0 so the publishing module can write `publish` events; this module adds
> the recompute trigger; (7) the work is split into WP1 (music), WP2 (preferences, reference video, brand),
> WP3 (trends without Instagram) and WP5 (Instagram hashtag watch).

---

## 1. Goal and scope

Turn the owner's everyday choices into better defaults, without training a model, and show every learned value
plainly with a way to undo it. Give the owner full control of music (licence, track choice, song section, beat
alignment, volume, original sound, fades), keep Spotify strictly as a private reference, and keep trend information
honest: sourced, dated, and never called "trending" without evidence.

| Brief requirement (docs/spec.md) | Design element |
| --- | --- |
| §2 "Learn preferences by saving selections and feedback; model training is not required" | §4.1, §6.1: deterministic `computeLearnedPreferences` over `feedback_events`; `preferences.recompute` job |
| §1 favourite, download, regenerate, revise each edit | Each action writes a `feedback_events` row with a plan-facts snapshot (§5.3) |
| Dismissals (task brief) | "Hide this edit" on a preview card; `edits.dismissed_at`; feedback type `dismiss` (§4.1) |
| Publishes (task brief) | Publishing module writes a `publish` feedback event when a target is confirmed published (§12 contract) |
| Learned defaults: duration, style order, pacing, text density, transitions, colour, music volume | §6.1 field rules; resolved by `effectivePreferences` and used by the Studio form and the planners |
| "shown transparently in Settings with a reset" | Settings → Editing preferences: per-field source chip, evidence sentence, pin/unpin, "Reset what it learned" (§9.1) |
| §2 optional reference-video upload | Kind `reference_video` in a project; ingest branch + `reference.analyse` job; suggestions the owner accepts per field; originals deleted after measuring (§4.3, §6.2) |
| "never copy its content" | Reference assets are structurally excluded from footage, plans and renders (§10) |
| Owner request 15 Nov 2026: "base the edits off my TikTok … the animations, transitions, and music" | No TikTok access (memo §11); the owner uploads their own posted videos as references. Reference style v2 measures transitions, beat sync, drop-timed reveals, zooms and music tempo/energy, and offers them as suggestions in the renderer's existing vocabulary; the reference sound is measured only, never used or kept (§4.3.1) |
| §2 saved brand preferences: fonts, colours, logo, text style, pacing | Audit of the renderer (§4.5); gaps: logo end card / corner mark inside the safe zone, brand snapshot per version, font list limited to bundled fonts |
| §3 uploaded audio with permission + licence tracking | Licence passport form and server rules (§4.6), usage ledger `music_usage` (§5.2) |
| §3 commercially licensed catalogue | Owner downloads from a business-eligible subscription and uploads (memo §2); `MusicCatalogueProvider` interface only, disabled (§6.4) |
| §3 genre, mood or artist-name preference guiding selection | `preferences.musicGenres/musicMoods/musicArtists` + `music_tracks.genres`; `rankTracksForPreferences` "Suggested for you" (§4.7) |
| §3 optional Spotify only where permitted | Link-only by default; official embed only on authenticated internal pages once legal pages exist; never audio, never AI, never public (§4.8) |
| §3 song segment, beats, align cuts and the reveal, volume, original sound, fades | Studio form (start point from branch -2) + revise "Sound" panel with an audio-only fast path and a re-cut path (§4.9) |
| §3 cross-post only when audio suits both destinations; otherwise silent export / draft handoff | `musicClearanceFor` gate on export; "Make a music-free version"; ledger snapshot; Meta Sound Collection `meta_only` lock (§4.6, §4.10) |
| §2 trend collection with source and last-updated date | Curated references (exists) re-sourced to the memo's URLs, "last reviewed" date and review badge (§4.11) |
| §2 "Use permitted current data where available" | Live signals: Instagram hashtag watch and YouTube AU popular chart, disabled until configured, capability-checked (§4.12) |
| §2 "Never … claim a song is trending without evidence, or promise viral results" | Fixed labels via `trendLabel`; validator rejects "trending"/"viral" in on-screen text; TikTok = "Note a trend" only (§4.13) |
| §6 Video Studio stays primary, plain language, honest states | No new navigation item; everything sits in Settings tabs and the existing Studio cards (§9) |

Out of scope: any external music catalogue API (memo §2: "no library API is built in Phase 1"), Spotify Web API
(memo §1), the Instagram Audio API (memo §11 says "behind a flag"; left as an open question), TikTok trend data of
any kind (memo §11), feeding trends into the AI planner, AI-generated music.

---

## 2. What the research allows

| Topic | What we may do | Memo reference (quoted) |
| --- | --- | --- |
| Spotify | Store the pasted URL/URI plus the owner's notes; show the official embed unmodified on authenticated internal pages, with a link-only fallback | §1 Decision: "Spotify serves only as the owner's private music reference … the official embed is shown unmodified on authenticated internal pages, with a link-only fallback. Do not build any Spotify Web API integration" |
| Spotify — prohibitions | No audio in renders/exports, no Spotify data to AI, no implication about in-shop playback, no caching of oEmbed data, no autoplay, attribution + link back, never on public/client-facing surfaces, terms + privacy pages before any embed | §1 Build notes: "Do not cache or persist oEmbed data, do not autoplay, and show Spotify attribution with a link back." "Never show embeds on public, client-facing or promotional surfaces, including the website module, emails and social posts." "A one-switch fallback to link-only mode (URL and notes, no iframe) must exist." "Studio Assistant's end-user terms and privacy policy pages must exist before any embed renders." |
| Spotify — UI copy | Fixed sentence | §1: "Spotify links are kept for your own music reference only. They are not licensed for playing in the shop or in your videos." |
| Licensed music | Owner-uploaded tracks, each with a licence passport; export blocked for destinations the licence does not cover | §2 Decision: "The source of truth is tracks the owner uploads, each with a per-track licence record (the "licence passport"). The renderer blocks export to any platform the licence does not cover." |
| Music schema changes | Add `meta_sound_collection`, `facebook`, `destinationLock`; reject CC BY-NC; CC BY attribution into captions; usage ledger; music-free export | §2 Build notes (quoted in §4.6 below) |
| Business tiers | Personal / Social / Creator tiers do not qualify | §2 Account requirements: "Personal, Social and Creator tiers do not qualify." |
| Chart music | Never baked into exports | §2 Decision: "Chart or trending music is never baked into exports." |
| TikTok sounds | Added by the owner in the TikTok app only | §2: "TikTok Commercial Sounds are added only inside the TikTok app." §3: "The API cannot attach TikTok-library sounds to a video." |
| Instagram music | The app never claims it can add library or trending music | §4 Decision: "The app never claims it can add Instagram library or trending music." |
| Meta Sound Collection | May be rendered into an MP4 only when that render is locked to Meta destinations; copyright check before publishing | §2 Decision; Follow-up 5: "`meta_only` renders are allowed. Poll `copyright_check_status` before publishing and do not publish if a match is found." |
| Safe zone | Logo and text stay in `R_strict` / `R_head`; nothing in the forbidden bands | §5 Build notes: "Areas where text, logos, CTAs and subtitles must never go: top band: y < 270; bottom band: y ≥ 1248; sides: x < 120 and x > 960; right-hand action column: x > 780 where y ≥ 840." "`R_head`, for boxes whose bottom edge is at y ≤ 840: x 120–960, y 270–840." |
| Vision for reference text density | Haiku 5.5, base64 JPEG ≤ 768 px, structured output, `oversized_image: "error"`, never identify people | §10 Decision and Build notes ("The prompt never asks Claude to identify people.") |
| Trends — structure | Two sections that never mix: "Live signals" (official APIs, source, fetch time in Melbourne time, staleness limit) and "Curated references" (static, dated, sourced) | §11 Decision |
| Trends — Instagram | `ig_hashtag_search` then `top_media`, at most 30 hashtags per rolling 7 days per account, labelled "Top posts under #tag — Instagram, fetched <date>" | §11 Build notes 1; source quote "you can query a maximum of 30 unique hashtags within a 7 day period" |
| Trends — YouTube | `videos.list chart=mostPopular regionCode=AU`, labelled "YouTube AU popular chart (music/movies/gaming)"; 1 unit per call, 10,000/day default | §11 Build notes 3 and sources |
| Trends — Google | Deep link to trends.google.com only | §11 Build notes 4 |
| Trends — TikTok | No live data; button to Creative Center in the owner's own login; "Note a trend" entries labelled "Noted by staff" | §11: "TikTok contributes no live data at all: it has no permitted API for trends, and its terms forbid scraping." |
| Curated formats | Static, dated, never worded "trending now"; unsourced ones tagged | §11: "'Speed-ramp montage', 'POV' and 'client story' had no source and may only be tagged 'editor suggestion — no external source'." |
| Higgsfield tool | Not an official feed | §11 Open questions: "Do not treat it as one." |

**Unverified items and how the design handles them**

| Unverified (memo) | Handling |
| --- | --- |
| Whether `ig_hashtag_search` is available to a Unified Login system-user configuration under Standard Access (§11 Open questions) | Hashtag watch starts in "Not checked" state; the first refresh of the first hashtag is the capability check; failure sets `social_accounts.capabilities.hashtagSearch=false` and shows "Not available for your Meta app setup" (§4.12). No assumption that it works. |
| Whether a hashtag's `top_media` call also counts towards the 30-per-7-days limit | Counted conservatively: every distinct hashtag touched by either call counts for 7 days (§6.3). |
| Exact hashtag permission name under Unified Login (§4 notes the dashboard is authoritative) | Setup checklist tells the owner to add "the hashtag search permission the App Dashboard lists" and reconnect; the app reads granted scopes from `debug_token` (publishing design) and shows what is missing. |
| YouTube caching/display rules not retrieved (§11 Open questions) | Store only id, title, channel title, category id and fetch time; refresh daily; delete live items after 7 days; show title + link only. Re-check before go-live. |
| Spotify Widget Terms do not define "commercial purposes" (§1 Open questions) | Link-only is the default; the embed needs an explicit owner switch plus terms/privacy URLs and an acknowledgement. |
| Prices and plan names of music libraries (§2) | The passport stores what the owner types; the app shows no prices and only warns on tier names known not to qualify. |
| Meta Sound Collection Rights Manager matching (§2 Open questions) | `meta_only` renders are labelled; the Instagram copyright check is the publishing module's job (§12). |

---

## 3. Concepts and terms

- **Declared value**: what is stored in `settings.preferences.<field>` (default, or set by the owner).
- **Learned value**: computed from feedback by `preferences.recompute`, stored in `settings.preferences.learned`.
- **Pinned field**: the owner set it (or accepted a reference suggestion). Learning never overrides a pinned field;
  it only shows "The editor would suggest …".
- **Effective value**: pinned → declared; else learned (if learning is on and a learned value exists); else declared.
  Computed by `effectivePreferences(prefs)` in `packages/core`. Everything that reads preferences (Studio form
  defaults, `buildPlannerInput`, rules planner, AI prompt) uses the effective values.
- **Plan facts**: a compact, numeric summary of an `EditPlan` (§5.3), snapshotted into each feedback event so that
  learning does not depend on rows that may later be deleted.
- **Licence passport**: the `MusicLicence` JSON on a track, filled in through a guided form and confirmed by the owner.
- **Music clearance**: the result of checking a version's music against its licence at export/publish time.
- **Live signal / noted trend / curated reference**: the three trend groups, never mixed in one list.

---

## 4. User flows

### 4.1 Feedback is recorded (no new steps for the owner)

| Owner action (existing UI unless noted) | Feedback event (`feedback_events.type`) | `data` snapshot |
| --- | --- | --- |
| Favourite / unfavourite on a preview card | `favourite` / `unfavourite` (exists) | `{ planFacts }` of the current version |
| Download full quality (`GET /api/edit-versions/[id]/download`) | `download` (exists) | `{ planFacts }` — counted once per version during learning |
| Revise with an instruction | `revise` (exists) | `{ instruction, hints: RevisionHints, parentPlanFacts }` |
| Regenerate | `regenerate` (exists) | `{ parentVersionId, parentPlanFacts }` |
| Sound panel change (§4.9) | `revise` | `{ audioPatch, parentPlanFacts }` |
| **New:** "Hide this edit" on a preview card (menu → Hide) / "Show again" | `dismiss` | `{ value: true \| false, planFacts }` |
| Publishing confirmed (publishing module) | `publish` | `{ planFacts, platform }` |

After each insert the web app enqueues `preferences.recompute` (debounced, §7). Nothing visible changes on the
card except the "Hidden" state. Hidden edits collapse into a "2 hidden edits · Show" row under the five cards;
nothing is deleted.

### 4.2 Owner reviews what was learned (Settings → Editing preferences)

1. Owner opens Settings → **Editing preferences**. At the top: a switch **"Learn from my choices"** (on by
   default) and the line "Learned from 14 choices since 3 Oct 2026. Updated 2 minutes ago."
2. A table with one row per learnable field: *Default length, Style order, Pacing, On-screen text, Transitions,
   Colour, Music volume*. Each row shows:
   - the value in use ("20 seconds");
   - a source chip: **Learned** (accent outline), **Set by you**, **From reference video**, or **Default**;
   - an evidence sentence for learned values, e.g. "You kept edits around 20 s: 4 favourites and 2 downloads,
     plus 'make this 20 seconds' once." For pinned fields with a different learned suggestion: "The editor would
     suggest 25 seconds from your recent choices. Use it" (button).
   - actions: **Change** (opens the existing control; saving pins the field) and, on pinned fields,
     **Let it learn** (unpins).
3. Rows with too little evidence say "Not enough choices yet — using your setting" (no fake confidence).
4. **"See recent choices"** expands the last 20 feedback events in plain words: "Favourited *Cinematic reveal*
   (Jordan, fade) · 12 Nov, 3:14 pm". Times are in Australia/Melbourne.
5. **"Reset what it learned"** → dialog: "The editor forgets what it learned from your favourites, downloads,
   revisions and hidden edits before now. Your own settings stay as they are. This cannot be undone." →
   **Reset**. Afterwards every row shows Set by you / Default, and learning starts again from new choices.
6. Switching learning off keeps the learned values visible but greyed: "Not used while learning is off."

States: loading skeleton; empty (no feedback yet: "Favourite, download or revise a few edits and the editor will
start adapting. Nothing has been learned yet."); recompute failed (`learned.error` set → amber alert "Could not
update what was learned. Your settings still work." with **Try again**, which enqueues a recompute); staff users see
the page read-only (owner-only settings, docs/security.md).

### 4.3 Reference video (optional)

1. In a Studio project, under the upload zone: link **"Add a reference video (style only)"**. Dialog copy:
   "Upload a video whose pace and look you like. Studio Assistant measures only its shot lengths, length, colour and
   how much text is on screen. Nothing from it is used in your edits, and the file is deleted once it has been
   measured. Only upload videos you are allowed to view and keep."
   Checkbox (shown only when AI is configured): "Also estimate how much on-screen text it has (sends up to 8 still
   frames to Anthropic)". Default unticked.
2. Upload uses the existing multipart flow with `kind: 'reference_video'`. A **Reference** card appears in a separate
   "Reference videos" strip under the clip list (never among clips), with the normal processing states:
   Uploading x% → Processing → Measuring style → Ready / Failed (Retry) / Cancelled.
3. When ready, the card shows measurements in plain words: "34 s long · 21 shots · shots mostly 1.2–1.8 s
   (median 1.4 s) · bright, clean colour · light on-screen text (6 of 8 frames)" or "on-screen text: not measured".
4. **Suggested preferences** with per-row **Use this** / **No thanks**, and **Use all suggestions**:
   - "Default length: 35 seconds (was 25)"
   - "Pacing: Balanced (no change)" (rows equal to the current effective value are shown as "matches your settings"
     with no button)
   - "Colour: Clean"
   - "On-screen text: Light"
5. Accepting pins the field with source "From reference video '<file name>'" and writes an audit entry. The same
   list appears in Settings → Editing preferences → **Reference videos** (all projects), with **Open project**.
6. Deleting the reference card (existing asset delete) removes the profile; accepted preferences stay pinned.

Failure states: "This file has no video" / "The video is shorter than 3 seconds, too short to measure" /
"Measuring failed. Try again." / "Text estimate not available (AI not set up)".

### 4.3.1 Reference style v2: transitions, beat sync and music

Status: written 2026-11-15 and built the same day on branch `worktree-wf_d3892033-bcb-1` (code paths in §15; tests
in `docs/testing.md`). §4.3 (v1: length, pacing, colour, on-screen text) is built; this section extends it.
Implementation notes where the build refined a number here: the automatic reveal accepts 45–90 % of the edit (the
styles hold the finished look for the last 15–30 %, so 80 % excluded most edits; the beat montage keeps 95 %), and the
music start moves by whole bars so beat-counted accents keep their beats; the drop time starts from the middle of the
first louder 0.25 s energy window (the window start biased it a beat early on the synthetic R5 track) and a single
knock is rejected by also requiring the median power of the next second to rise ≥ 3 dB; the "Go back to each style's
own" button calls `POST /api/references/summary/reset`; per-video agreement for length uses ±max(5 s, 20 %).

**Why.** On 15 Nov 2026 the owner asked for the edits to be based on their TikTok account: "the animations,
transitions, and music". The app cannot do that by reading TikTok: there is no permitted TikTok API for this, its
terms forbid scraping (memo §11, which is why §1 already rules out TikTok data of any kind), and the build
environment cannot open TikTok at all. Instead the owner uploads a few of their **own posted videos**, saved to their
phone, as reference videos (the §4.3 flow). v2 measures what makes that editing recognisable and turns it into
suggestions the owner accepts, using only what the renderer can already do.

**Fixed rules for v2** (each is tested, §4.3.1.10):

1. **Renderer vocabulary only.** Every suggestion is expressed in what exists today: `TRANSITION_TYPES`
   (`packages/core/src/styles.ts`), segment `zoom` `from`/`to` (1–1.5), per-segment `speed`, hard cuts
   (`transitionIn: null`) and the beat grid (`beatGrid`, `snapCutsToBeats`, `landRevealOnBeat` in
   `packages/ai/src/rules/music.ts`). No new render effects in this round (§4.3.1.11 lists them for later).
2. **Estimates, offered as suggestions.** Every measured value is labelled an estimate from the owner's videos and
   only changes a setting when the owner presses **Use this** (the accept/dismiss pattern of §4.3). Nothing
   silently changes their settings. No wording ever says "exact", "precise" or "detected perfectly".
3. **The reference soundtrack is measured, never used.** It is decoded in the worker only to measure tempo, how cuts
   line up with the beat and the energy shape. It is never used in an export, never sent to an AI model, never
   kept as audio, PCM, a beat list, an energy curve or a fingerprint, and no attempt is made to recognise the song.
   The original, proxy and frames are still deleted after measuring (§4.3 step 1, §6.2, §7). Only the numbers in the
   v2 schema (§4.3.1.5) remain. Those numbers rank the owner's **own licensed tracks** (§4.3.1.7); nothing is
   ever fetched.
4. **Captions are not transcribed.** Reference ingest keeps skipping transcription (§7 `ingest.asset`); v2 adds
   none. The optional on-screen text estimate stays as in §8.3: frames only, with the owner's tick, and the text is
   never read out.
5. **Plans still pass `validateEditPlan`.** No new validator errors are added and no rule is relaxed. Plans built
   with accepted suggestions go through the same repair loop and checks.
6. **No synthetic footage presented as the owner's.** Test fixtures are generated at test time, labelled
   `SYNTHETIC TEST CLIP` in the picture, named `synthetic-*.mp4`, and never seeded into a development or preview
   database (§4.3.1.10).

#### 4.3.1.1 Owner flow

1. Upload dialog (§4.3 step 1), new copy:
   "**Add a reference video (style only).** Studio Assistant can't open TikTok pages. Save a few of your own posted
   videos to your phone and upload them here, one at a time. It estimates the pace, colour, transitions, zooms, how
   your cuts line up with the beat, and the tempo and energy of the music. Nothing from these videos is used in your
   edits — not the footage and not the sound — and each file is deleted once it has been measured. Only upload
   videos you made or are allowed to use."
   Tip under the drop zone: "Best: the video as you exported it before posting. A video saved from the TikTok app may
   carry a watermark and an end screen; a dark end screen in the last few seconds is skipped."
   The text-estimate checkbox is unchanged (default unticked).
2. Processing states as §4.3, with two new progress messages: "Measuring transitions" and "Measuring the beat".
3. The Reference card (Studio `ReferenceStrip`) adds a v2 line, e.g. "28 s · 24 shots (median 0.9 s) · mostly
   straight cuts with 6 white flashes · cuts on the beat (19 of 23, about 124 BPM) · punch-in zooms in 3 shots ·
   punchy colour (estimates)". v1 suggestion rows stay as they are. A link **See your style from all your videos**
   opens Settings → Editing preferences → **Your style from your videos** (§4.3.1.9), where the v2 suggestions are
   offered, combined across every measured video.
4. A reference measured before v2 shows "Measured before transitions and beat were added. Upload it again to
   include it." Its originals are already deleted, so it cannot be re-measured; its v1 numbers still count for the
   v1 rows of the summary.

#### 4.3.1.2 Measurement pipeline (`reference.analyse`, worker, on the proxy)

All passes read the reference's proxy (`makeProxy`: upright, SDR, ≤ 960 px tall, ≤ 60 fps, AAC 96 kbps) in the job
temp dir, before the originals are deleted. FFmpeg 6.1 filters used — each confirmed present with
`ffmpeg -hide_banner -filters` on FFmpeg 6.1.1 (Ubuntu 24.04), 2026-11-15: `select` (scene score), `signalstats`,
`blurdetect`, `metadata`, `scale`, `fps`, `format`; plus `scdet`, `ssim`, `tpad`, `mestimate`, `ebur128` and
`xfade`, which were checked and are either not needed or used only in tests (reasons in the signal sections below).

- **Measured span**: the first `min(duration, 120 s)` (own posts are mostly under a minute; this bounds memory),
  minus a trimmed end screen (below). The span is stored as `measuredSec`.
- **Pass A — per-frame scores (one FFmpeg run, native proxy frame rate):**

  ```
  ffmpeg -i proxy.mp4 -map 0:v:0 -an -t <span> \
    -vf "scale=144:256:flags=area,format=yuv420p,select='gte(scene\,0)',signalstats,blurdetect=block_width=16:block_height=16:planes=1,metadata=mode=print:file=-" \
    -f null -
  ```

  (`scale=256:144` for landscape proxies.) Parsed per frame, with the same `metadata=mode=print` parser style as
  `parseSignalStats` in `look.ts`: `pts_time`, `lavfi.scene_score` (0–1), `lavfi.signalstats.YAVG`, `YMIN`,
  `YMAX`, `YDIF` (mean absolute luma change from the previous frame) and `lavfi.blur` (`nan` on flat frames is
  read as null). `select='gte(scene,0)'` passes every frame and only attaches the score, the same score
  `detectScenes` uses. `scdet` gives the same signal on a 0–100 scale (≈ 39 × the `select` score in the prototype)
  and is not needed.
- **Pass B — tiny grey frames for the shape tests (one FFmpeg run):**

  ```
  ffmpeg -i proxy.mp4 -map 0:v:0 -an -t <span> -vf "fps=30,scale=72:128:flags=area,format=gray" -f rawvideo pipe:1
  ```

  9,216 bytes per frame, ≤ 3,600 frames (≤ 34 MB) for 120 s, held in memory and dropped when the job ends. Pure
  functions over these frames do what FFmpeg filters cannot report as numbers: lagged comparisons (normalised cross-
  correlation, NCC, between frames before and after an event), the cross-fade linearity test, the moving-band test
  for slides and wipes, and the scale fit for zooms. A lag-K SSIM can be built in FFmpeg
  (`split[a][b];[b]tpad=start=K:start_mode=clone[d];[a][d]ssim=stats_file=-`) and was used to check the shapes in
  the prototype, but one raw pass serves every test and keeps the logic unit-testable. `mestimate` exists, but
  FFmpeg 6.1 exposes its motion vectors only as frame side data, which no text filter prints (`showinfo` prints
  the side-data size only: "Motion vectors: (11520 bytes)" in the prototype), so it is not used.
- **Pass C — audio, only when the proxy has an audio stream:** `decodePcm(proxy, { sampleRate: 22050, channels: 1 })`
  (existing) → `detectBeats` (existing: tempo, beat times, confidence, 0.25 s RMS energy). The same code measures
  the owner's tracks (`analyseMusic`), so reference and track numbers are comparable. The audio/video offset is
  `start_time(audio) − start_time(video)` from `ffprobe -show_entries stream=codec_type,start_time` and is added to
  every beat time before comparing with cut times. The PCM buffer lives only in memory. `analyseAudio`'s
  `speechLikely` (already computed for references at ingest) is read to recognise mostly-talking videos.
- **End-screen trim**: if the part after the last detected boundary lasts 1.5–5 s and its mean YAVG ≤ 40 (on the
  0–255 scale), it is excluded from every measurement and stored as `endScreenTrimmedSec`.

Code: FFmpeg runs and frame maths in `packages/media/src/analysis/reference-style.ts`
(`measureReferenceStyle(proxyPath, { probe, speechLikely, ffmpegPath, ffprobePath, signal })`, honouring the
`AbortSignal` between passes and inside the frame loops); classification of the results into suggestions in
`packages/core/src/reference-style.ts` (pure, no FFmpeg).

#### 4.3.1.3 Signals: how each is measured, when it is reportable, what it maps to

Every threshold below is a starting value from the synthetic prototype (§4.3.1.12), to be tuned once the owner's
real videos have been seen (§13.4). Frame counts assume 30 fps and scale with the proxy frame rate.

| Signal | Measured with | Reportable when | Maps to |
| --- | --- | --- | --- |
| Joins between shots (hard / cross-fade / flash / motion) | Pass A scene score, YAVG, YDIF, blur; Pass B NCC, linearity, band and scale tests (§4.3.1.3a) | ≥ 5 classified joins in the video and "unclear" ≤ 30 % of joins | `editingStyle.transitionPalette` in `TRANSITION_TYPES` (§4.3.1.5) |
| Beat sync | Cut times (Pass A) against the reference's own beat grid (Pass C), ±1 frame and ±80 ms (§4.3.1.3b) | tempo confidence ≥ 0.35, ≥ 8 cuts, aligned share ≥ 60 % **and** above chance (binomial p < 0.01) | `editingStyle.beatSync = 'on'` and `beatsPerCut` 1, 2, 4 or 8 |
| Drop-timed reveal | Largest 1-s energy rise ≥ 6 dB on the reference's RMS energy; cut, flash or punch-in within ±150 ms (§4.3.1.3c) | drop found **and** beat grid measured | `editingStyle.reveal = 'strongest_beat'` |
| Zooms in shots | Pass B scale fit at 15 % and 85 % of each shot, plus jumps at cuts (§4.3.1.3d) | ≥ 6 shots of ≥ 0.6 s checked | `editingStyle.zoom` (`none` / `push_in` / `punch_in` with a scale) |
| Music tempo and energy shape | Pass C tempo, 1-s smoothed RMS energy → 8-point shape, dynamic range, clear drop (§4.3.1.3e) | tempo confidence ≥ 0.35 | `editingStyle.musicFit`, used only by `rankTracksForPreferences` |
| Pace (v1 field, corrected) | Shot lengths between v2 boundaries, no merging or splitting | ≥ 3 shots | `pacing` (v1 rule, §6.2) |

##### 4.3.1.3a Transitions

Detected in this order on the measured span; each frame belongs to at most one event.

1. **Flashes and dips (white/black).** Baseline `Yb` = median YAVG of the 0.5 s before the event. A white event is a
   run of frames with YAVG ≥ max(200, Yb + 60); a black event a run with YAVG ≤ 30 and `Yb − YAVG ≥ 0.5 × Yb`.
   The event spans from the first frame where |YAVG − Yb| ≥ 15 to the frame where YAVG settles within 15 of the
   next shot's level (capped at 1.5 s); its time is the frame of peak (white) or trough (black) luma. Brightness
   alone is not enough: the extreme frame must be nearly uniform (10th–90th percentile spread of the Pass B grey frame
   ≤ 24 levels, so a caption does not matter), or the brightness must ramp over ≥ 2 frames each way; the ramp frames
   must be blends towards the extreme, and the picture must not be zooming into it (FFmpeg's `zoomin` passes through
   a single-colour frame). Otherwise the frames go to the cut test: a short bright or dark *shot* between two hard
   cuts is two cuts, not a flash. A uniform run at the extreme for more than 0.6 s is a black/white screen; only a
   screen at the very start or after the last join is a title or end screen and left out of the shots — the cut (or
   fade) into a screen inside the video counts as a join. A long bright or dark run with picture detail is just a
   shot. Uniformity is judged frame by frame, not on the brightest or darkest frame alone: inside a long run, a screen
   is uniform frames for more than 0.6 s that start within 0.5 s of the run (a cut or ramp into it) or right after a
   cut (scene score ≥ 0.18 within a frame); the detailed frames before it go to the cut test, so a bright shot followed
   by a white end card keeps its cut, and a light shot that drifts towards a uniform frame stays a shot. Kind:
   `fade_white` / `fade_black`. If NCC(frame before, frame after) ≥ 0.6, the flash happened inside one shot
   (`inShot`); it maps the same way, because the renderer can only place it at a join.
   *Prototype*: an `xfade=fadewhite` of 0.2 s read YAVG 125 → 244 then back over 5 frames; `fadeblack` 0.3 s read
   125 → 5. FFmpeg's `fadewhite`/`fadeblack` reach their extreme about 20 % into the transition (measured at 0.2,
   0.5 and 1.0 s durations), which the planner uses to put an accent's peak on the beat (§4.3.1.6).
2. **Hard cuts.** Frame `t` is a cut when its scene score ≥ max(0.18, 8 × the median score over ±1 s), it is the
   largest score within ±2 frames, both neighbours score ≤ 0.5 × it, it is not inside a flash event, and
   NCC(frame t−2, frame t+2) < 0.5 (rules out fast motion and camera flashes), unless the frames either side look
   clearly less alike than the frames within each side (by 0.25: two different shots that look alike). The frames 1/30 s
   either side are also tested for a shift along each axis: when a shift halves their difference *and* the shifted
   frames look alike (NCC of the overlap ≥ 0.5 and at most 0.1 below the NCC within each side), the spike is a slide or
   camera move, not a cut. The likeness check matters: a detailed shot cut against a smooth one (a gradient, a plain
   wall) can halve the difference just by cropping, with the shifted frames as unlike as before. *Prototype*: real
   cuts scored 0.26–0.91; one scored 0.264, below `detectScenes`' default 0.3, which is why v2 does not reuse that
   threshold.
   A busy single shot (Game-of-Life pattern) reached 0.27 on the frame after a cut, rejected by the ±2-frame
   local-maximum rule. A spike inside a short burst of change (busy on both sides, or a spike below 0.35 followed by
   a burst) belongs to a gradual join and is left for step 4 (FFmpeg's `zoomin` and blur transitions both have one).
3. **Punch-in jumps.** A cut where the scale fit (§4.3.1.3d step 2) between the frame before and the frame
   after finds `s` in 1.08–1.6 with residual ≤ 0.4 × the unscaled residual is reclassified `punch_in`: the same
   shot, cropped in. It still counts as a cut for pace and beat sync, but not as a transition; it feeds the zoom
   signal.
4. **Gradual joins.** Candidate windows are runs of 0.13–1.5 s (the `TransitionSchema` range; limits in seconds so
   they hold at any proxy frame rate up to 60 fps) of frames not taken by steps 1–3 where the Pass B grey picture
   changes per 1/30 s by ≥ 1.6 × its median over ±1.5 s (a fixed step: YDIF between 60 fps frames halves while sensor
   noise does not, so a 1 s cross-fade vanished at 60 fps), more than 0.1 s from a cut or flash, and the frames just
   outside the window differ (NCC < 0.6). Each window is then tested in turn:
   - **Cross-fade** (`cross_fade`): every inner frame fits `F ≈ (1 − α)·F_start + α·F_end` with residual ≤
     0.35 × the mean |F_end − F_start|, α rises with time (Spearman ≥ 0.8), the whole frame changes at once (α
     estimated per column and per row spreads ≤ 0.35 between the 10th and 90th percentile; a soft-edged wipe such
     as `smoothleft` fits a blend on average but measured a spread of about 0.8), and the frames are not blurrier
     than the shots around them (median `lavfi.blur` < 1.5 × the neighbours: a blur transition is never a
     cross-fade). *Prototype*: a 0.5 s join kept
     scene scores ≤ 0.03 while YDIF sat at 1.9 × baseline and YAVG ramped linearly between the two shots' levels.
   - **Slide/wipe**: per-frame change concentrates in a band (≥ 55 % of the |ΔF| in the top 30 % of rows or
     columns) whose centroid moves the same way for ≥ 3 frames. Rows → `slide_vertical` with direction up/down;
     columns → `wipe_horizontal` with direction left/right. *Prototype*: an `xfade=slideup` of 0.3 s kept scene
     scores ≤ 0.09 while YDIF ramped from 11 to 37.
   - **Zoom transition** (`zoom`): on frames that are not blurrier than the neighbours, the frame-to-frame scale fit
     counts only where it explains the change (residual ≤ 0.5 × the unscaled residual on a textured frame, as for
     zooms in shots); ≥ 3 such pairs at ≥ 1.03 (or ≤ 1/1.03) and at most one in four the other way.
   - **Whip-like** (`whip_like`): a moving band of columns through frames with median `lavfi.blur` ≥ 1.5 × the
     neighbouring shots; direction from the band.
   - Otherwise `unclear` (counted, never mapped).
   Known limits: FFmpeg's `zoomin` zooms the outgoing shot into its centre pixel, so out of a flat or noise-like
   shot (a smooth gradient, a cellular pattern) the zoom cannot be seen and the join reads as a cross-fade from a
   flat colour or as `unclear`; a blur of a smooth gradient is equally invisible. The edge fixtures use textured
   outgoing shots (§4.3.1.10).

**Mapping of measured kinds to the renderer's vocabulary:**

| Measured kind | `TRANSITION_TYPES` value | Note |
| --- | --- | --- |
| `hard` | none (`transitionIn: null`) | |
| `fade_white` | `fadewhite` | accent (§4.3.1.5) |
| `fade_black` | `fadeblack` | accent |
| `cross_fade` | `fade` | FFmpeg's `xfade=fade` is the linear cross-fade; `xfade=dissolve` is a dithered pixel dissolve (checked: black→white mid-frame YLOW 16 / YHIGH 235 for `dissolve` against 125/125 for `fade`). Both read as a cross-fade at phone size; `fade` is the faithful match. |
| `slide_vertical` up / down | `slideup` / `slidedown` | flashy |
| `wipe_horizontal` left / right | `wipeleft` / `wiperight` | flashy |
| `whip_like` left / right | `wipeleft` / `wiperight` | nearest available; a real whip blur is out of scope (§4.3.1.11) |
| `zoom` | `zoomin` | flashy |
| `punch_in` | not a transition | segment zoom (§4.3.1.3d) |
| `unclear` | — | not counted in shares |

`circleopen` is never suggested (nothing measures it).

**Palette** (`paletteFromCounts`, pure). Flashes are treated as accents on top of the ordinary joins, so they are
kept out of the base: classified = joins − unclear − punch-ins; `flash` = (white + black) ÷ classified; base =
classified − flashes; `hard`, `cross` (cross-fades) and `motion` (slides + wipes + zooms + whip-like) are shares of
the base.

| Family | Rule (first match wins) | `transitionPalette` |
| --- | --- | --- |
| Straight cuts only | hard ≥ 0.85 and flash < 0.08 | `{ hardCutShare: 1, types: [], durationSec: 0.3, accent: null }` |
| Straight cuts with flashes | hard ≥ 0.6 and flash ≥ 0.08 | `hardCutShare` = hard, rounded to 0.05; `types` = base kinds other than hard with share ≥ 0.1; `accent` = majority flash colour, `durationSec` = median flash length clamped 0.15–0.3, `everyBeats` = 4 or 8 when ≥ 60 % of flashes peak within ±80 ms of a beat and the median spacing of consecutive flashes rounds to 4 or 8 beats (needs ≥ 3 flashes and a measured beat), else null (accent only at the reveal) |
| Cross-fades | cross ≥ 0.3 | `types: ['fade', …]`, `durationSec` = median cross-fade length rounded to 0.05, clamped 0.3–1.0; `hardCutShare` = hard; accent as above when flash ≥ 0.08 |
| Movement | motion ≥ 0.25 | `types` = mapped motion kinds by count (≤ 3), `durationSec` = median clamped 0.2–0.6; `hardCutShare` = hard |
| Mixed | otherwise | `hardCutShare` = hard; `types` = the two most used mapped base kinds with share ≥ 0.1 |

Example: 20 joins measured as 15 hard, 4 white flashes peaking on every 4th beat and 1 unclear gives
"straight cuts with flashes": `{ hardCutShare: 1, types: [], durationSec: 0.3, accent: { type: 'fadewhite',
everyBeats: 4, durationSec: 0.2 } }`, worded "Straight cuts, with a quick white flash every 4 beats".

##### 4.3.1.3b Beat sync

- Needs Pass C with `bpm` not null, `confidence ≥ 0.35` (stricter than `detectBeats`' own 0.2), and not
  (`speechLikely` and confidence < 0.5). Otherwise `beat.status = 'not_measured'` with reason `no_audio`,
  `no_clear_beat` or `mostly_speech`; never reported as "not on the beat".
- Cuts = hard cuts + punch-in jumps + flash peaks (the moment the picture changes). Fewer than 8 → `too_few_cuts`.
- For each cut, the offset to the nearest beat (after the audio/video offset). Counted: `within1Frame`
  (|offset| ≤ 1/fps), `within80ms`, the median signed offset in ms (shown as "your cuts land about 20 ms before the
  beat") and `offBeatHalf` (cuts within ±80 ms of a half-beat but not a beat; noted only, not used in v2).
- **Chance correction**: random cuts hit a ±80 ms window with probability `p0 = min(1, 0.16 × bpm / 60)` (0.32 at
  120 BPM, 0.40 at 150 BPM). Reportable only when `within80ms ≥ max(ceil(0.6 × cuts), kMin)`, where `kMin` is the
  smallest k with binomial tail P(X ≥ k | cuts, p0) ≤ 0.01. Examples (computed): 15 cuts at 120 BPM → kMin 10;
  30 cuts at 120 BPM → 17; 8 cuts at 120 BPM → 7. The ±1-frame share is shown for information only.
- **Cut every N beats**: for consecutive aligned cuts, `n = round(Δt / beatInterval)`; histogram over 1, 2, 4, 8 and
  other. The mode is suggested as `beatsPerCut` when it holds ≥ 50 % of the gaps; else `beatsPerCut: null`
  (beat-synced, rhythm left to the style).

##### 4.3.1.3c Drop-timed reveal

- **Drop**: from the reference's 0.25 s RMS energy, power smoothed with a 1 s moving mean;
  `rise(t)` = 10·log10(mean power over [t, t + 1 s] ÷ mean power over [t − 2 s, t]). The drop is the largest rise
  for t in [1.5 s, span − 1 s]; it is **found** when the rise ≥ 6 dB and the level after it is within 3 dB of the
  video's 75th-percentile level (a real lift into a loud part, not a single knock). The time is refined to the
  nearest beat in [t − 0.4 s, t + 0.15 s] when a beat grid is measured. Stored: `atSec`, `atShare` (position as a
  share of the span) and `riseDb`.
  `ebur128` was tried for this: on a percussive click track its momentary loudness (100 ms frames) dropped
  15–35 LU between hits, so a rise found on it is noisy; the smoothed RMS energy is steadier and is exactly what the
  owner's tracks already store (`music_tracks.beats.energy`), so the same function finds the strongest beat of a
  track (§4.3.1.6).
- **Visual event at the drop**: the nearest hard cut, flash peak or punch-in jump within ±150 ms → `cut`, `flash`
  or `zoom` with its offset in ms; otherwise `none`. Without a measured beat grid the visual event is not measured
  (null).
- Combined (§4.3.1.4): suggested when ≥ 60 % of the videos with a found drop have an event there, with at least 2
  agreeing videos (or 1 of 1). Maps to `editingStyle.reveal = 'strongest_beat'`; if most events are flashes and a
  palette accent exists, the reveal also gets the accent.

##### 4.3.1.3d Zooms in shots

Conservative by design: a camera moving closer and a digital zoom look the same and are both reported as "zoom or
moving closer".

1. Shots of ≥ 0.6 s between v2 boundaries, ignoring 0.1 s at each end.
2. **Scale fit** between the Pass B frames at 15 % and 85 % of the shot: for scale s from 0.80 to 1.40 in steps of
   0.01 and anchor points on a 3 × 3 grid (0.3/0.5/0.7), predict the later frame by cropping the earlier one around
   the anchor by 1/s and scaling back (bilinear), comparing only the inner 80 % of the frame; keep the s with the
   lowest mean absolute error `e(s)`.
3. A shot has a zoom when |s − 1| ≥ 0.04, `e(best) ≤ 0.5 × e(1)`, `e(1) ≥ 4` grey levels (enough texture and
   change to tell) and the fits 15 % → 50 % and 50 % → 85 % point the same way. s > 1 is a push-in, s < 1 a pull-out.
4. Punch-in jumps come from §4.3.1.3a step 3.

*Prototype*: a `zoompan` push-in from 1.0 to 1.15 over 2 s measured 1.14 between 0.1 s and 1.9 s (true ratio 1.128)
with residual ratio 0.14, and 1.08 between 0.5 s and 1.5 s (true 1.073); a static test pattern measured 1.00; a
chaotic pattern gave residual ratio 0.91 (rejected); a smooth gradient had `e(1)` = 1.96 (rejected as too little
texture).

Mapping (combined): punch-in jumps ≥ 15 % of cuts → `{ mode: 'punch_in', scale: median clamped 1.08–1.25,
shareOfCuts: rounded share clamped 0.1–0.5 }`; else push-ins in ≥ 30 % of checked shots →
`{ mode: 'push_in', scale: median clamped 1.03–1.12 }`; else, with ≥ 12 checked shots and no zoom at all →
`{ mode: 'none' }` ("No zooms seen in 31 shots"); otherwise no suggestion.

##### 4.3.1.3e Music tempo and energy shape

- Tempo: `beat.bpm` when confidence ≥ 0.35 (cut alignment does not need to be reportable).
- Energy shape: the measured span in 8 equal parts; per part the mean power in dB relative to the loudest part,
  mapped to 0–1 by (dB + 24) ÷ 24, clamped. `dynamicRangeDb` = 90th − 10th percentile of the 1-s smoothed dB curve.
  Shape word for display only: `steady` (range < 4 dB), `builds` (second half ≥ 4 dB louder than the first),
  `drop` (a drop was found), else `varied`.
- Combined → `musicFit = { bpmLow, bpmHigh, prefersClearDrop, dynamicRangeDb }`: tempo range = min–max of the
  agreeing videos' tempos (each folded by ×2 or ÷2 into ±6 % of the median when that is closer, as half/double time
  is common), widened by 3 % each side; `prefersClearDrop` when ≥ 60 % of videos with a measured tempo have a drop.

#### 4.3.1.4 Combining several videos into "your style"

`summariseReferenceStyle(profiles, effectivePreferences)` (pure, `packages/core/src/reference-style.ts`) reads the
latest 12 ready reference profiles (all projects). Each video counts once.

- **Continuous values** (median shot, tempo, hard-cut share, cross-fade length, zoom scale): the median over the
  videos where the signal was reportable. A video **agrees** when its own value is within tolerance of that median:
  tempo ±6 % (octave-folded), hard-cut share ±0.15, median shot ±25 %, scale ±0.04.
- **Categories** (palette family, accent colour and `everyBeats`, `beatsPerCut`, zoom mode, drop event,
  `prefersClearDrop`): the majority value; agreeing videos are those with that value.
- **Shares pooled**: palette shares use the summed join counts of the agreeing videos (videos with more joins carry
  more evidence); per-video agreement still uses each video's own family.
- **Reportable**: agreeing ÷ measured ≥ 0.6 and (measured ≥ 2, or exactly one video was uploaded). With one video
  every row says "from 1 video". When videos split (for example 1 of 2), the row says "Your videos differ here" and
  offers no button.
- Each summary row carries `measured`, `agreeing`, `total` and the reasons videos were not measured, shown as
  "Seen in 3 of 4 videos (1 had no clear beat)".
- v1 fields (length, pace, colour, on-screen text) are combined the same way (median length rounded to 5 s,
  majority pace/colour/text density) so the summary is the single place to accept a style; older v1-only profiles
  count for these rows only.
- **Measuring version**: only v2 profiles whose `style.analysisVersion` is the current
  `REFERENCE_STYLE_ANALYSIS_VERSION` are combined (`isOlderMeasuringVersion`). A profile measured by an older version
  is left out of every row, the pace included (its shot lengths came from that measuring too), and counted in
  `summary.olderVersion`; the card says "2 videos were measured with an older version of the measuring. Upload them
  again to include them." The originals were deleted after measuring, so uploading the video again is the only way to
  measure it afresh. Raising the version (when the measuring changes what it measures) therefore takes the earlier
  profiles out of "your style" until those videos are uploaded again; they stay in the videos list with a chip.

#### 4.3.1.5 Schemas (Zod 4, `packages/core`, no migration)

`ReferenceStyleProfile` v2 (`packages/core/src/reference.ts`), stored in `media_assets.reference_profile` like v1:

```ts
export const BOUNDARY_KINDS = ['hard', 'fade_white', 'fade_black', 'cross_fade', 'slide_vertical', 'wipe_horizontal',
  'zoom', 'whip_like', 'punch_in', 'unclear'] as const;

export const ReferenceStyleSignalsSchema = z.object({
  analysisVersion: z.number().int().positive(),     // REFERENCE_STYLE_ANALYSIS_VERSION at measuring time
  estimate: z.literal(true),                        // every number here is an estimate
  measuredSec: z.number().nonnegative(),
  endScreenTrimmedSec: z.number().nonnegative(),
  fps: z.number().positive(),
  shots: z.object({ count: z.number().int().nonnegative(), medianSec: z.number().nonnegative(),
                    p25Sec: z.number().nonnegative(), p75Sec: z.number().nonnegative() }),   // raw v2 boundaries
  transitions: z.object({
    joins: z.number().int().nonnegative(),
    counts: z.partialRecord(z.enum(BOUNDARY_KINDS), z.number().int().nonnegative()),
    directions: z.object({ up: z.number().int(), down: z.number().int(), left: z.number().int(), right: z.number().int() }),
    crossFadeMedianSec: z.number().nullable(),
    flashMedianSec: z.number().nullable(),
    flashesOnBeat: z.number().int().nullable(),     // null when the beat was not measured
    flashEveryBeats: z.number().nullable(),
    family: z.enum(['straight_only', 'straight_flash', 'cross_fades', 'movement', 'mixed']).nullable(),
    reportable: z.boolean(),
  }),
  beat: z.discriminatedUnion('status', [
    z.object({ status: z.literal('measured'), bpm: z.number().positive(), confidence: z.number().min(0).max(1),
      cuts: z.number().int(), within1Frame: z.number().int(), within80ms: z.number().int(),
      chanceShare80ms: z.number().min(0).max(1), offBeatHalf: z.number().int(), medianOffsetMs: z.number(),
      beatsPerCutCounts: z.object({ one: z.number().int(), two: z.number().int(), four: z.number().int(),
                                    eight: z.number().int(), other: z.number().int() }),
      beatsPerCut: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).nullable(),
      reportable: z.boolean() }),
    z.object({ status: z.literal('not_measured'), reason: z.enum(['no_audio', 'no_clear_beat', 'mostly_speech', 'too_few_cuts']),
      bpm: z.number().positive().nullable() }),     // tempo may still be known with too few cuts
  ]),
  drop: z.object({ status: z.enum(['found', 'none', 'not_measured']), atSec: z.number().nullable(),
    atShare: z.number().min(0).max(1).nullable(), riseDb: z.number().nullable(),
    visualEvent: z.enum(['cut', 'flash', 'zoom', 'none']).nullable(), eventOffsetMs: z.number().nullable() }),
  zoom: z.object({ shotsChecked: z.number().int(), pushIns: z.number().int(), pullOuts: z.number().int(),
    punchIns: z.number().int(), medianPushScale: z.number().nullable(), medianPunchScale: z.number().nullable() }),
  music: z.object({ status: z.enum(['measured', 'not_measured']), bpm: z.number().nullable(),
    energyShape: z.array(z.number().min(0).max(1)).length(8).nullable(),
    shapeWord: z.enum(['steady', 'builds', 'drop', 'varied']).nullable(),
    dynamicRangeDb: z.number().nullable(), hasClearDrop: z.boolean() }),
});

export const ReferenceStyleProfileV1Schema = /* today's ReferenceStyleProfileSchema, unchanged */;
export const ReferenceStyleProfileV2Schema = ReferenceStyleProfileV1Schema.extend({
  version: z.literal(2),
  style: ReferenceStyleSignalsSchema.nullable(),     // null only for a v1 profile read through readReferenceProfile
});
export const ReferenceStyleProfileSchema = z.discriminatedUnion('version', [ReferenceStyleProfileV1Schema, ReferenceStyleProfileV2Schema]);
/** Backwards-compatible read: v1 → v2 shape with style null (never written back, so stored v1 stays recognisable). */
export function readReferenceProfile(raw: unknown): ReferenceStyleProfileV2;
```

No beat times, cut times, energy curve, audio or frames are stored; the shot quartiles, counts, ratios, the 8-point
shape and the drop position are all that remain. Every caller that parses `reference_profile`
(`handlers/reference.ts`, `apps/web/src/lib/references.ts`, the status DTO) switches to `readReferenceProfile`.
v2 `shotCount`/`shotSec`/`cutsPer10Sec` (the v1 fields) are filled from `style.shots`, which corrects a v1 bias:
v1 used `detectScenes` defaults (`minShotSec 0.8` merges, `maxShotSec 5` splits), so a montage of 0.4 s shots was
measured as ≥ 0.8 s and suggested "balanced" instead of "fast". Stored v1 profiles keep their numbers.

`EditingPreferences` addition (`packages/core/src/settings.ts`), all defaulted so stored settings parse and plans
are unchanged until the owner accepts something:

```ts
export const EDITING_STYLE_FIELDS = ['transitionPalette', 'beatSync', 'beatsPerCut', 'reveal', 'zoom', 'musicFit'] as const;

export const TransitionPaletteSchema = z.object({
  hardCutShare: z.number().min(0).max(1),                    // share of joins left as straight cuts
  types: z.array(TransitionTypeSchema).max(3),               // non-accent transitions, most used first
  durationSec: z.number().min(0.15).max(1),                  // typical length of those, rounded to 0.05
  accent: z.object({
    type: z.enum(['fadewhite', 'fadeblack']),
    everyBeats: z.union([z.literal(4), z.literal(8)]).nullable(),   // null = only at the reveal
    durationSec: z.number().min(0.15).max(0.3),
  }).nullable(),
});
export const ZoomUseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('style') }),                   // each style's own zooms (today)
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('push_in'), scale: z.number().min(1.03).max(1.12) }),
  z.object({ mode: z.literal('punch_in'), scale: z.number().min(1.08).max(1.25), shareOfCuts: z.number().min(0.1).max(0.5) }),
]);
export const MusicFitSchema = z.object({
  bpmLow: z.number().min(40).max(220), bpmHigh: z.number().min(40).max(220),
  prefersClearDrop: z.boolean(), dynamicRangeDb: z.number().nullable(),
});
export const REFERENCE_SUMMARY_FIELDS = [...REFERENCE_SUGGESTION_FIELDS, ...EDITING_STYLE_FIELDS] as const;

editingStyle: z.object({
  transitionPalette: TransitionPaletteSchema.nullable().default(null),   // null = each style's own transitions
  beatSync: z.enum(['auto', 'on', 'off']).default('auto'),
  beatsPerCut: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).nullable().default(null),
  reveal: z.enum(['style', 'strongest_beat']).default('style'),
  zoom: ZoomUseSchema.default({ mode: 'style' }),
  musicFit: MusicFitSchema.nullable().default(null),
  /** Where each non-default value came from (server-managed). */
  sources: z.partialRecord(z.enum(EDITING_STYLE_FIELDS), z.object({
    by: z.enum(['owner', 'reference']), at: z.string(),
    referenceAssetIds: z.array(z.string()).max(12).default([]), referenceName: z.string().max(200).default(''),
  })).default({}),
  /** Owner decisions on summary rows; a dismissed row comes back only if its suggested value changes. */
  summaryDecisions: z.partialRecord(z.enum(REFERENCE_SUMMARY_FIELDS), z.object({
    decision: z.enum(['accepted', 'dismissed']), valueKey: z.string().max(400), at: z.string(),
  })).default({}),
}).default(DEFAULT_EDITING_STYLE),
```

`valueKey` is the stable JSON of the suggested value. The `editingStyle` fields are not learnable from feedback in
this round (plan facts do not carry them), so they are plain declared values with their own `sources`; the v1 fields
keep using `learning.pinned`, whose `PinSchema` gains `referenceAssetIds: z.array(z.string()).max(12).default([])`
for summary accepts (`referenceAssetId: null`, `referenceName: 'Your videos (4)'`).

**Suggestion rows** (`SummarySuggestion`): `{ field: ReferenceSummaryField, value, valueKey, wording,
evidence: { measured, agreeing, total, notMeasured: Array<{ reason, count }> }, alsoChanges: Array<{ field, value }>,
state: 'open' | 'matches' | 'differs' | 'accepted' | 'dismissed' }`. `alsoChanges` makes side effects visible
before the owner presses the button: a palette containing a flashy type (anything outside
`RESTRAINED_TRANSITIONS`) also sets `transitions: 'varied'` (pinned `by: 'reference'`); `beatsPerCut` is offered
with `beatSync: 'on'` as one row.

**Accepting** (`POST /api/references/summary/decide`, §9.2): v1 fields set the declared value and pin it
(as §6.2); `editingStyle` fields set the value and `sources[field] = { by: 'reference', … }`; `summaryDecisions`
records the decision and `valueKey`. The owner can change any of them later in Settings (source becomes
`owner`) or press **Go back to each style's own** (resets `editingStyle` to its defaults, keeps v1 fields). Audit
`reference.summary_decided` / `preferences.editing_style_changed`.

#### 4.3.1.6 What accepted suggestions change in the five edits

Precedence, unchanged in spirit: a revision request (for example "remove the flashy transitions", "ignore the
beat") > this generation's form and the Sound panel > standing instructions > `editingStyle` > the style's
defaults. `effectiveSettings` (`packages/ai/src/rules/settings.ts`) gains `editingStyle`, resolved from the
effective preferences; with the defaults every plan is byte-identical to today's (tested).

**Rules planner** (`packages/ai/src/rules/editing-style.ts`, called from the style builders and `planner.ts`):

- **Joins**: join i (not the first segment, and not a join the style reserves, see the table) becomes a palette
  transition when `frac(i × 0.618 + attempt × 0.37) ≥ hardCutShare` (a low-discrepancy sequence: the share holds
  within one join and each take differs); type `types[k mod types.length]`, length `durationSec`, shortened to fit
  the existing `TRANSITION_TOO_LONG` limits or dropped to a hard cut when it cannot fit.
- **Accent on the beat**: with music, beat-synced styles put the accent on joins whose cut falls on beat index
  ≡ 0 (mod `everyBeats`) counted from where the music starts (the grid's bar convention), at most one per 2 s. The
  transition starts at `beat − 0.2 × duration`, so its white or black peak lands on the beat (§4.3.1.3a), and the
  segments either side are lengthened so the total length stays the same. `audio.beatAlignment.alignedCutTimesSec`
  reports the peak time.
- **Beat sync**: `PlannerInput.beatSync` defaults to `editingStyle.beatSync` when neither the form, the Sound
  panel nor a revision ("ignore the beat") set it — the same order in the rules planner and the AI brief
  (`beatSyncFor`). `on` runs `snapCutsToBeats` for styles that do not cut on the beat by themselves (existing).
- **Cut every N beats**: the beat montage's beats-per-shot options become the whole multiples of N (N, 2N, 4N) that
  fit its 0.4 s–`hi` shot range; when N beats are longer than a montage shot (every 8 beats at 120 BPM is 4 s), the
  largest whole divisor of N that fits is used, with a plan note, and when nothing fits the montage keeps its own
  steps (note). Other styles round each shot to a whole number of N-beat steps before snapping, inside their own
  `minShotSec`–`maxShotSec` (the style's range wins; the plan note says so).
- **Reveal on the strongest beat**: `strongestBeat(track)` runs the §4.3.1.3c drop function on the track's stored
  energy curve and beat grid. When the owner left the music start on automatic, the music start is chosen so this
  beat falls on the reveal (the first `result` segment) at 45–80 % of the edit, within the track's bounds. When the
  owner fixed the start, the reveal moves to the strongest beat if it lies at 35–85 % of the edit; otherwise the
  existing `landRevealOnBeat` (nearest downbeat) applies. No clear drop in the track (rise < 6 dB) → nearest
  downbeat, with the note "No clear drop in this track — the reveal lands on a downbeat."
- **Zoom**: `none` → every segment `zoom: null` (style push-ins included); `push_in` → the style's existing zoom
  places use `{ from: 1, to: scale }`, and process shots ≥ 1.5 s alternate push-ins; `punch_in` → on `shareOfCuts`
  of the hard cuts that land on a beat, instead of cutting to another shot the current shot continues (same asset,
  contiguous source time) as a new segment with a static `{ from: scale, to: scale }`, when ≥ 0.8 s of footage
  remains. Scale is capped at `min(scale, 1.25, max(1.10, sourceShortSide ÷ 1080))` so exports do not soften;
  the AI prompt's "subtle zooms (1.0–1.1)" line gains "or up to the accepted punch-in scale".
- **Music fit**: no planner effect; ranking only (§4.3.1.7). Only the planning fields (`transitionPalette`,
  `beatSync`, `beatsPerCut`, `reveal`, `zoom`) make the planners use the editing style (`isDefaultPlanningStyle`), so
  an accepted music fit alone leaves every rules plan and the AI brief exactly as with the defaults (tested).
- **Never worse than the defaults** (`buildWithStyleFallback`, `packages/ai/src/rules/planner.ts`): when an edit
  cannot be built with the accepted editing style, it steps down. Only a build that fails with `PROCESSING_FAILED`
  steps down; cancellations and every other error pass through unchanged. The owner's settings are never changed.
  1. **Without the transitions from the owner's videos** (palette and accent), keeping beat sync, beats per cut, the
     reveal and zoom (long cross-fades use up length the footage may not have). When the transitions were the only
     planning value accepted, this step is the edit without the editing style, with the note "The transitions from
     your videos could not be fitted to this footage at this length, so this version uses the style's own
     transitions."
  2. When step 1 builds, the edit is also built **without the editing style**, and the two are compared. If they
     differ, step 1's plan is used, with "The transitions from your videos could not be fitted to this footage at
     this length, so this version uses the style's own transitions and keeps the rest of your editing style." If they
     are the same apart from their notes (the rest of the style needs music, or its beat steps place no cut on this
     footage), the plan without the editing style is used, with "Your editing style could not be fitted to this
     footage at this length, so this version uses the style's own timing and transitions." A plan never says it keeps
     what it does not apply. If that comparison build fails, step 1's plan is kept.
  3. When step 1 does not build either, or no transitions were accepted, the edit is built **without the editing
     style**, with "Your editing style could not be fitted to this footage at this length, so this version uses the
     style's own timing and transitions."

  Every step starts from the notes taken before the first attempt, so no note from a failed attempt (such as
  "Cross-fades as in your videos, from your style.") reaches the plan. The build adds its step's note itself
  (`EffectiveSettings.styleFallback`), right after the notes it was given, once it knows whether it kept joins from
  the earlier version. A revision keeps the shots it can from the earlier version, each with its join ("keep
  everything the request does not mention"), so leaving out the transitions changes only the shots it adds. When a
  revision kept such joins, the three notes read instead:
  - "The transitions from your videos could not be fitted to this footage at this length, so the shots added in this
    version use the style's own transitions and the joins kept from the earlier version are unchanged."
  - "The transitions from your videos could not be fitted to this footage at this length, so the shots added in this
    version use the style's own transitions, the joins kept from the earlier version are unchanged, and the rest of
    your editing style is kept."
  - "Your editing style could not be fitted to this footage at this length, so the shots added in this version use
    the style's own timing and transitions, and the joins kept from the earlier version are unchanged."

  A revision rebuilt from scratch (the beat montage, which is rebuilt on the beat grid, or an earlier version whose
  clips are gone) keeps no joins and uses the first wordings. The "finished look lands on the biggest lift" note is
  rechecked on the final plan and replaced when later steps moved the reveal more than 0.1 s away.

  The planner sweep (`packages/ai/test/rules-editing-style-sweep.test.ts`) builds every N (1/2/4/8 beats),
  cross-fades of 0.3–1 s with no straight cuts, alone and combined with the beat, beats per cut, the reveal and
  punch-ins (1 s + every 8 beats + the reveal; 0.6 s + every 2 beats + the reveal + punch-ins; 0.3 s + every 2 beats +
  the reveal), at 15/30/45/60 s across the five styles and four music cases (40 s tracks, so a 45 s edit is trimmed
  to the music; 70 s tracks at 60 s). It judges every plan, and the default plan it is compared with, the way the
  worker does: `durationBoundsFor` around the length both planners aimed for (below). On its footage (45 s of clips)
  only the before & after falls back, at 60 s, and leaving out the transitions always builds it. The per-step counts
  are pinned (cross-fades alone: 4, 12 and 12 transitions-only; 1 s + every 8 beats: 12 whole-style, because its
  rest changes nothing there; 0.6 s + every 2 beats + punch-ins: 9 keep-rest and 3 whole-style; 0.3 s + every 2
  beats: 4 keep-rest and 1 whole-style). Every keep-rest plan differs from the plan without the editing style, every
  other fallback plan is that plan, and none mentions the transitions from the owner's videos. A revision case (the
  before & after at 30 s with 0.6 s cross-fades, then "Make it 60 seconds.") checks the revision wording, that every
  kept join is unchanged and that the added shots are joined as without the editing style.
- **Length and the music** (§4.7): with the music start on automatic, a chosen track a little shorter than the edit
  trims it by one shared rule (`editLengthForTrack`, `packages/core/src/edit-length.ts`), and both planners aim for
  that length (`plannedTargetSec`, `packages/ai/src/rules/settings.ts`): the rules planner (`capTargetToMusic` and its
  last-chance window), the AI brief's `target` and the AI plan's `targetDurationSec`. The worker validates every plan
  against `durationBoundsFor` (±12 %, at least ±2 s) around the same length (`planningContextFor` in
  `apps/worker/src/handlers/generate.ts`, first plans and revisions alike), so an edit trimmed to its music is never
  refused for being shorter than the music allows, and an accepted editing style is judged by the same window.

Each style keeps its character, so the five edits stay different:

| Style | Palette joins | Accent | Beat sync / every N beats | Reveal on strongest beat | Zoom |
| --- | --- | --- | --- | --- | --- |
| Beat montage | all body joins | on every `everyBeats`, and at the final shot | always on the beat; N applies | final result shot | push-in / punch-in apply |
| Cinematic reveal | process joins (calm types only, unless the family is "straight cuts", which makes them hard cuts) | only the pre-reveal join (replaces its dissolve/dip) | snapping when `on`; N applies to process shots | the held reveal | push-in replaces its subtle push-ins; punch-in only before the reveal |
| Before and after | bridge joins | the before → after join | snapping when `on` | the after shot | apply |
| Clean promo | `hardCutShare` and cross-fade length only | never (stays calm; note: "Clean promo stays calm, so it keeps straight cuts but no flashes") | snapping when `on` | final shot, on a downbeat only | push-in only; never punch-in |
| Process story | all joins | at the result only | snapping when `on`; N applies | first result shot | apply |

A revision hint `transitions: restrained` drops flashy palette types and accents for that edit (accents become hard
cuts), exactly as today's `tameTransition`; `none` makes every join a hard cut.

**AI planner brief** (`packages/ai/src/anthropic/prompts.ts`): `job.editingStyle` =
`{ transitionPalette, beatSync, beatsPerCut, reveal: { mode, targetOutputSec | null }, zoom }`, where
`targetOutputSec` is the strongest beat on the output timeline computed by the worker with the same function as the
rules planner (so the model never has to find the drop). `allowedTransitionsFor` adds the palette types (after the
calm/none filter). New system-prompt lines: "When job.editingStyle is present it describes the owner's own editing,
measured from their videos: keep about hardCutShare of the joins as straight cuts; use only the palette types; place
accent transitions so their brightest or darkest moment (about 20 % into the transition) lands on every
everyBeats-th beat; with beatsPerCut, make shots last whole multiples of that many beats; with reveal.targetOutputSec,
start the first result shot there; zoom.punch_in means continuing the same shot with a static zoom of that scale
instead of cutting away." The validator context gains `extraStyleTransitions` (the palette types), so palette
choices do not raise `OFF_STYLE_TRANSITION` warnings; errors are unchanged.

#### 4.3.1.7 Music ranking (`packages/core/src/music-ranking.ts`)

`rankTracksForPreferences` gains `opts.fit?: MusicFit` and `RankableTrack.drop?: { riseDb: number } | null`
(computed when tracks are listed, from the stored energy curve, with `strongestBeat`):

- +2 when the track's BPM is in `[bpmLow, bpmHigh]`; +1 when only half or double its BPM is (reason "Half-time
  feel close to your videos").
- +1 when `prefersClearDrop` and the track has a drop of ≥ 6 dB.
- Reasons: "Tempo close to your videos (118–126 BPM)", "Builds to a clear drop, like your videos". Tracks without a
  BPM get no tempo points ("tempo unknown").
- Unchanged: only the owner's own tracks; unusable tracks stay last with their reason; nothing is chosen
  automatically; "No music" stays a first-class choice. The fit never fetches, plays or looks up anything.

#### 4.3.1.8 Owner-facing wording (Australian English)

| Situation | Wording |
| --- | --- |
| Summary header | "**Your style from your videos** — estimated from 4 of your videos · updated 15 Nov 2026, 3:10 pm" |
| Honesty line under the header | "These are estimates from your videos, not exact measurements. Check the next few edits and change anything that doesn't feel like you. Nothing from the videos is used in your edits, and the files were deleted after measuring." |
| Transitions (straight + flash) | "Mostly straight cuts (about 80 %), with a quick white flash every 4 beats. Seen in 3 of 4 videos." → **Use straight cuts with a white flash every 4 beats** · "Also turns on bolder transitions" (when `alsoChanges` has it) |
| Transitions (cross-fades) | "Soft cross-fades of about half a second between most shots." → **Use half-second cross-fades** |
| Beat | "Your cuts land on the beat: 19 of 23 within 80 ms (about 124 BPM). Seen in 4 of 4 videos." → **Cut on the beat, about every 2 beats** |
| Beat not measured | "Beat: not measured — the sound in this video has no clear beat." / "… it's mostly talking." / "… it has no sound." / "… it has too few cuts to tell." |
| Not above chance | "Some cuts are near a beat, but no more than you'd expect by chance, so we're not suggesting beat-synced cuts." |
| Reveal | "The music's biggest lift lands on a cut or flash in 3 of 4 videos." → **Land the finished look on the strongest beat of your track** |
| Zoom | "Quick punch-in zooms on about 1 in 5 cuts (estimate)." → **Use punch-in zooms (up to 1.2×)** · "No zooms seen in 31 shots." → **Keep shots unzoomed** |
| Music | "Music around 118–126 BPM that builds to a clear drop." → **Suggest tracks from your library around 115–130 BPM with a clear drop** · "Only your own licensed tracks are suggested. The sound from your videos is never used or kept." |
| Videos differ | "Your videos differ here: 1 cuts on the beat, 1 doesn't." (no button) |
| Matches | "Matches your settings" (no button) |
| Older measurement | "Measured before transitions and beat were added. Upload it again to include it." |
| Older version of the measuring | Per video: "Measured with an older version of the measuring. Upload it again to include it." Summary: "2 videos were measured with an older version of the measuring. Upload them again to include them." (one video: "1 video was measured … Upload it again to include it.") |
| End screen | "Skipped a dark end screen in the last 3 s." |
| Plan note (rules planner) | "Straight cuts with a white flash on every 4th beat, from your style." / "The finished look lands on the biggest lift in 'Track' (estimate)." |
| Plan note (editing style left out) | The three step-down notes and their revision wordings, word for word in §4.3.1.6 ("Never worse than the defaults") |
| Plan note (trimmed to the music) | "The edit was trimmed to 39.8 s so it ends before the music does." |

Never used: "exact", "precisely", "detected", "trending", "viral", "your TikTok". The style is "from your videos".

#### 4.3.1.9 Settings → Editing preferences → "Your style from your videos"

New card above **Reference videos** in `preferences-tab.tsx` (component `YourStyleSummary`,
`apps/web/src/app/(app)/settings/_components/your-style-summary.tsx`), data from `GET /api/references/summary`.

- Header and honesty line (§4.3.1.8). **Use all suggestions** (open rows only; a confirm lists every change,
  including `alsoChanges`) and **Go back to each style's own** (confirm: "Transitions, beat, reveal, zoom and music
  matching go back to each style's own. Length, pace, colour and text stay as they are.").
- Rows in this order: Pace, Length, Colour, On-screen text, Transitions, Cutting to the beat, Big moment (reveal),
  Zooms, Music. Each row: what was seen (plain sentence), the agreement chip ("Seen in 3 of 4 videos"), and either
  **Use this** / **No thanks**, "Matches your settings", "Your videos differ here" or the not-measured reason. A
  small "In use: from your videos" chip on accepted rows, with **Change**.
- **Videos** list under the rows: thumbnail, file name, measured date (Melbourne time), the per-video line, "older
  measurement" chip where it applies, **Open project**.
- States: loading skeleton; empty ("Upload a few of your own posted videos with **Add a reference video** in any
  project and the editor will estimate your style. Nothing has been measured yet."); measuring ("2 videos are still
  being measured"); only older measurements; videos measured with an older version of the measuring (the notice
  "2 videos were measured with an older version of the measuring. Upload them again to include them.", an "Older
  version of the measuring" chip on each, and the videos list stays visible when none of them can be combined);
  nothing reportable ("Not enough to go on yet — 1 video had no clear
  beat and too few joins. Another video or two will help."); load error with **Try again**; staff see it read-only.
  Works at 360 px (rows stack).

#### 4.3.1.10 Tests

**Synthetic reference fixtures with known ground truth.** Generated at test time by
`packages/media/test/fixtures/make-reference-fixtures.ts` (FFmpeg `lavfi` only; nothing committed), 540 × 960,
30 fps, 48 kHz audio; every frame carries a small `SYNTHETIC TEST CLIP` label; files are named `synthetic-*.mp4`
and each has a ground-truth JSON beside it. Shots come from 8 visually different sources (`testsrc2`,
`mandelbrot`, `cellauto`, `smptebars`, `gradients`, `life`, `rgbtestsrc`, `testsrc`) with temporal noise and hue
offsets. Builds are reproducible: every random input is pinned (`gradients` colours, which it otherwise picks at
random whatever its `seed`; the `anoisesrc`, `life` and `cellauto` seeds; the `noise` seed), x264 encodes 4 slices on
4 threads (its frame threads now and then encode a few frames differently), and the top row FFmpeg 6.1's `slideup`
leaves undefined on its first frame is painted black; two builds of every fixture give the same sha256. The click
track is
`aevalsrc='0.8*sin(2*PI*55*t)*exp(-30*mod(t\,0.5))+0.3*sin(2*PI*1800*t)*exp(-60*mod(t\,0.5))'` (120 BPM; at
30 fps every beat is on a frame, so cuts can be placed exactly).

| Fixture | Built with | Ground truth | Tolerance assertions |
| --- | --- | --- | --- |
| R1 hard cuts, 120 BPM | 1.0 s shots concatenated (a cut every 2 beats, on the beat) + click track, 16 s | 15 hard cuts at 1, 2, …, 15 s | joins 15 ± 1, hard ≥ 14; tempo 120 ± 1.5; `within1Frame` ≥ 13; `within80ms` ≥ 14; \|median offset\| ≤ 15 ms; `beatsPerCut` 2; beat reportable; family `straight_only`; no zoom found |
| R2 flash every 4th beat | R1, but the joins at 2, 4, …, 14 s are `xfade=fadewhite` 0.2 s starting 0.04 s before the beat | 7 flashes (peaks on beats), 8 hard cuts | `fade_white` 7 ± 1; hard 8 ± 1; `flashesOnBeat` ≥ 6; `flashEveryBeats` 3.5–4.5; `flashMedianSec` 0.2 ± 0.07; palette `{ hardCutShare: 1, accent: { type: 'fadewhite', everyBeats: 4 } }` |
| R3 cross-fades | 6 shots × 2.5 s joined with `xfade=fade` 0.5 s; pink noise at −30 dBFS | 5 cross-fades, no beat | `cross_fade` ≥ 4; hard ≤ 1; `crossFadeMedianSec` 0.5 ± 0.1; beat `not_measured` (`no_clear_beat`); palette `types[0] = 'fade'`, `durationSec` 0.5 ± 0.1 |
| R3b pixel dissolve | as R3 with `xfade=dissolve` | 5 cross-fades | same as R3 (proves the `fade` mapping) |
| R4 zooms | shot A static 3 s; shot B 3 s `zoompan` 1.0 → 1.2 about the centre (from a 2× upscaled source); shot C 3 s with a jump to a 1.25× crop at 1.5 s | 1 push-in, 1 punch-in jump, 2 hard cuts | `pushIns` 1, scale between 15 % and 85 % = truth ± 0.03; `punchIns` 1, scale 1.25 ± 0.04, not counted as a transition; `pullOuts` 0; static shots \|s − 1\| < 0.02 |
| R5 drop on a cut | 120 BPM, −18 dB until 8.0 s, then 0 dB; hard cut + white flash peaking at 8.0 s; other cuts every 2 s | drop at 8.0 s | drop `found`, `atSec` 8.0 ± 0.15, `riseDb` ≥ 10; `visualEvent` `cut` or `flash`, \|offset\| ≤ 150 ms |
| R5b drop, no event | R5 audio; cuts only at 7 and 9 s around the drop | drop at 8.0 s, nothing there | `visualEvent` `none` |
| R6 slides and wipes | 5 joins: `slideup`, `slidedown`, `wipeleft`, `wiperight`, `slideup`, 0.3 s each | 5 motion joins | ≥ 4 classified motion with the right axis and direction; 0 classified `cross_fade` |
| R7 busy single shot | 15 s of `life` and `cellauto` with crop jitter (`crop=x='20*sin(7*t)'`), no cuts | 0 joins | joins ≤ 1; zooms 0 |
| R8 dark end screen | R1 + 3 s near-black with a small plain white box | trim 3 s | `endScreenTrimmedSec` 3 ± 0.2; no joins counted inside it |
| R9 talking | hard cuts over the speech-like signal from `packages/media/test/analysis-fixtures.ts` | no musical beat | beat `not_measured` (`mostly_speech` or `no_clear_beat`), never "off the beat" |
| R10 124 BPM, every beat | a cut on each beat of a 124 BPM click for 15 s (beats not on the frame grid) | one cut per beat (≈ 31) | tempo 124 ± 2; `within1Frame` ≥ 85 %; `beatsPerCut` 1 |
| R11 random cuts | 15 cuts at seeded random times over the 120 BPM click | chance alignment | beat `reportable: false`; no beat-sync suggestion |
| X1–X8 review edge cases | dark and bright shots of 2 s between hard cuts; 0.3 s bright inserts between hard cuts; `fadeblack` 0.4 s; `zoomin` 0.4 s out of textured shots; `hblur` 0.4 s; `smoothleft/up/right/down`; 0.5 s and 1 s cross-fades with hard cuts on the 120 BPM beat at 60 and 25 fps | flash and screen rules, zoom gate, blur transitions, soft wipes, frame-rate independence | X1 5 hard, no flash or screen, 6 shots; X2 4 hard, no flash; X3 5 dips; X4 ≥ 4 of 5 zoom, no flash or cross-fade; X5 no zoom or cross-fade; X6 ≥ 4 of 5 right axis and direction, no cross-fade; X7/X8 ≥ 3 of 4 cross-fades within 0.15 s of their length (a 1 s one among them), cuts within a frame, beat 120 ± 1.5 BPM with ≥ 85 % of cuts within 80 ms |
| X9–X11 regression cases | X2 with the last shot's gradient colours that lost a cut while FFmpeg still picked them at random (X9 light grey to blue, X10 light yellow-green); X2 with the last shot a white end card after a brighter insert (X11) | a cut into a smooth shot is not a slide; screens are uniform frame by frame | X9/X10 4 hard within a frame of the truth, no flash or screen; X11 3 hard (the bright shot keeps its cut), one end screen from 5.3 s |

**Unit (vitest, no FFmpeg)**: `packages/media` frame maths on hand-built metric arrays and tiny frames (cut rule
edges, flash run lengths, linearity residual, band centroid direction, scale fit on a synthetic 72 × 128 frame
zoomed by known factors, `nan` blur); `packages/core/test/reference-style.test.ts`: binomial `kMin` table (15 cuts at
p0 0.32 → 10; 30 → 17; 8 → 7), `beatsPerCut` histogram, `findDrop` on synthetic energy curves (step rise, single
knock rejected, alternating click windows smoothed), `paletteFromCounts` for each family and the worked example in
§4.3.1.3a, `summariseReferenceStyle` (1 of 1, 3 of 4 agree, 1 of 2 → differs, octave-folded tempos, older profiles
count only for v1 rows), `readReferenceProfile` (v1 → v2 with `style: null`, v2 round trip), `alsoChanges` for a
flashy palette, `valueKey` stability, wording never contains "exact"/"precise"/"trending"/"viral";
`music-ranking.test.ts`: in-range BPM above out-of-range, half-time +1, drop +1, unusable still last, no fit = today's
order.

**Measurement on fixtures (`packages/media/test/reference-style.test.ts`, needs FFmpeg like the other media
tests)**: every row of the fixture table, plus: the `AbortSignal` stops the passes; a proxy without audio gives
beat/music `not_measured` and still measures transitions.

**Planner (`packages/ai/test/rules-editing-style.test.ts`)**, on the existing synthetic footage analyses and a
synthetic 120 BPM track with a drop at 12 s:

- Defaults: all five plans are identical to today's (stored snapshot).
- Accepted `{ transitionPalette: straight + fadewhite every 4, beatSync: 'on', beatsPerCut: 2, reveal:
  'strongest_beat', zoom: punch_in 1.2 at 0.25 }`: all five plans pass `validateEditPlan` with no errors; the five
  plans differ from the defaults (plan facts compared) and still differ from each other; beat montage: every join
  that is not an accent is a hard cut (`hardCutShare` 1), ≥ 1 `fadewhite`, every `fadewhite` peak (start + 0.2 × duration) within ±40 ms of a beat
  whose index from the music start is ≡ 0 (mod 4); median shot ÷ beat interval in 1.5–2.5; process story: ≥ 70 % of
  cuts within ±40 ms of a beat; reveal: the first result segment starts within ±0.1 s of the track's strongest beat
  (music start automatic); punch-in: ≥ 1 pair of consecutive segments on the same asset with contiguous source
  times and a static zoom of 1.2, and no zoom above 1.25; clean promo has no `fadewhite` and no punch-in;
  a revision "remove the flashy transitions" removes every accent and passes `restrainedTransitionsOnly`
  validation; dismissed suggestions → plans equal the defaults; deterministic for the same input.
- AI brief: `buildPlannerJob` includes `editingStyle` with `targetOutputSec` and `allowedTransitions` contains the
  palette types; a fake AI plan using palette types raises no `OFF_STYLE_TRANSITION` warning.

**Integration (`TEST_DATABASE_URL` + FFmpeg)**: `apps/worker/test/reference.integration.test.ts` extended — ingest R2
and R5 as `reference_video`: a version 2 profile is stored with `style` filled; afterwards the storage prefix of the
asset holds only the thumbnail; the profile JSON contains no array longer than 8 numbers (no beat times or energy
curve); the fake text estimator is called with frames only, and not at all without the tick; no AI call is made
for audio. Web (`apps/web/test`): `GET /api/references/summary` and `POST …/summary/decide` (owner-only, CSRF,
`valueKey` mismatch → 409, accept writes `editingStyle` + `sources` + `summaryDecisions` and the audit row).
**Round trip** (slow, optional in CI): render the beat montage from the planner test with the accepted palette,
run `measureReferenceStyle` on the preview, expect `fade_white` peaks within ±80 ms of beats for ≥ 70 % of accents
and family `straight_flash` (no `zoomin` in this test, §4.3.1.3a known limit).

**Only with the owner's real videos (§13.4)**: 3–5 of their own posted videos. For a 15 s excerpt of each, a person
counts cuts and flashes frame by frame in a player; acceptance: cut count within ±10 %, flash count within ±1,
tempo within ±2 BPM (or an octave, noted). Thresholds are tuned only after this and recorded in
`docs/HANDOVER.md`.

#### 4.3.1.11 Out of scope for this round (later, once the owner's real videos have been seen)

New render effects and vocabulary, each needing renderer work and its own validator rules:

- Speed ramps inside a segment (eased speed curves); today speed is constant per segment.
- Whip-pan blur transitions; horizontal slides (`slideleft`/`slideright` exist in FFmpeg's `xfade` but are not in
  `TRANSITION_TYPES`).
- Camera shake, zoom pulses on every beat ("bounce"), eased or overshooting zoom curves (today: linear `zoompan`).
- A flash inside a shot without a join (an overlay effect); v2 places flashes only at joins.
- Text animation styles (kinetic or per-word captions, typewriter, stickers) beyond `none/fade/rise/pop`.
- Glitch/RGB-split, masks and shape transitions, colour grades beyond the four looks.
- Half-beat (eighth-note) cutting grids; `offBeatHalf` is measured but unused.
- Learning these fields from favourites and downloads (plan facts would need them).
- Weighting videos by views or likes (needs TikTok analytics, which the app does not have).

Never in scope: reading or scraping TikTok, recognising or fetching the reference's song, using any part of a
reference's audio or picture in an edit.

#### 4.3.1.12 Prototype notes (what the numbers above rest on)

A throw-away prototype (not committed) ran on FFmpeg 6.1.1 on 2026-11-15 with synthetic 360 × 640, 30 fps clips
analysed at 144 × 256: hard cuts every 1 s; `xfade` `fadewhite` 0.2 s, `fadeblack` 0.3 s, `dissolve` 0.5 s,
`slideup` 0.3 s and `zoomin` 0.4 s every 2 s; a `zoompan` push-in 1.0 → 1.15. The scene-score, YAVG, YDIF, scale-fit,
`fadewhite` peak-position and `ebur128` observations quoted in §4.3.1.3 come from it. These are synthetic clips, not
the owner's videos: phone footage with handheld motion, low light, filters and TikTok re-encoding will move every
threshold, which is why the owner-video check in §4.3.1.10 comes before any tuning is called done.

### 4.4 Brand (Settings → Branding) — additions only

Existing: business name, tagline, accent colour, logo upload, headline/body font, video text style, social handle.
Added:

- **"Logo in videos"**: Off (default) · End card · Corner mark · Both. Corner position: Top left / Top right. Opacity
  (Corner mark only): 60–100 %.
- A static 9:16 preview frame (CSS, no rendering) showing the logo positions and a shaded "kept clear for app
  buttons" overlay so the owner sees why the logo cannot go lower or further right.
- If no logo is uploaded the control is disabled: "Upload a logo above to use it in videos."
- Font selects list only fonts that ship with the renderer (Inter, Inter Display). Existing stored values
  "DejaVu Sans"/"Liberation Sans" render with Inter and the select shows "Inter (DejaVu Sans is not installed on
  the video server)".
- A note under the section: "Branding changes apply to new previews. Exports always match their preview."

### 4.5 Brand renderer audit (verified in code, 2026-11-14)

| Brand setting | Used by renderer? | Where | Gap and fix |
| --- | --- | --- | --- |
| `accentColour` | Yes | `packages/media/src/render/ass.ts` (accent text) via `apps/worker/src/handlers/render.ts:73` | — |
| `videoTextStyle` | Yes | `ass.ts` `TREATMENTS` | — |
| `fontHeadline`, `fontBody` | Yes | `render.ts:83-84` → libass with `fontsdir=assets/fonts` | `assets/fonts` contains Inter and Inter Display only; the schema also allows DejaVu Sans and Liberation Sans, which are not bundled. Fix: renderer maps unbundled names to Inter (`resolveRenderFont`), UI offers only bundled fonts, schema unchanged for back-compatibility. |
| `socialHandle` | Yes | `ass.ts` end handle (lower, else top) | — |
| `businessName`, `tagline` | Planner only (text overlays) | `packages/ai/src/rules/styles.ts`, `prompts.ts` | — |
| `logoStorageKey` | **No** | — | New logo end card / corner mark (§6.5). |
| Preferred pacing (`preferences.pacing`) | Planner only | `packages/ai/src/rules/settings.ts` | `textDensity` `light` vs `medium` are not distinguished by the rules planner (`text: prefs.textDensity === 'none' ? 'none' : 'normal'`). Fix: map `medium` → `more`, `light` → `normal`. |
| Brand at export time | Read live from settings at render time | `render.ts` `loadSettings` | Preview and export can differ if branding changes in between. Fix: snapshot `RenderBrand` into `edit_versions.render_brand` at preview render; export uses the snapshot (§5.1). |

### 4.6 Licence passport (music upload, Studio and Settings → Music)

The existing upload dialog (`music-upload-dialog.tsx`) becomes a three-step form. Nothing uploads until step 3 is
confirmed (as today).

1. **Where is this track from?** (radio list, plain words)
   - "I made it, or I own the recording" → `owner_upload`
   - "Music library subscription (Epidemic Sound, Soundstripe, Artlist, Uppbeat, Musicbed or similar)" → `catalogue`
   - "I bought a licence for this one track" → `commercial_licence`
   - "Meta Sound Collection (downloaded with the business's Meta login)" → `meta_sound_collection`
   - "Creative Commons zero (CC0)" / "Creative Commons with credit (CC BY)" / "Public domain"
   - "Creative Commons non-commercial (CC BY-NC)" → shows immediately: "Non-commercial licences don't cover
     promoting a business, so this track can't be added." Submit disabled; server rejects `cc_by_nc`.
   - "I'm not sure" → `unknown`: allowed, but "You can try it in previews. Exports with this track are blocked
     until you confirm a licence."
2. **Licence details** (fields depend on step 1)
   - Library / seller name, plan name (e.g. "Business"), account holder ("should be the business name"), track link
     or ID at the library, download date, licence end date (optional), proof link or invoice number, notes.
   - If the plan name matches `/personal|social|creator/i`: amber note "Personal, Social and Creator plans don't
     cover business promotion. Check your plan before using this track for the shop." (memo §2). Not blocking.
   - Meta Sound Collection: destinations are fixed (Instagram, Facebook only) and shown read-only with the note
     "Meta's licence covers use on Meta's apps only. Videos with this track are marked 'For Instagram/Facebook
     upload only'." Fields: download date, date you accepted Meta's terms, asset link.
   - CC BY: credit line required: "This credit is added to your post captions automatically."
3. **Where can it be used?** Checkboxes: Promoting the business · Instagram · Facebook · TikTok · YouTube · Website ·
   Paid ads/boosts. Then the confirmation box (exists): "I confirm the business holds the rights to use this
   recording for the purposes ticked above." Server stamps `confirmedByOwnerAt`.

Track list (Settings → Music and the Studio picker) shows per track: licence chip (**Licence confirmed** /
**Not confirmed** / **Expired** / **Instagram & Facebook only**), destination chips, genre/mood chips, BPM,
duration. Editing the licence re-asks for confirmation (branch -2 behaviour kept).

### 4.7 Music preference and track choice (Studio form)

1. Settings → Editing preferences → **Music taste**: genres (chips: hip hop, R&B, lo-fi, house, pop, acoustic,
   jazz, cinematic, + free text), moods (exists: `musicMoods`), artists ("Artists you like, to find similar tracks
   in your own library").
2. Each library track has genres and moods (editable chips on the track row; `music_tracks.genres`, `moods`).
3. In the Studio generation form, the Music select gains a **"Suggested for you"** group (top 3 usable tracks) with a
   reason line ("Matches hip hop · upbeat · by an artist you like · 96 BPM suits the beat montage"). Unusable
   tracks (not ready, licence expired, shorter than the edit) are listed greyed with the reason.
4. No track is ever chosen automatically; "No music" stays a first-class choice.
5. **Length and the chosen track** (one rule, `editLengthForTrack` in `packages/core/src/edit-length.ts`, used by the
   form, `POST /api/projects/[id]/generate`, both planners and the worker): with the music start on automatic, a track
   that leaves at least 0.15 s after the edit plays as it is. A track a little shorter trims the edit to what it
   leaves (its length less 0.15 s, rounded down to 0.1 s) when that is at least 5 s and 88 % of the asked length: a
   45 s edit with a 40 s track becomes 39.8 s, the plan says "The edit was trimmed to 39.8 s so it ends before the
   music does.", and the music start picker says so before generating. A shorter track is refused before anything is
   queued: "The chosen track is 30 seconds long, which is shorter than the 45-second edit. Choose a longer track or a
   shorter length." (the form keeps **Generate** disabled with that sentence; the route answers 400). With a chosen
   start the track must leave the whole edit after it (unchanged). "Suggested for you" still never suggests a track
   shorter than the edit (item 3).
6. If an artist preference has no match: "None of your tracks are by Drake. Look for similar tracks in your music
   library subscription, then upload them here." No external search happens.
7. Settings → Integrations shows **"Music library connection — Not available. Download tracks from your
   business-eligible library and upload them with their licence details."** (state `not_configured`, no button).

### 4.8 Spotify references (Settings → Music → "Music references")

1. Owner pastes a Spotify link (`https://open.spotify.com/…/track|album|playlist|artist/<22-char id>` or a
   `spotify:` URI) and optional notes ("vibe for fade videos"). Invalid → "That isn't a Spotify link."
2. The fixed notice is always shown above the list: "Spotify links are kept for your own music reference only. They
   are not licensed for playing in the shop or in your videos."
3. Display mode (`settings.music.spotifyReferenceMode`):
   - `link_only` (default): each row shows "Open in Spotify ↗" (link to the stored URL), the notes, and a
     "Spotify" attribution label. No iframe, no network call to Spotify from the app.
   - `embed`: the official iframe `https://open.spotify.com/embed/<type>/<id>` unmodified, `loading="lazy"`, no
     autoplay parameter, with "Spotify" attribution and the link back. The switch to `embed` is enabled only when
     Settings → Business has a **Terms of use URL** and a **Privacy policy URL** and the owner ticks "I have read
     Spotify's Developer Terms and Widget Terms". The switch back to link-only is always one click.
4. References never appear in the Studio planner input, AI prompts, the website module, emails, publishing captions
   or any page outside the signed-in app (§10).

### 4.9 Sound panel in the revise flow

On each preview card, the existing "Revise" area gains a **Sound** tab next to the free-text instruction:

| Control | Values | Path |
| --- | --- | --- |
| Track | Current track / another usable library track / No music | Re-cut (planner) when the track changes; "No music" uses the fast path |
| Song section | Energy strip of the track with a window the length of the edit; drag or "Use the strongest part" (max-energy window). Shows the chosen start in m:ss | Two buttons: **Keep my cuts** (fast path: shifts `startOffsetSec`, snapped to a beat) or **Re-cut to this section** (planner with `musicStartSec`) |
| Cut to the beat | On / Off (shown only when the track has beats) | Re-cut |
| Land the reveal on a beat | On / Off (only for styles with a result shot) | Re-cut |
| Music volume | Slider 0–100 % (step 5) | Fast path |
| Original sound | Off · Under the music · Original sound only (disabled with a reason if no clip has sound) + volume slider | Fast path |
| Lower music while people talk | On / Off (`duckUnderOriginal`) | Fast path |
| Fade in / fade out | 0–3 s / 0–4 s, step 0.1 | Fast path |
| Listen | Plays the chosen section of the track (expiring link) | — |

Pressing **Apply** creates a new version (history kept, as today). Fast-path versions say "Sound changed · cuts
kept"; re-cut versions say "Re-cut to the music". Card states reuse the existing ones (planning → rendering preview
→ preview ready / failed). Each apply records a `revise` feedback event with the audio patch, which feeds music
volume learning.

**"Make a music-free version"** (card menu and the export dialog): queues `render.export` with
`variant: 'no_music'` for the **same** version (publishing design §3.4): same cuts, text and colour, music removed,
original sound as in the plan, stored as `variant_exports.no_music`. No new version is created, so the publishing
composer and the download dialog can offer it next to the standard file. (Choosing **No music** as the Track in the
Sound panel is different: it is a revision and creates a new version.)

### 4.10 Export with music clearance

1. Owner presses **Export full quality** (exists). The route computes `musicClearanceFor(track.licence)`:
   - no music → export as today;
   - cleared → export; the download dialog lists "Music cleared for: Instagram, TikTok" and, for CC BY, "Credit
     to paste in your caption: … [Copy]";
   - `meta_only` → export; the dialog and file name say "For Instagram/Facebook upload only"
     (`…-instagram-facebook-only.mp4`);
   - blocked (licence not confirmed, expired, `unknown`, or no promotional use) → 409 with
     "This version's music isn't cleared for business use: <reason>. Make a music-free version, or confirm the
     licence in Settings → Music." and two buttons. **Make a music-free version** queues the `no_music` export
     variant of this version (§4.9), which needs no clearance.
2. The worker re-checks the `standard` variant before rendering (defence in depth) and writes a `music_usage` ledger
   row with the licence snapshot after a successful export. The `no_music` variant has no music, so it is never
   checked and writes no ledger row.

### 4.11 Curated references and noted trends (Settings → Trends)

The tab shows three groups, each with its own heading and explanation, never interleaved:

1. **Live signals** (§4.12) — "Fetched from official sources. Each item shows when it was fetched."
2. **Noted by staff** — entries from the "Note a trend" form, labelled "Noted by <name> on 12 Nov 2026 · seen on
   TikTok". Buttons: **Note a trend** (any signed-in user), **Open TikTok Creative Center ↗** (opens
   `https://ads.tiktok.com/business/creativecenter/` in a new tab; the owner signs in with their own TikTok for
   Business login), **Open Google Trends ↗** (`https://trends.google.com/trends/explore?geo=AU`).
3. **Curated references** — barber content formats with source link and "Last reviewed 9 Nov 2026"; a
   **Due for review** badge after 180 days; **Mark reviewed** (owner). Unsourced formats carry the chip
   "Editor suggestion — no external source".

"Note a trend" form: What did you see? (title, required) · Describe it (summary) · Where? (TikTok · Instagram ·
YouTube · In the shop · Other) · Link (optional, http/https only) · Date seen (defaults to today, Melbourne) ·
Type (format, sound, hook, text style, pacing, other). Helper text: "Write what you saw. Don't add view counts or
'trending' unless the app showed you a number." Each card in all groups has **Use as idea**, which copies the title
and summary into the Studio "Instructions" box as "Idea: Before/after reveal — …". It never sends anything else.

### 4.12 Live signals (disabled until configured)

Two source cards at the top of the Live signals group, each with an explicit state:

**Instagram hashtag watch**

| State | When | What the owner sees |
| --- | --- | --- |
| Not configured | No connected Instagram account (`social_accounts`, publishing design) | "Connect Instagram in Settings → Integrations first. Hashtag watch also needs the hashtag search permission on your Meta app." |
| Configured, not checked | Instagram connected, no watch yet | Field "Hashtag to watch (without #)" + **Watch**. Counter "0 of 30 hashtags used this week". |
| Connected | A refresh succeeded | Watched hashtags as chips with "Fetched 14 Nov, 6:05 am"; items listed per hashtag |
| Not available | Capability check failed with a permission error | "Your Meta app setup doesn't allow hashtag search. This is optional; everything else works." + **Check again** |
| Needs re-authorisation | Graph error 190 | "Reconnect Instagram in Settings → Integrations." |
| Error | Other failure | Plain message + **Try again** + last success time |
| Quota | 30 distinct hashtags in the last 7 days | "Instagram allows 30 hashtags a week. You can add another on 18 Nov." |

Items: "Top posts under #skinfade — Instagram, fetched 14 Nov 2026, 6:05 am" heading, then up to 9 posts as rows:
media type, posted date, likes/comments as reported (when returned), **Open on Instagram ↗** (permalink). No images,
no captions, no account names are stored or shown. Items older than 48 h show "Out of date"; after 7 days they are
hidden and deleted.

**YouTube AU popular chart**

| State | When | What the owner sees |
| --- | --- | --- |
| Not configured | `YOUTUBE_API_KEY` missing | "Optional. Add a YouTube Data API key to the server to see YouTube's Australian popular chart (music, movies and gaming only)." |
| Configured, not enabled | Key present, no watch | **Show the chart** (owner) → creates the watch and runs the first fetch |
| Connected | Last fetch succeeded | Heading "YouTube AU popular chart (music/movies/gaming) — fetched 14 Nov 2026, 6:05 am"; 20 rows: title, channel, category, **Watch on YouTube ↗**. Footer: "Popular videos and songs are not licensed for your edits." |
| Error | `keyInvalid`, `accessNotConfigured`, other | Plain message + **Try again** |
| Quota | `quotaExceeded` | "YouTube's daily limit was reached. It will try again tomorrow." |

Both are read-only: nothing is posted, nothing is changed on any account. Enabling a source is an owner action and
is audit-logged.

### 4.13 Rule: never "trending" without evidence

- Labels for every trend item come from one function, `trendLabel(item)` (§6.6). The words "trending", "viral" and
  "hot right now" appear nowhere in UI copy for trend items. The only uses of "Trends" are the tab name and the
  "Google Trends" deep link.
- `validateEditPlan` rejects on-screen text overlays that contain `/\b(trending|viral|goes viral|blowing up)\b/i`
  (error `TEXT_UNSUPPORTED_CLAIM`), so neither planner can put such a claim into a video.
- No trend data, live or curated, is passed to the planners. "Use as idea" only copies the owner-visible text into
  the instruction box, where the owner can edit it.
- Music suggestions never mention popularity; YouTube chart rows carry the "not licensed" footer.

---

## 5. Data model

All changes are additive. One migration: `packages/db/drizzle/<next>_preferences_music_trends.sql` (take the next
free number when implementing; the publishing design may add its own migration — they touch different tables).
Drizzle `text(..., { enum })` creates no database check constraint (verified in `0000_init.sql`), so enum
extensions below are TypeScript-only.

### 5.1 Changed tables

| Table | Change | Type / default | Why |
| --- | --- | --- | --- |
| `edits` | add `dismissed_at` | `timestamptz null` | "Hide this edit" without deleting |
| `edit_versions` | add `render_brand` | `jsonb null` (`RenderBrandSnapshot`) | Export matches its preview |
| `edit_versions` | TS enum: `origin` unchanged; `plan_source` uses existing `'manual'` for fast-path sound versions | — | — |
| `media_assets` | add `reference_profile` | `jsonb null` (`ReferenceStyleProfile`) | Reference measurements and suggestion decisions |
| `music_tracks` | add `genres` | `jsonb not null default '[]'::jsonb` | Genre-guided suggestions |
| `feedback_events` | add index `feedback_events_created_idx` on `(created_at)` | btree | Windowed reads by `preferences.recompute` |
| `trend_references` | add `watch_id` | `text null references trend_watches(id) on delete cascade` | Live items belong to a watch |
| `trend_references` | add `external_id` | `text null` | Instagram media id / YouTube video id |
| `trend_references` | add `fetched_at` | `timestamptz null` | Shown as "fetched <date>" |
| `trend_references` | add `stale_after` | `timestamptz null` | "Out of date" badge |
| `trend_references` | add `data` | `jsonb not null default '{}'::jsonb` | Live item fields (§6.3) / noted-trend platform |
| `trend_references` | add `noted_by` | `text null references users(id) on delete set null` | "Noted by <name>" |
| `trend_references` | TS enum `source_kind`: add `'noted'` | — | Third group |
| `trend_references` | unique index `trend_references_watch_ext_idx` on `(watch_id, external_id)` `where external_id is not null` | partial unique | Idempotent refresh upserts |

### 5.2 New tables

```sql
-- Snapshot of each track's licence at the time of use (memo §2 "usage ledger").
create table music_usage (
  id text primary key,
  track_id text not null references music_tracks(id) on delete restrict,
  edit_version_id text not null,          -- no FK: versions can be deleted with their project; the ledger stays
  purpose text not null,                  -- 'export' | 'publish'
  platform text not null default '',      -- '' for export; 'instagram' | 'tiktok' | … for publish
  licence_snapshot jsonb not null,        -- MusicLicence as it was
  clearance jsonb not null,               -- MusicClearance result
  created_by text references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index music_usage_version_purpose_idx on music_usage (edit_version_id, purpose, platform);
create index music_usage_track_idx on music_usage (track_id, created_at);

-- Private Spotify references (memo §1): URL, parsed id and the owner's notes only.
create table music_references (
  id text primary key,
  provider text not null default 'spotify',
  url text not null,                      -- canonical https://open.spotify.com/<type>/<id>
  item_type text not null,                -- 'track' | 'album' | 'playlist' | 'artist'
  external_id text not null,              -- 22-char Spotify id
  notes text not null default '',
  created_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index music_references_provider_ext_idx on music_references (provider, item_type, external_id);

-- One row per live source query the owner enabled.
create table trend_watches (
  id text primary key,
  provider text not null,                 -- 'instagram_hashtag' | 'youtube_chart'
  query text not null,                    -- hashtag (lower case, no #) or region code 'AU'
  external_id text,                       -- ig hashtag id once resolved
  social_account_id text references social_accounts(id) on delete cascade,  -- Instagram only
  enabled boolean not null default true,
  status text not null default 'pending', -- 'pending' | 'ok' | 'unavailable' | 'needs_reauth' | 'quota' | 'error'
  status_message text not null default '',
  last_queried_at timestamptz,            -- counts towards the 30-per-7-days hashtag budget
  last_success_at timestamptz,
  created_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index trend_watches_provider_query_idx on trend_watches (provider, query);
```

Removing a hashtag watch sets `enabled=false` (and deletes its items) but keeps the row for 7 days so the budget
stays correct; `maintenance.cleanup` deletes disabled watches whose `last_queried_at` is older than 7 days.

### 5.3 JSON contracts (Zod in `packages/core`, no migration)

`EditingPreferencesSchema` (settings.data.preferences) — additions, all with defaults:

```ts
export const LEARNABLE_FIELDS = ['defaultDurationSec', 'styleOrder', 'pacing', 'textDensity', 'transitions', 'colour', 'musicVolume'] as const;
export type LearnableField = (typeof LEARNABLE_FIELDS)[number];

styleOrder: z.array(StyleIdSchema).default([]),            // declared order; [] = STYLE_IDS order
musicGenres: z.array(z.string().max(40)).max(12).default([]),
musicArtists: z.array(z.string().max(80)).max(12).default([]),
learning: z.object({
  enabled: z.boolean().default(true),
  resetAt: z.string().nullable().default(null),           // ISO; events before it are ignored
  pinned: z.record(z.enum(LEARNABLE_FIELDS), z.object({
    by: z.enum(['owner', 'reference']),
    at: z.string(),
    referenceAssetId: z.string().nullable().default(null),
    referenceName: z.string().max(200).default(''),
  })).default({}),
}).default({ enabled: true, resetAt: null, pinned: {} }),
learned: LearnedPreferencesSchema.default(EMPTY_LEARNED),   // written only by preferences.recompute
```

```ts
export const LearnedFieldSchema = z.object({
  value: z.unknown(),                    // validated per field by learnedValueSchemas[field]
  weight: z.number(),                    // total evidence weight after recency decay
  counts: z.object({ favourites: z.number().int(), downloads: z.number().int(), publishes: z.number().int(),
                     revisions: z.number().int(), regenerations: z.number().int(), dismissals: z.number().int() }),
  explanation: z.string().max(300),      // plain sentence shown in Settings
});
export const LearnedPreferencesSchema = z.object({
  computedAt: z.string().nullable(),
  eventsConsidered: z.number().int(),
  since: z.string().nullable(),          // oldest event used
  fields: z.record(z.enum(LEARNABLE_FIELDS), LearnedFieldSchema).default({}),
  error: z.string().nullable().default(null),
});
```

`preferredStyles` stays (owner's style picks); `styleAffinity` stays and is now written by the recompute job (rounded
positive scores) so the existing Settings display keeps working.

`BrandConfigSchema` additions: `logoPlacement: z.enum(['off','end_card','corner','both']).default('off')`,
`logoCorner: z.enum(['top_left','top_right']).default('top_left')`,
`logoOpacity: z.number().min(0.6).max(1).default(0.85)`.

`BusinessConfigSchema` additions: `termsUrl`, `privacyUrl` (`z.string().max(500).default('')`, http(s) only when set).

New `AppSettings.music` section: `{ spotifyReferenceMode: z.enum(['link_only','embed']).default('link_only'),
spotifyTermsAcknowledgedAt: z.string().nullable().default(null) }`.

`MusicLicenceSchema` (memo §2 build notes) — additions, old rows still parse:

```ts
kind: z.enum(['owner_upload','catalogue','commercial_licence','meta_sound_collection','cc0','cc_by','cc_by_nc','public_domain','unknown']),
accountHolder: z.string().max(120).default(''),
planName: z.string().max(120).default(''),
providerTrackRef: z.string().max(300).default(''),
downloadedAt: z.string().nullable().default(null),
termsAcceptedAt: z.string().nullable().default(null),       // Meta Sound Collection
permitted: { …existing, facebook: z.boolean().default(false), paidAds: z.boolean().default(false) },
destinationLock: z.enum(['meta_only']).nullable().default(null),
```

`PUBLISH_PLATFORMS` gains `'facebook'` (memo §2: "Add a `facebook` platform"). It is a licence-coverage platform;
`publish_targets.platform` stays `instagram | tiktok`.

`normaliseLicence(licence)` (core) forces: `meta_sound_collection` → `destinationLock='meta_only'`, permitted
`tiktok=youtube=website=false`; `cc_by` → `attributionRequired=true`. `CreateMusicTrackSchema` and
`UpdateMusicTrackSchema` refine: `kind !== 'cc_by_nc'` ("Non-commercial licences can't be used to promote a
business."), `cc_by` needs non-empty `attributionText`.

`RenderBrandSnapshot` = `RenderBrand` (§6.5) minus the local logo path plus `logoStorageKey` and `logoSha256`.

`ReferenceStyleProfile` (`packages/core/src/reference.ts`):

```ts
{
  version: 1, assetId: string, measuredAt: string, sourceFilename: string,
  durationSec: number, shotCount: number,
  shotSec: { median: number, p25: number, p75: number }, cutsPer10Sec: number,
  look: { meanLuma: number /*0–1*/, meanSaturation: number /*0–1*/, contrast: number /*0–1*/ },
  colourLook: 'natural' | 'clean' | 'cinematic' | 'punchy',
  text: { density: 'none' | 'light' | 'medium' | null, framesChecked: number, framesWithText: number,
          source: 'vision_model' | 'not_measured' },
  suggestions: Array<{ field: 'defaultDurationSec' | 'pacing' | 'colour' | 'textDensity', value: unknown, reason: string }>,
  decisions: Partial<Record<'defaultDurationSec' | 'pacing' | 'colour' | 'textDensity', 'accepted' | 'dismissed'>>,
  originalsDeletedAt: string | null,
}
```

Reference style v2 (§4.3.1.5): new profiles are written as `version: 2` with the same fields plus
`style: ReferenceStyleSignals`; `ReferenceStyleProfileSchema` becomes a discriminated union of v1 and v2 and every
reader uses `readReferenceProfile` (v1 → v2 shape with `style: null`). `EditingPreferencesSchema` gains the
`editingStyle` object (`transitionPalette`, `beatSync`, `beatsPerCut`, `reveal`, `zoom`, `musicFit`, `sources`,
`summaryDecisions`, all defaulted), and `PinSchema` gains `referenceAssetIds` (default `[]`). No migration: both
live in existing jsonb columns.

`PlanFacts` (`packages/core/src/plan-facts.ts`, computed with `computeTimeline`):

```ts
{ styleId, durationSec, segmentCount, avgShotSec, medianShotSec, textOverlayCount, textPer10Sec,
  transitionCount, flashyTransitionCount, colourPreset, hasMusic: boolean, musicTrackId: string | null,
  musicVolume: number | null, musicStartSec: number | null, originalSound: boolean, beatAligned: boolean }
```

`AudioPatchSchema` (`packages/core/src/audio-patch.ts`):

```ts
{
  music: z.enum(['keep', 'none']).default('keep'),
  trackId: z.string().optional(),                 // change track → re-cut
  startSec: z.number().min(0).max(3600).nullable().optional(),
  keepCuts: z.boolean().default(true),            // false with startSec → re-cut
  beatSync: z.enum(['keep', 'on', 'off']).default('keep'),
  revealOnBeat: z.enum(['keep', 'on', 'off']).default('keep'),
  volume: z.number().min(0).max(1).optional(),
  fadeInSec: z.number().min(0).max(3).optional(),
  fadeOutSec: z.number().min(0).max(4).optional(),
  duckUnderOriginal: z.boolean().optional(),
  originalSound: z.enum(['keep', 'off', 'under_music', 'only']).default('keep'),
  originalVolume: z.number().min(0).max(1).optional(),
}
// needsRecut(patch) = trackId !== undefined || beatSync !== 'keep' || revealOnBeat !== 'keep' || (startSec != null && !keepCuts)
```

`MusicClearance` (`packages/core/src/music.ts`):

```ts
{ state: 'no_music' | 'cleared' | 'restricted' | 'blocked',
  platforms: PublishPlatform[], blockedPlatforms: PublishPlatform[],
  destinationLock: 'meta_only' | null, attributionText: string | null, reasons: string[] }
```

---

## 6. Algorithms (pure functions in `packages/core`, unit-tested)

### 6.1 `computeLearnedPreferences(events, prefs, now)`

Input: `feedback_events` with `created_at > max(learning.resetAt, now − 180 days)`, newest 1,000, each with its
`data.planFacts` / `parentPlanFacts` / `hints` / `audioPatch`. Events without facts (rows from before this change)
are used for style order only.

1. **Collapse per version** (`editVersionId`; for favourite/dismiss per `editId`, latest state wins):
   favourited (net), downloaded (once), published (once), dismissed (net), plus every revise/regenerate event.
2. **Weights**: favourited +3, published +3, downloaded +2, dismissed −2, regenerate −1 (applies to the parent's
   style only), revise hints as listed per field. **Recency**: `w × 0.5^(ageDays / 60)`. A version that is both
   favourited and downloaded scores 5.
3. **Positive versions** = net weight > 0.
4. **Fields** (each only if total weight ≥ threshold; otherwise no learned value):

| Field | Evidence | Rule | Threshold |
| --- | --- | --- | --- |
| `styleOrder` | All versions with a style | score = Σ signed weights per style; order by score desc, ties by `STYLE_IDS` order; `styleAffinity` = rounded positive scores | ≥ 3 events |
| `defaultDurationSec` | Positive versions' `durationSec`; revise `targetDurationSec>0` (w 2); relative revise −1/−2 → parent duration × 0.75 / × 1.3 (w 2) | weighted median, rounded to nearest 5, clamped 8–90; emitted only if it differs from the declared value by ≥ 3 s | weight ≥ 6, ≥ 3 distinct versions |
| `pacing` | Positive versions: r = `avgShotSec` ÷ style baseline (`(pacing.minShotSec + maxShotSec)/2`); hints faster → r 0.75 (w 2), slower → 1.3 (w 2) | weighted geometric mean; < 0.88 fast, > 1.14 slow, else balanced | weight ≥ 6 |
| `textDensity` | Positive versions: `textPer10Sec` 0 → none(0), ≤ 1 → light(1), > 1 → medium(2); hints none → 0 (w 3), less → parent level − 1 (w 2), more → + 1 (w 2) | weighted mean rounded | weight ≥ 6 |
| `transitions` | hints restrained/none → restrained (w 3); positive version with `flashyTransitionCount > 0` → varied (its weight); with none → restrained (w 1) | weighted majority | weight ≥ 6 |
| `colour` | Positive versions' `colourPreset`, counted only if the same preset was kept on versions of ≥ 2 different styles (otherwise it is just the style's own look); revise colour hints (w 3, new `hints.colour`, §6.7) | weighted majority with share ≥ 60 % | weight ≥ 6 |
| `musicVolume` | Positive versions with music: `musicVolume`; hints quieter → parent × 0.7, louder → × 1.25 (w 2, same factors as `rules/settings.ts`); sound-panel `volume` (w 3) | weighted mean, rounded to 0.05, clamped 0.1–1; emitted if Δ ≥ 0.05 | weight ≥ 5 |

5. **Explanation**: `"From 4 favourites, 2 downloads and 1 revision since 3 Oct 2026."` (dates formatted in
   `Australia/Melbourne`; counts only of events that contributed to that field).
6. Output conforms to `LearnedPreferencesSchema`; deterministic for the same input (sorted inputs, no randomness).

`effectivePreferences(prefs): EditingPreferences & { styleOrder: StyleId[] }` resolves each learnable field
(§3). `buildPlannerInput` (worker), `effectiveSettings` (rules planner) and the Studio `defaults` DTO call it, so the
planners keep reading `preferences.pacing` etc. unchanged. Style order affects the order of cards for a new
generation and which styles are pre-ticked; it never hides a style.

### 6.2 Reference profile → suggestions (`profileReference`)

- Shots from the existing `detectScenes` + `assembleShots`; durations of shots ≥ 0.2 s.
- `look` from the new `measureLook` (§8.3): mean of per-frame `YAVG/255`, `SATAVG/181` (8-bit chroma
  distance maximum ≈ 181), contrast = mean `(YHIGH − YLOW)/255`.
- `colourLook`: saturation > 0.32 and contrast > 0.22 → punchy; saturation < 0.18 and contrast > 0.20 →
  cinematic; luma > 0.55 and saturation < 0.28 → clean; else natural. Shown as "estimate".
- `pacing`: median shot < 1.0 s → fast; 1.0–2.2 s → balanced; > 2.2 s → slow.
- `defaultDurationSec`: duration rounded to nearest 5 s, only if 8 ≤ duration ≤ 90.
- `textDensity` (only when measured): framesWithText / framesChecked = 0 → none, ≤ 0.4 → light, > 0.4 → medium.
- A suggestion equal to the current effective value is kept with `reason` "matches your settings" (no button).
- Accept → declared value set, field pinned `{ by: 'reference', referenceAssetId, referenceName }`,
  `decisions[field]='accepted'`.
- v2 (§4.3.1): shots come from the v2 boundaries (no merging or splitting) instead of `detectScenes` defaults; the
  transition, beat, drop, zoom and music signals and their suggestions are computed by
  `packages/core/src/reference-style.ts` and offered, combined across videos, in the "Your style from your videos"
  summary (§4.3.1.4, §4.3.1.9).

### 6.3 Live trend items

Instagram item `data`: `{ mediaType, postedAt, likeCount?, commentsCount?, permalink }` (only fields returned; never
caption, media URL or username). YouTube item `data`: `{ channelTitle, categoryId, url }`; `title` stored in
`trend_references.title`. `fetched_at = now`, `stale_after = now + 48 h`, `last_verified_at = now`,
`source_kind='live'`, `source_name` = the label from `trendLabel`, `source_url` = permalink / watch URL.

Hashtag budget: `usedThisWeek = count(*) from trend_watches where provider='instagram_hashtag' and last_queried_at >
now() − interval '7 days'`. A new hashtag is refused at 30; a refresh of an existing hashtag does not add to the
count but updates `last_queried_at` (so it stays counted). The UI keeps a safety margin: at most **10 enabled**
hashtags.

### 6.4 `MusicCatalogueProvider` (interface only)

```ts
export interface MusicCatalogueProvider {
  readonly id: string;                 // e.g. 'soundstripe'
  readonly name: string;
  /** Business-eligible plan confirmed in writing by the owner (memo §2); the adapter refuses to run otherwise. */
  search(query: { text?: string; genres?: string[]; moods?: string[]; minDurationSec?: number }, opts?: { signal?: AbortSignal }):
    Promise<Array<{ providerTrackId: string; title: string; artist: string; durationSec: number; bpm: number | null; previewUrl: string | null }>>;
  /** The licence passport this provider grants for one track under the owner's plan (owner still confirms). */
  licenceFor(providerTrackId: string): Promise<Omit<MusicLicence, 'confirmedByOwnerAt'>>;
  /** Downloads the licensed file into the worker temp dir (never a watermarked preview). */
  download(providerTrackId: string, destPath: string, opts?: { signal?: AbortSignal }): Promise<{ mimeType: string; byteSize: number }>;
}
```

No implementation, env var or route ships. `music_tracks.source='catalogue'`, `catalogue_provider`,
`catalogue_track_id` already exist for a later adapter (memo §2: production keys need sales/enterprise agreements).

### 6.5 Logo rendering (`packages/media`)

`RenderBrand` gains `logo: { path: string; width: number; height: number; placement: 'end_card' | 'corner' | 'both';
corner: 'top_left' | 'top_right'; opacity: number } | null`.

Geometry at 1080 × 1920 (scaled with `scaleSafeZone` for previews; uses `zone.head`, i.e. R_head x 120–960,
y 270–840):

- **Corner mark**: fit inside 150 × 150 keeping aspect; inset 12 px: top-left at (132, 282); top-right at
  (960 − 12 − w, 282). Shown for the whole video at `opacity`, **except** while any `top` text overlay or a top-placed
  handle is on screen (the overlay's `enable` expression excludes those windows). Bottom edge ≤ 432 < 840, so it is
  always inside R_head.
- **End card**: fit inside 420 × 300; centred at x = 540, box top at y = 380 (bottom ≤ 680 ≤ 840). Shown for the last
  `min(2.0 s, 0.3 × total)`, fading in over 0.3 s, at opacity 1. Skipped (corner mark used instead when placement is
  `both`) if any `top` or `centre` text overlay overlaps that window. The handle text keeps its existing lower
  placement (R_strict), which never overlaps y 380–680.
- Filter graph (before the `ass` filter so text stays on top):
  `-loop 1 -i logo.png` →
  `[L]scale=W:H:flags=lanczos,format=rgba,colorchannelmixer=aa=<opacity>[lg]` →
  `[v][lg]overlay=x=X:y=Y:enable='<expr>':format=auto[v2]`; the end card uses a second, trimmed copy with
  `fade=t=in:st=<start>:d=0.3:alpha=1`.
- The logo is downloaded from `brand/logo.<ext>` into the job temp dir; a missing logo file renders without it and
  sets the version message "Logo not found — rendered without it".
- `verify.ts` (branch -1) gains `checkOverlayRects(rects, zone)`: every logo rectangle ⊂ `zone.head` and disjoint
  from `zone.forbidden`.

`resolveRenderFont(name)`: returns the name if a matching file exists in `fontsDir` (cached listing), else `'Inter'`
with a warning log.

### 6.6 `trendLabel(item)`

| Kind | Label (exact) |
| --- | --- |
| live, `instagram_hashtag` | `Top posts under #<tag> — Instagram, fetched <d MMM yyyy, h:mm a>` |
| live, `youtube_chart` | `YouTube AU popular chart (music/movies/gaming) — fetched <d MMM yyyy, h:mm a>` |
| noted | `Noted by <name> on <d MMM yyyy>` (+ ` · seen on <platform>`) |
| curated, with source | `<sourceName> · last reviewed <d MMM yyyy>` |
| curated, no source URL | `Editor suggestion — no external source · last reviewed <d MMM yyyy>` |

Unit test: no label contains `/trending|viral/i`.

### 6.7 Small parser/planner changes

- `parseRevisionInstruction` gains `colour: 'keep' | 'natural' | 'clean' | 'cinematic' | 'punchy'` from phrases
  ("more natural colour", "punchier", "more contrast" → punchy, "moodier"/"cinematic" → cinematic, "brighter and
  cleaner" → clean) and `beatSync: 'keep' | 'on' | 'off'` ("cut to the beat", "ignore the beat").
- `PlannerInput` gains `beatSync: 'auto' | 'on' | 'off'` and `revealOnBeat: boolean`. Rules planner: `off` uses
  natural shot lengths (no beat snapping); `revealOnBeat` snaps the start of the first `result` segment to the
  nearest beat (downbeat preferred) of the grid within ±0.25 s. The AI prompt gets the same two fields.
- `effectiveSettings`: `textDensity` `medium` → `text: 'more'`; `light` → `'normal'`; `none` → `'none'`.
- `applyAudioPatch(plan, patch, ctx)` (fast path): sets `audio.music` volume/fades/duck/startOffset (snapped with
  `snapMusicStart`), `music: 'none'` → `audio.music = null`; `originalSound`: `off` → `originalSound.enabled=false`
  and every `segment.keepOriginalSound=false`; `under_music` → enabled with `originalVolume`, `keepOriginalSound =
  asset.hasAudio`; `only` → `audio.music = null` and as `under_music`. Returns a plan that must still pass
  `validateEditPlan` (music start + duration ≤ track length, kept sound only on clips with audio).
- `validateEditPlan`: new error `TEXT_UNSUPPORTED_CLAIM` (§4.13).

---

## 7. Jobs

Added to `JOB_TYPES`, `JOB_PAYLOAD_SCHEMAS`, `QUEUE_SETTINGS`, `defaultRefId` and the worker's handler map (the
worker refuses to start if a type has no handler — `main.ts`). All handlers use `TrackedRun`, honour
`run.signal`, and are idempotent.

| Type | Payload (Zod) | Dedupe / idempotency | Queue settings | What it does / calls |
| --- | --- | --- | --- | --- |
| `preferences.recompute` | `{ reason: z.enum(['feedback','reset','settings','schedule']).default('feedback') }` | `singletonKey: 'preferences:recompute'`, `startAfterSeconds: 10` (debounce). Pure recompute from events, so a duplicate run is harmless. Writes only `data→preferences→learned` and `styleAffinity` with `jsonb_set` in one `UPDATE … WHERE id='default'`, never the whole settings object. | retryLimit 2, retryDelay 10, backoff, expire 300 s, heartbeat 60 | Reads `feedback_events`; `computeLearnedPreferences`. On failure writes `learned.error`. Also scheduled nightly `17 3 * * *` (`Australia/Melbourne`) so recency decay applies. `refId` = `'preferences'`. |
| `reference.analyse` | `{ assetId: z.string(), projectId: z.string(), useVision: z.boolean().default(false) }` | `singletonKey: 'reference:' + assetId`; skips if `reference_profile` exists; deleting originals is last and tolerant of "already gone". | retryLimit 2, retryDelay 15, backoff, expire 1800 s, heartbeat 60 | Enqueued by `ingest.asset` at the end for `kind='reference_video'`. Downloads proxy, `measureLook`, uses stored shots; if `useVision` and AI configured: `estimateOnScreenText` on ≤ 8 frames (`recordAiUsage(…, 'reference:text', usage)`). Writes profile, then deletes original + proxy + frames (keeps thumbnail), sets `originalsDeletedAt`. **v2 (§4.3.1.2), payload unchanged:** after `measureLook`, `measureReferenceStyle` on the proxy (Pass A per-frame scores, Pass B tiny grey frames, Pass C beats/energy when there is audio; first 120 s; progress "Measuring transitions" / "Measuring the beat"); writes a `version: 2` profile. A failed audio pass marks beat/drop/music `not_measured`; a failed Pass A/B fails the attempt (pg-boss retries; originals are still there because deletion stays last). Skip rule: any stored profile (v1 or v2) is not re-measured. |
| `trends.refresh` | `{ watchId: z.string().nullable() }` (null = all enabled watches) | `singletonKey: 'trends:' + (watchId ?? 'all')`; items upserted on `(watch_id, external_id)`; items not in the new result for that watch are deleted. | retryLimit 1, retryDelay 300, expire 300 s, heartbeat 60 | `null` → enqueues one job per enabled watch and exits. Per watch: Instagram (§8.1) or YouTube (§8.2). Scheduled daily `41 5 * * *` Melbourne. Manual refresh allowed once per 6 h per watch (route-enforced). |
| `edits.revise` (changed) | add `mode: 'audio'` to the enum and `audio: AudioPatchSchema.optional()` | unchanged (`newVersionId`; skips if the version already has a plan) | unchanged | `mode 'audio'`: load parent plan → `applyAudioPatch` → `validateEditPlan` (same context builder) → store with `planSource 'manual'`, `plannerModel null` → enqueue `render.preview` (`singletonKey preview:<id>`). `mode 'revise'` with an `audio` patch that needs a re-cut: music track = `patch.trackId ?? parentPlan.audio.music?.trackId ?? null` (falls back to `generation.settings.musicTrackId` only when there is no parent plan); passes `musicStartSec`, `beatSync`, `revealOnBeat` to the planner. |
| `render.preview` (changed) | unchanged | unchanged | unchanged | Builds `RenderBrand` from settings (with logo), stores the snapshot in `edit_versions.render_brand`. |
| `render.export` (changed) | add `variant: 'standard' \| 'no_music'` (default `standard`; publishing design §3.4, built by WP1) | `export:{versionId}:{variant}` | unchanged | Uses `render_brand` snapshot (falls back to current settings for old versions; WP2). For `standard` only, before rendering: `musicClearanceFor`; `blocked` → `AppError('UNSUPPORTED', …)` (no retry); after success insert `music_usage` (`on conflict do nothing`). `no_music` renders the plan with `audio.music = null` into `editExportVariant(...)` and updates `edit_versions.variant_exports.no_music`. Both call the export-ready hooks (WP0). |
| `ingest.asset` (changed) | unchanged | unchanged | unchanged | For `kind='reference_video'`: probe, proxy, thumbnail, scenes, quality, audio analysis; **skip** vision labelling and transcription; sample 8 frames only when `useVision` (read from the upload's `driverState.referenceOptions`); then enqueue `reference.analyse`. |
| `maintenance.cleanup` (changed) | unchanged | unchanged | unchanged | Also deletes live trend items with `fetched_at < now − 7 days` and disabled watches with `last_queried_at < now − 7 days`. |

Feedback recording helper (web, `apps/web/src/lib/feedback.ts`): `recordFeedback(tx, event)` inserts inside the
caller's transaction; after commit `scheduleRecompute()` calls `createTrackedJob({ type: 'preferences.recompute',
payload: { reason: 'feedback' }, singletonKey: 'preferences:recompute', startAfterSeconds: 10 })`. A failure to
enqueue is logged and never fails the owner's action (the nightly run catches up). `setFavourite` stops editing
`styleAffinity` in the request (removes a read-modify-write race on `settings`).

`createTrackedJob` and `JobQueue.enqueue` need a `startAfterSeconds` pass-through on the web side (the queue already
supports it).

---

## 8. External API calls

All calls run in the worker with `AbortSignal`, a 15 s timeout, no retries inside the handler (pg-boss retries),
and log only status codes and error codes (never tokens).

### 8.1 Instagram hashtag watch (Graph API, memo §11)

Prerequisite: a connected Instagram account from the publishing module (`social_accounts`, `status='connected'`,
provider `meta_graph`). The token is the system-user token in that account's `integration_connections` row
(provider `meta`, via `connection_id`), decrypted in the worker with the WP0 credentials helper; `social_accounts`
holds no token (publishing design §5.2). Calls go through the publishing module's Graph client
(`apps/worker/src/publishing/instagram.ts` / `src/lib/meta/graph.ts`) and its `mapGraphError`. Graph version:
`META_GRAPH_VERSION` as defined by the publishing design.

1. First refresh of a watch (no `external_id`):
   `GET https://graph.facebook.com/{v}/ig_hashtag_search?user_id={ig-user-id}&q={hashtag}` →
   `{ data: [{ id }] }`; store `external_id`; set `last_queried_at = now()` (counts towards 30/7 days).
2. Every refresh:
   `GET https://graph.facebook.com/{v}/{ig-hashtag-id}/top_media?user_id={ig-user-id}&fields=id,media_type,permalink,timestamp,like_count,comments_count&limit=9`
   (field list to be confirmed against the live reference; request only these). Token in the `Authorization:
   Bearer` header, not the query string.
3. Scopes: the account's existing publishing scopes plus the hashtag search permission listed in the App Dashboard
   (memo §11: "the hashtag-search permissions and the 'Instagram Public Content Access' feature"). Least privilege:
   the hashtag permission is requested only when the owner turns hashtag watch on: the owner adds it to the **same**
   Facebook Login for Business configuration (`META_LOGIN_CONFIG_ID`; the login dialog sends no `scope`, so the
   configuration decides the permissions) and reconnects Instagram. There is no second configuration.
4. Limits: 30 unique hashtags per 7 days per account (memo §11); at most 10 enabled; one refresh per watch per day
   (plus manual, ≥ 6 h apart).

| Graph error (third-party code tables, memo §4) | Mapping |
| --- | --- |
| `code 190` | watch `needs_reauth`; `social_accounts.status='needs_reauth'` is the publishing module's call — this job only reports |
| `code 10`, `code 200–299`, or "permission"/"feature" in message | watch `unavailable`; `social_accounts.capabilities.hashtagSearch=false`; no retry |
| `code 4`, `17`, `32`, `613` (rate limits) | watch `quota`, message "Instagram asked us to slow down; trying again tomorrow"; no retry |
| hashtag limit message (30 per 7 days) | watch `quota` with next free date |
| empty `data` from `ig_hashtag_search` | watch `error`: "Instagram found no hashtag with that name" |
| network/5xx | job fails → one pg-boss retry after 300 s; watch `error` after the last attempt |

### 8.2 YouTube AU popular chart (YouTube Data API v3, memo §11)

`GET https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=AU&maxResults=20&key={YOUTUBE_API_KEY}`
— 1 quota unit per call, default 10,000 units/day (memo §11). One call per day plus manual refreshes. The key is a
server-side env var, restricted in Google Cloud to the YouTube Data API v3 (owner checklist).

| Response | Mapping |
| --- | --- |
| 200 | upsert items (id, `snippet.title`, `snippet.channelTitle`, `snippet.categoryId`, `https://www.youtube.com/watch?v=<id>`) |
| 400 `keyInvalid` / `badRequest` | watch `error`: "The YouTube API key isn't valid." |
| 403 `accessNotConfigured` | watch `error`: "Turn on YouTube Data API v3 in your Google Cloud project." |
| 403 `quotaExceeded` / `dailyLimitExceeded` | watch `quota` |
| 5xx / network | retry once, then `error` |

The memo notes "No parameter identifies Shorts" and that the chart covers music, movies and gaming only since
21 July 2025; the label says so.

### 8.3 Media and AI (local / existing providers)

- `measureLook(input, { probe, ffmpegPath, signal })` in `packages/media/src/analysis/look.ts`:
  `ffmpeg -i proxy.mp4 -vf "fps=2,signalstats,metadata=mode=print:file=-" -an -f null -` → parse
  `lavfi.signalstats.YAVG`, `SATAVG`, `YLOW`, `YHIGH`.
- `estimateOnScreenText(frames, { signal })` in `packages/ai` (Anthropic only; `null` provider when AI is off):
  model `AI_VISION_MODEL` (default `claude-haiku-5-5`), `effort: 'low'`, `client.messages.parse` with
  `output_config.format = zodOutputFormat(z.object({ frames: z.array(z.object({ index: z.number().int(),
  hasOnScreenText: z.boolean(), coverage: z.enum(['none','small','large']) })) }))`, ≤ 8 base64 JPEG frames at
  432×768, `transformations: { oversized_image: 'error' }` per image (memo §10). Prompt: "Say only whether added
  on-screen text (titles, captions, stickers) is visible in each frame and roughly how much of the frame it covers.
  Do not read out or transcribe the text. Do not identify or describe people." Parse failure, refusal or
  max-tokens → `text.source = 'not_measured'` (never guessed).

### 8.4 Spotify

None. Link-only mode makes no request. Embed mode is a browser iframe to `https://open.spotify.com/embed/…`; the
server never fetches oEmbed or any Spotify endpoint (memo §1).

---

## 9. API routes

All under `/api`, session required, JSON errors as in `docs/api.md`, CSRF guard on every non-GET (existing
`handleApi`). "Owner" = `requireOwner(user)`.

### 9.1 Preferences and feedback

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| GET | `/api/preferences` | — | `{ declared: EditingPreferences, effective, learned, learning, reasons: Record<field, { source: 'learned'\|'owner'\|'reference'\|'default', explanation, suggestion? }>, recent: FeedbackSummary[] }` | signed in (staff read-only) |
| POST | `/api/preferences/pin` | `{ field: LearnableField, pinned: boolean, value?: unknown }` (value validated per field; pinning without value pins the current effective value) | `{ preferences }` | owner; audit `preferences.pinned` / `.unpinned` |
| POST | `/api/preferences/learning` | `{ enabled: boolean }` | `{ preferences }` | owner; audit `preferences.learning_toggled` |
| POST | `/api/preferences/reset` | `{ confirm: true }` | `{ preferences }`; sets `resetAt=now`, clears `learned`, enqueues recompute | owner; audit `preferences.learning_reset` |
| PUT | `/api/settings` (changed) | rejects `preferences.learned` and `preferences.learning` with `VALIDATION` "Use the preferences controls"; any changed learnable field in the patch is pinned `by: 'owner'` | unchanged | owner |
| POST | `/api/edits/[id]/dismiss` | `{ value: boolean }` | `{ dismissed: boolean }` | studio access (`getAccessibleEdit`) |

`GET /api/projects/[id]/status` (changed): edit DTOs gain `dismissed: boolean`; `defaults` come from
`effectivePreferences` and gain `styleOrder`, `musicVolume`; a new `references: ReferenceDto[]`
(`{ id, filename, status, statusMessage, thumbnailUrl, profile }`); `music` options gain `licenceState`,
`suggestion?: { rank, reasons[] }`.

### 9.2 Reference videos

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| POST | `/api/projects/[id]/uploads` (changed) | `kind: 'reference_video'` now accepted (video MIME rules), plus optional `referenceOptions: { useVision: boolean }` stored in `driverState` | unchanged | studio access |
| POST | `/api/uploads/[id]/complete` (changed) | — | `{ assetId, kind: 'reference_video' }`; queues `ingest.asset` | studio access; audit `reference.uploaded` |
| GET | `/api/references` | — | `{ references: Array<ReferenceDto & { projectId, projectTitle }> }` | owner |
| POST | `/api/references/[assetId]/decide` | `{ accept: SuggestionField[], dismiss: SuggestionField[] }` | `{ profile, preferences }` | owner; audit `reference.suggestions_decided` |
| GET | `/api/references/summary` (v2, §4.3.1.9) | — | `{ summary: ReferenceStyleSummary, suggestions: SummarySuggestion[], videos: { total, measured, olderMeasurement, olderVersion, measuring, failed } }` (`olderVersion`: measured with an older version of the measuring, not combined) | signed in (staff read-only) |
| POST | `/api/references/summary/decide` (v2) | `{ accept: ReferenceSummaryField[], dismiss: ReferenceSummaryField[], valueKeys: Record<field, string> }` | `{ summary, preferences }`; 409 `CONFLICT` "Your style summary changed — check the new suggestion." when a `valueKey` no longer matches | owner; audit `reference.summary_decided` |
| PUT | `/api/settings` (v2 change) | `preferences.editingStyle` value fields editable; `sources` and `summaryDecisions` rejected with `VALIDATION`; a changed field records `sources[field] = { by: 'owner' }` | unchanged | owner; audit `preferences.editing_style_changed` |
| DELETE | `/api/assets/[id]` (existing) | — | — | studio access; works for references |

### 9.3 Music

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| POST / PATCH | `/api/music`, `/api/music/[id]` (changed) | licence schema additions (§5.3), `genres: string[]` | `MusicTrackSummary` + `genres`, `licenceState: 'confirmed'\|'not_confirmed'\|'expired'\|'meta_only'` | owner for licence changes (as today: owner-only settings) |
| GET | `/api/music/[id]/listen` | — | `{ url, expiresInSeconds }` (expiring link to the track file, `Content-Type` audio) | signed in |
| GET | `/api/music/suggestions?durationSec=25&styleId=beat_montage` | — | `{ tracks: Array<{ id, score, reasons: string[], usable: boolean, unusableReason?: string }> }` | signed in |
| GET | `/api/music/references` | — | `{ mode, canEmbed: boolean, missing: string[], references: MusicReferenceDto[] }` | signed in |
| POST | `/api/music/references` | `{ url, notes? }` | `MusicReferenceDto` (409 if already saved) | owner; audit `music.reference_added` |
| PATCH / DELETE | `/api/music/references/[id]` | `{ notes }` | `MusicReferenceDto` / `{ ok }` | owner; audit `music.reference_removed` |
| PUT | `/api/settings` `music` section | `{ spotifyReferenceMode, acknowledgeSpotifyTerms?: true }` — `embed` refused (`CONFLICT`) unless both legal URLs are set and acknowledgement given | settings | owner; audit `music.spotify_mode_changed` |
| POST | `/api/edits/[id]/revise` (changed) | `{ instruction?: string, audio?: AudioPatch }` (at least one) → `mode 'audio'` when the patch needs no re-cut and there is no instruction, else `'revise'` | `{ version, jobId }` | studio access |
| POST | `/api/edit-versions/[id]/export` (changed) | — | adds `musicClearance: MusicClearance`; 409 `CONFLICT` with `details.musicClearance` when blocked | studio access |
| GET | `/api/edit-versions/[id]/download` (changed) | — | adds `musicClearance`; file name suffix `-instagram-facebook-only` for `meta_only` | studio access |

### 9.4 Trends

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| GET | `/api/trends` (changed shape) | — | `{ live: Array<{ watch, items: TrendItemDto[] }>, noted: TrendItemDto[], curated: TrendItemDto[], sources: TrendSourceStatus[] }`; each item carries `label` from `trendLabel` | signed in |
| POST / PUT / DELETE | `/api/trends` (existing) | curated only; `sourceKind` cannot be set by clients | unchanged | owner |
| POST | `/api/trends/notes` | `{ title, summary?, platform: 'tiktok'\|'instagram'\|'youtube'\|'in_person'\|'other', sourceUrl?, seenOn: 'YYYY-MM-DD', category }` | `TrendItemDto` (`source_kind 'noted'`) | signed in; audit `trends.noted` |
| DELETE | `/api/trends/notes/[id]` | — | `{ ok }` | owner or the user who noted it |
| POST | `/api/trends/watches` | `{ provider: 'instagram_hashtag', hashtag }` or `{ provider: 'youtube_chart' }` | `{ watch }`; enqueues `trends.refresh` | owner; audit `trends.watch_added` (the "connect" event) |
| DELETE | `/api/trends/watches/[id]` | — | `{ ok }` (disables, deletes items) | owner; audit `trends.watch_removed` |
| POST | `/api/trends/watches/[id]/refresh` | — | `{ jobId }`; 429 `RATE_LIMITED` within 6 h of the last query | owner |

`GET /api/integrations/status` gains entries `instagram_hashtags`, `youtube_chart`, `spotify_reference`,
`music_catalogue`. All entries use the shared WP0 contract (`stage-bc-plan.md`): `state: 'not_configured' |
'not_connected' | 'connected' | 'awaiting_approval' | 'unavailable' | 'needs_reauth' | 'error'` and
`liveMode: 'live' | 'development_live' | 'sandbox' | 'staging' | 'read_only' | null`; the
`configured`/`connected` booleans stay for existing callers. "Configured, not checked/enabled" in §4.12 maps to
`not_connected`, "Not available" to `unavailable`, "Quota" to `error` with its own message. The four new entries
are `read_only` or `null` — none of them can post or change anything.

---

## 10. UI

Design system: existing `apps/web/src/components/ui` (`Card`, `Badge`, `Switch`, `Dialog`, `Tabs`, `EmptyState`,
`StatusPill`, `Alert`, `Field`, `Button`, `Toast`, `Skeleton`). Charcoal/white with the configured accent; accent
is used only for primary buttons and the "Learned" chip outline. All pages work at 360 px wide (tables become
stacked rows). No new navigation item.

| Where | Component (new unless noted) | States |
| --- | --- | --- |
| Studio preview card (`components/studio/edit-grid.tsx`) | menu items **Hide this edit**, **Make a music-free version**; "Hidden edits" row; music licence banner on the card ("Music licence not confirmed — previews only") | normal / hidden / restoring |
| Studio revise area | `SoundPanel` (`components/studio/sound-panel.tsx`) with `EnergyStrip` (`components/studio/energy-strip.tsx`, keyboard: arrows move by one beat) | loading track data / no beats ("No clear beat found — beat options are off") / no clip sound / applying / error |
| Studio upload zone | "Add a reference video (style only)" link + `ReferenceStrip` (`components/studio/reference-strip.tsx`) with suggestion rows | uploading / processing / measuring / ready / failed / cancelled / originals deleted note |
| Studio style controls (`style-controls.tsx`, changed) | Music select with "Suggested for you" group and licence chips; defaults from effective preferences | no tracks (link to Settings → Music) / suggestions empty |
| Export dialog (changed) | `MusicClearanceNotice` (cleared platforms, `meta_only` label, CC BY credit copy, blocked with two actions) | — |
| Settings → Editing preferences (`preferences-tab.tsx`, rewritten) | `LearnedPreferencesTable`, `RecentChoicesList`, `ResetLearningDialog`, `MusicTasteFields`, `ReferenceSuggestionsList` | loading / nothing learned yet / learning off / recompute error / staff read-only |
| Settings → Editing preferences (v2, §4.3.1.9) | `YourStyleSummary` (`your-style-summary.tsx`) above Reference videos: rows with agreement chips, **Use this** / **No thanks**, **Use all suggestions**, **Go back to each style's own**, videos list; `ReferenceStrip` gains the v2 line and the "See your style from all your videos" link | loading / empty / measuring / only older measurements / older version of the measuring / nothing reportable / error / staff read-only |
| Settings → Branding (`branding-tab.tsx`, changed) | `LogoPlacementControl` + `SafeZonePreviewFrame` (static CSS 9:16 frame) | no logo / placement chosen |
| Settings → Music (`music-tab.tsx`, changed) | `LicencePassportForm` (3 steps, shared with the Studio dialog), genres/moods chips per track, `MusicReferences` (Spotify) with fixed notice and mode switch | empty library / not confirmed / expired / meta-only / CC BY-NC refused / link-only / embed |
| Settings → Trends (`trends-tab.tsx`, changed) | `LiveSignalsSection` with `TrendSourceCard` ×2, `NotedTrendsSection` + `NoteTrendDialog`, `CuratedSection` | per §4.11–4.12 |
| Settings → Business (changed) | Terms of use URL, Privacy policy URL | — |
| Settings → Integrations (changed) | four new read-only status cards | per §9.4 |

Plain-language copy rules: no job names, model names or error codes in normal views; Australian spelling
("colour", "licence", "analyse", "favourite"); dates "14 Nov 2026, 6:05 am" in Melbourne time.

---

## 11. Security and privacy

- **Owner-only**: everything under Settings (preferences pin/reset/learning, references decide, music licence edits,
  Spotify mode, trend watches, curated references). Staff may favourite/hide/revise in projects they can access,
  note a trend, and view (read-only) learned preferences.
- **CSRF**: all new state-changing routes go through `handleApi` (same-origin check).
- **Audit log** (`apps/web/src/lib/audit.ts`): `preferences.pinned`, `preferences.unpinned`,
  `preferences.learning_toggled`, `preferences.learning_reset`, `reference.uploaded`,
  `reference.suggestions_decided`, `reference.summary_decided` (v2), `preferences.editing_style_changed` (v2),
  `music.licence_updated` (exists), `music.reference_added`,
  `music.reference_removed`, `music.spotify_mode_changed`, `music.export_blocked`, `trends.watch_added`,
  `trends.watch_removed`, `trends.noted`, `settings.logo_placement_changed`. The worker writes
  `trends.source_unavailable` / `trends.source_needs_reauth` when a watch changes state.
- **Tokens**: hashtag watch reuses the encrypted Meta system-user token from `integration_connections` (provider
  `meta`; decrypt in the worker only, `packages/db/src/crypto.ts`); no new token storage. `YOUTUBE_API_KEY` is server-only, never in DTOs (status shows
  only "configured"), redacted in logs.
- **Least privilege**: hashtag permission requested only when hashtag watch is turned on; YouTube key restricted to
  one API; no Spotify credentials at all.
- **Reference videos**: private like all media; originals, proxy and frames deleted after measuring; only numbers,
  the thumbnail and the filename remain. Frames go to Anthropic only with the owner's per-upload tick. The prompt
  forbids identifying people (memo §10). Reference assets are excluded by `kind` from `loadProjectFootage`,
  the style-support computation in `apps/web/src/lib/assets.ts` (already filters `kind='video'`), the status DTO's clip list and the planner input; the validator context only lists
  `kind='video'` assets, so a plan that referenced a reference asset would fail with `UNKNOWN_ASSET` before rendering.
  A unit test asserts this.
- **Reference sound (v2, §4.3.1)**: decoded to PCM in worker memory only, to measure tempo, beat alignment and
  energy; never written out (the proxy that carries it is deleted as before), never sent to an AI model, never
  fingerprinted or looked up, never used in an export. Stored: only the summary numbers of
  `ReferenceStyleSignals` (no beat times, cut times or energy curve; an integration test asserts no array longer
  than 8 numbers). The tiny grey frames of Pass B live in memory for the job and are never stored.
- **Spotify**: stored fields are URL, type, id, notes; no metadata fetched or cached; iframe only on authenticated
  pages (`(app)` layout); `Content-Security-Policy` work (docs/security.md "not done yet") must include
  `frame-src https://open.spotify.com` when the CSP is written; `Referrer-Policy: same-origin` already sends no
  referrer. Lint guard: an ESLint `no-restricted-imports` rule forbids importing `lib/music-references` from
  `lib/publishing*`, `lib/email*`, `lib/website*` and `packages/ai`. A test asserts `buildPlannerInput` output
  contains no `open.spotify.com` string.
- **Third-party content from trends**: no images, captions or usernames stored; links open in a new tab with
  `rel="noopener noreferrer"`; items deleted after 7 days.
- **Uploaded and external data are data**: Graph/YouTube responses are parsed with Zod and length-limited (titles
  ≤ 160 chars) before storage; nothing from them reaches a model.
- **Settings write races**: the recompute job updates only its subtree with `jsonb_set`; web writes keep using the
  merge helper; the learned subtree is rejected from client patches.
- **No simulated data**: no sample trend items, no seeded learned values, no fake "suggested" tracks. Development
  uses labelled fixtures in tests only.

---

## 12. Contracts with other modules

| Module | Contract |
| --- | --- |
| Publishing (`docs/design/publishing.md`) | (1) Write a `feedback_events` row `type 'publish'` with `data.planFacts` and `data.platform` when a target becomes `published` (confirmed), via `recordFeedback` (WP0). (2) `checkPublishEligibility` is built on `musicClearanceFor(currentLicence)` and blocks destinations in `blockedPlatforms`; `meta_only` renders may only target Instagram (and Facebook if ever added). (3) Insert `music_usage` (`purpose 'publish'`, `platform`) when a target is published. (4) Pre-fill the caption with `attributionText` for CC BY tracks. (5) Offer the `no_music` export variant (built by WP1) for destinations the music does not cover, and show "Add a Commercial Sound in the TikTok app" for TikTok. (6) Use the shared WP0 `state`/`liveMode` fields on integration statuses. (7) Own the Instagram connection; hashtag watch only reads `social_accounts`, its capabilities and the `meta` connection's credential. |
| Website module | Must never read `music_references`, never embed a `meta_only` render (memo §2), never show trend items. |
| Email module | Must never include Spotify links/embeds or trend items. |
| Lead plan (`docs/design/stage-bc-plan.md`) | Migration numbering; `PUBLISH_PLATFORMS` gains `facebook`; `IntegrationStatus` gains `state`/`mode`. |

---

## 13. Testing

### 13.1 Unit (vitest, no DB)

- `packages/core`: `computeLearnedPreferences` — no events → empty; 3 favourites at ~20 s with declared 25 → 20;
  unfavourite cancels a favourite; repeated downloads count once; `resetAt` excludes older events; pinned field keeps
  declared value and exposes the suggestion; recency halves weight at 60 days; colour circularity rule (one style
  only → no colour learned); threshold edges; deterministic output. `effectivePreferences` precedence.
  Settings normaliser: stored settings without `learning` pin every learnable field whose value differs from the
  default (`by: 'owner'`).
- `planFacts` on fixture plans; `applyAudioPatch` + `validateEditPlan` (volume, fades, music none, original sound
  only with/without clip audio, start shift beyond track end rejected); `needsRecut` matrix.
- `profileReference` thresholds (pacing boundaries 1.0/2.2 s, colour rules, duration rounding/limits, text density
  null when not measured).
- Reference style v2: unit, fixture-measurement, planner, integration and round-trip tests as listed in §4.3.1.10
  (synthetic fixtures R1–R11 with ground truth and tolerances; five-edit planner changes when suggestions are
  accepted; defaults byte-identical).
- Music: `normaliseLicence` (meta_only forcing), `cc_by_nc` refused by schema, `cc_by` without credit refused,
  `musicClearanceFor` (no music / cleared / restricted / expired / unconfirmed / unknown / no promotional use /
  meta_only), `rankTracksForPreferences` (genre, mood, artist match, BPM fit, unusable reasons, never auto-picks).
- Spotify URL parser: track/album/playlist/artist, `intl-xx` paths, `spotify:` URIs, query strings stripped,
  non-Spotify hosts and lookalikes (`open.spotify.com.evil.com`) rejected.
- `trendLabel` outputs and the "no trending/viral" assertion; validator `TEXT_UNSUPPORTED_CLAIM`.
- `parseRevisionInstruction` colour and beat phrases.
- `packages/media`: logo rectangles at 1080×1920 and 540×960 inside `zone.head`, disjoint from forbidden areas;
  corner `enable` expression excludes top-overlay windows; end card skipped on overlap; `buildRenderCommand`
  contains the overlay chain before `ass`; `resolveRenderFont` fallback; `measureLook` parser on captured
  `signalstats` output.
- `packages/ai`: rules planner `beatSync off` produces no beat snapping; `revealOnBeat` puts the first result cut
  within ±0.25 s of a beat; `textDensity medium` → more overlays than `light`; `estimateOnScreenText` with a fake
  client (refusal → not measured; parse error → not measured; usage recorded).
- `apps/web`: `buildIntegrationStatuses` for the four new entries (each state); route schema tests (PUT settings
  rejects `learned`; embed mode refused without legal URLs).

### 13.2 Integration (`TEST_DATABASE_URL` + ffmpeg, fakes for HTTP)

- Worker: reference ingest on `scripts/make-sample-footage.sh` output → profile stored, originals/proxy deleted,
  thumbnail kept, asset absent from `loadProjectFootage` and style support; retry after deletion is a no-op.
- `preferences.recompute` with seeded events → `learned` written; a concurrent owner `PUT /api/settings` between
  read and write is not lost (jsonb_set subtree).
- `edits.revise` `mode 'audio'`: new version, plan patched, preview renders; music-free version renders without a
  music input; export of a blocked-licence version fails with `UNSUPPORTED` and no retry; successful export writes
  one `music_usage` row (second export attempt does not duplicate).
- Logo render: export of a 6 s synthetic plan with `both` placement; extract frames at t=1 s and t=end−0.5 s and
  check (ffmpeg `crop` + `signalstats`) that logo pixels appear inside the expected rectangles and the forbidden
  bands match a render without logo.
- `trends.refresh` with an injected `fetch` fake: Instagram success (upsert, stale items removed), code 190, code 10,
  code 4, 30-hashtag budget, empty search; YouTube 200, `quotaExceeded`, `keyInvalid`; cleanup deletes items older
  than 7 days.
- Web (`apps/web/test/*.integration.test.ts`): owner-only routes return 403 for staff; CSRF refusal without
  `Origin`; dismiss toggles and records feedback; references decide pins fields.

### 13.3 Sandbox / smoke tests (real services, read-only, owner-triggered)

- **YouTube**: Settings → Trends → **Show the chart** is itself the smoke test (one read, 1 unit). Record the result
  and the date in `docs/HANDOVER.md`.
- **Instagram hashtag**: only after the publishing module's Instagram connection works; the owner adds one hashtag
  they genuinely want to watch (this uses 1 of 30 weekly slots). Expected outcomes: `ok` or `unavailable`; both are
  valid end states.
- **Anthropic text estimate**: one reference upload with the box ticked; check `ai_usage` row and that the profile
  says `vision_model`.
- Never part of any test: posting, emailing, or changing an account.

### 13.4 Only verifiable with the owner's real accounts or use

- Whether hashtag search is permitted for the owner's Unified Login app (memo §11 open question) and whether
  `top_media` counts towards the 30-hashtag limit.
- Whether the learned defaults feel right after a few weeks of real favourites/downloads (thresholds are
  starting values; adjust from the owner's feedback).
- Colour and pacing classifications on real reference videos; text-density estimates.
- Reference style v2 on 3–5 of the owner's own posted videos: cut/flash counts against a frame-by-frame count of a
  15 s excerpt, tempo against the known track tempo (acceptance and tuning rule in §4.3.1.10); whether the five
  edits with accepted suggestions feel like the owner's own editing.
- Whether the owner's music library plan covers organic posts, website and boosts (provider's written confirmation,
  memo §2).
- Whether Meta Sound Collection tracks trigger copyright matches (publishing smoke test, memo §2 open question).
- Logo legibility on the owner's actual logo file and footage.

---

## 14. Owner setup checklist (plain language)

Required for nothing — everything in this module works without new accounts except the optional live sources.

1. **Music you can use for the shop**: if you use a music library, make sure the plan is a business plan (not
   Personal, Social or Creator) in the business's name. Ask the library to confirm in writing that it covers
   Instagram, TikTok, your website and any paid boosts. Keep the invoice. Register the shop's accounts in the
   library's "safelist" or claim-clearing page.
2. **Uploading a track**: download it from your library, upload it in Settings → Music or in a project, and fill in
   the licence form honestly. If you're not sure, choose "I'm not sure" — you can still try it in previews.
3. **Meta Sound Collection (optional)**: download tracks on a computer while logged into the business's Meta
   account, accept Meta's terms, and note the date. Videos with these tracks are for Instagram/Facebook only.
4. **TikTok sounds**: add Commercial Sounds inside the TikTok app when you post; the app can make a music-free
   version for this.
5. **Spotify references (optional)**: paste links you like as reference. To see the Spotify player instead of plain
   links, first publish a terms-of-use page and a privacy policy for this app, add both links in Settings →
   Business, read Spotify's Developer Terms and Widget Terms, then switch on "Show the Spotify player".
6. **Logo in videos (optional)**: upload a PNG with a transparent background (at least 600 px wide) in Settings →
   Branding and choose End card, Corner mark or Both.
7. **YouTube chart (optional)**: in Google Cloud, create a project, enable "YouTube Data API v3", create an API key,
   restrict it to that API, and ask whoever runs the server to set `YOUTUBE_API_KEY`. Then press "Show the chart".
8. **Instagram hashtag watch (optional)**: after Instagram is connected for publishing, add the hashtag search
   permission to your Meta app's login configuration (the App Dashboard shows its exact name), reconnect Instagram,
   then add up to 10 hashtags. Instagram allows 30 different hashtags a week.
9. **Google Trends and TikTok Creative Center**: no setup — use the buttons in Settings → Trends with your own
   logins.

---

## 15. Files to create / modify

Create:

- `packages/core/src/preference-learning.ts` (`LEARNABLE_FIELDS`, schemas, `computeLearnedPreferences`, `effectivePreferences`, `explainLearned`)
- `packages/core/src/plan-facts.ts` (created by WP0, shared with publishing)
- `packages/core/src/audio-patch.ts` (`AudioPatchSchema`, `needsRecut`, `applyAudioPatch`)
- `packages/core/src/reference.ts` (`ReferenceStyleProfileSchema`, `profileReference`)
- `packages/core/src/music-catalogue.ts` (`MusicCatalogueProvider` interface)
- `packages/core/src/music-ranking.ts` (`rankTracksForPreferences`)
- `packages/core/src/spotify-link.ts` (`parseSpotifyLink`)
- `packages/core/src/trend-label.ts` (`trendLabel`)
- `packages/core/test/{preference-learning,plan-facts,audio-patch,reference,music-clearance,music-ranking,spotify-link,trend-label}.test.ts`
- `packages/media/src/analysis/look.ts`, `packages/media/src/render/logo.ts`, `packages/media/test/{look,logo}.test.ts`
- `packages/ai/src/anthropic/text-estimate.ts`, `packages/ai/test/text-estimate.test.ts`
- `packages/db/drizzle/<next>_preferences_music_trends.sql` (+ drizzle meta snapshot/journal)
- `apps/worker/src/handlers/preferences.ts`, `apps/worker/src/handlers/reference.ts`, `apps/worker/src/handlers/trends.ts`
- `apps/worker/src/lib/youtube-client.ts` (the Instagram calls reuse the publishing module's Graph client; WP5 is
  scheduled after WP4, so no second Graph wrapper is written)
- `apps/worker/test/{preferences,reference,trends,audio-revise}.integration.test.ts`
- `apps/web/src/lib/feedback.ts` (created by WP0 with `recordFeedback`; WP2 adds `scheduleRecompute`), `apps/web/src/lib/preferences.ts`, `apps/web/src/lib/references.ts`, `apps/web/src/lib/music-references.ts`, `apps/web/src/lib/trend-watches.ts`
- `apps/web/src/app/api/preferences/route.ts`, `…/preferences/pin/route.ts`, `…/preferences/learning/route.ts`, `…/preferences/reset/route.ts`
- `apps/web/src/app/api/edits/[id]/dismiss/route.ts`
- `apps/web/src/app/api/references/route.ts`, `…/references/[assetId]/decide/route.ts`
- `apps/web/src/app/api/music/[id]/listen/route.ts`, `…/music/suggestions/route.ts`, `…/music/references/route.ts`, `…/music/references/[id]/route.ts`
- `apps/web/src/app/api/trends/notes/route.ts`, `…/trends/notes/[id]/route.ts`, `…/trends/watches/route.ts`, `…/trends/watches/[id]/route.ts`, `…/trends/watches/[id]/refresh/route.ts`
- `apps/web/src/components/studio/{sound-panel,energy-strip,reference-strip}.tsx`
- `apps/web/src/app/(app)/settings/_components/{learned-preferences,licence-passport-form,music-references,logo-placement,live-signals,note-trend-dialog}.tsx`

Modify:

- `packages/core/src/settings.ts` (preferences additions, `music` section, business legal URLs, normaliser), `brand.ts` (logo fields), `music.ts` (licence additions, `facebook`, `normaliseLicence`, `musicClearanceFor`), `jobs.ts` (new types/payloads, `ReviseEditPayloadSchema`), `revision.ts` (colour, beatSync), `plan-validation.ts` (`TEXT_UNSUPPORTED_CLAIM`), `index.ts` (exports)
- `packages/db/src/schema.ts` (§5)
- `packages/queue/src/index.ts` (`QUEUE_SETTINGS` for new types)
- `packages/media/src/render/{types,render,command,ass}.ts` (logo, font resolution), `render/verify.ts` (overlay rect check), `analysis/index.ts`, `index.ts`
- `packages/ai/src/types.ts` (`beatSync`, `revealOnBeat`, text estimator type), `rules/settings.ts` (text density mapping, beatSync), `rules/music.ts` / `rules/planner.ts` (beat options, reveal snap), `anthropic/prompts.ts` (beat fields), `index.ts` / provider factory (`textEstimator`)
- `apps/worker/src/main.ts` (register handlers, schedules), `handlers/ingest.ts` (reference branch), `handlers/generate.ts` (`effectivePreferences`, music track from parent plan, audio mode), `handlers/render.ts` (brand snapshot, logo download, clearance, ledger), `handlers/cleanup.ts`, `lib/plan-context.ts`
- `apps/web/src/lib/studio-edits.ts` (`recordFeedback`, plan facts, dismiss, audio revise, export clearance; remove in-request affinity update), `jobs.ts` (`startAfterSeconds`, `defaultRefId`), `uploads.ts` and `shared/upload-math.ts` (reference kind), `shared/studio-schemas.ts`, `shared/studio-dto.ts`, `studio-status-shape.ts`, `music.ts` (schemas, genres, licence state), `settings-merge.ts` (reject learned/learning, auto-pin), `trends.ts` (groups, noted), `seed-trends.ts` (re-source curated list, one-off update marker `trends.curated_sources_v2` that only touches rows still carrying the original seed `sourceName`), `integrations.ts` + `shared/integration-types.ts` (`state`, `mode`, four entries)
- `apps/web/src/app/api/settings/route.ts`, `api/edits/[id]/revise/route.ts`, `api/edit-versions/[id]/export/route.ts`, `api/edit-versions/[id]/download/route.ts`, `api/trends/route.ts`, `api/projects/[id]/uploads/route.ts`
- `apps/web/src/components/studio/{edit-grid,style-controls,upload-zone,music-upload-dialog,studio-workspace}.tsx`
- `apps/web/src/app/(app)/settings/_components/{preferences-tab,branding-tab,business-tab,music-tab,trends-tab,integrations-tab}.tsx`
- `packages/config/src/*` (`YOUTUBE_API_KEY` optional), `.env.example`
- Docs: `docs/api.md`, `docs/architecture.md` (Stage B section), `docs/security.md` (new audit actions, Spotify CSP note), `docs/testing.md`, `docs/HANDOVER.md`

Reference style v2 (§4.3.1), when built:

- Create: `packages/media/src/analysis/reference-style.ts` (+ `test/reference-style.test.ts`,
  `test/fixtures/make-reference-fixtures.ts`); `packages/core/src/reference-style.ts` (`alignCutsToBeats`,
  `binomialMinAligned`, `findDrop`, `energyShape`, `paletteFromCounts`, `summariseReferenceStyle`, wording)
  (+ `test/reference-style.test.ts`); `packages/ai/src/rules/editing-style.ts` (+ `test/rules-editing-style.test.ts`);
  `apps/web/src/app/api/references/summary/route.ts`, `…/summary/decide/route.ts`;
  `apps/web/src/app/(app)/settings/_components/your-style-summary.tsx`.
- Modify: `packages/core/src/reference.ts` (v2 schema, union, `readReferenceProfile`), `settings.ts`
  (`editingStyle`), `preference-learning.ts` (`PinSchema.referenceAssetIds`), `music-ranking.ts` (`fit`, `drop`),
  `plan-validation.ts` (`extraStyleTransitions` warning context only), `index.ts`; `packages/media/src/analysis/index.ts`;
  `packages/ai/src/types.ts` (`editingStyle`, `PlannerMusic.energy`/`energyStepSec`), `rules/settings.ts`,
  `rules/music.ts` (`strongestBeat`), `rules/styles.ts`, `rules/planner.ts`, `anthropic/prompts.ts`;
  `apps/worker/src/handlers/reference.ts`, `handlers/generate.ts` / `lib/plan-context.ts` (beat-sync default, track
  energy into `PlannerMusic`); `apps/web/src/lib/references.ts`, `settings-merge.ts`, `music.ts` (ranking inputs),
  `components/studio/{reference-strip,upload-zone}.tsx`, `settings/_components/preferences-tab.tsx`;
  `apps/worker/test/reference.integration.test.ts`; docs `docs/api.md`, `docs/testing.md`, `docs/HANDOVER.md`.

---

## 16. Open questions

1. Is hashtag search available to a Unified Login system-user configuration in Development mode, and what is the
   exact permission name in the dashboard? (memo §11, §4) — resolved only by the owner's smoke test.
2. Does `top_media` count towards the 30-hashtags-per-7-days limit? Designed conservatively; confirm on the live
   reference.
3. YouTube API data caching/display terms were not retrieved (memo §11); the 7-day deletion and title/link-only
   display are a cautious guess to confirm before go-live.
4. Does the owner want reference videos uploadable from Settings (outside a project)? Upload sessions are
   project-scoped today; branch -2 attaches Settings music uploads to the most recent project, which is not suitable
   for videos the owner expects to be deleted with nothing else. Designed project-scoped; revisit if the owner asks.
5. Should a learned style order also pre-untick styles the owner keeps hiding? Designed as order only (never hides a
   style) to avoid reducing variety silently.
6. Instagram Audio API as a third live source (memo §11 "behind a flag") — left out; add only if a live reference
   confirms what it returns and the owner wants it.
7. ~~Who writes the end-user terms and privacy policy pages the Spotify embed needs (memo §1)?~~ Resolved in
   `stage-bc-plan.md`: WP0 adds public `/terms`, `/privacy` and `/data-deletion` pages whose text the owner edits and
   publishes (a plain draft is offered, marked "review before publishing"; nothing is shown until the owner
   publishes). `termsUrl`/`privacyUrl` default to those pages; the embed switch needs both published (or both
   overridden with the owner's own URLs).
8. Thresholds in §6.1/§6.2 (weights, half-life, pacing/colour cut-offs) are starting values; agree to tune them after
   the owner has used the app for a few weeks.
9. Reference style v2 (§4.3.1) thresholds come from synthetic clips only (§4.3.1.12). Which of the owner's posted
   videos best represent "their style" (recent ones, favourites), and how many, is the owner's choice; 3–5 is the
   suggested starting point. Tune only after the real-video check in §13.4.
10. Should accepted v2 suggestions also be offered per project (for example a different style for promos)? Designed
    as one global "your style"; revisit if the owner asks.
