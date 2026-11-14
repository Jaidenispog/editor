import { JOB_TYPES } from '@studio/core';
import { QUEUE_HEARTBEAT_SECONDS } from './studio.js';
import type { QueueSettingsMap } from './types.js';

/**
 * Queue settings for the website check and Search Console module (WP8, design §8). Every queue uses the shared 30 s
 * heartbeat, and every attempt may run longer than four heartbeats (so the 2-minute connection check gets 3 minutes).
 * `website.edit_apply` retries only transient failures (a retry first reads the page back, so a write that already
 * landed is never repeated). `search.sync` backs off on Google's 429/5xx.
 */
export const WEBSITE_QUEUE_SETTINGS = {
  [JOB_TYPES.WEBSITE_AUDIT]: {
    retryLimit: 1,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 20 * 60,
    heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS,
  },
  [JOB_TYPES.WEBSITE_EDIT_APPLY]: {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
    heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS,
  },
  [JOB_TYPES.WEBSITE_COPY_DRAFT]: {
    retryLimit: 1,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 3 * 60,
    heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS,
  },
  [JOB_TYPES.WEBSITE_CONNECTION_CHECK]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 3 * 60,
    heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS,
  },
  [JOB_TYPES.SEARCH_SYNC]: {
    retryLimit: 3,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS,
  },
} as const satisfies QueueSettingsMap;
