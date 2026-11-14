import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Queue settings for the Square appointments module's job types (WP6; WP6b adds booking changes and the self-test).
 * - `square.sync`: 3 retries 30 s apart, 15 minutes per attempt, `stately` (one queued and one active sync).
 * - `square.refresh`: 5 retries 10 s apart, 2½ minutes per attempt.
 * - `square.attendance`: 3 retries 30 s apart, 10 minutes per attempt.
 * - `square.availability`: 1 retry after 5 s, 2½ minutes per attempt (the owner is waiting for it).
 * - `square.token_refresh`: 3 retries 5 minutes apart, 2½ minutes per attempt.
 * - `square.revoke`: 3 retries 60 s apart, 2½ minutes per attempt.
 * The design's 60 s sync heartbeat is replaced by the shared 30 s one; every attempt outlives four heartbeats.
 */
export const SQUARE_QUEUE_SETTINGS = {
  [JOB_TYPES.SQUARE_SYNC]: { retryLimit: 3, retryDelay: 30, retryBackoff: false, expireInSeconds: 15 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS, policy: 'stately' },
  [JOB_TYPES.SQUARE_REFRESH]: { retryLimit: 5, retryDelay: 10, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.SQUARE_ATTENDANCE]: { retryLimit: 3, retryDelay: 30, retryBackoff: false, expireInSeconds: 10 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.SQUARE_AVAILABILITY]: { retryLimit: 1, retryDelay: 5, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.SQUARE_TOKEN_REFRESH]: { retryLimit: 3, retryDelay: 5 * 60, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.SQUARE_REVOKE]: { retryLimit: 3, retryDelay: 60, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
} as const satisfies QueueSettingsMap;
