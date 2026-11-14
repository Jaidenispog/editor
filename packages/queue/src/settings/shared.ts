import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Settings for the shared Stage B/C jobs. `webhook.process`: 5 retries with a 10 s backoff. `google.disconnect`:
 * 3 retries 60 s apart. The designs ask for 1–2 minutes per attempt; 2.5 minutes is used so an attempt always
 * outlives more than four 30 s heartbeats (a rule every queue follows).
 */
export const SHARED_QUEUE_SETTINGS = {
  [JOB_TYPES.WEBHOOK_PROCESS]: { retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.GOOGLE_DISCONNECT]: { retryLimit: 3, retryDelay: 60, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
} as const satisfies QueueSettingsMap;
