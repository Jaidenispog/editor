export const meta = {
  name: 'studio-assistant-stage-a-hardening',
  description: 'Apply research-driven fixes and Studio gaps in isolated worktrees: safe zone + export preset, Studio gaps + music start point, Deepgram transcription + queue/db tuning',
  phases: [{ title: 'Harden', detail: 'three worktree agents, each commits on its own branch' }],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    worktree_path: { type: 'string' },
    branch: { type: 'string' },
    commit_sha: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    commands_run: { type: 'array', items: { type: 'string' } },
    test_output_tail: { type: 'string' },
    typecheck_passed: { type: 'boolean' },
    tests_passed: { type: 'boolean' },
    limitations: { type: 'array', items: { type: 'string' } },
    notes_for_integrator: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'worktree_path', 'branch', 'commit_sha', 'files_changed', 'commands_run', 'test_output_tail', 'typecheck_passed', 'tests_passed', 'limitations', 'notes_for_integrator'],
}

const WT = `
You are a senior engineer on "Studio Assistant": a private web app for a barber studio in Ivanhoe, Victoria, Australia (Australian English, AUD, Australia/Melbourne). Owners drop phone haircut clips into a project, click "Generate 5 edits", get five vertical previews, revise them and export 1080x1920 MP4s.

WORKTREE RULES (critical):
- You run in your OWN git worktree. First run "pwd" and call that directory ROOT. Use absolute paths under ROOT for every command (the shell's working directory resets between commands).
- Never edit anything under /home/user/editor: that is the main checkout, used concurrently by another agent.
- Setup inside ROOT before anything else: "cd ROOT && pnpm install --frozen-lockfile" (fast, uses the local store) and "ln -sfn /home/user/editor/data ROOT/data" (synthetic sample footage, gitignored).
- Tests needing Postgres: export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres and only create throwaway databases. Never touch the databases studio_assistant or studio_e2e, and never stop or reconfigure the server. Do not bind ports 3000 or 3100.
- Read first: ROOT/CLAUDE.md, ROOT/docs/HANDOVER.md (sections 7–8 and "Research-driven changes" / "Gaps reported"), ROOT/docs/architecture.md, ROOT/docs/api.md, and the sections of ROOT/docs/research/platform-constraints.md named in your task.
- Conventions: TypeScript strict, ESM, ".js" suffix on relative imports, Zod 4 contracts live in packages/core, vitest tests in <pkg>/test. No placeholders, TODOs or mock logic on production paths; no invented APIs; JSDoc on exports; Australian English in UI text and comments; plain, non-technical user-facing messages.
- Verify before finishing: typecheck and tests for every package you touched and every package that depends on it (core changes → media, ai, worker, web). If you touched apps/web or a package it imports, also run NEXT_TELEMETRY_DISABLED=1 pnpm --filter @studio/web build inside ROOT. Worker integration test when you touched media/ai/worker/core planning: TEST_DATABASE_URL=… pnpm --filter @studio/worker test:integration.
- Then commit inside ROOT: "git add -A && git commit -m '<clear message>'" with a message whose last two lines are exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A394AkMo88kGxHK5MDHk5B
  Do not push. Leave nothing uncommitted. Report ROOT, the branch (git rev-parse --abbrev-ref HEAD) and the commit SHA.
- If you run out of budget or hit something you cannot fix, still commit what is solid and return the structured report saying exactly where you stopped.
Return ONLY the structured report.`

