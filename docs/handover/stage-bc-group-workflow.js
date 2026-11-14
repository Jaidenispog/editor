export const meta = {
  name: 'studio-assistant-stage-bc-group',
  description: 'Build one Stage B/C plan group: each work package in its own worktree, then an integration lead merges, renumbers migrations and re-verifies everything (no push)',
  phases: [
    { title: 'Build', detail: 'one agent per work package, isolated worktrees, each commits on its branch' },
    { title: 'Integrate', detail: 'merge in plan order, regenerate migrations, full verification, commit (no push)' },
  ],
}

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    worktree_path: { type: 'string' },
    branch: { type: 'string' },
    commit_sha: { type: 'string' },
    migration_sql: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    commands_run: { type: 'array', items: { type: 'string' } },
    test_output_tail: { type: 'string' },
    typecheck_passed: { type: 'boolean' },
    tests_passed: { type: 'boolean' },
    acceptance_tests_covered: { type: 'array', items: { type: 'string' } },
    not_done: { type: 'array', items: { type: 'string' } },
    owner_setup_needed: { type: 'array', items: { type: 'string' } },
    notes_for_integrator: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'worktree_path', 'branch', 'commit_sha', 'migration_sql', 'files_changed', 'commands_run', 'test_output_tail', 'typecheck_passed', 'tests_passed', 'acceptance_tests_covered', 'not_done', 'owner_setup_needed', 'notes_for_integrator'],
}

const WT = `
You are a senior engineer on "Studio Assistant": a private web app for a barber studio in Ivanhoe, Victoria, Australia (Australian English, AUD, Australia/Melbourne incl. daylight saving). Stage A (video editing) is complete and verified; you are building one Stage B/C work package.

WORKTREE RULES (critical):
- You run in your OWN git worktree. First run "pwd" and call that directory ROOT. Use absolute paths under ROOT for every command (the shell's working directory resets between commands).
- Never edit anything under /home/user/editor (the main checkout) — other agents use it.
- Setup in ROOT first: "cd ROOT && pnpm install --frozen-lockfile" (if you add a dependency: exact version in the right package.json, then "pnpm install" in ROOT) and "ln -sfn /home/user/editor/data ROOT/data" (synthetic sample footage, gitignored; do not commit the symlink).
- Postgres: export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres and create only throwaway databases. Never touch studio_assistant or any studio_* database you did not create, never stop the server. Do not bind ports 3000 or 3100 (use 3300+ for any server you start, and stop it afterwards).
- NO real external calls: there are no credentials, and live emails, posts or booking changes must never be triggered to test a connection. Test every integration against injected fakes / local fake HTTP servers. Build honest UI states (not configured / configured / connected / needs re-authorisation / error; sandbox vs live).
- Conventions: TypeScript strict, ESM, ".js" suffix on relative imports, Zod 4 contracts in packages/core, vitest tests in <pkg>/test, JSDoc on exports, Australian English in UI text and comments, plain user-facing messages, no placeholders/TODOs/mock logic on production paths, no invented APIs (use only what the design docs and research memo document; where they mark something unverified, implement the documented capability check and keep the feature off until it passes).
- Never present simulated data as real.`

const BUILD = (p) => `${WT}

TASK: implement work package ${p.wp} of ROOT/docs/design/stage-bc-plan.md exactly.
Read first: ROOT/CLAUDE.md, ROOT/docs/HANDOVER.md, ROOT/docs/design/stage-bc-plan.md (section 1 cross-check results, section 2 shared foundations, the ${p.wp} section in section 3, section 4 shared-file rules, section 9 the lead's design edits), the module design doc(s): ${p.docs.map((d) => 'ROOT/' + d).join(', ')}, and ROOT/docs/research/platform-constraints.md sections those docs cite. Then the existing code you build on.
Rules:
- Create/edit only what ${p.wp}'s "Owns" list gives you, plus one-line additions to the append-only shared files listed in plan section 4. If you need a change in a file you do not own, implement the smallest compatible alternative inside your files and record the request in notes_for_integrator.
- Migration: ${p.migration ? `after editing the schema, generate exactly one migration with "cd ROOT/packages/db && pnpm exec drizzle-kit generate --name ${p.migration}" (use the DATABASE_URL of a throwaway database if drizzle-kit asks for one); review the SQL (additive only, per plan section 3) and paste it into migration_sql (the lead may renumber it on merge).` : 'this package needs no migration; leave packages/db/drizzle untouched and set migration_sql to "".'}
- Implement every acceptance test listed for ${p.wp} in the plan (unit, integration with fakes, database-backed with TEST_DATABASE_URL). List them in acceptance_tests_covered; list anything not done in not_done with the reason.
- Update the docs per plan section 4 (only your module headings).
Verify (all must pass before you commit): "cd ROOT && pnpm -r typecheck"; "TEST_DATABASE_URL=… pnpm -r --no-bail test"; "TEST_DATABASE_URL=… pnpm --filter @studio/worker test:integration" (Stage A pipeline, must stay 12/12); "NEXT_TELEMETRY_DISABLED=1 pnpm --filter @studio/web build"; and if you touched UI, a quick headless-Chromium check of your new pages for console errors and a 390 px width (require('playwright') works globally; never run playwright install).
Then commit inside ROOT: "git add -A -- . ':!data'" and "git commit -m '<clear message>'" whose last two lines are exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A394AkMo88kGxHK5MDHk5B
Do not push. Leave nothing else uncommitted. Report ROOT, branch (git rev-parse --abbrev-ref HEAD) and commit SHA. If you run out of budget, commit what is solid and report exactly where you stopped.
Return ONLY the structured report.`

