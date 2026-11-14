import { describe, expect, it } from 'vitest';
import { AudioPatchSchema, applyAudioPatch, isEmptyAudioPatch, needsRecut, originalSoundModeOf, snapToBeatAtOrAfter, withoutMusic, type AudioPatch } from '../src/audio-patch.js';
import type { EditPlan } from '../src/edit-plan.js';
import { validateEditPlan, type PlanValidationContext } from '../src/plan-validation.js';
import { computeTimeline } from '../src/timeline.js';

const BEATS = Array.from({ length: 80 }, (_, i) => Math.round(i * 0.5 * 1000) / 1000);

function plan(): EditPlan {
  const seg = (id: string, assetId: string, inSec: number, outSec: number) => ({
    id,
    assetId,
    inSec,
    outSec,
    speed: 1,
    framing: { mode: 'centre' as const, focusX: 0.5, focusY: 0.5 },
    zoom: null,
    transitionIn: null,
    role: 'cutting' as const,
    keepOriginalSound: false,
  });
  return {
    version: 1,
    styleId: 'clean_promo',
    title: 'Fixture',
    description: 'Fixture plan',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 10,
    segments: [seg('s1', 'a-sound', 0, 3), seg('s2', 'a-silent', 1, 5), seg('s3', 'a-sound', 4, 7)],
    textOverlays: [],
    captions: [],
    audio: {
      music: { trackId: 'm1', startOffsetSec: 4, volume: 0.85, fadeInSec: 0.3, fadeOutSec: 1.2, duckUnderOriginal: true },
      originalSound: { enabled: false, volume: 1 },
      beatAlignment: { bpm: 120, alignedCutTimesSec: [3, 7] },
      loudnessTargetLufs: -14,
    },
    colourPreset: 'clean',
  };
}

const ctx = {
  assets: [
    { id: 'a-sound', durationSec: 10, hasAudio: true },
    { id: 'a-silent', durationSec: 10, hasAudio: false },
  ],
  music: { trackId: 'm1', durationSec: 40, beatTimesSec: BEATS },
};
const vctx: PlanValidationContext = { assets: ctx.assets, music: { trackId: 'm1', durationSec: 40 }, transcripts: {}, durationBounds: { min: 8, max: 12 } };
const patch = (p: Partial<AudioPatch>) => AudioPatchSchema.parse(p);

describe('needsRecut', () => {
  it.each([
    [{}, false],
    [{ volume: 0.4 }, false],
    [{ music: 'none' as const }, false],
    [{ startSec: 12 }, false],
    [{ startSec: 12, keepCuts: false }, true],
    [{ trackId: 't2' }, true],
    [{ beatSync: 'off' as const }, true],
    [{ revealOnBeat: 'on' as const }, true],
    [{ originalSound: 'only' as const }, false],
  ])('%j → %s', (p, expected) => {
    expect(needsRecut(patch(p))).toBe(expected);
  });

  it('knows an empty patch', () => {
    expect(isEmptyAudioPatch(patch({}))).toBe(true);
    expect(isEmptyAudioPatch(patch({ volume: 0.5 }))).toBe(false);
  });
});

