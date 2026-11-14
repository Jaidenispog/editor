import { SegmentLabelSchema, type SegmentLabel } from './styles.js';
import type { AssetAnalysis } from './analysis.js';
import { evaluateStyleSupport } from './style-support.js';
import type { StyleSupport } from './analysis.js';

export interface ManualLabelSource {
  clipLabel: string | null;
  manualLabels: Record<string, string>;
}

/** Owner tags always win over model/heuristic labels: per-shot tags first, then a whole-clip tag. */
export function applyManualLabels(analysis: AssetAnalysis, source: ManualLabelSource): AssetAnalysis {
  const clipLabel = parseLabel(source.clipLabel);
  const shots = analysis.shots.map((shot) => {
    const perShot = parseLabel(source.manualLabels[shot.id] ?? null);
    const label = perShot ?? clipLabel;
    if (!label) return shot;
    return { ...shot, label, labelSource: 'manual' as const, confidence: 1 };
  });
  return { ...analysis, shots };
}

function parseLabel(value: string | null): SegmentLabel | null {
  if (!value) return null;
  const parsed = SegmentLabelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Style support for a set of clips after applying each clip's manual tags (used by the web app and the worker). */
export function styleSupportWithManualLabels(clips: Array<{ analysis: AssetAnalysis; clipLabel: string | null; manualLabels: Record<string, string> }>): StyleSupport[] | null {
  if (clips.length === 0) return null;
  return evaluateStyleSupport(clips.map((c) => applyManualLabels(c.analysis, { clipLabel: c.clipLabel, manualLabels: c.manualLabels })));
}
