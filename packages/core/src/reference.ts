import { z } from 'zod';
import { REFERENCE_STYLE_ANALYSIS_VERSION, ReferenceStyleSignalsSchema, type ReferenceStyleSignals } from './reference-signals.js';
import type { EditingPreferences } from './settings.js';

/**
 * Reference videos (preferences design §4.3, §6.2): the owner uploads a video whose pace and look they like; the app
 * measures only its shot lengths, length, colour and (optionally) how much on-screen text it has, suggests matching
 * preferences, and deletes the file. Nothing from a reference is ever used in an edit.
 */

/** Preferences a reference video can suggest. */
export const REFERENCE_SUGGESTION_FIELDS = ['defaultDurationSec', 'pacing', 'colour', 'textDensity'] as const;
export const ReferenceSuggestionFieldSchema = z.enum(REFERENCE_SUGGESTION_FIELDS);
export type ReferenceSuggestionField = (typeof REFERENCE_SUGGESTION_FIELDS)[number];

/** The reason shown (with no button) when a suggestion equals the value already in use. */
export const MATCHES_SETTINGS_REASON = 'matches your settings';

/** Shortest reference video that can be measured, in seconds. */
export const REFERENCE_MIN_DURATION_SEC = 3;
/** Frames sent to the AI text estimate at most (only with the owner's tick on that upload). */
export const REFERENCE_TEXT_FRAMES = 8;

export const ReferenceSuggestionSchema = z.object({
  field: ReferenceSuggestionFieldSchema,
  value: z.union([z.number(), z.string()]),
  reason: z.string().max(200),
});
export type ReferenceSuggestion = z.infer<typeof ReferenceSuggestionSchema>;

export const ColourLookSchema = z.enum(['natural', 'clean', 'cinematic', 'punchy']);
export type ColourLook = z.infer<typeof ColourLookSchema>;

export const ReferenceStyleProfileV1Schema = z.object({
  version: z.literal(1),
  assetId: z.string(),
  measuredAt: z.string(),
  sourceFilename: z.string().max(300),
  durationSec: z.number().nonnegative(),
  shotCount: z.number().int().nonnegative(),
  shotSec: z.object({ median: z.number().nonnegative(), p25: z.number().nonnegative(), p75: z.number().nonnegative() }),
  cutsPer10Sec: z.number().nonnegative(),
  look: z.object({ meanLuma: z.number().min(0).max(1), meanSaturation: z.number().min(0).max(1), contrast: z.number().min(0).max(1) }),
  colourLook: ColourLookSchema,
  text: z.object({
    density: z.enum(['none', 'light', 'medium']).nullable(),
    framesChecked: z.number().int().nonnegative(),
    framesWithText: z.number().int().nonnegative(),
    source: z.enum(['vision_model', 'not_measured']),
  }),
  suggestions: z.array(ReferenceSuggestionSchema),
  decisions: z.partialRecord(ReferenceSuggestionFieldSchema, z.enum(['accepted', 'dismissed'])).default({}),
  originalsDeletedAt: z.string().nullable(),
});
export type ReferenceStyleProfileV1 = z.infer<typeof ReferenceStyleProfileV1Schema>;

/** v2 (design §4.3.1.5): the v1 fields plus the transition, beat, drop, zoom and music signals. */
export const ReferenceStyleProfileV2Schema = ReferenceStyleProfileV1Schema.extend({
  version: z.literal(2),
  /** null only for a v1 profile read through {@link readReferenceProfile}. */
  style: ReferenceStyleSignalsSchema.nullable(),
});
export type ReferenceStyleProfileV2 = z.infer<typeof ReferenceStyleProfileV2Schema>;

/** A stored profile: v1 (measured before transitions and beat were added) or v2. */
export const ReferenceStyleProfileSchema = z.discriminatedUnion('version', [ReferenceStyleProfileV1Schema, ReferenceStyleProfileV2Schema]);
export type ReferenceStyleProfile = z.infer<typeof ReferenceStyleProfileSchema>;

/**
 * Backwards-compatible read: a v1 profile comes back in the v2 shape with `style: null` (the stored copy is never
 * rewritten, so it stays recognisable as an older measurement). Returns null when the stored value does not parse.
 */
