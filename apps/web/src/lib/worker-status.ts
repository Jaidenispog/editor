import 'server-only';
import { readWorkerStatus } from '@studio/db';
import { getDb } from './db.js';
import { getLogger } from './logger.js';
import type { WorkerStatusDto } from './shared/worker-notice.js';

/** `next dev` (the owner's local app, started by scripts/dev.sh) versus a production build on a server. */
function startHint(): WorkerStatusDto['startHint'] {
  return process.env.NODE_ENV === 'production' ? 'service' : 'dev';
}

/**
 * Whether a background worker is running, from the heartbeat each worker records every 15 s (worker_heartbeats).
 * Any failure to read it (database away, migration not applied yet) reports "not running": the app never says the
 * worker is running without a fresh heartbeat.
 */
export async function getWorkerStatus(): Promise<WorkerStatusDto> {
  try {
    const status = await readWorkerStatus(getDb());
    return { alive: status.alive, lastSeenAt: status.lastSeenAt ? status.lastSeenAt.toISOString() : null, startHint: startHint() };
  } catch (err) {
    getLogger().warn({ err }, 'could not read the worker heartbeat');
    return { alive: false, lastSeenAt: null, startHint: startHint() };
  }
}
