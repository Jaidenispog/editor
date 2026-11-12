import { SegmentLabelSchema, type AssetAnalysis, type SegmentLabel } from '@studio/core';

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
