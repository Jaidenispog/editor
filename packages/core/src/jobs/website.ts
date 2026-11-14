import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the website check and Search Console module (WP8 adds them here). */
export const WEBSITE_JOB_TYPES = {} as const;

/** Payload schemas of the website check and Search Console module's job types, keyed by job type. */
export const WEBSITE_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
