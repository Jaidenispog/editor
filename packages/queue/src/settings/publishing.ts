import type { QueueSettingsMap } from './types.js';

/** Queue settings for the publishing module's job types (WP4 and WP10 adds them here; one entry per registered job type). */
export const PUBLISHING_QUEUE_SETTINGS = {} as const satisfies QueueSettingsMap;
