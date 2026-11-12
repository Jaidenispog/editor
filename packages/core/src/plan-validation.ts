import { EditPlanSchema, type EditPlan } from './edit-plan.js';
import { computeTimeline, type Timeline } from './timeline.js';
import { RESTRAINED_TRANSITIONS, getStyle } from './styles.js';
import type { TranscriptSegment } from './analysis.js';

export interface PlanAssetInfo {
  id: string;
  durationSec: number;
  hasAudio: boolean;
}

export interface PlanMusicInfo {
  trackId: string;
  durationSec: number;
}

export interface PlanValidationContext {
  assets: PlanAssetInfo[];
  music: PlanMusicInfo | null;
  /** Transcript segments across all assets, keyed by asset id. Required for captions to be allowed. */
  transcripts: Record<string, TranscriptSegment[]>;
  /** Allowed total duration window (seconds). */
  durationBounds: { min: number; max: number };
  /** When true, flashy transitions are reported as errors (e.g. after "remove the flashy transitions"). */
  restrainedTransitionsOnly?: boolean;
}

export interface PlanIssue {
  code: string;
  message: string;
  path?: string;
}

export interface PlanValidationResult {
  ok: boolean;
  plan: EditPlan | null;
  timeline: Timeline | null;
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

export const MIN_SEGMENT_PLAY_SEC = 0.3;
const MIN_GAP_AROUND_TRANSITIONS_SEC = 0.15;

export function normaliseText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates an edit plan against the real footage. The renderer must only ever receive a plan
 * that passed this check, so every bound the FFmpeg graph depends on is enforced here.
 */
export function validateEditPlan(input: unknown, ctx: PlanValidationContext): PlanValidationResult {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];

