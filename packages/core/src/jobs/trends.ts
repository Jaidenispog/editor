import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the trends module (WP3; the Instagram hashtag watch in WP5 reuses `trends.refresh`). */
export const TRENDS_JOB_TYPES = {
  /**
   * Reads one live trend source (a `trend_watches` row) and replaces its items, or, with `watchId: null`, queues
   * one refresh per enabled watch. Read-only: it never posts or changes anything on any account.
   */
  TRENDS_REFRESH: 'trends.refresh',
} as const;

/** `trends.refresh`: one watch, or `null` for every enabled watch (the daily schedule). */
export const TrendsRefreshPayloadSchema = z.object({ watchId: z.string().min(1).nullable().default(null) });
export type TrendsRefreshPayload = z.infer<typeof TrendsRefreshPayloadSchema>;

/** Payload schemas of the trends module's job types, keyed by job type. */
export const TRENDS_JOB_PAYLOAD_SCHEMAS = {
  [TRENDS_JOB_TYPES.TRENDS_REFRESH]: TrendsRefreshPayloadSchema,
} as const satisfies JobPayloadSchemaMap;
