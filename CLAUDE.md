> **New session? Start with docs/HANDOVER.md — it says exactly where the previous session stopped.**

# Studio Assistant — notes for Claude Code sessions

Private web app for a barber studio in Ivanhoe, VIC (Australian English, AUD, `Australia/Melbourne`).
Read `docs/architecture.md` first, then `docs/api.md`. Research on platform policies lives in `docs/research/`.

## Commands
- `pnpm install` · `pnpm -r typecheck` · `pnpm -r test` (unit) · `pnpm --filter @studio/worker test:integration` (needs `TEST_DATABASE_URL` + ffmpeg)
- Local Postgres without Docker: `bash scripts/local-postgres.sh start` · migrations: `pnpm db:migrate` · owner account: `pnpm db:seed` (OWNER_EMAIL/OWNER_PASSWORD) or the `/setup` page
- Run: `pnpm dev` (web) and `pnpm dev:worker` (worker) with a `.env` based on `.env.example`
- Synthetic test footage: `bash scripts/make-sample-footage.sh data/samples`

## Rules that matter here
- Never present simulated bookings, renders, analytics or posts as real. Every integration shows an honest "needs setup" state until connected.
- The renderer only accepts plans that passed `validateEditPlan` (packages/core). Captions must come from the transcript; never invent before shots, reactions or dialogue.
- Long work belongs in `apps/worker` jobs (pg-boss), never in a web request. Handlers must be idempotent and honour the `AbortSignal`.
- Media is private: browsers only ever get expiring links. Secrets stay server-side; tokens are encrypted at rest.
- Keep relative imports with the `.js` suffix; strict TypeScript; Zod 4 schemas in `packages/core` are the contracts.
- Australian English in UI text (colour, favourite, licence, analyse).