  const parsed = EditPlanSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ code: 'SCHEMA', message: issue.message, path: issue.path.map(String).join('.') });
    }
    return { ok: false, plan: null, timeline: null, errors, warnings };
  }
  const plan = parsed.data;
  const assetsById = new Map(ctx.assets.map((a) => [a.id, a]));
  const style = getStyle(plan.styleId);

  // --- segments against source bounds
  const seenIds = new Set<string>();
  const usedRanges: { assetId: string; inSec: number; outSec: number; idx: number }[] = [];
  plan.segments.forEach((seg, idx) => {
    const p = `segments.${idx}`;
    if (seenIds.has(seg.id)) errors.push({ code: 'DUPLICATE_SEGMENT_ID', message: `Segment id "${seg.id}" is used twice`, path: p });
    seenIds.add(seg.id);
    const asset = assetsById.get(seg.assetId);
    if (!asset) {
      errors.push({ code: 'UNKNOWN_ASSET', message: `Segment refers to unknown asset ${seg.assetId}`, path: p });
      return;
    }
    if (seg.outSec <= seg.inSec) {
      errors.push({ code: 'EMPTY_RANGE', message: `Segment ${seg.id} ends before it starts`, path: p });
    }
    const tolerance = 0.02;
    if (seg.outSec > asset.durationSec + tolerance) {
      errors.push({
        code: 'OUT_OF_BOUNDS',
        message: `Segment ${seg.id} ends at ${seg.outSec.toFixed(2)}s but the clip is only ${asset.durationSec.toFixed(2)}s long`,
        path: p,
      });
    }
    const play = (seg.outSec - seg.inSec) / seg.speed;
    if (play < MIN_SEGMENT_PLAY_SEC) {
      errors.push({ code: 'SEGMENT_TOO_SHORT', message: `Segment ${seg.id} plays for ${play.toFixed(2)}s (minimum ${MIN_SEGMENT_PLAY_SEC}s)`, path: p });
    }
    if (idx === 0 && seg.transitionIn) {
      errors.push({ code: 'FIRST_TRANSITION', message: 'The first segment cannot have an incoming transition', path: p });
    }
    if (seg.keepOriginalSound && !asset.hasAudio) {
      warnings.push({ code: 'NO_SOURCE_AUDIO', message: `Segment ${seg.id} asks to keep original sound but the clip has no audio track`, path: p });
    }
    if (seg.transitionIn && ctx.restrainedTransitionsOnly && !RESTRAINED_TRANSITIONS.includes(seg.transitionIn.type)) {
      errors.push({ code: 'FLASHY_TRANSITION', message: `Transition "${seg.transitionIn.type}" is not allowed for this edit`, path: p });
    }
    if (seg.transitionIn && !style.transitions.includes(seg.transitionIn.type)) {
      warnings.push({ code: 'OFF_STYLE_TRANSITION', message: `Transition "${seg.transitionIn.type}" is unusual for the ${style.name} style`, path: p });
    }
    for (const r of usedRanges) {
      if (r.assetId !== seg.assetId) continue;
      const overlap = Math.min(r.outSec, seg.outSec) - Math.max(r.inSec, seg.inSec);
      const shorter = Math.min(r.outSec - r.inSec, seg.outSec - seg.inSec);
      if (overlap > 0 && shorter > 0 && overlap / shorter > 0.6) {
        warnings.push({ code: 'REPEATED_CLIP', message: `Segments ${plan.segments[r.idx]?.id} and ${seg.id} reuse mostly the same footage`, path: p });
      }
    }
    usedRanges.push({ assetId: seg.assetId, inSec: seg.inSec, outSec: seg.outSec, idx });
  });

  // --- transitions must fit inside neighbouring segments
  for (let i = 1; i < plan.segments.length; i++) {
    const seg = plan.segments[i]!;
    const prev = plan.segments[i - 1]!;
    const t = seg.transitionIn?.durationSec ?? 0;
    if (t <= 0) continue;
    const prevPlay = (prev.outSec - prev.inSec) / prev.speed;
    const curPlay = (seg.outSec - seg.inSec) / seg.speed;
    const prevIn = i >= 2 ? (prev.transitionIn?.durationSec ?? 0) : 0;
    const nextIn = plan.segments[i + 1]?.transitionIn?.durationSec ?? 0;
    if (prevPlay < t + prevIn + MIN_GAP_AROUND_TRANSITIONS_SEC) {
      errors.push({ code: 'TRANSITION_TOO_LONG', message: `Transition into ${seg.id} (${t}s) is longer than the previous segment allows`, path: `segments.${i}.transitionIn` });
    }
    if (curPlay < t + nextIn + MIN_GAP_AROUND_TRANSITIONS_SEC) {
      errors.push({ code: 'TRANSITION_TOO_LONG', message: `Transition into ${seg.id} (${t}s) is longer than the segment itself allows`, path: `segments.${i}.transitionIn` });
    }
  }

  const timeline = errors.length === 0 ? computeTimeline(plan) : null;

  if (timeline) {
    const total = timeline.totalDurationSec;
    if (total < ctx.durationBounds.min - 0.05 || total > ctx.durationBounds.max + 0.05) {
      errors.push({
        code: 'DURATION_OUT_OF_RANGE',
        message: `Edit runs ${total.toFixed(1)}s; it must be between ${ctx.durationBounds.min.toFixed(0)}s and ${ctx.durationBounds.max.toFixed(0)}s`,
      });
    }
    if (Math.abs(total - plan.targetDurationSec) > Math.max(2, plan.targetDurationSec * 0.2)) {
      warnings.push({ code: 'TARGET_DRIFT', message: `Edit runs ${total.toFixed(1)}s against a ${plan.targetDurationSec}s target` });
    }
    if (plan.segments.length < style.requirement.minUsableShots) {
      warnings.push({ code: 'FEW_SEGMENTS', message: `${style.name} normally uses at least ${style.requirement.minUsableShots} shots` });
    }

    const byPlacement = new Map<string, { start: number; end: number; id: string }[]>();
    plan.textOverlays.forEach((t, idx) => {
      const p = `textOverlays.${idx}`;
      if (t.endSec <= t.startSec) errors.push({ code: 'TEXT_EMPTY_RANGE', message: `Text "${t.text}" ends before it starts`, path: p });
      if (t.endSec > total + 0.05) errors.push({ code: 'TEXT_OUT_OF_RANGE', message: `Text "${t.text}" runs past the end of the edit`, path: p });
      if (t.endSec - t.startSec < 0.6) warnings.push({ code: 'TEXT_TOO_BRIEF', message: `Text "${t.text}" shows for under 0.6s`, path: p });
      const list = byPlacement.get(t.placement) ?? [];
      for (const o of list) {
        if (t.startSec < o.end && o.start < t.endSec) {
          errors.push({ code: 'TEXT_OVERLAP', message: `Text "${t.text}" overlaps "${o.id}" in the same position`, path: p });
        }
      }
      list.push({ start: t.startSec, end: t.endSec, id: t.text });
      byPlacement.set(t.placement, list);
    });

    const transcriptText = normaliseText(
      Object.values(ctx.transcripts)
        .flat()
        .map((s) => s.text)
        .join(' '),
    );
    plan.captions.forEach((c, idx) => {
      const p = `captions.${idx}`;
      if (!transcriptText) {
        errors.push({ code: 'CAPTION_WITHOUT_TRANSCRIPT', message: 'Captions were added but no speech was transcribed in this footage', path: p });
        return;
      }
      const n = normaliseText(c.text);
      if (n.length > 0 && !transcriptText.includes(n)) {
        errors.push({ code: 'CAPTION_NOT_IN_TRANSCRIPT', message: `Caption "${c.text}" does not appear in the transcript`, path: p });
      }
      if (c.endSec <= c.startSec) errors.push({ code: 'CAPTION_EMPTY_RANGE', message: `Caption "${c.text}" ends before it starts`, path: p });
      if (c.endSec > total + 0.05) errors.push({ code: 'CAPTION_OUT_OF_RANGE', message: `Caption "${c.text}" runs past the end of the edit`, path: p });
      const prev = plan.captions[idx - 1];
      if (prev && c.startSec < prev.endSec - 0.01) errors.push({ code: 'CAPTION_OVERLAP', message: `Caption "${c.text}" overlaps the previous caption`, path: p });
    });

    if (plan.audio.music) {
      const m = plan.audio.music;
      if (!ctx.music || ctx.music.trackId !== m.trackId) {
        errors.push({ code: 'UNKNOWN_TRACK', message: `Music track ${m.trackId} is not available to this project`, path: 'audio.music' });
      } else if (m.startOffsetSec + total > ctx.music.durationSec + 0.05) {
        errors.push({
          code: 'MUSIC_TOO_SHORT',
          message: `Music starts at ${m.startOffsetSec.toFixed(1)}s and the track (${ctx.music.durationSec.toFixed(1)}s) ends before the edit does`,
          path: 'audio.music',
        });
      }
    }
    const anyOriginal = plan.audio.originalSound.enabled || plan.segments.some((s) => s.keepOriginalSound);
    if (!plan.audio.music && !anyOriginal) {
      warnings.push({ code: 'SILENT_EDIT', message: 'This edit has no music and no original sound; it will export silent' });
    }
  }

  return { ok: errors.length === 0, plan: errors.length === 0 ? plan : null, timeline, errors, warnings };
}
