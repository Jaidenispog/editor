import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Queue settings for the Google Business Profile module (email design §6): `reviews.gbp.sync` retries twice, 10 minutes
 * apart (transient Google errors only; quota 0 and owner-fixable problems complete the job with a message), with
 * 10 minutes per attempt and the shared 30 s heartbeat. The Performance probe and sync run on the website module's
 * `website.connection_check` and `search.sync` queues, whose settings are unchanged.
 */
export const BUSINESS_PROFILE_QUEUE_SETTINGS = {
  [JOB_TYPES.REVIEWS_GBP_SYNC]: {
    retryLimit: 2,
    retryDelay: 600,
    retryBackoff: false,
    expireInSeconds: 10 * 60,
    heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS,
  },
} as const satisfies QueueSettingsMap;
