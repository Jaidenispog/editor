import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the email and review requests module (WP7 adds them here). */
export const EMAIL_JOB_TYPES = {} as const;

/** Payload schemas of the email and review requests module's job types, keyed by job type. */
export const EMAIL_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
