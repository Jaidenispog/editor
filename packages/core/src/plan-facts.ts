import { z } from 'zod';
import type { EditPlan } from './edit-plan.js';
import { ColourPresetSchema, RESTRAINED_TRANSITIONS, StyleIdSchema } from './styles.js';
import { computeTimeline, round3 } from './timeline.js';

/**
 * A compact numeric summary of one edit plan, snapshotted into every feedback event (`feedback_events.data.planFacts`)
 * so preference learning never depends on rows that may later be deleted.
 */
export const PlanFactsSchema = z.object({
  styleId: StyleIdSchema,
  /** Output length in seconds (transitions overlap, as on the real timeline). */
  durationSec: z.number().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  avgShotSec: z.number().nonnegative(),
  medianShotSec: z.number().nonnegative(),
  textOverlayCount: z.number().int().nonnegative(),
  /** On-screen text items per 10 seconds of video. */
  textPer10Sec: z.number().nonnegative(),
  transitionCount: z.number().int().nonnegative(),
  /** Transitions outside the restrained set (fade, dissolve, fade to black or white). */
  flashyTransitionCount: z.number().int().nonnegative(),
  colourPreset: ColourPresetSchema,
  hasMusic: z.boolean(),
  musicTrackId: z.string().nullable(),
  musicVolume: z.number().min(0).max(1).nullable(),
  musicStartSec: z.number().nonnegative().nullable(),
  /** Any of the clips' own sound is heard. */
  originalSound: z.boolean(),
  /** Cuts were aligned to the music's beats. */
  beatAligned: z.boolean(),
});
export type PlanFacts = z.infer<typeof PlanFactsSchema>;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Owner actions recorded in `feedback_events.type`. */
export const FEEDBACK_EVENT_TYPES = ['favourite', 'unfavourite', 'download', 'revise', 'regenerate', 'publish', 'dismiss'] as const;
export type FeedbackEventType = (typeof FEEDBACK_EVENT_TYPES)[number];

/** One feedback event to record (web `recordFeedback` and its worker twin share this shape). */
export interface FeedbackEventInput {
  type: FeedbackEventType;
  userId: string | null;
  projectId: string | null;
  editId: string | null;
  editVersionId: string | null;
  styleId: string | null;
  /** The plan the action was about; its facts are snapshotted into the event. */
  plan?: EditPlan | null;
  /** Where the facts go: `planFacts` (default) or `parentPlanFacts` for revise and regenerate. */
  factsKey?: 'planFacts' | 'parentPlanFacts';
  /** Extra data, e.g. `{ platform }` for publish or `{ instruction, hints }` for revise. */
  data?: Record<string, unknown>;
}

/** The `data` column for a feedback event: the caller's data plus the plan-facts snapshot. */
export function feedbackEventData(input: FeedbackEventInput): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(input.data ?? {}) };
  if (input.plan) data[input.factsKey ?? 'planFacts'] = computePlanFacts(input.plan);
  return data;
}

/** Summarises a validated edit plan into {@link PlanFacts}. Pure and deterministic. */
export function computePlanFacts(plan: EditPlan): PlanFacts {
  const timeline = computeTimeline(plan);
  const shots = timeline.segments.map((s) => s.playDurationSec);
  const durationSec = timeline.totalDurationSec;
  const transitions = plan.segments.slice(1).flatMap((s) => (s.transitionIn ? [s.transitionIn.type] : []));
  const music = plan.audio.music;
  const textOverlayCount = plan.textOverlays.length;
  return {
    styleId: plan.styleId,
    durationSec: round3(durationSec),
    segmentCount: plan.segments.length,
    avgShotSec: round3(shots.length ? shots.reduce((a, b) => a + b, 0) / shots.length : 0),
    medianShotSec: round3(median(shots)),
    textOverlayCount,
    textPer10Sec: round3(durationSec > 0 ? (textOverlayCount / durationSec) * 10 : 0),
    transitionCount: transitions.length,
    flashyTransitionCount: transitions.filter((t) => !RESTRAINED_TRANSITIONS.includes(t)).length,
    colourPreset: plan.colourPreset,
    hasMusic: music !== null,
    musicTrackId: music?.trackId ?? null,
    musicVolume: music ? music.volume : null,
    musicStartSec: music ? round3(music.startOffsetSec) : null,
    originalSound: plan.audio.originalSound.enabled || plan.segments.some((s) => s.keepOriginalSound),
    beatAligned: (plan.audio.beatAlignment?.alignedCutTimesSec.length ?? 0) > 0,
  };
}
