import { z } from 'zod';
import { SegmentLabelSchema, StyleIdSchema, type SegmentLabel } from './styles.js';

export const ColourInfoSchema = z.object({
  primaries: z.string().nullable(),
  transfer: z.string().nullable(),
  matrix: z.string().nullable(),
  range: z.string().nullable(),
});

/** Facts about a source file, derived from ffprobe. */
export const AssetProbeSchema = z.object({
  container: z.string(),
  durationSec: z.number().nonnegative(),
  fileSizeBytes: z.number().int().nonnegative(),
  video: z
    .object({
      codec: z.string(),
      /** Coded (stored) dimensions before rotation. */
      codedWidth: z.number().int().positive(),
      codedHeight: z.number().int().positive(),
      /** Dimensions as displayed after applying rotation metadata. */
      displayWidth: z.number().int().positive(),
      displayHeight: z.number().int().positive(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      fps: z.number().positive(),
      pixelFormat: z.string().nullable(),
      bitDepth: z.number().int(),
      colour: ColourInfoSchema,
      isHdr: z.boolean(),
      hdrFormat: z.enum(['hlg', 'pq']).nullable(),
      bitrate: z.number().int().nullable(),
    })
    .nullable(),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.number().int(),
      channels: z.number().int(),
      bitrate: z.number().int().nullable(),
    })
    .nullable(),
});
export type AssetProbe = z.infer<typeof AssetProbeSchema>;

export const ShotQualitySchema = z.object({
  /** 0–1, higher is sharper (normalised Laplacian variance). */
  sharpness: z.number().min(0).max(1),
  /** 0–1 mean luma. */
  brightness: z.number().min(0).max(1),
  /** 0–1 mean inter-frame motion. */
  motion: z.number().min(0).max(1),
  /** 0–1 luma standard deviation (contrast proxy). */
  contrast: z.number().min(0).max(1),
  exposureIssue: z.enum(['none', 'dark', 'bright', 'flat']),
  /** Overall usability 0–1 combining the above. */
  score: z.number().min(0).max(1),
});
export type ShotQuality = z.infer<typeof ShotQualitySchema>;

export const LabelSourceSchema = z.enum(['vision_model', 'heuristic', 'manual']);
export type LabelSource = z.infer<typeof LabelSourceSchema>;

export const ShotSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  quality: ShotQualitySchema,
  label: SegmentLabelSchema,
  labelSource: LabelSourceSchema,
  /** 0–1 confidence for the label. Manual labels are 1. */
  confidence: z.number().min(0).max(1),
  /** One-sentence description from the vision model (or empty). */
  description: z.string().max(400).default(''),
  framing: z.enum(['closeup', 'medium', 'wide', 'unknown']).default('unknown'),
  /** Horizontal/vertical centre of the subject (0–1) if known, used for 9:16 crops. */
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().default(null),
  /** Flags the model/heuristics raised: e.g. "camera shake", "face partly out of frame". */
  issues: z.array(z.string().max(120)).default([]),
});
export type Shot = z.infer<typeof ShotSchema>;

export const SampledFrameSchema = z.object({
  timeSec: z.number().nonnegative(),
  storageKey: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  shotId: z.string().nullable().default(null),
});
export type SampledFrame = z.infer<typeof SampledFrameSchema>;

export const TranscriptSegmentSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const AudioAnalysisSchema = z.object({
  hasAudio: z.boolean(),
  integratedLoudnessLufs: z.number().nullable(),
  /** Fraction of the duration that is silence (0–1). */
  silenceRatio: z.number().min(0).max(1),
  /** Heuristic: speech-band energy suggests talking. */
  speechLikely: z.boolean(),
  speechConfidence: z.number().min(0).max(1),
});
export type AudioAnalysis = z.infer<typeof AudioAnalysisSchema>;

export const ASSET_ANALYSIS_VERSION = 1;

export const AssetAnalysisSchema = z.object({
  version: z.literal(ASSET_ANALYSIS_VERSION),
  assetId: z.string(),
  probe: AssetProbeSchema,
  shots: z.array(ShotSchema),
  sampledFrames: z.array(SampledFrameSchema),
  audio: AudioAnalysisSchema,
  transcript: z
    .object({
      provider: z.string(),
      language: z.string().nullable(),
      segments: z.array(TranscriptSegmentSchema),
    })
    .nullable(),
  /** Which labeller produced the shot labels. */
  labelling: z.object({
    source: LabelSourceSchema.or(z.literal('none')),
    model: z.string().nullable(),
    note: z.string().default(''),
  }),
  completedAt: z.string(),
});
export type AssetAnalysis = z.infer<typeof AssetAnalysisSchema>;

export const StyleSupportSchema = z.object({
  styleId: StyleIdSchema,
  supported: z.boolean(),
  reason: z.string().default(''),
});
export type StyleSupport = z.infer<typeof StyleSupportSchema>;

export interface FootageAvailability {
  labels: Record<SegmentLabel, number>;
  usableShots: number;
  hasSpeech: boolean;
  totalDurationSec: number;
}

export function summariseAvailability(analyses: AssetAnalysis[]): FootageAvailability {
  const labels = Object.fromEntries(SegmentLabelSchema.options.map((l) => [l, 0])) as Record<SegmentLabel, number>;
  let usableShots = 0;
  let hasSpeech = false;
  let totalDurationSec = 0;
  for (const a of analyses) {
    totalDurationSec += a.probe.durationSec;
    if (a.transcript && a.transcript.segments.length > 0) hasSpeech = true;
    for (const s of a.shots) {
      labels[s.label] += 1;
      if (s.quality.score >= 0.35 && s.endSec - s.startSec >= 0.5) usableShots += 1;
    }
  }
  return { labels, usableShots, hasSpeech, totalDurationSec };
}
