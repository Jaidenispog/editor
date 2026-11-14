import type { SettingsSectionMap } from './types.js';

/** New top-level settings sections of the saved preferences, reference video and brand module (WP2 adds them here; each needs a full default). */
export const PREFERENCES_SETTINGS_SECTIONS = {} as const satisfies SettingsSectionMap;
