import type { SettingsSectionMap } from './types.js';

/** New top-level settings sections of the publishing module (WP4 and WP10 adds them here; each needs a full default). */
export const PUBLISHING_SETTINGS_SECTIONS = {} as const satisfies SettingsSectionMap;
