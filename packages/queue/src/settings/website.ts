import type { QueueSettingsMap } from './types.js';

/** Queue settings for the website check and Search Console module's job types (WP8 adds them here; one entry per registered job type). */
export const WEBSITE_QUEUE_SETTINGS = {} as const satisfies QueueSettingsMap;
