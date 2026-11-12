import type { Shot, ShotQuality } from '@studio/core';
import type { SceneSpan } from './scenes.js';

/** Thresholds (on the normalised 0–1 metrics) above/below which a shot gets a human-readable issue. */
export const SHOT_ISSUE_THRESHOLDS = {
  softFocusBelow: 0.3,
  heavyMotionAbove: 0.6,
} as const;

/** Human-readable flags derived from the quality metrics (shown in the UI and given to the planner). */
export function issuesFromQuality(quality: ShotQuality): string[] {
  const issues: string[] = [];
  if (quality.sharpness < SHOT_ISSUE_THRESHOLDS.softFocusBelow) issues.push('Soft focus');
  if (quality.exposureIssue === 'dark') issues.push('Underexposed');
  if (quality.exposureIssue === 'bright') issues.push('Overexposed');
  if (quality.exposureIssue === 'flat') issues.push('Low contrast');
  if (quality.motion > SHOT_ISSUE_THRESHOLDS.heavyMotionAbove) issues.push('Heavy camera movement');
  return issues;
}

/**
 * Builds the unlabelled Shot records for an asset from its scene spans and per-shot quality (same order).
 * Ids are `${first 8 chars of assetId}-s${index}` with a zero-based index; labels start as 'unknown'
 * from the heuristic source with zero confidence until a vision model or the owner labels them.
 */
export function assembleShots(assetId: string, scenes: SceneSpan[], qualities: ShotQuality[]): Shot[] {
  if (scenes.length !== qualities.length) {
    throw new Error(`assembleShots: ${scenes.length} scenes but ${qualities.length} quality records`);
  }
  const prefix = assetId.slice(0, 8);
  return scenes.map((scene, index) => {
    const quality = qualities[index]!;
    return {
      id: `${prefix}-s${index}`,
      assetId,
      startSec: scene.startSec,
      endSec: scene.endSec,
      quality,
      label: 'unknown',
      labelSource: 'heuristic',
      confidence: 0,
      description: '',
      framing: 'unknown',
      focus: null,
      issues: issuesFromQuality(quality),
    };
  });
}

export interface FrameChoice {
  shotId: string;
  timeSec: number;
}

/**
 * Picks the time of one representative frame (the midpoint) per shot. When there are more shots than
 * `maxFrames`, the shots are split into `maxFrames` consecutive groups and the best-scoring shot of each
 * group is kept, so the chosen frames favour quality while still spanning the whole clip.
 */
export function chooseFrameTimes(shots: Shot[], options: { maxFrames: number }): FrameChoice[] {
  const maxFrames = Math.floor(options.maxFrames);
  if (maxFrames <= 0 || shots.length === 0) return [];
  const ordered = [...shots].sort((a, b) => a.startSec - b.startSec);
  const midpoint = (s: Shot): FrameChoice => ({ shotId: s.id, timeSec: Math.round(((s.startSec + s.endSec) / 2) * 1000) / 1000 });
  if (ordered.length <= maxFrames) return ordered.map(midpoint);
  const chosen: FrameChoice[] = [];
  for (let g = 0; g < maxFrames; g++) {
    const from = Math.floor((g * ordered.length) / maxFrames);
    const to = Math.floor(((g + 1) * ordered.length) / maxFrames);
    let best: Shot | undefined;
    for (let i = from; i < to; i++) {
      const s = ordered[i]!;
      if (!best || s.quality.score > best.quality.score) best = s;
    }
    if (best) chosen.push(midpoint(best));
  }
  return chosen;
}
