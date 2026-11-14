import type { QueueSettingsMap } from './types.js';

/** Queue settings for the email and review requests module's job types (WP7 adds them here; one entry per registered job type). */
export const EMAIL_QUEUE_SETTINGS = {} as const satisfies QueueSettingsMap;
