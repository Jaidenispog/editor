import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Queue settings for the saved preferences, reference video and brand module's job types (WP2). The design asked for
 * a 60 s heartbeat; every queue uses the shared 30 s heartbeat instead (checked by the worker's queue-settings test).
 * - `preferences.recompute`: pure recompute from events, 2 retries from 10 s with backoff, 5 minutes per attempt.
 * - `reference.analyse`: measuring a short video, 2 retries from 15 s with backoff, 30 minutes per attempt.
 */
export const PREFERENCES_QUEUE_SETTINGS = {
  [JOB_TYPES.PREFERENCES_RECOMPUTE]: { retryLimit: 2, retryDelay: 10, retryBackoff: true, expireInSeconds: 300, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.REFERENCE_ANALYSE]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 1800, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
} as const satisfies QueueSettingsMap;
