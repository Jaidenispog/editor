import type { QueueSettingsMap } from './types.js';

/** Queue settings for the trends module's job types (WP3 and WP5 adds them here; one entry per registered job type). */
export const TRENDS_QUEUE_SETTINGS = {} as const satisfies QueueSettingsMap;