const SAFE_ZONE = `${WT}

TASK: safe zone and export preset (research memo section 5 "Safe zones & export specs"). You may edit packages/core and packages/media (and their tests), plus docs.
1. Replace the single-rectangle safe zone in packages/core/src/safe-zones.ts with the researched model at 1080x1920 (origin top-left): R_strict x 120–780, y 270–1248 (default for all text); R_head x 120–960, y 270–840 (for boxes whose bottom edge is ≤ 840); forbidden areas: y < 270, y ≥ 1248, x < 120, x > 960, and the right action column x > 780 where y ≥ 840. Subtitles/captions: centred at x = 540, at most 480 px wide, box bottom ≤ 1248, type ≥ 56 px. Provide scaling for other output sizes (540x960 previews) and keep a small, documented API (e.g. regions + helpers). Update every caller.
2. Update packages/media/src/render/ass.ts so 'top' text may use R_head when it fits above y 840, 'centre' and 'lower' text use R_strict, the end-of-video handle uses R_strict, and captions follow the subtitle rules (wrap to the 480 px width, ≥ 56 px at 1080 width, scaled for previews). Text must never enter a forbidden area at any animation frame (rise/pop included).
3. Update the renderer's pixel-diff safe-zone test to assert no changed pixels in every forbidden area (scaled) and changed pixels inside the allowed regions, for top, centre, lower text and captions, and add unit tests for the region maths.
4. Export preset: libx264 High profile, level 4.1 at ≤ 30 fps and 4.2 at 60 fps, yuv420p, progressive, constant frame rate, closed 2 s GOP (-g 2×fps, -keyint_min 2×fps, -sc_threshold 0, -flags +cgop), bt709 tags, AAC-LC 48 kHz stereo, faststart. Refuse renders longer than 180 s with a clear AppError. After every EXPORT render, verify the output with ffprobe (h264, High profile, the expected level, yuv420p, 1080x1920, bt709, AAC 48 kHz stereo when audio exists, duration within one frame of the timeline) via an exported verifyExport() helper, and fail the render with a clear message if it does not match. Keep previews fast (veryfast, crf 27) but give them the same GOP/CFR settings.
5. Update packages/media/README.md (Renderer section) and the safe-zone lines in docs/HANDOVER.md "Research-driven changes" (mark items 1 and 4 done).`

const STUDIO = `${WT}

TASK: close the Video Studio gaps reported in docs/HANDOVER.md ("Gaps reported by the Video Studio agent") and add a music start-point control. You may edit apps/web, and make the small cross-package changes listed here in packages/core, packages/ai and apps/worker.
1. Staff access: staff may only see projects they created; the owner sees all. Apply apps/web/src/lib/studio-access.ts (getAccessibleProject) consistently to GET/POST /api/projects, GET/PATCH/DELETE /api/projects/[id], the jobs routes, the Content Library page and the dashboard. Add route tests for staff vs owner.
2. Settings → Music library tab: show each track's licence status; add a "Licence details" form (MusicLicenceSchema fields in plain language: where the track came from, licence name, proof link, allowed for promotional use, Instagram, TikTok, YouTube, website, attribution, expiry) with an explicit "I confirm I have the rights to use this recording as described" checkbox that sets confirmedByOwnerAt via PATCH /api/music/[id]; allow uploading a new licensed track from this tab by reusing the Studio upload component.
3. Clip order: accessible "Move up"/"Move down" controls on clip cards (and keyboard support), backed by POST /api/projects/[id]/assets/order { assetIds: string[] } that renumbers sortOrder in one transaction (validate the ids belong to the project). Update docs/api.md.
4. Per-shot tagging: an expandable "Shots" panel on each clip card listing its shots (time range, a frame thumbnail from analysis.sampledFrames via signed URLs, current label and source) with a label select per shot writing manualLabels through PATCH /api/assets/[id]; recompute style support as today.
5. Music start point: add musicStartSec: number | null (default null = automatic) to GenerationSettingsSchema in packages/core (with validation against the track duration done server-side in the generate route). Pass it through apps/worker (buildPlannerInput in apps/worker/src/handlers/generate.ts) into PlannerInput (packages/ai types) as musicStartSec?: number | null. RulesPlanner: when set, snap it to the nearest beat at or after the value and use it as audio.music.startOffsetSec instead of choosing one; AnthropicPlanner: include it as a fixed constraint in the job JSON. UI: in the Studio style controls, when a track is selected show its BPM and an energy curve (music_tracks.beats.energy at energyStepSec) with an "Automatic" default and a slider to pick the start point, showing mm:ss. Add tests in core (schema), ai (rules planner honours the start point, snapped to a beat) and web (route validation).
6. Update apps/web/README.md, docs/api.md and the "Gaps reported" list in docs/HANDOVER.md (mark what you closed).`