describe('applyAudioPatch', () => {
  it('changes volume and fades without touching the cuts, and the plan stays valid', () => {
    const before = plan();
    const res = applyAudioPatch(before, patch({ volume: 0.5, fadeInSec: 1, fadeOutSec: 2.5, duckUnderOriginal: false }), ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.audio.music).toMatchObject({ volume: 0.5, fadeInSec: 1, fadeOutSec: 2.5, duckUnderOriginal: false, startOffsetSec: 4 });
    expect(res.plan.segments).toEqual(before.segments);
    expect(before.audio.music?.volume).toBe(0.85);
    expect(validateEditPlan(res.plan, vctx).ok).toBe(true);
  });

  it('removes the music', () => {
    const res = applyAudioPatch(plan(), patch({ music: 'none' }), ctx);
    expect(res.ok && res.plan.audio.music).toBeNull();
    if (res.ok) expect(validateEditPlan(res.plan, vctx).ok).toBe(true);
  });

  it('shifts the song section to the next beat and keeps the cuts', () => {
    const res = applyAudioPatch(plan(), patch({ startSec: 12.2 }), ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.audio.music?.startOffsetSec).toBe(12.5);
    expect(res.plan.audio.beatAlignment).toBeNull();
    expect(validateEditPlan(res.plan, vctx).ok).toBe(true);
  });

  it('refuses a song start that runs past the end of the track', () => {
    const res = applyAudioPatch(plan(), patch({ startSec: 35 }), ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/track ends before the edit does/);
    // The validator would refuse the same plan.
    const shifted = plan();
    shifted.audio.music!.startOffsetSec = 35;
    expect(validateEditPlan(shifted, vctx).errors.map((e) => e.code)).toContain('MUSIC_TOO_SHORT');
  });

  it('keeps the original sound only on clips that have sound', () => {
    const under = applyAudioPatch(plan(), patch({ originalSound: 'under_music', originalVolume: 0.6 }), ctx);
    expect(under.ok).toBe(true);
    if (!under.ok) return;
    expect(under.plan.audio.originalSound).toEqual({ enabled: true, volume: 0.6 });
    expect(under.plan.segments.map((s) => s.keepOriginalSound)).toEqual([true, false, true]);
    expect(under.plan.audio.music).not.toBeNull();
    expect(originalSoundModeOf(under.plan)).toBe('under_music');
    const v = validateEditPlan(under.plan, vctx);
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).not.toContain('NO_SOURCE_AUDIO');

    const only = applyAudioPatch(plan(), patch({ originalSound: 'only' }), ctx);
    expect(only.ok && only.plan.audio.music).toBeNull();
    if (only.ok) expect(originalSoundModeOf(only.plan)).toBe('only');

    const off = applyAudioPatch(under.plan, patch({ originalSound: 'off' }), ctx);
    expect(off.ok && off.plan.segments.every((s) => !s.keepOriginalSound) && !off.plan.audio.originalSound.enabled).toBe(true);
  });

  it('refuses original sound when no clip in the edit has sound', () => {
    const silent = { ...ctx, assets: ctx.assets.map((a) => ({ ...a, hasAudio: false })) };
    const res = applyAudioPatch(plan(), patch({ originalSound: 'only' }), silent);
    expect(res.ok).toBe(false);
  });

  it('refuses re-cut changes and music changes on a plan without music', () => {
    expect(applyAudioPatch(plan(), patch({ trackId: 'm2' }), ctx).ok).toBe(false);
    const noMusic = withoutMusic(plan());
    expect(applyAudioPatch(noMusic, patch({ volume: 0.3 }), ctx).ok).toBe(false);
  });
});

describe('withoutMusic (the no_music export variant)', () => {
  it('removes only the music, so a valid plan stays valid with the same cuts and length', () => {
    const p = plan();
    const nm = withoutMusic(p);
    expect(nm.audio.music).toBeNull();
    expect(nm.segments).toEqual(p.segments);
    expect(nm.textOverlays).toEqual(p.textOverlays);
    expect(nm.colourPreset).toBe(p.colourPreset);
    expect(computeTimeline(nm).totalDurationSec).toBe(computeTimeline(p).totalDurationSec);
    expect(validateEditPlan(nm, { ...vctx, music: null }).ok).toBe(true);
    expect(p.audio.music).not.toBeNull();
  });

  it('snaps to the first beat at or after a time', () => {
    expect(snapToBeatAtOrAfter([0, 0.5, 1], 0.2)).toBe(0.5);
    expect(snapToBeatAtOrAfter([0, 0.5, 1], 5)).toBe(1);
    expect(snapToBeatAtOrAfter([], 3.21)).toBe(3.21);
  });
});