export function readReferenceProfile(raw: unknown): ReferenceStyleProfileV2 | null {
  const parsed = ReferenceStyleProfileSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.version === 1 ? { ...parsed.data, version: 2, style: null } : parsed.data;
}

/** True for a profile measured before transitions and beat were added (its originals are gone, so it cannot be re-measured). */
export function isOlderReferenceMeasurement(profile: Pick<ReferenceStyleProfileV2, 'style'>): boolean {
  return profile.style === null;
}

/**
 * True for a v2 profile measured by another version of the measuring code than `current` (the stored
 * `style.analysisVersion`): "your style" does not pool it, because every number in it came from that measuring. Its
 * originals are gone, so only uploading the video again measures it with the current version.
 */
export function isOlderMeasuringVersion(profile: Pick<ReferenceStyleProfileV2, 'style'>, current: number = REFERENCE_STYLE_ANALYSIS_VERSION): boolean {
  return profile.style !== null && profile.style.analysisVersion !== current;
}

/** Average picture measurements (0–1) from `measureLook` in @studio/media. */
export interface LookMeasurement {
  meanLuma: number;
  meanSaturation: number;
  contrast: number;
}

/** The on-screen text estimate from the vision model, or null when it was not measured. */
export interface TextMeasurement {
  framesChecked: number;
  framesWithText: number;
}

/** Everything `profileReference` needs. */
export interface ReferenceMeasurements {
  assetId: string;
  sourceFilename: string;
  durationSec: number;
  /** Shot lengths in seconds, in order (shots under 0.2 s are ignored). */
  shotDurationsSec: number[];
  look: LookMeasurement;
  text: TextMeasurement | null;
  measuredAt: Date;
  /**
   * Reference style v2 signals. When given, the shot numbers come from its raw v2 boundaries (no merging or
   * splitting), which corrects v1's bias towards 0.8–5 s shots.
   */
  style?: ReferenceStyleSignals | null;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo);
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Colour look estimate (design §6.2): punchy, cinematic, clean, else natural. */
export function classifyColourLook(look: LookMeasurement): ColourLook {
  if (look.meanSaturation > 0.32 && look.contrast > 0.22) return 'punchy';
  if (look.meanSaturation < 0.18 && look.contrast > 0.2) return 'cinematic';
  if (look.meanLuma > 0.55 && look.meanSaturation < 0.28) return 'clean';
  return 'natural';
}

/** Pacing from the median shot length: under 1.0 s fast, 1.0–2.2 s balanced, over 2.2 s slow. */
export function classifyPacing(medianShotSec: number): EditingPreferences['pacing'] {
  if (medianShotSec < 1.0) return 'fast';
  if (medianShotSec > 2.2) return 'slow';
  return 'balanced';
}

/** Text density from the share of checked frames with added text: 0 none, up to 40 % light, more medium. */
export function classifyTextDensity(text: TextMeasurement | null): 'none' | 'light' | 'medium' | null {
  if (!text || text.framesChecked === 0) return null;
  const share = text.framesWithText / text.framesChecked;
  if (share === 0) return 'none';
  return share <= 0.4 ? 'light' : 'medium';
}

/** The suggested default length: the reference's length rounded to 5 s, only between 8 and 90 s. */
export function suggestedDuration(durationSec: number): number | null {
  if (durationSec < 8 || durationSec > 90) return null;
  return Math.min(90, Math.max(10, Math.round(durationSec / 5) * 5));
}

const FIELD_LABEL: Record<ReferenceSuggestionField, string> = {
  defaultDurationSec: 'Default length',
  pacing: 'Pacing',
  colour: 'Colour',
  textDensity: 'On-screen text',
};

/**
 * Measurements → profile with suggestions (design §6.2). A suggestion equal to the value in use is kept with the
 * reason "matches your settings" (shown without a button). Pure.
 */
