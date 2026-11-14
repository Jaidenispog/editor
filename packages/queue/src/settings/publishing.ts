import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Queue settings for the publishing module's job types (WP4; WP10 reuses them for Zernio).
 * - `publish.prepare`: 3 retries 30 s apart, 10 minutes per attempt.
 * - `publish.target`: 3 retries with a 60 s backoff, transient errors only (permanent ones are written to the row and
 *   the job completes), 45 minutes per attempt so a large upload fits.
 * - `publish.poll`: 5 retries with a 60 s backoff, 15 minutes per attempt.
 * - `publish.dispatch`: the per-minute cron, no retry (the next minute runs it again).
 * - `social.check`: 2 retries 60 s apart, 5 minutes per attempt.
 * The three per-target queues use the `stately` policy (one queued and one active job per `singletonKey`) as a
 * second guard; the authoritative guard against double posting is the conditional update on `publish_targets`.
 * The design's 60 s heartbeat is replaced by the shared 30 s one, and every attempt outlives four heartbeats.
 */
export const PUBLISHING_QUEUE_SETTINGS = {
  [JOB_TYPES.PUBLISH_PREPARE]: { retryLimit: 3, retryDelay: 30, retryBackoff: false, expireInSeconds: 10 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS, policy: 'stately' },
  [JOB_TYPES.PUBLISH_TARGET]: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 45 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS, policy: 'stately' },
  [JOB_TYPES.PUBLISH_POLL]: { retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 15 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS, policy: 'stately' },
  [JOB_TYPES.PUBLISH_DISPATCH]: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.SOCIAL_CHECK]: { retryLimit: 2, retryDelay: 60, retryBackoff: false, expireInSeconds: 5 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
} as const satisfies QueueSettingsMap;
