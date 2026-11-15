import {
  AppSettingsSchema,
  EDITING_STYLE_FIELDS,
  LEARNABLE_FIELDS,
  SERVER_ONLY_WEBSITE_FIELDS,
  declaredValue,
  isHttpsUrl,
  parseStoredSettings,
  stableJson,
  type AppSettings,
  type EditingStyleField,
  type LearnableField,
} from '@studio/core';
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
    /** Website check settings (word lists, external links). The ownership fields are server-only and dropped here. */
    website: z.record(z.string(), z.unknown()).optional(),
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
    // The booking link goes into client emails as {{booking_link}}: only an https address is accepted (blank clears it).
    const bookingLink = patch.business?.['bookingLink'];
    if (typeof bookingLink === 'string' && bookingLink.trim() && !isHttpsUrl(bookingLink)) {
      ctx.addIssue({ code: 'custom', path: ['business', 'bookingLink'], message: 'Use the full booking address starting with https://' });
    }
    for (const field of SERVER_OWNED_PREFERENCE_FIELDS) {
      if (patch.preferences && field in patch.preferences) {
        ctx.addIssue({ code: 'custom', path: ['preferences', field], message: 'Use the preferences controls in Settings → Editing preferences to change what the editor learns.' });
      }
    }
    // The editing style's value fields are editable here; where each came from and the summary decisions are not.
    const style = patch.preferences?.['editingStyle'];
    if (style !== undefined && (style === null || typeof style !== 'object' || Array.isArray(style))) {
      ctx.addIssue({ code: 'custom', path: ['preferences', 'editingStyle'], message: 'The editing style must be an object.' });
    } else if (style && typeof style === 'object') {
      for (const field of ['sources', 'summaryDecisions']) {
        if (field in style) ctx.addIssue({ code: 'custom', path: ['preferences', 'editingStyle', field], message: 'Use "Your style from your videos" in Settings → Editing preferences to accept or dismiss suggestions.' });
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
  const websitePatch = { ...(patch.website ?? {}) };
  // Only POST /api/website/ownership sets these (design §5.3).
  for (const field of SERVER_ONLY_WEBSITE_FIELDS) delete websitePatch[field];
  const prefsPatch = { ...(patch.preferences ?? {}) };
  for (const field of SERVER_OWNED_PREFERENCE_FIELDS) delete prefsPatch[field];
  if (prefsPatch['editingStyle'] && typeof prefsPatch['editingStyle'] === 'object') {
    // Value fields only; the bookkeeping stays server-managed.
    const { sources: _sources, summaryDecisions: _decisions, ...values } = prefsPatch['editingStyle'] as Record<string, unknown>;
    prefsPatch['editingStyle'] = { ...current.preferences.editingStyle, ...values };
  }
  const merged = AppSettingsSchema.parse({
    // Sections this route does not edit (module sections added in packages/core/src/settings/<module>.ts) are kept.
    ...current,
    brand: { ...current.brand, ...brandPatch },
    business: { ...current.business, ...(patch.business ?? {}) },
    preferences: { ...current.preferences, ...prefsPatch },
    legal: { ...current.legal, ...(patch.legal ?? {}) },
    website: { ...current.website, ...websitePatch },
  });
  return recordEditingStyleSources(current, pinChangedFields(current, merged, now), now);
}

/** The editing-style value fields whose value differs between two settings objects. */
export function changedEditingStyleFields(before: AppSettings, after: AppSettings): EditingStyleField[] {
  return EDITING_STYLE_FIELDS.filter((f) => stableJson(before.preferences.editingStyle[f]) !== stableJson(after.preferences.editingStyle[f]));
}

/** Records `sources[field] = { by: 'owner' }` for every editing-style value the owner changed by hand. */
function recordEditingStyleSources(before: AppSettings, after: AppSettings, now: Date): AppSettings {
  const changed = changedEditingStyleFields(before, after);
  if (changed.length === 0) return after;
  const sources = { ...after.preferences.editingStyle.sources };
  for (const f of changed) sources[f] = { by: 'owner', at: now.toISOString(), referenceAssetIds: [], referenceName: '' };
  return { ...after, preferences: { ...after.preferences, editingStyle: { ...after.preferences.editingStyle, sources } } };
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
  for (const field of changed) pinned[field] = { by: 'owner', at: now.toISOString(), referenceAssetId: null, referenceName: '', referenceAssetIds: [] };
  return { ...after, preferences: { ...after.preferences, learning: { ...after.preferences.learning, pinned } } };
}

/**
 * Reads stored settings JSON, filling any fields added since it was saved (settings that predate preference learning
 * get pins for the fields the owner had changed); falls back to defaults if corrupt.
 */
export function normaliseStoredSettings(data: unknown): AppSettings {
  return parseStoredSettings(data ?? {}) ?? AppSettingsSchema.parse({});
}
