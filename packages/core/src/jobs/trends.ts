import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the trends module (WP3 and WP5 adds them here). */
export const TRENDS_JOB_TYPES = {} as const;

/** Payload schemas of the trends module's job types, keyed by job type. */
export const TRENDS_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
