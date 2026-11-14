import { eq, lt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { workerHeartbeats } from './schema/workers.js';

/** How often a running worker records that it is alive. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
/** No heartbeat for longer than this (four missed beats) means no worker is running. */
export const WORKER_STALE_AFTER_MS = 60_000;
/** Rows of workers not seen for this long are deleted when a worker starts. */
export const WORKER_HEARTBEAT_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/** What one worker records about itself. */
export interface WorkerHeartbeatInfo {
  id: string;
  hostname: string;
  pid: number;
  version: string;
  queues: string[];
}

/** Whether any worker is running, as far as the database can tell. */
export interface WorkerStatus {
  /** True only when some worker's latest heartbeat is no older than the staleness limit. */
  alive: boolean;
  /** Latest heartbeat of any worker (null when no worker has ever recorded one, or every worker stopped cleanly). */
  lastSeenAt: Date | null;
}

/**
 * The staleness rule: a worker is alive when its latest heartbeat is at most `staleAfterMs` old. Both times come from
 * the database clock, so a web server and a worker on different machines never disagree because of clock drift.
 */
export function isHeartbeatFresh(lastSeenAt: Date | null, now: Date, staleAfterMs = WORKER_STALE_AFTER_MS): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() <= staleAfterMs;
}

/** Inserts or refreshes this worker's row; `last_seen_at` is the database's now(). */
export async function recordWorkerHeartbeat(db: Database, info: WorkerHeartbeatInfo): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ id: info.id, hostname: info.hostname, pid: info.pid, version: info.version, queues: info.queues, startedAt: sql`now()`, lastSeenAt: sql`now()` })
    .onConflictDoUpdate({ target: workerHeartbeats.id, set: { lastSeenAt: sql`now()`, queues: info.queues, version: info.version } });
}

/** Removes this worker's row (graceful shutdown), so the app stops counting it straight away. */
export async function removeWorkerHeartbeat(db: Database, workerId: string): Promise<void> {
  await db.delete(workerHeartbeats).where(eq(workerHeartbeats.id, workerId));
}

/** Deletes rows of workers that have not been seen for `olderThanMs` (killed workers leave theirs behind). */
export async function pruneWorkerHeartbeats(db: Database, olderThanMs = WORKER_HEARTBEAT_PRUNE_AFTER_MS): Promise<number> {
  const rows = await db
    .delete(workerHeartbeats)
    .where(lt(workerHeartbeats.lastSeenAt, sql`now() - make_interval(secs => ${olderThanMs / 1000})`))
    .returning({ id: workerHeartbeats.id });
  return rows.length;
}

/** Reads whether a worker is running: the newest heartbeat against the database clock and the staleness rule. */
export async function readWorkerStatus(db: Database, staleAfterMs = WORKER_STALE_AFTER_MS): Promise<WorkerStatus> {
  const result = await db.execute<{ now: Date | string; last_seen_at: Date | string | null }>(
    sql`select now() as now, max(${workerHeartbeats.lastSeenAt}) as last_seen_at from ${workerHeartbeats}`,
  );
  const row = result.rows[0];
  const now = row ? new Date(row.now) : new Date();
  const lastSeenAt = row?.last_seen_at ? new Date(row.last_seen_at) : null;
  return { alive: isHeartbeatFresh(lastSeenAt, now, staleAfterMs), lastSeenAt };
}

/**
 * Whether the `worker_heartbeats` table exists, i.e. the database has the migrations this version needs. The worker
 * checks it at start-up so a database that was not migrated after an update fails with a plain message instead of
 * a crash loop.
 */
export async function hasWorkerHeartbeatsTable(db: Database): Promise<boolean> {
  const result = await db.execute<{ t: string | null }>(sql`select to_regclass('public.worker_heartbeats')::text as t`);
  return Boolean(result.rows[0]?.t);
}
