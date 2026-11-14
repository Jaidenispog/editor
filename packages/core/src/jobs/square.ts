import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the Square appointments module (WP6 and WP6b adds them here). */
export const SQUARE_JOB_TYPES = {} as const;

/** Payload schemas of the Square appointments module's job types, keyed by job type. */
export const SQUARE_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
