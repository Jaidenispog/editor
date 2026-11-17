# HANDOVER — read this first (written 2026-11-12 by the previous Claude session)

This file exists so a new model/session can continue **exactly** where the last one stopped. Read it top to
bottom before touching code. Then read `CLAUDE.md`, `docs/architecture.md`, `docs/api.md`,
`docs/research/decisions-summary.md`.

## Continuing in the SAME Claude Code session?

History of the background runs:
1. The first implementation run (`docs/handover/phase1-implementation-workflow.js`) finished the media analysis and
   renderer, then stopped on 2026-11-13 when the account hit its 5-hour usage limit. The AI package, web foundation
   and dev-ops agents never wrote anything.
2. On 2026-11-14 the work was relaunched as `docs/handover/stage-a-retry-workflow.js`: AI package → worker
   integrator (typecheck, unit + integration tests, music case, real boot and kill -9 recovery test) → dev-ops/docs,
   in parallel with web foundation → Video Studio UI, then an end-to-end browser test. The research run was resumed
   for its three missing topics plus critique and synthesis.

3. Also on 2026-11-14, `docs/handover/stage-a-hardening-workflow.js` started three agents in **separate git worktrees**
   (safe zone + export preset; Studio gaps + music start point; Deepgram transcription + queue/db tuning). Each
   commits on its own worktree branch and reports the branch and SHA; the lead session merges them into
   `claude/blissful-lamport-f1lndn` after the end-to-end browser test agent (main checkout) has finished.

4. Also on 2026-11-14, `docs/handover/stage-bc-design-workflow.js` started five design agents (publishing,
   preferences/music/trends, Square, email + reviews, website/local search) writing `docs/design/*.md`, then a lead
   architect writing `docs/design/stage-bc-plan.md` (ordered, conflict-free work packages). Design only: no code.
   Stage B/C implementation starts from that plan after the Stage A merges.

5. 2026-11-14: the three hardening branches were merged into `claude/blissful-lamport-f1lndn` (worktrees removed).
   After the merge: 9 packages typecheck, 333 unit tests pass, worker integration 12/12, browser test 51/51
   (production) and 44/44 (dev server). Two bugs found and fixed while verifying: a relative-time hydration mismatch
   (`apps/web/src/components/ui/relative-time.tsx`) and dev-mode media 404s (driver tag instead of `instanceof`).

6. Stage B/C implementation follows `docs/design/stage-bc-plan.md` group by group with
   `docs/handover/stage-bc-group-workflow.js` (args: `{ group, packages: [{ wp, migration, docs }] }`): each work
   package builds in its own worktree and commits there; an integration agent then merges in plan order in the main
   checkout, renumbers migrations, re-runs every check (incl. the Stage A browser test) and commits WITHOUT pushing.
   The lead session reviews, pushes, then launches the next group. G0 (WP0 foundations) started 2026-11-14, was stopped by the usage limit before committing; its work was saved as a WIP commit on branch `worktree-wf_733f80c8-1d0-1` (worktree `.claude/worktrees/wf_733f80c8-1d0-1`) and a resume agent was relaunched there (packages accept `resumeWorktree`/`resumeBranch` in the workflow args).
   Next: G1 = WP1 (music, migration "music") ∥ WP3 (trends, "trends"); G2 = WP2 ("preferences") ∥ WP4
   ("publishing"); G3 = WP5 (no migration) then Stage B acceptance; G4 = WP6 ("square") ∥ WP7 ("email_reviews") ∥
   WP8 ("website"); G5 = WP6b ("square_changes") ∥ WP9 ("business_profile") ∥ WP10 (none).

7. G0 merged and pushed 2026-11-14 (HEAD cd32d1b): 428 unit tests, worker integration 12/12, browser test 51/51,
   migration 0001_foundations applied to the preview database. G1 (WP1 music ∥ WP3 trends) started right after.
   If a group run stops mid-way (usage limit), commit the worktree's changes as a WIP commit on its branch and
   relaunch the group with `resumeWorktree`/`resumeBranch` for that package.

8. G1 merged and pushed 2026-11-14 (f471de3): migrations 0002_music and 0003_trends, 574 unit tests, worker
   integration 12/12, browser test 51/51, preview database migrated. The lead then fixed what G1 reported (823a6e5,
   details in `docs/design/stage-bc-plan.md` §10): renderer frame grid (`quantiseTimeline`; speed-changed beat
   montages used to export short and fail `verifyExport`), `NonRetryableError` for jobs another attempt cannot fix,
   and music cards in the shared status list. 578 unit tests, integration 12/12. The port-3000 preview was rebuilt
   on that commit. **G2 (WP2 preferences ∥ WP4 publishing) started right after** (workflow run `wf_5a49e176-d40`).
   Plan §10 lists the requests G2+ must honour; the agents read it.

9. G2 merged and pushed 2026-11-14 (ed37bbd): migrations 0004_preferences and 0005_publishing; the integrator fixed
   export audio to AAC 128 kbps (Instagram Reels limit) and queued preferences.recompute on publish. Then, merged on
   top: the setup-guide hotfix (`docs/run-locally.md`; Mac needs Homebrew `ffmpeg-full`, verified by a fresh-clone
   run on Ubuntu 24.04 and against Homebrew/Microsoft sources) and the UI polish branch from a 29-screenshot review
   (15 findings fixed, 4 left to WP4/WP2/WP7 in plan §10.1). Verified on ed37bbd: typecheck, 753 unit tests,
   integration 12/12, web build, browser test 51/51 (51 needs `E2E_SCREENSHOT_DIR`; 44 without it).
   - The GitHub repository is PUBLIC and `claude/blissful-lamport-f1lndn` is its default branch: never push
     unverified merges; the owner may be cloning it (they have a Mac and follow `docs/run-locally.md`).
   - Remote Control: the owner's Mac lists folders but offers none to cloud sessions (`not_available`, even after
     updating the app); do not keep re-requesting it.
   - Progress page for the owner: https://claude.ai/artifact/9Bx4CSC1gGWJyHxFDiA8Wj, built from a separate showcase
     stack (port 3200, database studio_showcase, files in the scratchpad `showcase/` folder, capture script
     `showcase/capture.cjs`). Republish it after each group.
   - **G3 (WP5 hashtag watch) started** (run `wf_f68429be-c39`), then the Stage B acceptance pass.
   - In parallel, worktree run `wf_7fd264b2-afe` fixes: the whole-object settings write that can overwrite learned
     preferences (logo routes), dev server bound to 127.0.0.1 by default, `apps/web/next-env.d.ts` untracked,
     telemetry off in `.env.example`, README owner command without the password on the command line. Merge it
     after G3's integrator has finished, then re-run all checks.
   - Still open from G2: shared pill label for manual_step_required ("Action needed" vs "Your turn"), Studio style
     checkboxes not pre-ticked by learned order (style-controls.tsx), logo copy key belongs in packages/storage,
     nothing tested against real Meta accounts.

