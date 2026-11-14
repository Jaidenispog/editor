import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Queue settings for the trends module's job types (WP3; WP5 reuses `trends.refresh`). `trends.refresh`: one retry
 * after 5 minutes (a network or server error at the source), 5 minutes per attempt. The design asked for a 60 s
 * heartbeat; every queue uses the shared 30 s heartbeat instead (checked by the worker's queue-settings test).
 */
export const TRENDS_QUEUE_SETTINGS = {
  [JOB_TYPES.TRENDS_REFRESH]: { retryLimit: 1, retryDelay: 300, retryBackoff: false, expireInSeconds: 300, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
} as const satisfies QueueSettingsMap;