export function profileReference(m: ReferenceMeasurements, current: Pick<EditingPreferences, ReferenceSuggestionField>): ReferenceStyleProfileV2 {
  const style = m.style ?? null;
  const shots = m.shotDurationsSec.filter((d) => d >= 0.2).sort((a, b) => a - b);
  const shotCount = style ? style.shots.count : shots.length;
  const median = style ? style.shots.medianSec : quantile(shots, 0.5);
  const p25 = style ? style.shots.p25Sec : quantile(shots, 0.25);
  const p75 = style ? style.shots.p75Sec : quantile(shots, 0.75);
  const spanSec = style && style.measuredSec > 0 ? style.measuredSec : m.durationSec;
  const colourLook = classifyColourLook(m.look);
  const density = classifyTextDensity(m.text);
  const candidates: Array<{ field: ReferenceSuggestionField; value: number | string; reason: string }> = [];
  const duration = suggestedDuration(m.durationSec);
  if (duration !== null) candidates.push({ field: 'defaultDurationSec', value: duration, reason: `The reference runs for ${Math.round(m.durationSec)} seconds.` });
  if (style ? shotCount >= 3 : shotCount > 0) candidates.push({ field: 'pacing', value: classifyPacing(median), reason: `Its shots last about ${median.toFixed(1)} seconds (median).` });
  candidates.push({ field: 'colour', value: colourLook, reason: 'Estimated from its brightness, saturation and contrast.' });
  if (density !== null && m.text) candidates.push({ field: 'textDensity', value: density, reason: `On-screen text in ${m.text.framesWithText} of ${m.text.framesChecked} checked frames.` });

  return {
    version: 2,
    style,
    assetId: m.assetId,
    measuredAt: m.measuredAt.toISOString(),
    sourceFilename: m.sourceFilename.slice(0, 300),
    durationSec: r3(m.durationSec),
    shotCount,
    shotSec: { median: r3(median), p25: r3(p25), p75: r3(p75) },
    cutsPer10Sec: r3(spanSec > 0 ? (Math.max(0, shotCount - 1) / spanSec) * 10 : 0),
    look: { meanLuma: r3(clamp01(m.look.meanLuma)), meanSaturation: r3(clamp01(m.look.meanSaturation)), contrast: r3(clamp01(m.look.contrast)) },
    colourLook,
    text: m.text
      ? { density, framesChecked: m.text.framesChecked, framesWithText: m.text.framesWithText, source: 'vision_model' }
      : { density: null, framesChecked: 0, framesWithText: 0, source: 'not_measured' },
    suggestions: candidates.map((c) => (current[c.field] === c.value ? { ...c, reason: MATCHES_SETTINGS_REASON } : c)),
    decisions: {},
    originalsDeletedAt: null,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Suggestions that still need a decision (not matching the settings, not yet accepted or dismissed). */
export function openSuggestions(profile: Pick<ReferenceStyleProfile, 'suggestions' | 'decisions'>): ReferenceSuggestion[] {
  return profile.suggestions.filter((s) => s.reason !== MATCHES_SETTINGS_REASON && !profile.decisions[s.field]);
}

/** "Default length: 35 seconds" style wording for a suggestion. */
export function describeSuggestion(s: ReferenceSuggestion): string {
  const value =
    s.field === 'defaultDurationSec'
      ? `${s.value} seconds`
      : String(s.value).charAt(0).toUpperCase() + String(s.value).slice(1);
  return `${FIELD_LABEL[s.field]}: ${value}`;
}

/** Plain summary of a profile: "34 s long · 21 shots · shots mostly 1.2–1.8 s (median 1.4 s) · clean colour · …". */
export function describeReferenceProfile(p: Pick<ReferenceStyleProfile, 'durationSec' | 'shotCount' | 'shotSec' | 'colourLook' | 'text'>): string {
  const parts = [`${Math.round(p.durationSec)} s long`, `${p.shotCount} shot${p.shotCount === 1 ? '' : 's'}`];
  if (p.shotCount > 0) parts.push(`shots mostly ${p.shotSec.p25.toFixed(1)}–${p.shotSec.p75.toFixed(1)} s (median ${p.shotSec.median.toFixed(1)} s)`);
  parts.push(`${p.colourLook} colour (estimate)`);
  if (p.text.source === 'vision_model' && p.text.density) {
    const word = p.text.density === 'none' ? 'no' : p.text.density;
    parts.push(`${word} on-screen text (${p.text.framesWithText} of ${p.text.framesChecked} frames)`);
  } else parts.push('on-screen text: not measured');
  return parts.join(' · ');
}