10. 2026-11-14 afternoon: G3 (WP5 Instagram hashtag watch) merged and pushed (838ab1f; 780 tests, 12/12, 51/51).
    The local-dev hardening branch merged and pushed (8c999aa; 783 tests, 12/12, 51/51): settings writes only under
    the row lock (logo routes could overwrite learned preferences), `next dev` bound to 127.0.0.1 (opt-in
    `WEB_HOST=0.0.0.0`), `apps/web/next-env.d.ts` untracked, `NEXT_TELEMETRY_DISABLED=1` in `.env.example`, owner
    command via `OWNER_EMAIL`/`OWNER_PASSWORD`. Also e6d59b1: `local-postgres.sh` now reads Homebrew's
    "17.11 (Homebrew)" version string (found by the owner on their Mac).
    - **The owner is running the app on their Mac** (Apple silicon, Homebrew, already had postgresql@17 and node
      linked). Real incident: they started `dev.sh` before the database; the worker (`tsx watch`) died silently and
      five real clips sat on "Waiting to be analysed". Workaround given: run `pnpm dev:worker` in a second tab.
    - Two runs were stopped by the 5-hour usage limit and **relaunched with `resumeWorktree`** after saving WIP
      commits: worker liveness (`.claude/worktrees/wf_ffdb3376-fd0-1`, WIP c8a002b; worker waits for the database,
      dev.sh surfaces a dead worker, `worker_heartbeats` migration 0006 + "background worker isn't running" notice +
      `/api/health` worker field) and Stage B acceptance (`.claude/worktrees/wf_d9dca0d1-b5f-1`, WIP 0af31f8;
      `apps/web/e2e/run-stage-b.sh` + `stage-b.e2e.mjs` with a local Meta fake). Merge each after its review passes,
      re-run all checks, push, then update the README status table, recapture the showcase and republish the
      progress page. The workflow scripts accept `{resumeWorktree, resumeBranch}`.
    - Next after that: Stage C, G4 = WP6 (square) ∥ WP7 (email_reviews) ∥ WP8 (website). Migration numbers start
      after 0006 if worker liveness lands first.

11. Stage B acceptance (plan "Stage B acceptance (after WP5)") merged on top of item 10's hardening: `apps/web/e2e/stage-b.e2e.mjs` + `run-stage-b.sh` drive the whole Stage B flow in Chromium on synthetic
   footage against a local fake of Meta (`apps/web/e2e/fake-meta.ts`, built on WP4's Graph fake): music licence →
   export gates and the music-free version → manual posting → Instagram connect and direct post (fake) → trends
   labels and hashtag watch (fake) → learned preferences. A passing run prints `77 checks passed, 0 failed` in five to
   six and a half minutes plus the build (`docs/testing.md`, "Stage B browser test"); three consecutive runs passed after a
   review found the first version flaky (it clicked "Make a music-free version" instead of the download, since
   button names match as substrings). Product fixes on the branch: `licenceStateOf` never reports an "I'm not sure"
   track as confirmed (it used to say "Licence confirmed" while exports stayed blocked), and `META_DIALOG_BASE_URL`,
   a test-only host for Meta's login dialog that is ignored unless `NODE_ENV=test`.
   - **Built and verified on synthetic data (with fakes):** WP1 music passport, export gates, music-free version and
     usage ledger; WP2 learned preferences; WP3 curated and noted trends; WP4 composer, manual posting and Instagram
     direct; WP5 hashtag watch. README status table updated.
   - **Still waiting on account access (unchanged):** a real Meta business app and the first real verification post;
     hashtag search permission and the first real read; `YOUTUBE_API_KEY` for the chart; the music library's written
     confirmation of its plan; the Anthropic key; manual posting in the real Instagram/TikTok apps and Web Share on
     iOS. Spotify stays links only.
   - Next: merge worker liveness (item 10) once its review passes, then G4 (Stage C: WP6 Square ∥ WP7
     email/reviews ∥ WP8 website).

12. Worker liveness merged and pushed (8a37eb9; 821 unit tests, integration 12/12, Stage A 51/51, Stage B 77/77):
    migration `0006_worker_heartbeats`; the worker waits for the database (one plain line, capped backoff) and
    exits 78 only for real configuration errors; `scripts/dev.sh` runs the worker without watch mode and restarts it
    (stops both on exit 78 or 5 crashes in 5 minutes; `--watch` for developers); the project page and dashboard show
    "The background worker isn't running" from the heartbeat; `/api/health` has `worker: { alive, lastSeenAt }`.
    Reproduced on the showcase (worker stopped → notice within about a minute → worker started → clip analysed).
    - Plan §10.2 lists what Stage C builds on. The group script's integrator now also runs `run-stage-b.sh` (77/77).
    - **G4 started** (run `wf_9f6293cb-cb0`): WP6 square ∥ WP7 email_reviews ∥ WP8 website. Then G5.
    - Preview/showcase processes: process-group ids are in `preview-run/{web,worker}.pgid` and
      `showcase/{web,worker}.pgid` in the scratchpad; stop them with `kill -TERM -- -<pgid>`.
13. G4 merged and pushed (c7b4600; 1,197 unit tests, integration 12/12, Stage A 51/51, Stage B 77/77, re-run by the
    lead after the integrator): WP6 Square Tier 0 (read-only), WP7 email and review requests (Postmark, consent
    ledger, send gate, Places rating), WP8 website check, prepared changes, WordPress apply and Search Console.
    Migrations `0007_square`, `0008_email_reviews` (ends with the hand-written `message_class` backfill) and
    `0009_website`. Everything is verified against fakes only; no real Square, Postmark, WordPress or Google call.
    - **Three independent review rounds, all merged and pushed** (runs `wf_385679c2-cf6`, `wf_e1e0fd0b-b1f`,
      `wf_e67bcee8-d74`; each fix re-checked by a separate agent, then the full suite re-run by the lead):
      - round 1 (f3d0e42): 2 blockers (sandbox Square bookings counted as real visits and could trigger real emails;
        a campaign paused/cancelled during expansion switched itself back to sending) and 17 should_fix, plus the
        lead follow-ups (worker scripts typechecked, compile-checked job labels, start-up email check, attendance
        test, Appointments review-request badge);
      - round 2 (b7b86aa): the reviewers' smaller findings and design gaps (change-bound WordPress write marker,
        approval hash bound to the destination, pre-write re-check, IPv6/NAT64 ranges, per-host robots, crawl
        budget, stable email link tokens in `0010_link_tokens`, honest unsubscribe page, Square revoke outcome on
        the card), and the Website/Emails layout fixes;
      - round 3 (9751dbf): checks that read no page make no claims; malformed Square bookings are left as stored.
      - Result: 1,293 unit tests, integration 12/12, Stage A 51/51, Stage B 77/77. Plan §10.3 records what G5
        must build on.
    - **G5 running** (run `wf_57df34d0-732`): WP6b (`square_changes`) ∥ WP9 (`business_profile`, docs
      email-and-reviews + website-local-search).
