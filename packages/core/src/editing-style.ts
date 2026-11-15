import { z } from 'zod';
import { REFERENCE_SUGGESTION_FIELDS } from './reference.js';
import { RESTRAINED_TRANSITIONS, TransitionTypeSchema, type TransitionType } from './styles.js';

/**
 * The owner's editing style measured from their own posted videos (preferences design §4.3.1.5). Every value is
 * expressed in what the renderer can already do: `TRANSITION_TYPES`, segment zoom from/to, beat-synced cuts. The
 * defaults change nothing, so plans are identical to before until the owner accepts a suggestion.
 */

/** The `editingStyle` fields a summary row can set. */
export const EDITING_STYLE_FIELDS = ['transitionPalette', 'beatSync', 'beatsPerCut', 'reveal', 'zoom', 'musicFit'] as const;
export const EditingStyleFieldSchema = z.enum(EDITING_STYLE_FIELDS);
export type EditingStyleField = (typeof EDITING_STYLE_FIELDS)[number];

/** The `editingStyle` fields the planners use. `musicFit` is not one: it only ranks the owner's own licensed tracks. */
export const EDITING_STYLE_PLANNING_FIELDS = ['transitionPalette', 'beatSync', 'beatsPerCut', 'reveal', 'zoom'] as const satisfies readonly EditingStyleField[];

/** Every field the "Your style from your videos" summary can suggest (v1 reference fields first). */
export const REFERENCE_SUMMARY_FIELDS = [...REFERENCE_SUGGESTION_FIELDS, ...EDITING_STYLE_FIELDS] as const;
export const ReferenceSummaryFieldSchema = z.enum(REFERENCE_SUMMARY_FIELDS);
export type ReferenceSummaryField = (typeof REFERENCE_SUMMARY_FIELDS)[number];

export const BeatsPerCutSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]);
export type BeatsPerCut = z.infer<typeof BeatsPerCutSchema>;

/** Accent transitions: a quick flash to white or a dip to black placed on the beat. */
export const ACCENT_TRANSITIONS = ['fadewhite', 'fadeblack'] as const;

export const TransitionPaletteSchema = z.object({
  /** Share of joins left as straight cuts. */
  hardCutShare: z.number().min(0).max(1),
  /** Non-accent transitions, most used first. */
  types: z.array(TransitionTypeSchema).max(3),
  /** Typical length of those, rounded to 0.05 s. */
  durationSec: z.number().min(0.15).max(1),
  accent: z
    .object({
      type: z.enum(ACCENT_TRANSITIONS),
      /** null = only at the reveal. */
      everyBeats: z.union([z.literal(4), z.literal(8)]).nullable(),
      durationSec: z.number().min(0.15).max(0.3),
    })
    .nullable(),
});
export type TransitionPalette = z.infer<typeof TransitionPaletteSchema>;

export const ZoomUseSchema = z.discriminatedUnion('mode', [
  /** Each style's own zooms (the default). */
  z.object({ mode: z.literal('style') }),
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('push_in'), scale: z.number().min(1.03).max(1.12) }),
  z.object({ mode: z.literal('punch_in'), scale: z.number().min(1.08).max(1.25), shareOfCuts: z.number().min(0.1).max(0.5) }),
]);
export type ZoomUse = z.infer<typeof ZoomUseSchema>;

export const MusicFitSchema = z
  .object({
    bpmLow: z.number().min(40).max(220),
    bpmHigh: z.number().min(40).max(220),
    prefersClearDrop: z.boolean(),
    dynamicRangeDb: z.number().nullable(),
  })
  .refine((fit) => fit.bpmLow <= fit.bpmHigh, {
    path: ['bpmLow'],
    message: 'The music tempo range is the wrong way round: the lower BPM (bpmLow) must not be above the higher BPM (bpmHigh).',
  });
export type MusicFit = z.infer<typeof MusicFitSchema>;

export const EditingStyleSourceSchema = z.object({
  by: z.enum(['owner', 'reference']),
  at: z.string(),
  referenceAssetIds: z.array(z.string()).max(12).default([]),
  referenceName: z.string().max(200).default(''),
});
export type EditingStyleSource = z.infer<typeof EditingStyleSourceSchema>;

export const SummaryDecisionSchema = z.object({
  decision: z.enum(['accepted', 'dismissed']),
  /** Stable JSON of the suggested value; a dismissed row comes back only when its value changes. */
  valueKey: z.string().max(400),
  at: z.string(),
});
export type SummaryDecision = z.infer<typeof SummaryDecisionSchema>;

export const EditingStyleSchema = z.object({
  /** null = each style's own transitions. */
  transitionPalette: TransitionPaletteSchema.nullable().default(null),
  beatSync: z.enum(['auto', 'on', 'off']).default('auto'),
  beatsPerCut: BeatsPerCutSchema.nullable().default(null),
  reveal: z.enum(['style', 'strongest_beat']).default('style'),
  zoom: ZoomUseSchema.default({ mode: 'style' }),
  /** Used only to rank the owner's own licensed tracks. */
  musicFit: MusicFitSchema.nullable().default(null),
  /** Where each non-default value came from (server-managed). */
  sources: z.partialRecord(EditingStyleFieldSchema, EditingStyleSourceSchema).default({}),
  /** Owner decisions on summary rows (server-managed). */
  summaryDecisions: z.partialRecord(ReferenceSummaryFieldSchema, SummaryDecisionSchema).default({}),
});
export type EditingStyle = z.infer<typeof EditingStyleSchema>;

export const DEFAULT_EDITING_STYLE: EditingStyle = EditingStyleSchema.parse({});

/** The value fields of an editing style (no bookkeeping), as accepted from Settings. */
export const EditingStyleValuesSchema = EditingStyleSchema.pick({ transitionPalette: true, beatSync: true, beatsPerCut: true, reveal: true, zoom: true, musicFit: true });
export type EditingStyleValues = z.infer<typeof EditingStyleValuesSchema>;

/** Stable JSON (object keys sorted) used to compare suggested values. */
export function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value) ?? null);
}

/**
 * True when no editing-style value the planners use differs from its default, so plans are identical to the defaults.
 * An accepted music fit alone (`musicFit` only ranks the owner's tracks) still counts as the default here.
 */
export function isDefaultPlanningStyle(style: EditingStyle | undefined | null): boolean {
  if (!style) return true;
  return EDITING_STYLE_PLANNING_FIELDS.every((f) => stableJson(style[f]) === stableJson(DEFAULT_EDITING_STYLE[f]));
}

/** The palette's non-accent types that are not restrained (anything that also needs "bolder transitions"). */
export function flashyPaletteTypes(palette: TransitionPalette | null | undefined): TransitionType[] {
  return (palette?.types ?? []).filter((t) => !RESTRAINED_TRANSITIONS.includes(t));
}

/** Every transition type an accepted palette may place (types plus the accent), for the validator and the AI brief. */
export function paletteTransitionTypes(palette: TransitionPalette | null | undefined): TransitionType[] {
  if (!palette) return [];
  const out: TransitionType[] = [...palette.types];
  if (palette.accent && !out.includes(palette.accent.type)) out.push(palette.accent.type);
  return out;
}
