import { PROCESS_LABELS, STYLES, STYLE_IDS, type SegmentLabel, type StyleId } from './styles.js';
import type { AssetAnalysis, StyleSupport } from './analysis.js';
import { summariseAvailability } from './analysis.js';

const LABEL_NAMES: Record<SegmentLabel, string> = {
  before: 'a "before" shot',
  cutting: 'cutting footage',
  fade_detail: 'fade/line-up detail',
  styling: 'styling footage',
  result: 'a finished-result shot',
  reaction: 'a client reaction',
  environment: 'shop footage',
  other: 'other footage',
  unknown: 'unlabelled footage',
};

/**
 * Decides which of the five styles the footage can honestly support. A style is only offered when
 * every label it needs exists in the analysed shots (manual tags count; "unknown" never does).
 */
export function evaluateStyleSupport(analyses: AssetAnalysis[]): StyleSupport[] {
  const availability = summariseAvailability(analyses);
  const hasLabel = (l: SegmentLabel) => availability.labels[l] > 0;
  return STYLE_IDS.map((styleId: StyleId) => {
    const def = STYLES[styleId];
    const missing: string[] = [];
    for (const group of def.requirement.labelGroups) {
      if (!group.some(hasLabel)) {
        missing.push(group.map((l) => LABEL_NAMES[l]).join(' or '));
      }
    }
    if (availability.usableShots < def.requirement.minUsableShots) {
      missing.push(`${def.requirement.minUsableShots} usable shots (found ${availability.usableShots})`);
    }
    if (missing.length === 0) return { styleId, supported: true, reason: '' };
    const allUnknown =
      analyses.length > 0 && analyses.every((a) => a.shots.every((s) => s.label === 'unknown' || s.label === 'other'));
    const hint = allUnknown
      ? ' Tag your clips (Before, Cutting, Fade detail, Result, Reaction) or configure the vision model so shots can be identified.'
      : '';
    return { styleId, supported: false, reason: `Needs ${missing.join('; ')}.${hint}` };
  });
}

export function processShotCount(analyses: AssetAnalysis[]): number {
  return analyses.reduce((n, a) => n + a.shots.filter((s) => PROCESS_LABELS.includes(s.label)).length, 0);
}
