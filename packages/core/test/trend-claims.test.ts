import { describe, expect, it } from 'vitest';
import { containsUnsupportedClaim, validateEditPlan, type EditPlan, type PlanValidationContext } from '../src/index.js';

const ctx: PlanValidationContext = {
  assets: [{ id: 'a1', durationSec: 20, hasAudio: true }],
  music: null,
  transcripts: { a1: [{ startSec: 1, endSec: 3, text: 'this cut went viral last week' }] },
  durationBounds: { min: 8, max: 14 },
};

function plan(overlayText: string): EditPlan {
  return {
    version: 1,
    styleId: 'beat_montage',
    title: 'Test',
    description: 'A test plan',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 10,
    segments: [
      { id: 's1', assetId: 'a1', inSec: 0, outSec: 5, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'cutting', keepOriginalSound: true },
      { id: 's2', assetId: 'a1', inSec: 10, outSec: 15, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'result', keepOriginalSound: true },
    ],
    textOverlays: [{ id: 't1', text: overlayText, startSec: 0.5, endSec: 2.5, placement: 'lower', style: 'headline', animation: 'fade', emphasis: 'normal' }],
    captions: [],
    audio: { music: null, originalSound: { enabled: true, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'natural',
  };
}

describe('TEXT_UNSUPPORTED_CLAIM', () => {
  it.each(['Trending fade', 'This cut went VIRAL', 'Goes viral every time', 'Blowing up right now', '#trending skin fade', 'viral!'])('rejects on-screen text "%s"', (text) => {
    const res = validateEditPlan(plan(text), ctx);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('TEXT_UNSUPPORTED_CLAIM');
    expect(res.errors.find((e) => e.code === 'TEXT_UNSUPPORTED_CLAIM')?.path).toBe('textOverlays.0');
  });

  it.each(['Fresh skin fade', 'Before and after', 'Trend-free taper', 'Virtually seamless blend'])('accepts plain on-screen text "%s"', (text) => {
    const res = validateEditPlan(plan(text), ctx);
    expect(res.errors.map((e) => e.code)).not.toContain('TEXT_UNSUPPORTED_CLAIM');
    expect(res.ok).toBe(true);
  });

  it('leaves spoken captions to the transcript check (they are what was really said)', () => {
    const p: EditPlan = { ...plan('Fresh fade'), captions: [{ text: 'this cut went viral', startSec: 3, endSec: 5 }] };
    const res = validateEditPlan(p, ctx);
    expect(res.errors.map((e) => e.code)).not.toContain('TEXT_UNSUPPORTED_CLAIM');
  });

  it('matches whole words only', () => {
    expect(containsUnsupportedClaim('Viral')).toBe(true);
    expect(containsUnsupportedClaim('virality')).toBe(false);
    expect(containsUnsupportedClaim('trendy fade')).toBe(false);
  });
});
