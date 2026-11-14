import type { QueueSettingsMap } from './types.js';

/** Queue settings for the saved preferences, reference video and brand module's job types (WP2 adds them here; one entry per registered job type). */
export const PREFERENCES_QUEUE_SETTINGS = {} as const satisfies QueueSettingsMap;
