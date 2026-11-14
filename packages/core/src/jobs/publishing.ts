import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the publishing module (WP4 and WP10 adds them here). */
export const PUBLISHING_JOB_TYPES = {} as const;

/** Payload schemas of the publishing module's job types, keyed by job type. */
export const PUBLISHING_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
