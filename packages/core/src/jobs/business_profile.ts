import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the Google Business Profile module (WP9 adds them here). */
export const BUSINESS_PROFILE_JOB_TYPES = {} as const;

/** Payload schemas of the Google Business Profile module's job types, keyed by job type. */
export const BUSINESS_PROFILE_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
