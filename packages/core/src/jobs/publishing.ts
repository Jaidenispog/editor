import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the publishing module (WP4; WP10 adds the Zernio parts to the same handlers). */
export const PUBLISHING_JOB_TYPES = {
  /** Makes sure each target's file exists (queues the export when missing), checks it, cuts the cover, then hands targets on. */
  PUBLISH_PREPARE: 'publish.prepare',
  /** One target's adapter state machine (Instagram: container → upload → poll → copyright check → publish → read back). */
  PUBLISH_TARGET: 'publish.target',
  /** Reads the platform's own status for one target and re-schedules itself until the target settles. */
  PUBLISH_POLL: 'publish.poll',
  /** Every minute: hands due scheduled targets on, and marks due manual targets as the owner's turn. */
  PUBLISH_DISPATCH: 'publish.dispatch',
  /** Read-only check of a publishing connection (Meta): token, account discovery and quota. Never posts. */
  SOCIAL_CHECK: 'social.check',
} as const;

export const PublishPreparePayloadSchema = z.object({ postId: z.string().min(1), projectId: z.string().nullable() });
export const PublishTargetPayloadSchema = z.object({ targetId: z.string().min(1), postId: z.string().min(1), projectId: z.string().nullable() });
export const PublishPollPayloadSchema = z.object({ targetId: z.string().min(1), postId: z.string().min(1), projectId: z.string().nullable(), pollNo: z.number().int().min(0) });
export const PublishDispatchPayloadSchema = z.object({});
export const SocialCheckPayloadSchema = z.object({
  /** The connection to check, or null for every publishing connection. */
  connectionId: z.string().nullable(),
  reason: z.enum(['connect', 'manual', 'daily', 'pre_publish']),
});

/** Payload schemas of the publishing module's job types, keyed by job type. */
export const PUBLISHING_JOB_PAYLOAD_SCHEMAS = {
  [PUBLISHING_JOB_TYPES.PUBLISH_PREPARE]: PublishPreparePayloadSchema,
  [PUBLISHING_JOB_TYPES.PUBLISH_TARGET]: PublishTargetPayloadSchema,
  [PUBLISHING_JOB_TYPES.PUBLISH_POLL]: PublishPollPayloadSchema,
  [PUBLISHING_JOB_TYPES.PUBLISH_DISPATCH]: PublishDispatchPayloadSchema,
  [PUBLISHING_JOB_TYPES.SOCIAL_CHECK]: SocialCheckPayloadSchema,
} as const satisfies JobPayloadSchemaMap;
