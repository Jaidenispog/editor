import { z } from 'zod';
import { ColourPresetSchema, SegmentLabelSchema, StyleIdSchema, TransitionTypeSchema } from './styles.js';

export const EDIT_PLAN_VERSION = 1;

export const OutputFormatSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().min(24).max(60),
});
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const VERTICAL_1080: OutputFormat = { width: 1080, height: 1920, fps: 30 };
export const VERTICAL_PREVIEW: OutputFormat = { width: 540, height: 960, fps: 30 };

export const FramingSchema = z.object({
  mode: z.enum(['centre', 'focus']).default('centre'),
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
});

export const ZoomSchema = z.object({
  /** Scale factor at segment start (1 = no zoom). */
  from: z.number().min(1).max(1.5),
  /** Scale factor at segment end. */
  to: z.number().min(1).max(1.5),
});

export const TransitionSchema = z.object({
  type: TransitionTypeSchema,
  durationSec: z.number().min(0.15).max(1.5),
});

export const SegmentSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  inSec: z.number().nonnegative(),
  outSec: z.number().positive(),
  speed: z.number().min(0.25).max(4).default(1),
  framing: FramingSchema.default({ mode: 'centre', focusX: 0.5, focusY: 0.5 }),
  zoom: ZoomSchema.nullable().default(null),
  /** Transition INTO this segment from the previous one. null = hard cut. Must be null on the first segment. */
  transitionIn: TransitionSchema.nullable().default(null),
  role: SegmentLabelSchema.default('other'),
  /** Keep this segment's own sound (mixed under the music or alone). */
  keepOriginalSound: z.boolean().default(false),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const TextOverlaySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(60),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  placement: z.enum(['top', 'centre', 'lower']).default('lower'),
  style: z.enum(['headline', 'subtitle', 'label']).default('headline'),
  animation: z.enum(['none', 'fade', 'rise', 'pop']).default('fade'),
  emphasis: z.enum(['normal', 'accent']).default('normal'),
});
export type TextOverlay = z.infer<typeof TextOverlaySchema>;

export const CaptionSchema = z.object({
  text: z.string().min(1).max(120),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
});
export type Caption = z.infer<typeof CaptionSchema>;

export const MusicPlanSchema = z.object({
  trackId: z.string().min(1),
  /** Where in the track playback starts. */
  startOffsetSec: z.number().nonnegative().default(0),
  volume: z.number().min(0).max(1).default(0.85),
  fadeInSec: z.number().min(0).max(3).default(0.3),
  fadeOutSec: z.number().min(0).max(4).default(1.2),
  /** Lower the music while a kept original-sound segment is playing. */
  duckUnderOriginal: z.boolean().default(true),
});
export type MusicPlan = z.infer<typeof MusicPlanSchema>;

export const AudioPlanSchema = z.object({
  music: MusicPlanSchema.nullable().default(null),
  originalSound: z.object({
    enabled: z.boolean().default(false),
    volume: z.number().min(0).max(1).default(1),
  }),
  /** Informational: how cuts were aligned to beats (used by the UI and tests). */
  beatAlignment: z
    .object({
      bpm: z.number().positive().nullable(),
      alignedCutTimesSec: z.array(z.number().nonnegative()),
    })
    .nullable()
    .default(null),
  loudnessTargetLufs: z.number().min(-24).max(-9).default(-14),
});
export type AudioPlan = z.infer<typeof AudioPlanSchema>;

export const EditPlanSchema = z.object({
  version: z.literal(EDIT_PLAN_VERSION),
  styleId: StyleIdSchema,
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(280),
  rationale: z.string().max(2000).default(''),
  output: OutputFormatSchema,
  targetDurationSec: z.number().min(5).max(90),
  segments: z.array(SegmentSchema).min(1).max(40),
  textOverlays: z.array(TextOverlaySchema).max(12).default([]),
  captions: z.array(CaptionSchema).max(80).default([]),
  audio: AudioPlanSchema,
  colourPreset: ColourPresetSchema.default('natural'),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

/** Shape the AI planner is asked to return (no derived fields). Identical to EditPlan today. */
export const PlannerOutputSchema = EditPlanSchema;
