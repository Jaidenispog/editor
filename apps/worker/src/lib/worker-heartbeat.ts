import type { Logger } from 'pino';
import { WORKER_HEARTBEAT_INTERVAL_MS, recordWorkerHeartbeat, removeWorkerHeartbeat, type Database, type WorkerHeartbeatInfo } from '@studio/db';

export interface WorkerHeartbeatHandle {
  /** Stops the timer and deletes this worker's row, so the app stops counting it straight away. */
  stop(): Promise<void>;
}

/**
 * Records that this worker is alive: one row in `worker_heartbeats`, refreshed every `intervalMs` (15 s). The web app
 * reads it to tell the owner when no worker is running (GET /api/health, the Studio and dashboard notices). The first
 * beat is written before this resolves; a beat that fails (database briefly away) is logged once and retried on the
 * next tick.
 */
export async function startWorkerHeartbeat(
  db: Database,
  info: WorkerHeartbeatInfo,
  logger: Pick<Logger, 'warn' | 'info'>,
  intervalMs = WORKER_HEARTBEAT_INTERVAL_MS,
): Promise<WorkerHeartbeatHandle> {
  await recordWorkerHeartbeat(db, info);
  let failing = false;
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    pending = recordWorkerHeartbeat(db, info).then(
      () => {
        if (failing) logger.info('worker heartbeat recorded again');
        failing = false;
      },
      (err: unknown) => {
        if (!failing) logger.warn({ err }, 'could not record the worker heartbeat; will keep trying');
        failing = true;
      },
    );
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await pending;
      await removeWorkerHeartbeat(db, info.id).catch((err: unknown) => logger.warn({ err }, 'could not remove the worker heartbeat'));
    },
  };
}