14. G5 merged, reviewed and pushed (1bd3e49; 1,398 unit tests, integration 12/12, Stage A 51/51, Stage B 77/77):
    - WP6b Square Tier 1 (booking changes and self-test) in `0011_square_changes`, **shipped switched off**
      (`SQUARE_TIER1_AVAILABLE = false` in `packages/core/src/square.ts`). Switch it on only after the sandbox write
      checks in square design §11.3 are recorded and `mapSquareError` is updated; the `square.test.ts` assertion that
      it is false changes with it.
    - WP9 Google Business Profile reviews and Performance (read-only) in `0012_business_profile`.
    - Review (run `wf_11274755-1c0`): 1 blocker (a Business Profile job running during a disconnect could switch the
      row back on and write deleted data back) and 15 more, all fixed and re-checked (971f20c). The lead then bound
      Performance answers to the location asked about and stopped the Settings card asking to "Press Check again"
      while a check runs (1c21e3b, 1bd3e49, after an independent read).
    - **WP10 Zernio not built:** docs.zernio.com and zernio.com are unreachable from this environment (proxy refusal,
      DNS failure); the plan forbids building it on unconfirmed API details. The owner can allow those hosts.
    - **Stage C acceptance running** (run `wf_27afe9cd-b85`): two browser tests in worktrees
      (`run-stage-c-bookings.sh` on port 3800 / `studio_e2e_c1`; `run-stage-c-website.sh` on 3900 /
      `studio_e2e_c2`), each re-run twice and reviewed independently, then fixed up. Merge each only after the full
      suite plus all four browser tests pass on the merged result.
15. Stage C acceptance merged and pushed (d614663): 1,411 unit tests, integration 12/12, Stage A 51/51, Stage B
    77/77, **Stage C bookings 124/124** (Square sandbox then live through a restart, owner-only contact details,
    sandbox never counts as a visit, signed webhooks, Postmark read-only check, consent at the counter, one approved
    review request → exactly one send with the footer, unsubscribe, campaign pause/complaint/cancel, Square writes
    stay off) and **Stage C website 114/114** (fixture site check with robots and the 25-page cap, refused private
    addresses, prepared change applied once to a WordPress fake and refused when the page changed, Search Console and
    Business Profile through Google fakes, no placeholder numbers).
    - Test-only hooks added (all ignored unless `NODE_ENV=test`, each with an inertness unit test):
      `POSTMARK_API_BASE_URL`, `GOOGLE_API_BASE_URL`, `WEBSITE_FIXTURE_BASE_URL` (one dotted host name on 127.0.0.1;
      every other private address stays refused).
    - Product bug found by the test and fixed: choosing the Square location queued a short sync, so that location's
      recent past bookings were missing until the nightly reconcile; it now queues the full connect window.
    - Full local check: `scratchpad/verify-all.sh <out dir>` runs install, typecheck, unit, integration and all four
      browser tests (about 35 minutes). Stage C scripts take `E2E_SKIP_BUILD=1` after Stage A has built.
    - **What remains:** WP10 Zernio (blocked on docs access), and everything that needs the owner's real accounts and
      footage (README "Not yet done").
