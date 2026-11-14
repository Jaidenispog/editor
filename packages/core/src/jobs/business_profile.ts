import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';
import { WEBSITE_JOB_TYPES } from './website.js';

/**
 * Job type names of the Google Business Profile module (WP9): reviews (email design §6) and Performance (website
 * design §8, through the website module's `website.connection_check` and `search.sync` queues). Payloads hold no
 * tokens, addresses or review text.
 */
export const BUSINESS_PROFILE_JOB_TYPES = {
  /**
   * Read-only: finds the owner's Business Profile locations (on connect, or while none is chosen), then lists Google
   * reviews into `reviews` (incremental on the `review_updated_at` watermark; everything on `weekly_full`). Quota 0
   * (Google has not approved API access yet) is recorded as "waiting for Google approval", not an error.
   */
  REVIEWS_GBP_SYNC: 'reviews.gbp.sync',
} as const;

/** `reviews.gbp.sync`: why it runs. `weekly_full` reads every page (Google's API can miss reviews from page 2 on). */
export const ReviewsGbpSyncPayloadSchema = z.object({
  reason: z.enum(['connect', 'daily', 'manual', 'weekly_full']),
});
export type ReviewsGbpSyncPayload = z.infer<typeof ReviewsGbpSyncPayloadSchema>;

/**
 * `website.connection_check`, extended with the read-only Business Profile Performance probe (website design §7.3,
 * §8). A backwards-compatible extension of the website module's schema: one more enum value, same defaults.
 */
export const ConnectionCheckWithProfilePayloadSchema = z.object({
  provider: z.enum(['google_search_console', 'website', 'business_profile_performance']),
  reason: z.enum(['connect', 'manual', 'daily']).default('manual'),
});
/** `search.sync`, extended with the Business Profile Performance source (website design §7.3). Backwards-compatible. */
export const SearchSyncWithProfilePayloadSchema = z.object({
  source: z.enum(['search_console', 'business_profile']),
  reason: z.enum(['connect', 'daily', 'manual']).default('daily'),
});

/**
 * Payload schemas of the Google Business Profile module's job types. The two website queues are replaced here by
 * their extended schemas (the registry spreads this map last, plan §2.2).
 */
export const BUSINESS_PROFILE_JOB_PAYLOAD_SCHEMAS = {
  [BUSINESS_PROFILE_JOB_TYPES.REVIEWS_GBP_SYNC]: ReviewsGbpSyncPayloadSchema,
  [WEBSITE_JOB_TYPES.WEBSITE_CONNECTION_CHECK]: ConnectionCheckWithProfilePayloadSchema,
  [WEBSITE_JOB_TYPES.SEARCH_SYNC]: SearchSyncWithProfilePayloadSchema,
} as const satisfies JobPayloadSchemaMap;
