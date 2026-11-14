import { CancelledError } from '@studio/core';
import type { AiCallOptions, LabelShotsInput, LabelShotsResult, ShotLabelResult, VisionLabeler } from '../types.js';

/**
 * Stand-in labeller used when no vision model is configured. It never guesses: every shot stays 'unknown'
 * with zero confidence (so no style is unlocked by a guess, and above all no invented "before" or "reaction"),
 * and it adds no issues of its own, so the quality flags measured during analysis pass through unchanged.
 */
export class HeuristicLabeler implements VisionLabeler {
  readonly name = 'heuristic';
  readonly model = null;

  /** Returns one 'unknown' result per distinct shot in the frames. */
  async labelShots(input: LabelShotsInput, opts: AiCallOptions = {}): Promise<LabelShotsResult> {
    if (opts.signal?.aborted) throw new CancelledError();
    const seen = new Set<string>();
    const results: ShotLabelResult[] = [];
    for (const frame of input.frames) {
      if (seen.has(frame.shotId)) continue;
      seen.add(frame.shotId);
      results.push({ shotId: frame.shotId, label: 'unknown', confidence: 0, description: '', framing: 'unknown', focus: null, issues: [] });
    }
    return { results, usage: null };
  }
}