16. WP10 TikTok via Zernio built, reviewed and pushed (1,478 unit tests, integration 12/12, Stage A 51/51, Stage B
    77/77, Stage C bookings 124/124, website 114/114, **TikTok 105/105**):
    - The owner approved a personal cloud environment "editor" for this repository that allows docs.zernio.com and
      zernio.com (plus package registries); this session uses it. Its one-line setup script (`pnpm install`) has not
      run in a fresh session yet.
    - Research: `docs/research/zernio-api.md` (dated 15 Nov 2026, every fact quoted with its page) and publishing §7.2
      rewritten from the docs, checked by an adversarial verifier (176 claims; 13 corrected). Open items only block
      the first live verification post, not the code.
    - Review: 7 issues (incl. a draft that could show as published, Zernio wording with the flag off, rate limits read
      as "reconnect") and the poll safety-net follow-up, all fixed; round 2 fixed forged hints displacing genuine ones
      and an orphaned poll row keeping a target on "Checking…"; the lead kept verified hints across key refusals.
    - New browser test `apps/web/e2e/run-stage-c-tiktok.sh` (port 4300, `studio_e2e_c3`; flag on, then off).
    - **Lesson recorded:** a push once went out while the TikTok browser test had 2 failures (the test still expected
      wording the review had removed). Push only through `scratchpad/push-if-green.sh <verify output> 5`, which
      refuses unless every step exited 0 and all five browser tests report 0 failures.
    - In progress: reference style v2 (run `wf_d3892033-bcb`): measure transitions, beat-synced cuts, tempo and
      drop-timed reveals from the owner's own videos. The owner asked to base the edits on their TikTok
      (@jc_chopz); TikTok is not reachable from here and must not be scraped, so they were asked for 3–5 of their
      own videos (attached here or via Google Drive) to calibrate the editor and decide which effects to add.
      **WP10 Zernio stays blocked:** the plan requires docs.zernio.com to be read first; this environment's proxy
      refuses docs.zernio.com and zernio.com (CONNECT 403) and WebFetch cannot resolve them. Needs the owner to
      allow those hosts (a network change) before WP10 can start.
    - The preview/showcase restart is scripted: `scratchpad/restart-preview.sh` (stops by pgid, copies the
      standalone build, migrates both databases, restarts, records new pgids). Run it without a pipe to `tail`.

17. 2026-11-15 to 17, merged into `claude/blissful-lamport-f1lndn`: **reference style v2 — "your style from your videos"** (owner's
    request to base the edits on their TikTok: animations, transitions, music; preferences design §4.3.1). TikTok is
    never read or scraped; the owner uploads their own posted videos as reference videos. Built: measuring in
    `packages/media/src/analysis/reference-style.ts` (transitions, beat sync with a chance correction, drop, zooms,
    music tempo/energy shape, end screen; numbers only, the reference sound never kept or sent anywhere), the v2
    profile and summary in `packages/core` (`reference-signals.ts`, `reference-style.ts`, `editing-style.ts`; v1
    profiles read unchanged), `reference.analyse` writing `version: 2`, the summary routes, the rules planner and AI
    brief using accepted values in the existing renderer vocabulary only, music ranking by tempo/drop over the owner's
    licensed tracks, and Settings → Editing preferences → "Your style from your videos" plus the v2 line on Studio
    reference cards. No migration (jsonb). Deviations from the design numbers, all documented in code: the reveal may
    sit at 45–90 % of the edit (styles hold the result for the last 15–30 %), the drop time starts from the middle of
    the first louder 0.25 s window, and a single knock is rejected by requiring the median power to rise too.
    Review fix-up on the same branch: "cut every N beats" fitted to each style's shot range (every 8 beats no
    longer breaks the beat montage), a music-length repair when a trimmed-to-the-track edit ran past the music, a
    last-resort rebuild without the editing style (plan note), the "lands on the biggest lift" note rechecked on the
    final plan; measuring: flashes need a near-uniform frame (bright/dark shots are cuts), only start/end screens
    are screens, gradual limits in seconds with a fixed 1/30 s change measure (60 fps proxies), zoom joins gated by
    the scale-fit residual, blur transitions never cross-fades, soft wipes told from cross-fades by the per-column/row
    blend spread; edge fixtures X1–X8 (design §4.3.1.10).
    Second fix-up: the X2 test was flaky because `gradients` picks random colours whatever its `seed` (also
    `anoisesrc`, R7's `life`/`cellauto`, x264 frame threads and FFmpeg 6.1's `slideup` first frame varied between
    builds); all pinned, two builds of every fixture are byte-identical. The colours exposed two measuring bugs, both
    fixed with regression fixtures X9–X11: a cut into a smooth shot read as a slide (the shifted frames must now look
    alike), and a long bright run counted as a white screen because its brightest frame was uniform (now frame by
    frame). The planner's last resort steps down: first without the transitions from the owner's videos (keeping the
    beat, beats per cut, the reveal and zooms), then without the editing style, each with its own plan note.
    Review round 2 (independent review of that fix-up: 43 agents, 15 confirmed findings) and its fix-ups, in two
    tracks, each independently verified and rechecked:
    - Measuring: cards (white or black screens) are judged frame by frame and continue while the frame still shows
      the card, so logos, banners and text animating in stay in the card while a cut that takes the card's marks
      away ends it; steep fades into cards are not cuts; the cut into a card is anchored at its own frame (no double
      count at 60/24 fps); white and black end screens are left out of every measurement; slow fades into end cards
      start the end screen; the cut test searches shifts up to half the frame only when the picture is moving beside
      the spike (fast slides stay slides, jump cuts stay cuts); pans and tilts (also diagonal) inside one shot are
      not joins. Regression fixtures X12-X30; the measuring constants are pinned to REFERENCE_STYLE_ANALYSIS_VERSION
      (still 1: no real profile exists yet; bump it whenever measuring semantics change). On a 525-clip SYNTHETIC
      battery measured on identical bytes: 485 right (403b68e 314, 258cadc 287), no clip right before and wrong now
      except the two trade-offs listed under "Known limits" in design §4.3.1.10.
    - Planner, worker and core: one shared length rule (packages/core edit-length.ts, measured from the first usable
      beat) for both planners, the worker, the route and the form, which also fixes a live bug where a 45 s edit with
      a slightly shorter track failed in the worker; the music starts on the beat the cuts snap to and beatAlignment
      reports only beats a plan really hits (none for tracks without a clear beat); fallback, revision and palette
      notes describe what the finished plan does; musicFit only ranks tracks; the worker refuses a too-short track
      before any planner call; the Your style summary combines only the current measuring version and keeps accepted
      values visible and stoppable; a reversed tempo range is refused (400).
    **Next:** run it on 3–5 of the owner's real posted videos and tune the thresholds (design §4.3.1.10, including the
    known limits there); every threshold is a starting value from synthetic clips.
