import type { Logger } from 'pino';
import { WORKER_HEARTBEAT_INTERVAL_MS, recordWorkerHeartbeat, removeWorkerHeartbeat, type Database, type WorkerHeartbeatInfo } from '@studio/db';

export interface WorkerHeartbeatHandle {
  /** Stops the timer, waits for a beat still being written and deletes this worker's row, so the app stops counting it straight away. */
  stop(): Promise<void>;
}

export interface WorkerHeartbeatOptions {
  /** Time between beats; 15 s in the worker. */
  intervalMs?: number;
  /**
   * Runs before every beat after the first; when it throws, that beat is skipped (logged once), so a worker that
   * cannot reach its queue (for example a separate QUEUE_DATABASE_URL that is down) stops telling the app it runs.
   */
  healthCheck?: () => Promise<void>;
}

/**
 * Records that this worker is alive: one row in `worker_heartbeats`, refreshed every `intervalMs` (15 s). The web app
 * reads it to tell the owner when no worker is running (GET /api/health, the Studio and dashboard notices). The first
 * beat is written before this resolves; a beat that fails (database briefly away) is logged once and retried on the
 * next tick. A tick never starts a new write while the previous one is still running, so slow writes cannot pile up.
 *
 * Limitation: the beat proves the process is running and can reach both databases, not that pg-boss is still
 * fetching jobs; a job loop that is stuck while the process stays healthy is not detected here.
 */
export async function startWorkerHeartbeat(
  db: Database,
  info: WorkerHeartbeatInfo,
  logger: Pick<Logger, 'warn' | 'info'>,
  options: WorkerHeartbeatOptions = {},
): Promise<WorkerHeartbeatHandle> {
  const intervalMs = options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  await recordWorkerHeartbeat(db, info);
  let failing = false;
  let stopped = false;
  let pending: Promise<void> | null = null;
  const beat = async () => {
    if (options.healthCheck) {
      try {
        await options.healthCheck();
      } catch (err) {
        if (!failing) logger.warn({ err }, 'the job queue is not reachable, so the worker heartbeat is paused; will keep trying');
        failing = true;
        return;
      }
    }
    try {
      await recordWorkerHeartbeat(db, info);
      if (failing) logger.info('worker heartbeat recorded again');
      failing = false;
    } catch (err) {
      if (!failing) logger.warn({ err }, 'could not record the worker heartbeat; will keep trying');
      failing = true;
    }
  };
  const timer = setInterval(() => {
    // The previous beat is still running (a slow or hanging database): skip this tick instead of overlapping it.
    if (pending || stopped) return;
    pending = beat().finally(() => {
      pending = null;
    });
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (pending) await pending;
      await removeWorkerHeartbeat(db, info.id).catch((err: unknown) => logger.warn({ err }, 'could not remove the worker heartbeat'));
    },
  };
}
