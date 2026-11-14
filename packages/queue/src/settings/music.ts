import type { QueueSettingsMap } from './types.js';

/** Queue settings for the music controls and licence passport module's job types (WP1 adds them here; one entry per registered job type). */
export const MUSIC_QUEUE_SETTINGS = {} as const satisfies QueueSettingsMap;