18. 2026-11-17: **CI fixed** (GitHub Actions had failed on all 93 runs). No assertion had ever failed: fresh runners have
    no data/samples (git-ignored), and (A) the media tests' footage lock was taken before its folder existed, so they
    waited out a 240 s timeout; (B) render.test.ts never generated the footage and logo/look skipped silently; (C)
    four worker DB tests ran scripts/make-sample-footage.sh at once and broke each other's files. Now one coordinated
    generator (a portable mkdir lock with an exclusively created owner record and stale-lock takeover, a re-check
    under the lock, a per-run temporary folder, a completion marker; macOS bash 3.2 compatible) serves every caller,
    every synthetic source is deterministic, and square-changes-db.test.ts books at 10:00 Melbourne time (it failed
    whenever the suite ran after about 22:00 Melbourne). The whole CI sequence passes on a fresh checkout with no
    data/ folder (also on 2 CPUs); a faketime audit (app and Postgres on the same fake clock) found no other
    time-of-day dependence. Check GitHub's CI result after every push (the local verify-all.sh does not run on a
    fresh checkout).
    Merged and pushed together with item 17 as 60800f2 (README follow-up f0b913a) after verify-all.sh on main:
    1,677 unit tests passed + 1 skipped, integration 12/12, Stage A 51/51, Stage B 77/77, Stage C bookings 124/124,
    website 114/114, TikTok 105/105. **GitHub CI is green for the first time**: runs #94 (60800f2) and #95 (f0b913a),
    17 Nov 2026. CI's "Install FFmpeg" step took 9 minutes on the runner (slow apt mirror); caching it is a possible
    speed-up, not a correctness issue.

Check the task list or `/workflows` first. **While a run is alive, do not edit `packages/ai`, `apps/web`,
`apps/worker` or the root dev-ops files yourself**: its agents are writing them. Agents never commit; the lead
session reviews and commits their output. If no run is alive, compare the repo with the run's goals (each agent
returns a structured report in the workflow journal) and re-launch only the missing pieces from `docs/handover/`.

## 0. First commands in a fresh session

```bash
cd /home/user/editor
git status                      # agent processes may have written files after the handover commit — keep them, review them
pnpm install                    # node_modules were present in the sandbox; a fresh clone needs this
bash scripts/make-sample-footage.sh data/samples   # synthetic test clips (data/ is gitignored)
pnpm -r typecheck               # expect: everything passes EXCEPT apps/worker (needs @studio/ai) and apps/web (not started)
pnpm -r --no-bail test          # core 21, db 3, storage 5, media 63, worker 3 (+5 skipped unless TEST_DATABASE_URL is set)
```

Local Postgres used in the sandbox (no Docker daemon available there). In a fresh container run the `initdb`
block once; afterwards only `pg_ctl … start`:
```bash
mkdir -p /var/lib/postgresql/sa-test && chown postgres:postgres /var/lib/postgresql/sa-test
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/sa-test/data -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/sa-test/data -o '-p 55432 -k /tmp -c listen_addresses=127.0.0.1' -l /var/lib/postgresql/sa-test/log start"
export DATABASE_URL=postgres://postgres@127.0.0.1:55432/studio_assistant
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres
psql -h 127.0.0.1 -p 55432 -U postgres -c "create database studio_assistant"   # first time only
pnpm db:migrate
```
A `.env` (gitignored) with these values existed at the repo root; recreate it from the list in section 6 if missing.
The dev-ops agent was meant to write `scripts/local-postgres.sh` and `.env.example` — **they do not exist yet**.

## 1. What the product is (unchanged spec)

Private web app "Studio Assistant" for a barber in Ivanhoe VIC (Australian English, AUD, Australia/Melbourne).
Highest priority: drop phone haircut videos into a project → choose length/style/music → "Generate 5 edits" →
five genuinely different 9:16 previews → revise/regenerate each independently with version history → export real
1080×1920 MP4. Later stages: music licensing/controls, Instagram/TikTok publishing, Square appointments, email,
Google review requests, website/local-search tools. The owner's full specification is reproduced in section 9.

Build order agreed: **Stage A** (upload → analysis → five previews → revise → export) must pass the acceptance
test before Stages B/C. Never present simulated data as real; show honest "needs setup" states.

## 2. State of the repository at handover (commit history on `claude/blissful-lamport-f1lndn`)

| Area | Status | Evidence |
| --- | --- | --- |
| `packages/core` — contracts (EditPlan schema, validator, timeline maths, 5 styles, analysis types, jobs, revision parser, music licence, settings, safe zones) | **Done, tested** | 21 unit tests pass |
| `packages/config` — typed env (Zod) | Done | typechecks |
| `packages/db` — Drizzle schema (29 tables incl. Stage B/C), `drizzle/0000_init.sql`, client, migrate, seed, AES-GCM token crypto | **Done, tested** | migration applied to local PG; 3 tests |
| `packages/storage` — BlobStore: LocalDiskStore + S3Store (Supabase/R2/S3), HMAC signed links, multipart | **Done, tested** | 5 tests |
| `packages/queue` — pg-boss 12 wrapper (per-type retry/expiry/heartbeat) | Done | typechecks; verified against installed types |
| `packages/media` — ffmpeg/ffprobe, analysis, renderer | **Done, tested** | 64 tests; cut-then-transition fix |
| `apps/worker` — job tracker, handlers, recovery | **Done, tested** | 11 unit + 12 integration tests (synthetic footage, incl. music beat alignment); kill -9 recovery verified |
| `packages/ai` — rules planner, Anthropic planner/labeller, transcription | **Done, tested** | 60 tests; real Anthropic/OpenAI APIs not yet called (no keys) |
| `apps/web` — shell, auth, settings, Video Studio, API | **Done, tested** | 77 tests; build passes; end-to-end browser test 51/51 (`apps/web/e2e/run-stage-a.sh`) |
| Dev-ops/docs — compose, Dockerfiles, scripts, docs | Done | scripts tested; Docker images not built (no daemon here) |
| Research | **Complete** (12 topics, critique, 8 follow-ups). Read `docs/research/platform-constraints.md` (supersedes `decisions-summary.md` where they differ) | memo + raw findings in `docs/research/` |
| CI | `.github/workflows/ci.yml` written (untested in GitHub) | |

