import { AppSettingsSchema, LEARNABLE_FIELDS, declaredValue, parseStoredSettings, type AppSettings, type LearnableField } from '@studio/core';
import { z } from 'zod';

/** Preference fields only the server writes: learning state through the preferences routes, learned values by the recompute job. */
export const SERVER_OWNED_PREFERENCE_FIELDS = ['learning', 'learned', 'styleAffinity'] as const;

/**
 * Partial settings accepted by PUT /api/settings. Sections are loose objects here; the merged result is
 * validated against AppSettingsSchema so field errors come back with precise paths (e.g. brand.accentColour).
 * The Spotify reference mode (`music`) and the learning fields of `preferences` are refused with a plain message
 * naming the route that changes them.
 */
export const SettingsPatchSchema = z
  .object({
    brand: z.record(z.string(), z.unknown()).optional(),
    business: z.record(z.string(), z.unknown()).optional(),
    preferences: z.record(z.string(), z.unknown()).optional(),
    /** Legal pages (Settings → Business → Legal pages); each page object is replaced whole. */
    legal: z.record(z.string(), z.unknown()).optional(),
    /** Never accepted here: present only so the refusal can explain where it changes. */
    music: z.unknown().optional(),
  })
  .strict()
  .superRefine((patch, ctx) => {
    if (patch.music !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['music'],
        message: 'The Spotify reference mode changes only in Settings → Music (PUT /api/music/references/mode), which checks the embed rules.',
      });
    }
    for (const field of SERVER_OWNED_PREFERENCE_FIELDS) {
      if (patch.preferences && field in patch.preferences) {
        ctx.addIssue({ code: 'custom', path: ['preferences', field], message: 'Use the preferences controls in Settings → Editing preferences to change what the editor learns.' });
      }
    }
  });
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Fields that can only change through dedicated routes (the logo upload owns logoStorageKey). */
const PROTECTED_BRAND_FIELDS = ['logoStorageKey'] as const;

/**
 * Shallow-merges each section of the patch over the current settings and validates the result.
 * Arrays and records inside a section are replaced, not merged. Server-owned preference fields always keep their
 * current values. Every learnable preference the patch changes is pinned `by: 'owner'` (at `now`), so learning
 * never overrides it. Throws a ZodError for invalid values.
 */
export function mergeSettings(current: AppSettings, patch: SettingsPatch, now: Date = new Date()): AppSettings {
  const brandPatch = { ...(patch.brand ?? {}) };
  for (const field of PROTECTED_BRAND_FIELDS) delete brandPatch[field];
  const prefsPatch = { ...(patch.preferences ?? {}) };
  for (const field of SERVER_OWNED_PREFERENCE_FIELDS) delete prefsPatch[field];
  const merged = AppSettingsSchema.parse({
    // Sections this route does not edit (module sections added in packages/core/src/settings/<module>.ts) are kept.
    ...current,
    brand: { ...current.brand, ...brandPatch },
    business: { ...current.business, ...(patch.business ?? {}) },
    preferences: { ...current.preferences, ...prefsPatch },
    legal: { ...current.legal, ...(patch.legal ?? {}) },
  });
  return pinChangedFields(current, merged, now);
}

/** The learnable fields whose declared value differs between two settings objects. */
export function changedLearnableFields(before: AppSettings, after: AppSettings): LearnableField[] {
  return LEARNABLE_FIELDS.filter((f) => JSON.stringify(declaredValue(before.preferences, f)) !== JSON.stringify(declaredValue(after.preferences, f)));
}

/** Pins (`by: 'owner'`) every learnable field changed between `before` and `after`. */
export function pinChangedFields(before: AppSettings, after: AppSettings, now: Date): AppSettings {
  const changed = changedLearnableFields(before, after);
  if (changed.length === 0) return after;
  const pinned = { ...after.preferences.learning.pinned };
  for (const field of changed) pinned[field] = { by: 'owner', at: now.toISOString(), referenceAssetId: null, referenceName: '' };
  return { ...after, preferences: { ...after.preferences, learning: { ...after.preferences.learning, pinned } } };
}

/**
 * Reads stored settings JSON, filling any fields added since it was saved (settings that predate preference learning
 * get pins for the fields the owner had changed); falls back to defaults if corrupt.
 */
export function normaliseStoredSettings(data: unknown): AppSettings {
  return parseStoredSettings(data ?? {}) ?? AppSettingsSchema.parse({});
}
