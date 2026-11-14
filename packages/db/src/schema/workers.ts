import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Background worker presence. `../schema.ts` re-exports this file, so the app, the worker and drizzle-kit all see
 * the table. Each running worker process keeps one row up to date (see `../worker-heartbeats.ts`): it writes
 * `last_seen_at` every WORKER_HEARTBEAT_INTERVAL_MS and deletes its row on a graceful stop. A worker that was killed
 * leaves its row behind with an old `last_seen_at`, which is exactly what the web app needs to say "the background
 * worker isn't running". Rows nobody has updated for a day are pruned when a worker starts.
 */
export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    /** The worker's id (`<hostname>-<pid>-<random>`), the same value as `jobs.worker_id`. */
    id: text('id').primaryKey(),
    hostname: text('hostname').notNull(),
    pid: integer('pid').notNull(),
    /** Worker package version (informational). */
    version: text('version').notNull().default(''),
    /** Job types this worker registered handlers for. */
    queues: jsonb('queues').$type<string[]>().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Database time of the latest heartbeat (always written with the server's now(), never the worker's clock). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('worker_heartbeats_last_seen_idx').on(t.lastSeenAt)],
);

export type WorkerHeartbeat = typeof workerHeartbeats.$inferSelect;
