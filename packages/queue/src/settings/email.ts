import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Queue settings for the email and review requests module (design §6), with the shared 30 s heartbeat; every attempt
 * outlives at least four heartbeats.
 * - `email.send`: 3 retries with a 60 s backoff (transient provider errors only; everything else is written to the row
 *   and the job completes). `stately`: one queued and one active job per message as a second guard; the authoritative
 *   guard is the conditional claim on `email_messages` (`submitted_at`).
 * - `email.dispatch`: the per-minute cron, no retry (the next minute runs it again).
 * - `email.automation.sweep`: 1 retry after 60 s; every write is `ON CONFLICT DO NOTHING`, so a re-run is harmless.
 * - `email.campaign.expand`: 2 retries 30 s apart, 10 minutes per attempt.
 * - `email.provider.check` and `reviews.places.sync`: 2 retries (60 s and 5 minutes apart); both are read-only.
 * - `email.suppression.push`: 5 retries with a 60 s backoff.
 */
export const EMAIL_QUEUE_SETTINGS = {
  [JOB_TYPES.EMAIL_SEND]: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 5 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS, policy: 'stately' },
  [JOB_TYPES.EMAIL_DISPATCH]: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.EMAIL_AUTOMATION_SWEEP]: { retryLimit: 1, retryDelay: 60, retryBackoff: false, expireInSeconds: 5 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.EMAIL_CAMPAIGN_EXPAND]: { retryLimit: 2, retryDelay: 30, retryBackoff: false, expireInSeconds: 10 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.EMAIL_PROVIDER_CHECK]: { retryLimit: 2, retryDelay: 60, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.EMAIL_SUPPRESSION_PUSH]: { retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.REVIEWS_PLACES_SYNC]: { retryLimit: 2, retryDelay: 300, retryBackoff: false, expireInSeconds: 2 * 60 + 30, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
} as const satisfies QueueSettingsMap;
