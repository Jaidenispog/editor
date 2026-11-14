import { AppSettingsSchema, type AppSettings } from '@studio/core';
import { z } from 'zod';

/**
 * Partial settings accepted by PUT /api/settings. Sections are loose objects here; the merged result is
 * validated against AppSettingsSchema so field errors come back with precise paths (e.g. brand.accentColour).
 */
export const SettingsPatchSchema = z
  .object({
    brand: z.record(z.string(), z.unknown()).optional(),
    business: z.record(z.string(), z.unknown()).optional(),
    preferences: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Fields that can only change through dedicated routes (the logo upload owns logoStorageKey). */
const PROTECTED_BRAND_FIELDS = ['logoStorageKey'] as const;

/**
 * Shallow-merges each section of the patch over the current settings and validates the result.
 * Arrays and records inside a section are replaced, not merged. Throws a ZodError for invalid values.
 */
export function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  const brandPatch = { ...(patch.brand ?? {}) };
  for (const field of PROTECTED_BRAND_FIELDS) delete brandPatch[field];
  const merged = {
    brand: { ...current.brand, ...brandPatch },
    business: { ...current.business, ...(patch.business ?? {}) },
    preferences: { ...current.preferences, ...(patch.preferences ?? {}) },
  };
  return AppSettingsSchema.parse(merged);
}

/** Reads stored settings JSON, filling any fields added since it was saved; falls back to defaults if corrupt. */
export function normaliseStoredSettings(data: unknown): AppSettings {
  const parsed = AppSettingsSchema.safeParse(data ?? {});
  return parsed.success ? parsed.data : AppSettingsSchema.parse({});
}