**Stage A status (2026-11-14): passes its acceptance checks on synthetic footage only. It has NOT been validated on the owner's real haircut clips, and no AI key has been used yet.** Screenshots: `docs/screenshots/`.

## 3. Background agents that were running when the session ended

Two workflows (Claude Code `Workflow` tool) were in flight. Their scripts are saved verbatim in `docs/handover/`.

1. `phase1-implementation-workflow.js` — five parallel implementation agents. Only **media-analysis** and
   **media-render** had started (sandbox allowed 2 concurrent agents); both had produced working code when this
   file was written (typecheck + 63 tests green). **ai-package, web-foundation, devops-docs never started.**
   To continue: either re-run the script with the `Workflow` tool (edit it to drop the two media agents if their
   work is complete) or implement those three prompts directly. The prompts are complete specifications —
   follow them literally; they encode decisions already made (SDK usage, routes, design, safety rules).
2. `platform-research-workflow.js` — 12 research topics + critique + follow-up + synthesis into
   `docs/research/platform-constraints.md`. 9 topics finished and are saved in `docs/research/`. Missing: **transcription, trend sources, Anthropic vision limits**, plus the
   critique/synthesis stages (they write `docs/research/platform-constraints.md`).
   Re-run the script (the journal cache does not survive a new session) or run only the missing topics by hand.

Agents may have kept writing to `packages/media/**` after the last commit; `git status` shows whether. Review
any such files before committing (they are agent-generated).

## 4. Contracts the worker assumes from `@studio/ai` (implement exactly, or adjust the worker)

`apps/worker` imports these from `@studio/ai` (see `src/handlers/ingest.ts`, `generate.ts`, `lib/planning.ts`,
`lib/plan-context.ts`, `main.ts`, `test/pipeline.integration.test.ts`):

```ts
createAiProviders(env: Env, logger?: Logger): {
  planner: EditPlanner;            // AnthropicPlanner when AI_PROVIDER=anthropic, else RulesPlanner
  rulesPlanner: EditPlanner;       // always the deterministic RulesPlanner
  labeler: VisionLabeler | null;   // AnthropicVisionLabeler or null
  transcriber: Transcriber | null;
  describe(): { plannerName: string; plannerModel: string | null; labelerModel: string | null; transcriberName: string };
}
class HeuristicLabeler implements VisionLabeler  // model: null; returns 'unknown' labels
interface VisionLabeler { name: string; model: string | null;
  labelShots(input: { frames: FrameForLabelling[]; context: { clipName; clipDurationSec; projectNotes; clipIndex; clipCount } }, opts?: { signal?: AbortSignal })
    : Promise<{ results: ShotLabelResult[]; usage: AiUsage | null }> }
interface FrameForLabelling { assetId; shotId; timeSec; jpegPath; width; height }
interface ShotLabelResult { shotId; label: SegmentLabel; confidence; description; framing: 'closeup'|'medium'|'wide'|'unknown'; focus: {x,y}|null; issues: string[] }
interface EditPlanner { name: string; model: string | null;
  planEdit(input: PlannerInput, opts?: { signal? }): Promise<{ plan: unknown; usage: AiUsage | null; source: 'ai' | 'rules' }> }
interface PlannerInput { styleId; targetDurationSec; analyses: AssetAnalysis[]; assets: PlanAssetInfo[];
  music: { trackId; durationSec; bpm: number|null; beatTimesSec: number[]; title } | null; preferences: EditingPreferences;
  brand: BrandConfig; businessName; instructions; keepOriginalSound: 'auto'|'always'|'never'; captions: 'auto'|'never';
  attempt: number; previousPlan?: EditPlan; revisionInstruction?: string; revisionHints?: RevisionHints; previousErrors?: PlanIssue[] }
interface Transcriber { name; transcribe(audioPath, opts?: { language?; signal? }): Promise<{ provider; language: string|null; segments: TranscriptSegment[] }> }
interface AiUsage { provider; model; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; durationMs; estimatedCostUsdCents }
```
The worker does its own validate→repair→fallback loop (`apps/worker/src/lib/planning.ts`), so the AI package's
optional `planWithRepair` helper is not required.

Anthropic SDK facts verified against the installed `@anthropic-ai/sdk@1.6.0`: `client.messages.parse({ model,
max_tokens, system: [{type:'text', text, cache_control:{type:'ephemeral'}}], messages, output_config: { format:
zodOutputFormat(Schema), effort } })` → `response.parsed_output`; `zodOutputFormat` from
`@anthropic-ai/sdk/helpers/zod`; zod peer `^3.25 || ^4`. Models: planner default `claude-opus-5-5`, vision
default `claude-haiku-5-5` (cheap bulk labelling), configurable via env. Never send temperature/thinking/tool_choice forcing.

## 5. Media package API the worker uses (already implemented by the agents — names verified)

`makeProxy(input, output, { probe, maxHeight, ffmpegPath, signal, onProgress })`, `makeThumbnail`,
`extractFrames(input, times, outDir, { probe, longEdge, ffmpegPath, signal })`, `detectScenes(input, { probe, … })`,
`measureQuality(input, shots, { probe, … })`, `analyseAudio(input, { probe, … })`, `analyseMusic(input, { probe, … })`,
`assembleShots(assetId, scenes, qualities)`, `chooseFrameTimes(shots, { maxFrames })`,
`renderEditPlan(inputs: RenderInputs, outputPath)` with `RenderInputs = { plan, assets: Record<id,{path,probe}>, music,
transcripts?, quality: 'preview'|'export', output?, brand, fontsDir, tmpDir, ffmpegPath?, threads?, signal?, onProgress? }`.
Previews render from the 540×960 SDR proxies; exports from the originals (HDR tonemap + autorotate handled in the graph).

## 6. Environment variables (from `packages/config/src/index.ts`)

