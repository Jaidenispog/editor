import type {
  AssetAnalysis,
  BrandConfig,
  EditPlan,
  EditingPreferences,
  PlanAssetInfo,
  PlanIssue,
  RevisionHints,
  SegmentLabel,
  StyleId,
  TranscriptSegment,
} from '@studio/core';

/** Token usage and estimated cost of one provider call (or a batch of calls made for one task). */
export interface AiUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  estimatedCostUsdCents: number;
}

/** Options every provider call accepts. */
export interface AiCallOptions {
  signal?: AbortSignal;
}

/** One sampled JPEG frame handed to a vision labeller. */
export interface FrameForLabelling {
  assetId: string;
  shotId: string;
  timeSec: number;
  jpegPath: string;
  width: number;
  height: number;
}

/** How tightly a shot is framed. */
export type ShotFraming = 'closeup' | 'medium' | 'wide' | 'unknown';

/** What the labeller concluded about one shot. */
export interface ShotLabelResult {
  shotId: string;
  label: SegmentLabel;
  confidence: number;
  description: string;
  framing: ShotFraming;
  focus: { x: number; y: number } | null;
  issues: string[];
}

/** Facts about the clip a batch of frames came from (treated as data, never as instructions). */
export interface LabelShotsContext {
  clipName: string;
  clipDurationSec: number;
  projectNotes: string;
  clipIndex: number;
  clipCount: number;
}

/** Frames of one clip to label, with the clip's context. */
export interface LabelShotsInput {
  frames: FrameForLabelling[];
  context: LabelShotsContext;
}

/** Labels per shot and the cost of producing them. */
export interface LabelShotsResult {
  results: ShotLabelResult[];
  usage: AiUsage | null;
}

/** Labels shots from sampled frames (vision model, or the heuristic stand-in). */
export interface VisionLabeler {
  name: string;
  model: string | null;
  labelShots(input: LabelShotsInput, opts?: AiCallOptions): Promise<LabelShotsResult>;
}

/** Music the owner chose for this generation, with its analysed beat grid. */
export interface PlannerMusic {
  trackId: string;
  durationSec: number;
  bpm: number | null;
  beatTimesSec: number[];
  title: string;
}

/** Everything a planner needs to propose one edit. */
export interface PlannerInput {
  styleId: StyleId;
  targetDurationSec: number;
  /** Per-clip analyses with the owner's manual tags already merged in by the caller. */
  analyses: AssetAnalysis[];
  assets: PlanAssetInfo[];
  music: PlannerMusic | null;
  preferences: EditingPreferences;
  brand: BrandConfig;
  businessName: string;
  /** The owner's free text for this generation. */
  instructions: string;
  keepOriginalSound: 'auto' | 'always' | 'never';
  captions: 'auto' | 'never';
  /** 0 for the first take; regenerate increments it so each take differs. */
  attempt: number;
  previousPlan?: EditPlan;
  revisionInstruction?: string;
  revisionHints?: RevisionHints;
  /** Validator errors from the previous attempt (repair loop). */
  previousErrors?: PlanIssue[];
}

/** What a planner returns. */
export interface PlannerResult {
  /** Unvalidated plan: the caller must run validateEditPlan before rendering. */
  plan: unknown;
  usage: AiUsage | null;
  source: 'ai' | 'rules';
}

/** Turns footage analysis and settings into an edit plan. */
export interface EditPlanner {
  name: string;
  model: string | null;
  planEdit(input: PlannerInput, opts?: AiCallOptions): Promise<PlannerResult>;
}

/** Timed transcript of one clip's speech. */
export interface TranscriptionResult {
  provider: string;
  language: string | null;
  segments: TranscriptSegment[];
}

/** Options for one transcription. */
export interface TranscribeOptions extends AiCallOptions {
  /** ISO-639-1 hint such as "en"; omitted lets the provider detect it. */
  language?: string;
}

/** Speech-to-text for clips where speech is likely. */
export interface Transcriber {
  name: string;
  transcribe(audioPath: string, opts?: TranscribeOptions): Promise<TranscriptionResult>;
}
