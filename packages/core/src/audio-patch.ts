import { z } from 'zod';
import type { EditPlan } from './edit-plan.js';
import type { PlanAssetInfo } from './plan-validation.js';
import { formatSeconds } from './time.js';
import { computeTimeline } from './timeline.js';

/**
 * A Sound panel change to one version (preferences/music design §4.9). Fields left out keep the current value.
 * Changes that only touch the audio take the fast path (`applyAudioPatch`, same cuts); a new track, beat options or
 * a new song section with "Re-cut to this section" go back to the planner (see {@link needsRecut}).
 */
export const AudioPatchSchema = z.object({
  /** `none` removes the music (a new version without music). */
  music: z.enum(['keep', 'none']).default('keep'),
  /** Another library track: always a re-cut. */
  trackId: z.string().min(1).max(100).optional(),
  /** Where the song section starts, seconds into the track. */
  startSec: z.number().min(0).max(3600).nullable().optional(),
  /** With `startSec`: true keeps the cuts and shifts the music; false re-cuts to the new section. */
  keepCuts: z.boolean().default(true),
  beatSync: z.enum(['keep', 'on', 'off']).default('keep'),
  revealOnBeat: z.enum(['keep', 'on', 'off']).default('keep'),
  volume: z.number().min(0).max(1).optional(),
  fadeInSec: z.number().min(0).max(3).optional(),
  fadeOutSec: z.number().min(0).max(4).optional(),
  duckUnderOriginal: z.boolean().optional(),
  originalSound: z.enum(['keep', 'off', 'under_music', 'only']).default('keep'),
  originalVolume: z.number().min(0).max(1).optional(),
});
export type AudioPatch = z.infer<typeof AudioPatchSchema>;

/** True when the patch changes the cuts (new track, beat options, or a new section that should be re-cut). */
export function needsRecut(patch: AudioPatch): boolean {
  return patch.trackId !== undefined || patch.beatSync !== 'keep' || patch.revealOnBeat !== 'keep' || (patch.startSec != null && !patch.keepCuts);
}

/** True when the patch changes nothing at all. */
export function isEmptyAudioPatch(patch: AudioPatch): boolean {
  return (
    patch.music === 'keep' &&
    patch.trackId === undefined &&
    patch.startSec == null &&
    patch.beatSync === 'keep' &&
    patch.revealOnBeat === 'keep' &&
    patch.volume === undefined &&
    patch.fadeInSec === undefined &&
    patch.fadeOutSec === undefined &&
    patch.duckUnderOriginal === undefined &&
    patch.originalSound === 'keep' &&
    patch.originalVolume === undefined
  );
}

/** Facts the fast path needs: which clips have sound, and the track's length and beats. */
export interface AudioPatchContext {
  assets: PlanAssetInfo[];
  /** The plan's current track (null when the plan has no music or the track is gone). */
  music: { trackId: string; durationSec: number; beatTimesSec: number[] } | null;
}

export type AudioPatchResult = { ok: true; plan: EditPlan } | { ok: false; message: string };

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The first beat at or after `startSec` (the last beat when it is past every beat); the time itself without beats. */
export function snapToBeatAtOrAfter(beatTimesSec: readonly number[], startSec: number): number {
  const beats = beatTimesSec.filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  if (beats.length === 0) return round3(Math.max(0, startSec));
  const after = beats.find((t) => t >= startSec - 0.001);
  return round3(after ?? beats[beats.length - 1]!);
}

/**
 * The Sound panel's fast path: changes the music volume, fades, ducking, song start (snapped to a beat) and the
 * original sound without touching the cuts. Returns a new plan, which the caller must still pass through
 * `validateEditPlan` before rendering, or a plain reason the change cannot be made. Never re-cuts: a patch that
 * {@link needsRecut} is refused here.
 */
export function applyAudioPatch(plan: EditPlan, patch: AudioPatch, ctx: AudioPatchContext): AudioPatchResult {
  if (needsRecut(patch)) return { ok: false, message: 'This change needs the edit to be re-cut to the music.' };
  const next: EditPlan = structuredClone(plan);
  const audioById = new Map(ctx.assets.map((a) => [a.id, a.hasAudio]));
  const anyClipAudio = next.segments.some((s) => audioById.get(s.assetId) === true);

  const removeMusic = patch.music === 'none' || patch.originalSound === 'only';
  if (removeMusic) {
    next.audio.music = null;
    next.audio.beatAlignment = null;
  } else if (next.audio.music) {
    const m = next.audio.music;
    if (patch.volume !== undefined) m.volume = round3(patch.volume);
    if (patch.fadeInSec !== undefined) m.fadeInSec = round3(patch.fadeInSec);
    if (patch.fadeOutSec !== undefined) m.fadeOutSec = round3(patch.fadeOutSec);
    if (patch.duckUnderOriginal !== undefined) m.duckUnderOriginal = patch.duckUnderOriginal;
    if (patch.startSec != null) {
      if (!ctx.music || ctx.music.trackId !== m.trackId) return { ok: false, message: 'The music track for this version is no longer available.' };
      const start = snapToBeatAtOrAfter(ctx.music.beatTimesSec, patch.startSec);
      const total = computeTimeline(next).totalDurationSec;
      if (start + total > ctx.music.durationSec + 0.05) {
        return {
          ok: false,
          message: `If the music starts at ${formatSeconds(start)}, the track ends before the edit does. Choose an earlier part of the song.`,
        };
      }
      m.startOffsetSec = start;
      // The cuts stay where they were, so they no longer follow this section's beats.
      next.audio.beatAlignment = null;
    }
  } else if (patch.startSec != null || patch.volume !== undefined || patch.fadeInSec !== undefined || patch.fadeOutSec !== undefined) {
    return { ok: false, message: 'This version has no music to change. Choose a track to re-cut it to the music.' };
  }

  switch (patch.originalSound) {
    case 'off':
      next.audio.originalSound.enabled = false;
      for (const s of next.segments) s.keepOriginalSound = false;
      break;
    case 'under_music':
    case 'only':
      if (!anyClipAudio) return { ok: false, message: "None of the clips in this edit has its own sound, so there's no original sound to keep." };
      next.audio.originalSound.enabled = true;
      if (patch.originalVolume !== undefined) next.audio.originalSound.volume = round3(patch.originalVolume);
      else if (next.audio.originalSound.volume <= 0) next.audio.originalSound.volume = 1;
      for (const s of next.segments) s.keepOriginalSound = audioById.get(s.assetId) === true;
      break;
    case 'keep':
      if (patch.originalVolume !== undefined) next.audio.originalSound.volume = round3(patch.originalVolume);
      break;
  }
  return { ok: true, plan: next };
}

/** What the Sound panel shows for a plan's original sound. */
export function originalSoundModeOf(plan: EditPlan): 'off' | 'under_music' | 'only' {
  const on = plan.audio.originalSound.volume > 0 && (plan.audio.originalSound.enabled || plan.segments.some((s) => s.keepOriginalSound));
  if (!on) return 'off';
  return plan.audio.music ? 'under_music' : 'only';
}

/** The same plan with its music removed (the `no_music` export variant). Cuts, text and colour are unchanged. */
export function withoutMusic(plan: EditPlan): EditPlan {
  const next: EditPlan = structuredClone(plan);
  next.audio.music = null;
  next.audio.beatAlignment = null;
  return next;
}
