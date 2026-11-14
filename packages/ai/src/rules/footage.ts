import type { AssetAnalysis, LabelSource, PlanAssetInfo, SegmentLabel, TranscriptSegment } from '@studio/core';

/** Minimum quality score and length for a shot to be used by the rules planner. */
export const USABLE_SCORE = 0.35;
export const USABLE_LENGTH_SEC = 0.6;
/** Looser thresholds used only when the strict ones leave almost nothing to work with. */
const RELAXED_SCORE = 0.15;
const RELAXED_LENGTH_SEC = 0.5;

export const PROCESS_LABELS: readonly SegmentLabel[] = ['cutting', 'fade_detail', 'styling'];
export const NEUTRAL_LABELS: readonly SegmentLabel[] = ['environment', 'other', 'unknown'];

/** A shot (or the bounds of a previous plan's segment) the planner can cut a window from. */
export interface Candidate {
  shotId: string;
  assetId: string;
  /** Position of the clip in the project (owner's order). */
  assetIndex: number;
  shotIndex: number;
  /** Global chronological rank: clip order, then time within the clip. */
  order: number;
  startSec: number;
  endSec: number;
  label: SegmentLabel;
  labelSource: LabelSource;
  score: number;
  motion: number;
  focus: { x: number; y: number } | null;
  hasAudio: boolean;
  /** Transcript segments that overlap this shot. */
  speech: TranscriptSegment[];
}

export interface Footage {
  /** Shots that passed the usability filter, in chronological order. */
  candidates: Candidate[];
  /** Every shot with valid bounds (used to map a previous plan back onto the footage). */
  allShots: Candidate[];
  transcripts: Record<string, TranscriptSegment[]>;
  assetsById: Map<string, PlanAssetInfo>;
  /** True when the strict quality filter was relaxed because too few shots passed it. */
  relaxed: boolean;
}

/** Length of a candidate in source seconds. */
export function lengthOf(c: Pick<Candidate, 'startSec' | 'endSec'>): number {
  return c.endSec - c.startSec;
}

/**
 * Collects every shot the planner may use. Shot ends are clamped to the clip length the validator knows about
 * (shot detection can overshoot by a frame), and clips missing from `assets` are ignored.
 */
export function collectFootage(analyses: AssetAnalysis[], assets: PlanAssetInfo[]): Footage {
  const assetsById = new Map(assets.map((a) => [a.id, a]));
  const assetOrder = new Map(assets.map((a, i) => [a.id, i]));
  const transcripts: Record<string, TranscriptSegment[]> = {};
  const all: Candidate[] = [];

  analyses.forEach((analysis, analysisIndex) => {
    const asset = assetsById.get(analysis.assetId);
    if (!asset) return;
    const speech = (analysis.transcript?.segments ?? []).filter((s) => s.text.trim().length > 0 && s.endSec > s.startSec);
    if (speech.length > 0) transcripts[analysis.assetId] = speech;
    const assetIndex = assetOrder.get(analysis.assetId) ?? analysisIndex;
    const shots = [...analysis.shots].sort((a, b) => a.startSec - b.startSec);
    shots.forEach((shot, shotIndex) => {
      const startSec = Math.max(0, shot.startSec);
      const endSec = Math.min(shot.endSec, asset.durationSec);
      if (endSec - startSec <= 0.05) return;
      all.push({
        shotId: shot.id,
        assetId: analysis.assetId,
        assetIndex,
        shotIndex,
        order: 0,
        startSec,
        endSec,
        label: shot.label,
        labelSource: shot.labelSource,
        score: shot.quality.score,
        motion: shot.quality.motion,
        focus: shot.focus,
        hasAudio: asset.hasAudio,
        speech: speech.filter((s) => s.endSec > startSec && s.startSec < endSec),
      });
    });
  });

  all.sort((a, b) => a.assetIndex - b.assetIndex || a.startSec - b.startSec);
  all.forEach((c, i) => (c.order = i));

  const strict = all.filter((c) => c.score >= USABLE_SCORE && lengthOf(c) >= USABLE_LENGTH_SEC);
  if (strict.length >= 2) return { candidates: strict, allShots: all, transcripts, assetsById, relaxed: false };
  const relaxed = all.filter((c) => c.score >= RELAXED_SCORE && lengthOf(c) >= RELAXED_LENGTH_SEC);
  return { candidates: relaxed, allShots: all, transcripts, assetsById, relaxed: relaxed.length > strict.length };
}

/** Candidates whose label is one of `labels` (an empty list means any label). */
export function withLabels(cands: readonly Candidate[], labels: readonly SegmentLabel[]): Candidate[] {
  if (labels.length === 0) return [...cands];
  return cands.filter((c) => labels.includes(c.label));
}

/** Best first by quality score, ties broken by source order so the result is deterministic. */
export function byScore(cands: readonly Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => b.score - a.score || a.order - b.order);
}

/** Steadiest first: quality score with a penalty for heavy movement (used by the promo style). */
export function bySteadiness(cands: readonly Candidate[]): Candidate[] {
  const steady = (c: Candidate) => c.score - 0.4 * Math.max(0, c.motion - 0.35);
  return [...cands].sort((a, b) => steady(b) - steady(a) || a.order - b.order);
}

/** Chronological order (clip order, then time). */
export function bySource(cands: readonly Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => a.order - b.order);
}

/** True when the shot carries a real label (unknown/other do not count). */
export function isLabelled(c: Candidate): boolean {
  return c.label !== 'unknown' && c.label !== 'other';
}
