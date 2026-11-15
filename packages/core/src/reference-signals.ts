import { z } from 'zod';

/**
 * Reference style v2 signals (preferences design §4.3.1.5): what makes the owner's own editing recognisable,
 * measured from one of their posted videos. Every number is an estimate. No beat times, cut times, energy curve,
 * audio or frames are kept: only counts, ratios, quartiles, the 8-point energy shape and the drop position.
 */

/** Version of the measuring code, stored with each profile so older measurements can be recognised. */
export const REFERENCE_STYLE_ANALYSIS_VERSION = 1;

/** Kinds of join between two shots the measurement can tell apart. */
export const BOUNDARY_KINDS = ['hard', 'fade_white', 'fade_black', 'cross_fade', 'slide_vertical', 'wipe_horizontal', 'zoom', 'whip_like', 'punch_in', 'unclear'] as const;
export const BoundaryKindSchema = z.enum(BOUNDARY_KINDS);
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

export const TRANSITION_FAMILIES = ['straight_only', 'straight_flash', 'cross_fades', 'movement', 'mixed'] as const;
export type TransitionFamily = (typeof TRANSITION_FAMILIES)[number];

export const BEAT_NOT_MEASURED_REASONS = ['no_audio', 'no_clear_beat', 'mostly_speech', 'too_few_cuts'] as const;
export type BeatNotMeasuredReason = (typeof BEAT_NOT_MEASURED_REASONS)[number];

const int = () => z.number().int();
const nonNegInt = () => z.number().int().nonnegative();

export const BeatsPerCutCountsSchema = z.object({ one: int(), two: int(), four: int(), eight: int(), other: int() });
export type BeatsPerCutCounts = z.infer<typeof BeatsPerCutCountsSchema>;

export const BeatSignalSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('measured'),
    bpm: z.number().positive(),
    confidence: z.number().min(0).max(1),
    cuts: int(),
    within1Frame: int(),
    within80ms: int(),
    chanceShare80ms: z.number().min(0).max(1),
    offBeatHalf: int(),
    medianOffsetMs: z.number(),
    beatsPerCutCounts: BeatsPerCutCountsSchema,
    beatsPerCut: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).nullable(),
    reportable: z.boolean(),
  }),
  z.object({
    status: z.literal('not_measured'),
    reason: z.enum(BEAT_NOT_MEASURED_REASONS),
    /** Tempo may still be known with too few cuts. */
    bpm: z.number().positive().nullable(),
  }),
]);
export type BeatSignal = z.infer<typeof BeatSignalSchema>;

export const DropSignalSchema = z.object({
  status: z.enum(['found', 'none', 'not_measured']),
  atSec: z.number().nullable(),
  atShare: z.number().min(0).max(1).nullable(),
  riseDb: z.number().nullable(),
  visualEvent: z.enum(['cut', 'flash', 'zoom', 'none']).nullable(),
  eventOffsetMs: z.number().nullable(),
});
export type DropSignal = z.infer<typeof DropSignalSchema>;

export const TransitionSignalSchema = z.object({
  joins: nonNegInt(),
  counts: z.partialRecord(BoundaryKindSchema, nonNegInt()),
  directions: z.object({ up: int(), down: int(), left: int(), right: int() }),
  crossFadeMedianSec: z.number().nullable(),
  flashMedianSec: z.number().nullable(),
  /** null when the beat was not measured. */
  flashesOnBeat: int().nullable(),
  flashEveryBeats: z.number().nullable(),
  family: z.enum(TRANSITION_FAMILIES).nullable(),
  reportable: z.boolean(),
});
export type TransitionSignal = z.infer<typeof TransitionSignalSchema>;

export const ZoomSignalSchema = z.object({
  shotsChecked: int(),
  pushIns: int(),
  pullOuts: int(),
  punchIns: int(),
  medianPushScale: z.number().nullable(),
  medianPunchScale: z.number().nullable(),
});
export type ZoomSignal = z.infer<typeof ZoomSignalSchema>;

export const MusicSignalSchema = z.object({
  status: z.enum(['measured', 'not_measured']),
  bpm: z.number().nullable(),
  energyShape: z.array(z.number().min(0).max(1)).length(8).nullable(),
  shapeWord: z.enum(['steady', 'builds', 'drop', 'varied']).nullable(),
  dynamicRangeDb: z.number().nullable(),
  hasClearDrop: z.boolean(),
});
export type MusicSignal = z.infer<typeof MusicSignalSchema>;

export const ReferenceStyleSignalsSchema = z.object({
  analysisVersion: z.number().int().positive(),
  /** Every number here is an estimate. */
  estimate: z.literal(true),
  measuredSec: z.number().nonnegative(),
  endScreenTrimmedSec: z.number().nonnegative(),
  fps: z.number().positive(),
  /** Raw v2 boundaries: no merging or splitting of shots. */
  shots: z.object({ count: nonNegInt(), medianSec: z.number().nonnegative(), p25Sec: z.number().nonnegative(), p75Sec: z.number().nonnegative() }),
  transitions: TransitionSignalSchema,
  beat: BeatSignalSchema,
  drop: DropSignalSchema,
  zoom: ZoomSignalSchema,
  music: MusicSignalSchema,
});
export type ReferenceStyleSignals = z.infer<typeof ReferenceStyleSignalsSchema>;