NODE_ENV, LOG_LEVEL, APP_URL, DATABASE_URL, QUEUE_DATABASE_URL?, APP_SECRET (≥32 chars), APP_ENCRYPTION_KEY?,
STORAGE_DRIVER=local|s3, STORAGE_LOCAL_ROOT, S3_ENDPOINT/S3_REGION/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_FORCE_PATH_STYLE,
MEDIA_LINK_TTL_SECONDS, MAX_UPLOAD_BYTES, WORKER_TMP_DIR, WORKER_CONCURRENCY, FFMPEG_PATH, FFPROBE_PATH, FFMPEG_THREADS,
AI_PROVIDER=none|anthropic, ANTHROPIC_API_KEY, AI_PLANNER_MODEL, AI_PLANNER_EFFORT, AI_VISION_MODEL, AI_VISION_MAX_FRAMES_PER_CLIP,
DB_POOL_MAX?, QUEUE_POOL_MAX?, TRANSCRIPTION_PROVIDER=none|deepgram|openai, DEEPGRAM_API_KEY, DEEPGRAM_MODEL (nova-3),
OPENAI_API_KEY, OPENAI_TRANSCRIPTION_MODEL, META_APP_ID/SECRET, TIKTOK_CLIENT_KEY/SECRET,
SQUARE_APPLICATION_ID/SECRET, SQUARE_ENVIRONMENT, SQUARE_WEBHOOK_SIGNATURE_KEY, RESEND_API_KEY, EMAIL_FROM, GOOGLE_CLIENT_ID/SECRET.
Sandbox `.env` used: DATABASE_URL=postgres://postgres@127.0.0.1:55432/studio_assistant, APP_SECRET=dev-only-…,
STORAGE_DRIVER=local, STORAGE_LOCAL_ROOT=./data/storage, WORKER_TMP_DIR=./tmp/worker, AI_PROVIDER=none.

## 7. Exact next steps, in order

1. **Implement `packages/ai`** from the `AI` prompt (rules planner is the critical path: it must yield five valid,
   distinct plans with no API key). Then `pnpm --filter @studio/worker typecheck` must pass.
2. **Run the Stage A worker acceptance test**: `TEST_DATABASE_URL=… pnpm --filter @studio/worker test:integration`
   (`apps/worker/test/pipeline.integration.test.ts`: ingest incl. rotated HEVC HLG + silent clip → manual tags →
   five styles planned → previews → revise to 15 s without losing versions → 1080×1920 export → interrupted job →
   incomplete footage). Fix whatever fails. Synthetic footage only — say so in the README.
3. **Web foundation** (`WEB_FOUNDATION` prompt) then **Video Studio UI** (routes in `docs/api.md`): chunked resumable
   uploads (8 MiB parts, `upload_sessions`), status polling (`/api/projects/[id]/status` every 3 s), clip cards with
   thumbnails, manual tags (Before/Cutting/Fade detail/Result/Reaction), style support shown with reasons, duration
   slider (8–90, default 25), music picker (upload with licence form + offset slider over the `beats.energy` curve),
   "Generate 5 edits" (creates generation + 5 edits + v1 versions status `planning`, enqueues `edits.generate`), five
   preview cards (video player on a signed URL, style description, favourite, revise with instruction box,
   regenerate, version switcher, export → download), job progress with cancel/retry, honest empty/error states.
   Project delete must remove storage prefix. Keep Video Studio the main destination; charcoal/white + accent colour.
4. **Dev-ops/docs** (`DEVOPS_DOCS` prompt): compose, Dockerfiles, `.env.example`, `scripts/local-postgres.sh`,
   deployment/costs/testing/security docs, README with Completed / Verified on synthetic footage / Waiting on access.
5. **Playwright E2E** (Chromium preinstalled at /opt/pw-browsers/chromium in the sandbox): login → create project →
   upload sample → generate → five previews → export → download → ffprobe the file.
6. Commit + push after each step (`git push -u origin claude/blissful-lamport-f1lndn`).
7. **Stage B/C** following `docs/research/decisions-summary.md` (TikTok = draft/export fallback only; Instagram = Meta
   container flow via unified/Facebook Login for Business with dev-mode owner account; Spotify = reference links only,
   never audio or AI input; Square = tiered capabilities gated at runtime; Google = link-based review requests first;
   Supabase Pro Sydney with S3 protocol storage; music = owner-uploaded "licence passport" + optional provider adapters).
   Finish the missing research topics first (transcription, trend sources, Anthropic vision limits).

### Research-driven changes still to apply (after the current agent run finishes)

1. **Safe zone. DONE.** `packages/core/src/safe-zones.ts` now holds the researched model at 1080x1920:
   R_strict x 120–780, y 270–1248 (all text by default); R_head x 120–960, y 270–840 (boxes ending at y ≤ 840);
   forbidden areas y < 270, y ≥ 1248, x < 120, x ≥ 960 and the action column x ≥ 780 where y ≥ 840; subtitles
   centred on x 540, ≤ 480 px wide, bottom ≤ 1248, ≥ 56 px type. `safeZoneFor`/`scaleSafeZone` scale it (previews
   halve exactly). `packages/media/src/render/ass.ts` (`layoutAssDocument`) wraps and sizes text itself from
   conservative font metrics so every box, outline, shadow, pop scale and rise travel included, stays in its region;
   `top` text uses R_head when it fits above y 840. Tests: `packages/core/test/safe-zones.test.ts` (region maths),
   `packages/media/test/render-ass.test.ts` (layout) and `render.test.ts` (libass every frame over grey at both sizes,
   plus a real preview pixel diff with zero changed pixels in every forbidden area). See `packages/media/README.md`.
   Consequence: captions at 56 px in 480 px hold about 10–16 characters per line, so a long caption takes 3+ lines;
   splitting long captions into timed pages is a possible follow-up.
