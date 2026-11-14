import 'server-only';
import { JobQueue } from '@studio/queue';
import { getEnv } from './env.js';
import { getLogger } from './logger.js';

const globalForQueue = globalThis as unknown as { __studioWebQueue?: Promise<JobQueue> };

/**
 * Producer-only pg-boss queue, started on first use and cached on globalThis. If start-up fails the cache is
 * cleared so the next request tries again instead of keeping a broken connection. QUEUE_POOL_MAX caps its pool
 * (default 3).
 */
export function getQueue(): Promise<JobQueue> {
  if (!globalForQueue.__studioWebQueue) {
    const env = getEnv();
    const queue = new JobQueue({ connectionString: env.QUEUE_DATABASE_URL ?? env.DATABASE_URL, role: 'producer', logger: getLogger(), max: env.QUEUE_POOL_MAX });
    globalForQueue.__studioWebQueue = queue.start().then(
      () => queue,
      (err: unknown) => {
        globalForQueue.__studioWebQueue = undefined;
        throw err;
      },
    );
  }
  return globalForQueue.__studioWebQueue;
}
