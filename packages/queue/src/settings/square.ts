import type { QueueSettingsMap } from './types.js';

/** Queue settings for the Square appointments module's job types (WP6 and WP6b adds them here; one entry per registered job type). */
export const SQUARE_QUEUE_SETTINGS = {} as const satisfies QueueSettingsMap;
