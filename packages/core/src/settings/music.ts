import { z } from 'zod';
import type { SettingsSectionMap } from './types.js';

/**
 * Music settings (Settings → Music). `spotifyReferenceMode` starts as link-only (memo §1): no iframe and no request
 * to Spotify. The embed can only be switched on once the terms and privacy pages exist and the owner has
 * acknowledged Spotify's Developer and Widget Terms; switching back to link-only is always one click.
 */
export const MusicSettingsSchema = z.object({
  spotifyReferenceMode: z.enum(['link_only', 'embed']).default('link_only'),
  /** When the owner ticked "I have read Spotify's Developer Terms and Widget Terms" (ISO), or null. */
  spotifyTermsAcknowledgedAt: z.string().nullable().default(null),
});
export type MusicSettings = z.infer<typeof MusicSettingsSchema>;

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = MusicSettingsSchema.parse({});

/** New top-level settings sections of the music controls and licence passport module. */
export const MUSIC_SETTINGS_SECTIONS = {
  music: MusicSettingsSchema.default(DEFAULT_MUSIC_SETTINGS),
} as const satisfies SettingsSectionMap;