const INTEGRATE = (group, reports) => `You are the integration lead for "Studio Assistant", working in the MAIN checkout /home/user/editor on branch claude/blissful-lamport-f1lndn (no worktree). Plan group ${group} of /home/user/editor/docs/design/stage-bc-plan.md was just built by the agents below, each on its own worktree branch.

Read /home/user/editor/docs/design/stage-bc-plan.md sections 3 ("Merge and migration rules"), 4 and 5, and /home/user/editor/CLAUDE.md.

STEPS:
1. Check the main checkout is clean (git status). Merge the branches in this order, one at a time, with "git merge --no-ff <branch>" and a clear message ending with the two attribution lines below. Resolve conflicts per plan section 4 (append-only files keep both sides; never drop another package's work).
2. Migrations: after merging a package that ships SQL, renumber it in merge order exactly as plan section 3 says: delete that package's generated migration SQL, its snapshot and its journal entry from packages/db/drizzle, regenerate with "cd /home/user/editor/packages/db && pnpm exec drizzle-kit generate --name <name>", diff the result against the package's reviewed SQL (in its report) and re-add any statement drizzle-kit cannot express. Commit the renumbered migration. The journal must list every migration once, in order.
3. "cd /home/user/editor && pnpm install" (only if a lockfile/package.json changed), then verify on the merged result: "pnpm -r typecheck"; "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm -r --no-bail test"; "TEST_DATABASE_URL=… pnpm --filter @studio/worker test:integration" (must be 12/12); "NEXT_TELEMETRY_DISABLED=1 pnpm --filter @studio/web build"; the Stage A browser test "bash apps/web/e2e/run-stage-a.sh" (must stay 51/51; it uses port 3100 and its own studio_e2e database); and apply the migrations to the live preview database with "DATABASE_URL=postgres://postgres@127.0.0.1:55432/studio_assistant pnpm db:migrate". Do not stop the preview server on port 3000 or its worker.
4. Fix integration problems with minimal, clearly justified changes (list each). Never weaken a test to hide a defect.
5. Commit any fixes. Do NOT push (the lead session reviews and pushes). Then remove the merged worktrees ("git worktree remove --force <path>") and delete the merged branches.
Every commit message ends with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A394AkMo88kGxHK5MDHk5B

BUILD REPORTS (merge in this order):
${JSON.stringify(reports, null, 1).slice(0, 90000)}

Return a plain-text report: merge commits, renumbered migrations, verification results with counts, fixes made, and anything left open.`

const pkgs = args.packages
phase('Build')
log(`Group ${args.group}: building ${pkgs.map((p) => p.wp).join(', ')} in worktrees`)
const RESUME = (p) => BUILD(p).replace(
  'You run in your OWN git worktree. First run "pwd" and call that directory ROOT.',
  `You CONTINUE work in an existing git worktree: ROOT is ${p.resumeWorktree} (branch ${p.resumeBranch}). Do not run "pwd" to find ROOT; use that path. A previous agent built part of ${p.wp} there and was stopped by a usage limit before verifying; its work is in the latest commit ("WIP: ${p.wp}…"). Start by reviewing that diff against the plan's Owns list and acceptance tests, keep what is sound, finish what is missing, fix what is wrong, then verify and commit as below (a normal commit on top of the WIP commit).`,
)
const reports = await parallel(pkgs.map((p) => () =>
  p.resumeWorktree
    ? agent(RESUME(p), { label: `resume:${p.wp}`, phase: 'Build', schema: REPORT, effort: 'high' })
    : agent(BUILD(p), { label: `build:${p.wp}`, phase: 'Build', schema: REPORT, isolation: 'worktree', effort: 'high' })))
const ordered = pkgs.map((p, i) => ({ wp: p.wp, migration: p.migration || null, report: reports[i] }))
const missing = ordered.filter((o) => !o.report).map((o) => o.wp)
if (missing.length) log(`No report from: ${missing.join(', ')} — the integrator will merge only the packages that reported a branch`)

phase('Integrate')
const integration = await agent(INTEGRATE(args.group, ordered.filter((o) => o.report)), { label: `integrate:${args.group}`, phase: 'Integrate', effort: 'high' })
return { group: args.group, reports: ordered, integration }