2. **Transcription. Done (adapter); VAD gate still open.** OpenAI `whisper-1` is scheduled to shut down on 26 Feb
   2027 and newer OpenAI models give no documented timestamps. `packages/ai/src/transcription/deepgram.ts` now
   calls Deepgram's pre-recorded `POST /v1/listen` (Nova-3, `smart_format`, `punctuate`, `utterances`, header
   `Authorization: Token …`, raw audio bytes with their content type) and maps utterance words to caption-sized
   segments (≤ 42 characters per line, ≤ 2 lines, ≥ 0.7 s on screen, real word timings only; low-confidence
   segments dropped). `TRANSCRIPTION_PROVIDER=deepgram` + `DEEPGRAM_API_KEY` (+ optional `DEEPGRAM_MODEL`) select
   it; Settings → Integrations shows it as configured or missing. whisper-1 stays as the optional `openai`
   provider. Still to do: the Silero VAD gate (only the DSP heuristic gates today), caching results by asset +
   audio hash so retries do not pay twice, and checking the parser against a recorded live Deepgram response
   (the response nesting of `utterances` was not verified; both places are read).
   Also done in the same change: pg-boss `heartbeatSeconds` 30 on every queue and `superviseIntervalSeconds` 30
   for the worker (existing queues are updated at worker start); optional `DB_POOL_MAX`/`QUEUE_POOL_MAX` with a
   Supabase Micro budget in `docs/deployment.md`; more natural revision phrasings in `parseRevisionInstruction`
   ("turn the music down", "cut it to 15", "half a minute", "no wipes", "keep it simple", "linger on the
   reveal", "start with the finished cut").
3. **Vision requests.** At most 20 images per Claude request; frames at 768 px; no person identification.
4. **Export preset. DONE** (`packages/media/src/render/command.ts`, `verify.ts`): libx264 High, level 4.1 at ≤ 30 fps
   and 4.2 above, CRF 18 with `-maxrate 20M` (24M at 60 fps, 12M over 90 s), yuv420p, progressive, CFR, closed 2 s
   GOP (`-g`/`-keyint_min` 2×fps, `-sc_threshold 0`, `-flags +cgop`), BT.709 tags, AAC-LC 48 kHz stereo, faststart;
   previews keep veryfast/CRF 27 with the same GOP/CFR settings. Renders over 180 s are refused with a plain
   `AppError('VALIDATION')`. Every export is checked with `verifyExport` (ffprobe) and fails with a plain message if
   it does not match. Still open: the worker always exports `VERTICAL_1080` at 30 fps; choosing 60 fps when every
   source is ≥ 50 fps is not wired up (the 4.2 path is ready for it).
5. **Stage B/C approaches changed by the follow-ups:** Spotify links/embeds only (no Web API); TikTok export +
   manual post, optional Zernio provider later; Instagram direct publishing only after a live smoke test; Meta
   Sound Collection tracks locked to Instagram/Facebook renders; Square writes gated on plan, fee-free services and
   a self-test; Postmark (transactional + broadcast streams) for email with a consent ledger.

### Gaps reported by the Video Studio agent (to schedule)

- ~~Staff access~~ **Closed (2026-11-14).** `getAccessibleProject` / `projectVisibilityFilter` / `getAccessibleJob`
  (`apps/web/src/lib/studio-access.ts`) now apply to GET/POST `/api/projects`, GET/PATCH/DELETE `/api/projects/[id]`,
  `/api/projects/[id]/jobs`, `/api/jobs/[id]/cancel|retry`, the dashboard, the project list and the Content
  Library (owner sees all, staff only their own; project-less jobs are the owner's). Tests:
  `apps/web/test/studio-access.integration.test.ts`.
- ~~Music licence confirmation~~ **Closed.** Settings → Music library shows each track's licence status and has a
  "Licence details" form with the explicit rights checkbox (`PATCH /api/music/[id]` `confirmLicence`), plus
  "Upload licensed track" using the Studio uploader (`POST /api/music/uploads`). Remaining limitation: library
  uploads ride on the user's most recent project because `upload_sessions.project_id` is NOT NULL; making it
  nullable (migration) would let a user with no project upload music.
- ~~Not built yet: clip reordering, per-shot tagging, music start-offset picker~~ **Closed.** Move up/down
  (+ Alt + arrows) backed by `POST /api/projects/[id]/assets/order`; an expandable "Shots" panel per clip
  (`GET /api/assets/[id]/shots`, tags via `manualLabels`); `GenerationSettings.musicStartSec` (core) → worker
  `buildPlannerInput` → `PlannerInput.musicStartSec` → rules planner snaps to the first beat at or after it
  (`beatGrid(..., fixedStartSec)`, `snapMusicStart`), the Anthropic planner gets `music.fixedStartOffsetSec` and
  the plan's start is forced to it; the generate route checks it against the track length; the Studio shows BPM,
  the energy curve and an Automatic / slider (mm:ss) picker.
- Local-driver media links carry a readable (HMAC-signed, not encrypted) payload with the storage key; keys hold only
  ids. Encrypt or use opaque references if keys must never reach browsers.

## 8. Decisions already made (do not re-litigate without reason)

- FFmpeg + libass render text (vendored Inter fonts in `assets/fonts`); Remotion not used (licence is free ≤3
  employees, but it adds a Chromium dependency; noted as optional later upgrade).
- Postgres (local or Supabase) + S3-compatible private storage; auth is self-managed (Argon2id, opaque session
  cookies) rather than Supabase Auth so local dev works without Supabase.
- pg-boss 12 for durable jobs; `jobs` table mirrors progress; cancellation is cooperative via AbortSignal; restart
  recovery via heartbeats + `recoverStaleJobs`.
- Plans are validated against real footage (`validateEditPlan`) before rendering; captions must exist in the
  transcript; styles needing before/result/reaction shots are disabled unless the vision model or owner tags provide them.
- Previews from proxies, exports from originals; five previews rendered automatically, exports only on request.
- Default models: planner `claude-opus-5-5`, vision `claude-haiku-5-5`; `AI_PROVIDER=none` → rules planner.
- Sandbox quirks: no Docker daemon; most documentation hosts blocked (use WebSearch); shell cwd resets between
  commands (use absolute paths); keep `.js` suffixes on relative imports.

## 9. Owner's specification

See `docs/spec.md` (faithful restatement of the full brief, sections 1–8).
