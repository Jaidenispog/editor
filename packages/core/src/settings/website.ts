import { WebsiteSettingsSchema } from '../website.js';
import type { SettingsSectionMap } from './types.js';

/**
 * The `website` settings section (WP8): ownership confirmation (server-set), the manual Business Profile check date,
 * the search-grouping word lists and the external-link switch. Older settings parse to the defaults.
 */
export const WEBSITE_SETTINGS_SECTIONS = {
  website: WebsiteSettingsSchema.default(WebsiteSettingsSchema.parse({})),
} as const satisfies SettingsSectionMap;