const PLATFORM = `${WT}

TASK: transcription provider, crash-recovery tuning, connection budgets and revision phrasing (research memo sections 9 "Transcription" and the Supabase connection notes in docs/research/decisions-summary.md and docs/deployment.md). You may edit packages/config, packages/ai, packages/queue, packages/db, packages/core (src/revision.ts and its tests only), the pool wiring in apps/worker/src/main.ts and apps/web/src/lib/db.ts and apps/web/src/lib/queue.ts, .env.example and docs.
1. Deepgram transcription adapter in packages/ai/src/transcription/deepgram.ts (read the memo for the request/response shape; prerecorded endpoint POST https://api.deepgram.com/v1/listen with model nova-3, punctuation/smart formatting and utterances or word timestamps; header "Authorization: Token <key>"; send the audio bytes with the right Content-Type). Map to TranscriptSegment[] with real timings only; split long utterances at word boundaries into caption-sized segments (≤ 42 characters per line, ≤ 2 lines, ≥ 0.7 s). Errors → AppError codes (auth → INTEGRATION_NOT_CONFIGURED, 429 → RATE_LIMITED, other → PROCESSING_FAILED). Config: TRANSCRIPTION_PROVIDER gains 'deepgram'; add DEEPGRAM_API_KEY and DEEPGRAM_MODEL (default nova-3); validation like the Anthropic key check. Factory selects it. Keep the OpenAI whisper-1 adapter as optional and note its announced shutdown date from the memo in a comment and docs. Tests with an injected fake fetch (no network). Update .env.example, apps/web integration status (Settings → Integrations shows Deepgram as configured/missing without values) and docs/HANDOVER.md item 2 of "Research-driven changes".
2. Crash recovery: in packages/queue set heartbeatSeconds 30 for every job type and superviseIntervalSeconds 30 for the worker role (confirm both option names against the installed pg-boss types in node_modules before using them), and adjust any tests/docs that state the old timings (apps/worker/README.md, docs/testing.md).
3. Connection budgets: add DB_POOL_MAX and QUEUE_POOL_MAX (optional integers) to packages/config; createDatabase and JobQueue accept them; defaults stay as today (web db 10, worker db 8, producer queue 3, worker queue 6). Wire them in apps/worker/src/main.ts, apps/web/src/lib/db.ts and apps/web/src/lib/queue.ts. Document a Supabase Micro budget example in docs/deployment.md.
4. Revision phrasing: widen packages/core/src/revision.ts parseRevisionInstruction to understand more natural phrasings (e.g. "turn the music down", "music's too loud", "cut it to 15", "15 sec", "half a minute", "no wipes", "keep it simple", "more of the line-up", "linger on the reveal", "start with the finished cut") without breaking existing tests; add tests for each.`

phase('Harden')
log('Launching three worktree agents: safe zone + export preset, Studio gaps + music start point, transcription + queue/db tuning')
const results = await parallel([
  () => agent(SAFE_ZONE, { label: 'safe-zone-export', phase: 'Harden', schema: REPORT_SCHEMA, isolation: 'worktree', effort: 'high' }),
  () => agent(STUDIO, { label: 'studio-gaps', phase: 'Harden', schema: REPORT_SCHEMA, isolation: 'worktree', effort: 'high' }),
  () => agent(PLATFORM, { label: 'platform-tuning', phase: 'Harden', schema: REPORT_SCHEMA, isolation: 'worktree', effort: 'high' }),
])
return { safeZone: results[0], studio: results[1], platform: results[2] }