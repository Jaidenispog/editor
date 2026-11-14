import { JOB_TYPES } from '@studio/core';
import type { QueueSettingsMap } from './types.js';

/** Seconds without a heartbeat after which pg-boss fails an attempt (pg-boss refreshes it every half of this). */
export const QUEUE_HEARTBEAT_SECONDS = 30;

/**
 * Stage A (Video Studio) job settings. With a 30 s heartbeat and the worker's 30 s supervisor pass, a crashed
 * attempt is picked up again within about a minute plus its retry delay.
 */
export const STUDIO_QUEUE_SETTINGS = {
  [JOB_TYPES.INGEST_ASSET]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 60 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.GENERATE_EDITS]: { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 30 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.REVISE_EDIT]: { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 20 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.RENDER_PREVIEW]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 45 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.RENDER_EXPORT]: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 2 * 60 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.ANALYSE_MUSIC]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 20 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.CLEANUP]: { retryLimit: 1, retryDelay: 60, retryBackoff: false, expireInSeconds: 20 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
} as const satisfies QueueSettingsMap;
