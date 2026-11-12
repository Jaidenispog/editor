import type { EditPlan, Segment } from './edit-plan.js';

export interface PlacedSegment {
  segment: Segment;
  index: number;
  /** Source duration in seconds (outSec - inSec). */
  sourceDurationSec: number;
  /** Duration after the speed change. */
  playDurationSec: number;
  /** Start time on the output timeline (after overlap with the incoming transition). */
  startSec: number;
  endSec: number;
  transitionInSec: number;
}

export interface Timeline {
  segments: PlacedSegment[];
  totalDurationSec: number;
}

export function segmentPlayDuration(seg: Segment): number {
  return (seg.outSec - seg.inSec) / seg.speed;
}

/**
 * Places segments on the output timeline. A transition overlaps the end of the previous
 * segment, so total = sum(play durations) - sum(transition durations).
 */
export function computeTimeline(plan: Pick<EditPlan, 'segments'>): Timeline {
  const placed: PlacedSegment[] = [];
  let cursor = 0;
  plan.segments.forEach((segment, index) => {
    const sourceDurationSec = segment.outSec - segment.inSec;
    const playDurationSec = sourceDurationSec / segment.speed;
    const transitionInSec = index === 0 ? 0 : (segment.transitionIn?.durationSec ?? 0);
    const startSec = Math.max(0, cursor - transitionInSec);
    const endSec = startSec + playDurationSec;
    placed.push({ segment, index, sourceDurationSec, playDurationSec, startSec, endSec, transitionInSec });
    cursor = endSec;
  });
  return { segments: placed, totalDurationSec: round3(cursor) };
}

/** Output-time → source-time mapping helper (used for captions kept with original sound). */
export function outputTimeToSource(placed: PlacedSegment, outputSec: number): number {
  const rel = Math.min(Math.max(outputSec - placed.startSec, 0), placed.playDurationSec);
  return placed.segment.inSec + rel * placed.segment.speed;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
