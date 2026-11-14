import { z } from 'zod';
import { BrandConfigSchema } from './brand.js';
import { StyleIdSchema } from './styles.js';
import { BUSINESS_PROFILE_SETTINGS_SECTIONS } from './settings/business_profile.js';
import { EMAIL_SETTINGS_SECTIONS } from './settings/email.js';
import { DEFAULT_LEGAL_SETTINGS, LEGAL_PAGES, LegalSettingsSchema, publishedLegalPage, type LegalPageKind } from './settings/legal.js';
import { MUSIC_SETTINGS_SECTIONS } from './settings/music.js';
import { PREFERENCES_SETTINGS_SECTIONS } from './settings/preferences.js';
import { PUBLISHING_SETTINGS_SECTIONS } from './settings/publishing.js';
import { SQUARE_SETTINGS_SECTIONS } from './settings/square.js';
import { TRENDS_SETTINGS_SECTIONS } from './settings/trends.js';
import { WEBSITE_SETTINGS_SECTIONS } from './settings/website.js';

export * from './settings/types.js';
export * from './settings/legal.js';

export const BusinessConfigSchema = z.object({
  suburb: z.string().max(80).default('Ivanhoe'),
  state: z.string().max(40).default('VIC'),
  postcode: z.string().max(10).default('3079'),
  country: z.string().max(40).default('Australia'),
  phone: z.string().max(40).default(''),
  email: z.string().max(120).default(''),
  addressLine: z.string().max(160).default(''),
  website: z.string().max(300).default(''),
  googleReviewLink: z.string().max(500).default(''),
  googleBusinessProfileName: z.string().max(160).default(''),
  instagramHandle: z.string().max(60).default(''),
  tiktokHandle: z.string().max(60).default(''),
  bookingLink: z.string().max(500).default(''),
  /** Terms page used elsewhere (for example in the Spotify embed notice). Blank = this app's own published /terms page. */
  termsUrl: z.string().max(500).default(''),
  /** Privacy page used elsewhere (Meta, Google, Spotify embed). Blank = this app's own published /privacy page. */
  privacyUrl: z.string().max(500).default(''),
});
export type BusinessConfig = z.infer<typeof BusinessConfigSchema>;

/** Learned/declared editing preferences; updated from owner selections and feedback. */
export const EditingPreferencesSchema = z.object({
  defaultDurationSec: z.number().int().min(8).max(90).default(25),
  preferredStyles: z.array(StyleIdSchema).default([]),
  pacing: z.enum(['slow', 'balanced', 'fast']).default('balanced'),
  textDensity: z.enum(['none', 'light', 'medium']).default('light'),
  transitions: z.enum(['restrained', 'varied']).default('restrained'),
  colour: z.enum(['natural', 'clean', 'cinematic', 'punchy']).default('natural'),
  musicMoods: z.array(z.string().max(40)).default([]),
  musicVolume: z.number().min(0).max(1).default(0.85),
  keepOriginalSound: z.enum(['auto', 'always', 'never']).default('auto'),
  captions: z.enum(['auto', 'never']).default('auto'),
  /** Per-style favourite counts, updated when the owner favourites or downloads an edit. */
  styleAffinity: z.record(z.string(), z.number()).default({}),
  /** Free-text notes the owner wants every edit to respect. */
  standingInstructions: z.string().max(1000).default(''),
});
export type EditingPreferences = z.infer<typeof EditingPreferencesSchema>;

/**
 * All app settings (one jsonb row). The core sections are listed here; modules add new top-level sections in
 * `./settings/<module>.ts`, which are spread in a fixed order so parallel work packages never edit this file.
 */
export const AppSettingsSchema = z.object({
  brand: BrandConfigSchema.default(BrandConfigSchema.parse({})),
  business: BusinessConfigSchema.default(BusinessConfigSchema.parse({})),
  preferences: EditingPreferencesSchema.default(EditingPreferencesSchema.parse({})),
  legal: LegalSettingsSchema.default(DEFAULT_LEGAL_SETTINGS),
  ...MUSIC_SETTINGS_SECTIONS,
  ...PREFERENCES_SETTINGS_SECTIONS,
  ...TRENDS_SETTINGS_SECTIONS,
  ...PUBLISHING_SETTINGS_SECTIONS,
  ...SQUARE_SETTINGS_SECTIONS,
  ...EMAIL_SETTINGS_SECTIONS,
  ...WEBSITE_SETTINGS_SECTIONS,
  ...BUSINESS_PROFILE_SETTINGS_SECTIONS,
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({});

/**
 * Public URLs of the legal pages for other services (Meta app settings, Google consent screen, Spotify embed
 * notice). An address the owner typed in Settings → Business wins; otherwise this app's own page is used, but only
 * once it is published (an unpublished page answers 404, so it is never handed out).
 */
export function resolveLegalUrls(settings: Pick<AppSettings, 'business' | 'legal'>, appUrl: string): Record<LegalPageKind, string | null> {
  const base = appUrl.replace(/\/+$/, '');
  const own = (kind: LegalPageKind) => (publishedLegalPage(settings.legal, kind) ? `${base}${LEGAL_PAGES[kind].path}` : null);
  return {
    privacy: settings.business.privacyUrl.trim() || own('privacy'),
    terms: settings.business.termsUrl.trim() || own('terms'),
    dataDeletion: own('dataDeletion'),
  };
}
