import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the saved preferences, reference video and brand module (WP2 adds them here). */
export const PREFERENCES_JOB_TYPES = {} as const;

/** Payload schemas of the saved preferences, reference video and brand module's job types, keyed by job type. */
export const PREFERENCES_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
