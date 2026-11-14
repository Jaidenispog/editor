# Design: saved preferences, music controls and trends (Stage B)

Status: design only, written 2026-11-14. Nothing here is built yet. It builds on the Stage A code on
`claude/blissful-lamport-f1lndn` and on two hardening branches that are not merged yet:

- `worktree-wf_56f21c16-d62-1`: the new safe-zone model (`SafeZone.strict` / `.head` / `.forbidden` / `.subtitle`)
  and `packages/media/src/render/verify.ts`.
- `worktree-wf_56f21c16-d62-2`: `GenerationSettings.musicStartSec`, `PlannerInput.musicStartSec`, `snapMusicStart`
  and `beatGrid(…, fixedStartSec)` in `packages/ai/src/rules/music.ts`, and Settings-side library music uploads.

This design assumes both are merged first. References such as "memo §2" mean
`docs/research/platform-constraints.md`, which supersedes `docs/research/decisions-summary.md`.

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
5. If an artist preference has no match: "None of your tracks are by Drake. Look for similar tracks in your music
   library subscription, then upload them here." No external search happens.
6. Settings → Integrations shows **"Music library connection — Not available. Download tracks from your
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

**"Make a music-free version"** (card menu and the export dialog): fast path with `{ music: 'none' }`; original
sound follows the plan.

### 4.10 Export with music clearance

1. Owner presses **Export full quality** (exists). The route computes `musicClearanceFor(track.licence)`:
   - no music → export as today;
   - cleared → export; the download dialog lists "Music cleared for: Instagram, TikTok" and, for CC BY, "Credit
     to paste in your caption: … [Copy]";
   - `meta_only` → export; the dialog and file name say "For Instagram/Facebook upload only"
     (`…-instagram-facebook-only.mp4`);
   - blocked (licence not confirmed, expired, `unknown`, or no promotional use) → 409 with
     "This version's music isn't cleared for business use: <reason>. Make a music-free version, or confirm the
     licence in Settings → Music." and two buttons.
2. The worker re-checks before rendering (defence in depth) and writes a `music_usage` ledger row with the licence
   snapshot after a successful export.

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
| `reference.analyse` | `{ assetId: z.string(), projectId: z.string(), useVision: z.boolean().default(false) }` | `singletonKey: 'reference:' + assetId`; skips if `reference_profile` exists; deleting originals is last and tolerant of "already gone". | retryLimit 2, retryDelay 15, backoff, expire 1800 s, heartbeat 60 | Enqueued by `ingest.asset` at the end for `kind='reference_video'`. Downloads proxy, `measureLook`, uses stored shots; if `useVision` and AI configured: `estimateOnScreenText` on ≤ 8 frames (`recordAiUsage(…, 'reference:text', usage)`). Writes profile, then deletes original + proxy + frames (keeps thumbnail), sets `originalsDeletedAt`. |
| `trends.refresh` | `{ watchId: z.string().nullable() }` (null = all enabled watches) | `singletonKey: 'trends:' + (watchId ?? 'all')`; items upserted on `(watch_id, external_id)`; items not in the new result for that watch are deleted. | retryLimit 1, retryDelay 300, expire 300 s, heartbeat 60 | `null` → enqueues one job per enabled watch and exits. Per watch: Instagram (§8.1) or YouTube (§8.2). Scheduled daily `41 5 * * *` Melbourne. Manual refresh allowed once per 6 h per watch (route-enforced). |
| `edits.revise` (changed) | add `mode: 'audio'` to the enum and `audio: AudioPatchSchema.optional()` | unchanged (`newVersionId`; skips if the version already has a plan) | unchanged | `mode 'audio'`: load parent plan → `applyAudioPatch` → `validateEditPlan` (same context builder) → store with `planSource 'manual'`, `plannerModel null` → enqueue `render.preview` (`singletonKey preview:<id>`). `mode 'revise'` with an `audio` patch that needs a re-cut: music track = `patch.trackId ?? parentPlan.audio.music?.trackId ?? null` (falls back to `generation.settings.musicTrackId` only when there is no parent plan); passes `musicStartSec`, `beatSync`, `revealOnBeat` to the planner. |
| `render.preview` (changed) | unchanged | unchanged | unchanged | Builds `RenderBrand` from settings (with logo), stores the snapshot in `edit_versions.render_brand`. |
| `render.export` (changed) | unchanged | unchanged | unchanged | Uses `render_brand` snapshot (falls back to current settings for old versions). Before rendering: `musicClearanceFor`; `blocked` → `AppError('UNSUPPORTED', …)` (no retry). After success: insert `music_usage` (`on conflict do nothing`). |
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
token decrypted with `packages/db` crypto). Graph version: `META_GRAPH_VERSION` as defined by the publishing design.

