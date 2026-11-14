import { z } from 'zod';
import type { SettingsSectionMap } from './types.js';

/** Publishing settings, edited in the "Publishing settings" card on the Publishing page (owner only). */
export const PublishingSettingsSchema = z.object({
  /** Text the composer prefills at the end of every caption. Empty by default and never written by AI. */
  captionFooter: z.string().max(500).default(''),
});
export type PublishingSettings = z.infer<typeof PublishingSettingsSchema>;

/** New top-level settings sections of the publishing module (WP4 and WP10 adds them here; each needs a full default). */
export const PUBLISHING_SETTINGS_SECTIONS = {
  publishing: PublishingSettingsSchema.default(PublishingSettingsSchema.parse({})),
} as const satisfies SettingsSectionMap;
