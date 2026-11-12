import { describe, expect, it } from 'vitest';
import { validateEditPlan, type PlanValidationContext } from '../src/plan-validation.js';
import { computeTimeline } from '../src/timeline.js';
import type { EditPlan } from '../src/edit-plan.js';

const ctx: PlanValidationContext = {
  assets: [
    { id: 'a1', durationSec: 20, hasAudio: true },
    { id: 'a2', durationSec: 12, hasAudio: false },
  ],
  music: { trackId: 'm1', durationSec: 60 },
  transcripts: { a1: [{ startSec: 1, endSec: 3, text: 'Clean skin fade today' }] },
  durationBounds: { min: 8, max: 14 },
};

function basePlan(): EditPlan {
  return {
    version: 1,
    styleId: 'beat_montage',
    title: 'Test',
    description: 'A test plan',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 10,
    segments: [
      { id: 's1', assetId: 'a1', inSec: 0, outSec: 4, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'cutting', keepOriginalSound: false },
      { id: 's2', assetId: 'a2', inSec: 2, outSec: 6, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: { from: 1, to: 1.1 }, transitionIn: { type: 'fade', durationSec: 0.5 }, role: 'fade_detail', keepOriginalSound: false },
      { id: 's3', assetId: 'a1', inSec: 10, outSec: 13, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'result', keepOriginalSound: false },
    ],
    textOverlays: [{ id: 't1', text: 'Fresh fade', startSec: 0.5, endSec: 2.5, placement: 'lower', style: 'headline', animation: 'fade', emphasis: 'normal' }],
    captions: [],
    audio: { music: { trackId: 'm1', startOffsetSec: 5, volume: 0.8, fadeInSec: 0.3, fadeOutSec: 1, duckUnderOriginal: true }, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'natural',
  };
}

describe('computeTimeline', () => {
  it('overlaps transitions and sums durations', () => {
    const tl = computeTimeline(basePlan());
    // 4 + 4 + 3 - 0.5 transition = 10.5
    expect(tl.totalDurationSec).toBeCloseTo(10.5, 3);
    expect(tl.segments[1]!.startSec).toBeCloseTo(3.5, 3);
    expect(tl.segments[2]!.startSec).toBeCloseTo(7.5, 3);
  });
  it('accounts for speed changes', () => {
    const plan = basePlan();
    plan.segments[0]!.speed = 2;
    const tl = computeTimeline(plan);
    expect(tl.segments[0]!.playDurationSec).toBeCloseTo(2, 3);
  });
});

describe('validateEditPlan', () => {
  it('accepts a sound plan', () => {
    const res = validateEditPlan(basePlan(), ctx);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.timeline?.totalDurationSec).toBeCloseTo(10.5, 3);
  });
  it('rejects segments beyond the clip length', () => {
    const plan = basePlan();
    plan.segments[2]!.outSec = 25;
    const res = validateEditPlan(plan, ctx);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('OUT_OF_BOUNDS');
  });
  it('rejects unknown assets and tracks', () => {
    const plan = basePlan();
    plan.segments[0]!.assetId = 'nope';
    plan.audio.music!.trackId = 'other';
    const res = validateEditPlan(plan, ctx);
    const codes = res.errors.map((e) => e.code);
    expect(codes).toContain('UNKNOWN_ASSET');
  });
  it('rejects music that ends before the edit does', () => {
    const plan = basePlan();
    plan.audio.music!.startOffsetSec = 55;
    const res = validateEditPlan(plan, ctx);
    expect(res.errors.map((e) => e.code)).toContain('MUSIC_TOO_SHORT');
  });
  it('rejects durations outside the allowed window', () => {
    const plan = basePlan();
    plan.segments[2]!.outSec = 19; // total 16.5
    const res = validateEditPlan(plan, ctx);
    expect(res.errors.map((e) => e.code)).toContain('DURATION_OUT_OF_RANGE');
  });
  it('rejects transitions longer than their neighbours allow', () => {
    const plan = basePlan();
    plan.segments[1]!.transitionIn = { type: 'fade', durationSec: 1.5 };
    plan.segments[1]!.outSec = 3.4; // 1.4s segment
    const res = validateEditPlan(plan, ctx);
    expect(res.errors.map((e) => e.code)).toContain('TRANSITION_TOO_LONG');
  });
  it('rejects invented captions and accepts transcript captions', () => {
    const plan = basePlan();
    plan.captions = [{ text: 'Best barber in Melbourne', startSec: 1, endSec: 2 }];
    expect(validateEditPlan(plan, ctx).errors.map((e) => e.code)).toContain('CAPTION_NOT_IN_TRANSCRIPT');
    plan.captions = [{ text: 'clean skin fade', startSec: 1, endSec: 2 }];
    expect(validateEditPlan(plan, ctx).ok).toBe(true);
    const noSpeech = { ...ctx, transcripts: {} };
    expect(validateEditPlan(plan, noSpeech).errors.map((e) => e.code)).toContain('CAPTION_WITHOUT_TRANSCRIPT');
  });
  it('rejects overlapping text in the same placement and text past the end', () => {
    const plan = basePlan();
    plan.textOverlays.push({ id: 't2', text: 'Another', startSec: 1, endSec: 3, placement: 'lower', style: 'label', animation: 'none', emphasis: 'normal' });
    plan.textOverlays.push({ id: 't3', text: 'Late', startSec: 9, endSec: 12, placement: 'top', style: 'label', animation: 'none', emphasis: 'normal' });
    const codes = validateEditPlan(plan, ctx).errors.map((e) => e.code);
    expect(codes).toContain('TEXT_OVERLAP');
    expect(codes).toContain('TEXT_OUT_OF_RANGE');
  });
  it('flags flashy transitions when restrained mode is requested', () => {
    const plan = basePlan();
    plan.segments[1]!.transitionIn = { type: 'wipeleft', durationSec: 0.4 };
    const res = validateEditPlan(plan, { ...ctx, restrainedTransitionsOnly: true });
    expect(res.errors.map((e) => e.code)).toContain('FLASHY_TRANSITION');
  });
  it('rejects malformed input with schema errors', () => {
    const res = validateEditPlan({ version: 1, styleId: 'nope' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe('SCHEMA');
  });
  it('warns about repeated footage and silent edits', () => {
    const plan = basePlan();
    plan.segments[2] = { ...plan.segments[0]!, id: 's3', inSec: 0.5, outSec: 3.5 };
    plan.audio.music = null;
    const res = validateEditPlan(plan, ctx);
    const warn = res.warnings.map((w) => w.code);
    expect(warn).toContain('REPEATED_CLIP');
    expect(warn).toContain('SILENT_EDIT');
  });
});
