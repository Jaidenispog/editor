import { z } from 'zod';
import { BrandConfigSchema } from './brand.js';
import { StyleIdSchema } from './styles.js';

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

export const AppSettingsSchema = z.object({
  brand: BrandConfigSchema.default(BrandConfigSchema.parse({})),
  business: BusinessConfigSchema.default(BusinessConfigSchema.parse({})),
  preferences: EditingPreferencesSchema.default(EditingPreferencesSchema.parse({})),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({});