1. First refresh of a watch (no `external_id`):
   `GET https://graph.facebook.com/{v}/ig_hashtag_search?user_id={ig-user-id}&q={hashtag}` →
   `{ data: [{ id }] }`; store `external_id`; set `last_queried_at = now()` (counts towards 30/7 days).
2. Every refresh:
   `GET https://graph.facebook.com/{v}/{ig-hashtag-id}/top_media?user_id={ig-user-id}&fields=id,media_type,permalink,timestamp,like_count,comments_count&limit=9`
   (field list to be confirmed against the live reference; request only these). Token in the `Authorization:
   Bearer` header, not the query string.
3. Scopes: the account's existing publishing scopes plus the hashtag search permission listed in the App Dashboard
   (memo §11: "the hashtag-search permissions and the 'Instagram Public Content Access' feature"). Least privilege:
   the hashtag permission is requested only when the owner turns hashtag watch on (reconnect with the extended
   configuration), never at first connection.
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
`music_catalogue` and, for all entries, additive fields `state: 'not_configured' | 'configured' | 'connected' |
'needs_reauth' | 'error'` and `mode: 'sandbox' | 'live' | 'read_only' | null` (the publishing design should use
the same two fields; `configured`/`connected` booleans stay for existing callers). The four new entries are
`read_only` or `null` — none of them can post or change anything.

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
  `reference.suggestions_decided`, `music.licence_updated` (exists), `music.reference_added`,
  `music.reference_removed`, `music.spotify_mode_changed`, `music.export_blocked`, `trends.watch_added`,
  `trends.watch_removed`, `trends.noted`, `settings.logo_placement_changed`. The worker writes
  `trends.source_unavailable` / `trends.source_needs_reauth` when a watch changes state.
- **Tokens**: hashtag watch reuses the encrypted Instagram token from `social_accounts` (decrypt in the worker only,
  `packages/db/src/crypto.ts`); no new token storage. `YOUTUBE_API_KEY` is server-only, never in DTOs (status shows
  only "configured"), redacted in logs.
- **Least privilege**: hashtag permission requested only when hashtag watch is turned on; YouTube key restricted to
  one API; no Spotify credentials at all.
- **Reference videos**: private like all media; originals, proxy and frames deleted after measuring; only numbers,
  the thumbnail and the filename remain. Frames go to Anthropic only with the owner's per-upload tick. The prompt
  forbids identifying people (memo §10). Reference assets are excluded by `kind` from `loadProjectFootage`,
  the style-support computation in `apps/web/src/lib/assets.ts` (already filters `kind='video'`), the status DTO's clip list and the planner input; the validator context only lists
  `kind='video'` assets, so a plan that referenced a reference asset would fail with `UNKNOWN_ASSET` before rendering.
  A unit test asserts this.
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
| Publishing (`docs/design/publishing.md`) | (1) Write a `feedback_events` row `type 'publish'` with `data.planFacts` and `data.platform` when a target becomes `published` (confirmed), via `recordFeedback`. (2) Before queueing a target, call `musicClearanceFor(currentLicence)` and block destinations in `blockedPlatforms`; `meta_only` renders may only target Instagram (and Facebook if ever added). (3) Insert `music_usage` (`purpose 'publish'`, `platform`) when a target is published. (4) Pre-fill the caption with `attributionText` for CC BY tracks. (5) Offer "Make a music-free version" (this module's route) for destinations the music does not cover, and show "Add a Commercial Sound in the TikTok app" for TikTok. (6) Use the shared `state`/`mode` fields on integration statuses. (7) Own the Instagram connection; hashtag watch only reads `social_accounts` and its capabilities. |
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
- `packages/core/src/plan-facts.ts`
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
- `apps/worker/src/lib/graph-client.ts` (minimal fetch wrapper, if the publishing module has not created one), `apps/worker/src/lib/youtube-client.ts`
- `apps/worker/test/{preferences,reference,trends,audio-revise}.integration.test.ts`
- `apps/web/src/lib/feedback.ts`, `apps/web/src/lib/preferences.ts`, `apps/web/src/lib/references.ts`, `apps/web/src/lib/music-references.ts`, `apps/web/src/lib/trend-watches.ts`
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
7. Who writes the end-user terms and privacy policy pages the Spotify embed needs (memo §1)? The app only stores
   their URLs.
8. Thresholds in §6.1/§6.2 (weights, half-life, pacing/colour cut-offs) are starting values; agree to tune them after
   the owner has used the app for a few weeks.
