import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the music controls and licence passport module (WP1 adds them here). */
export const MUSIC_JOB_TYPES = {} as const;

/** Payload schemas of the music controls and licence passport module's job types, keyed by job type. */
export const MUSIC_JOB_PAYLOAD_SCHEMAS = {} as const satisfies JobPayloadSchemaMap;
