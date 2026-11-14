import { describe, expect, it } from 'vitest';
import {
  AppError,
  DEFAULT_SETTINGS,
  RESTRAINED_TRANSITIONS,
  STYLE_IDS,
  computeTimeline,
  normaliseText,
  validateEditPlan,
  type EditPlan,
  type PlanValidationContext,
  type StyleId,
} from '@studio/core';
import { RulesPlanner } from '../src/rules/planner.js';
import type { PlannerInput } from '../src/types.js';
import { TRANSCRIPT_B, clickTrack, clipTaggedProject, labelledProject, plannerInput, untaggedProject } from './fixtures.js';

const planner = new RulesPlanner();

function contextFor(input: PlannerInput, slack = 0.15, restrained = false): PlanValidationContext {
  const transcripts: PlanValidationContext['transcripts'] = {};
  for (const a of input.analyses) if (a.transcript?.segments.length) transcripts[a.assetId] = a.transcript.segments;
  const target = input.targetDurationSec;
  return {
    assets: input.assets,
    music: input.music ? { trackId: input.music.trackId, durationSec: input.music.durationSec } : null,
    transcripts,
    durationBounds: { min: target * (1 - slack), max: target * (1 + slack) },
    restrainedTransitionsOnly: restrained,
  };
}

function planFor(input: PlannerInput): EditPlan {
  return planner.plan(input);
}

const total = (p: EditPlan) => computeTimeline(p).totalDurationSec;
const order = (p: EditPlan) => p.segments.map((s) => `${s.assetId}@${s.inSec.toFixed(2)}`).join('>');
const opening = (p: EditPlan) => `${p.segments[0]!.assetId}@${p.segments[0]!.inSec.toFixed(1)}`;
const playOf = (p: EditPlan, role: string) => p.segments.filter((s) => s.role === role).reduce((n, s) => n + (s.outSec - s.inSec) / s.speed, 0);

describe('RulesPlanner on a labelled project', () => {
  const analyses = labelledProject();
  const plans = new Map<StyleId, EditPlan>();
  for (const styleId of STYLE_IDS) plans.set(styleId, planFor(plannerInput(analyses, { styleId, targetDurationSec: 20 })));

  it.each(STYLE_IDS)('%s passes validation and lands within ±5 %% of the target', (styleId) => {
    const input = plannerInput(analyses, { styleId, targetDurationSec: 20 });
    const plan = plans.get(styleId)!;
    const res = validateEditPlan(plan, contextFor(input));
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(total(plan)).toBeGreaterThanOrEqual(19);
    expect(total(plan)).toBeLessThanOrEqual(21);
    expect(plan.styleId).toBe(styleId);
    expect(plan.output).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(plan.description.length).toBeLessThanOrEqual(280);
    expect(plan.description).toMatch(/second/);
  });

  it('gives five genuinely different edits', () => {
    const all = [...plans.values()];
    expect(new Set(all.map(order)).size).toBe(5);
    expect(new Set(all.map(opening)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(all.map((p) => p.colourPreset)).size).toBeGreaterThanOrEqual(3);
  });

  it('opens and closes each style the way its brief says', () => {
    expect(plans.get('before_after')!.segments[0]!.role).toBe('before');
    expect(plans.get('before_after')!.segments.at(-1)!.role).toBe('result');
    expect(plans.get('cinematic_reveal')!.segments.at(-1)!.role).toBe('result');
    expect(plans.get('process_story')!.segments[0]!.role).toBe('before');
    expect(plans.get('process_story')!.segments.at(-1)!.role).toBe('result');
    const montage = plans.get('beat_montage')!;
    expect(montage.segments[0]!.role).toBe('fade_detail');
    expect(montage.segments.at(-1)!.role).toBe('result');
    expect((montage.segments.at(-1)!.outSec - montage.segments.at(-1)!.inSec) / montage.segments.at(-1)!.speed).toBeGreaterThanOrEqual(1.5);
    for (const s of montage.segments.slice(0, -1)) expect((s.outSec - s.inSec) / s.speed).toBeLessThanOrEqual(1.3);
  });

  it('never reuses the same footage within a plan', () => {
    for (const plan of plans.values()) {
      const res = validateEditPlan(plan, contextFor(plannerInput(analyses, { styleId: plan.styleId, targetDurationSec: 20 })));
      expect(res.warnings.filter((w) => w.code === 'REPEATED_CLIP')).toEqual([]);
    }
  });

  it('keeps text short, honest and non-overlapping', () => {
    for (const plan of plans.values()) {
      for (const o of plan.textOverlays) {
        expect(o.text.length).toBeLessThanOrEqual(40);
        expect(['Before', 'After', 'Fresh cut', 'In the details', 'Ivanhoe Barber Co']).toContain(o.text);
      }
    }
    expect(plans.get('before_after')!.textOverlays.map((o) => o.text).sort()).toEqual(['After', 'Before']);
    expect(plans.get('clean_promo')!.textOverlays[0]!.text).toBe('Ivanhoe Barber Co');
  });

  it('copies captions verbatim from the transcript, only in the process story', () => {
    const story = plans.get('process_story')!;
    expect(story.captions.length).toBeGreaterThan(0);
    const spoken = TRANSCRIPT_B.map((t) => normaliseText(t.text)).join(' ');
    for (const c of story.captions) expect(spoken).toContain(normaliseText(c.text));
    for (const styleId of STYLE_IDS.filter((s) => s !== 'process_story')) expect(plans.get(styleId)!.captions).toEqual([]);
    // Original sound is kept under speech and, with no music, for the whole edit.
    expect(story.audio.originalSound.enabled).toBe(true);
    expect(story.audio.music).toBeNull();
  });

  it('a second take differs from the first for every style', () => {
    for (const styleId of STYLE_IDS) {
      const input = plannerInput(analyses, { styleId, targetDurationSec: 20, attempt: 1 });
      const take2 = planFor(input);
      expect(validateEditPlan(take2, contextFor(input)).ok).toBe(true);
      expect(order(take2)).not.toBe(order(plans.get(styleId)!));
    }
  });

  it('a regenerate never repeats the previous plan', () => {
    const first = plans.get('cinematic_reveal')!;
    const again = planFor(plannerInput(analyses, { styleId: 'cinematic_reveal', targetDurationSec: 20, attempt: 1, previousPlan: first }));
    expect(order(again)).not.toBe(order(first));
  });

  it('is deterministic for the same input', () => {
    const input = plannerInput(analyses, { styleId: 'clean_promo', targetDurationSec: 20 });
    expect(planFor(input)).toEqual(planFor(input));
  });
});

describe('revision hints', () => {
  const analyses = labelledProject();

  it('"make this 15 seconds" changes the length and keeps the earlier choices', () => {
    const v1 = planFor(plannerInput(analyses, { styleId: 'clean_promo', targetDurationSec: 20 }));
    const input = plannerInput(analyses, { styleId: 'clean_promo', targetDurationSec: 20, previousPlan: v1, revisionInstruction: 'Make this 15 seconds' });
    const v2 = planFor(input);
    expect(total(v2)).toBeGreaterThanOrEqual(14.25);
    expect(total(v2)).toBeLessThanOrEqual(15.75);
    expect(v2.targetDurationSec).toBe(15);
    expect(v2.segments[0]!.assetId).toBe(v1.segments[0]!.assetId);
    expect(v2.segments[0]!.id).toBe(v1.segments[0]!.id);
    expect(v2.title).toBe(v1.title);
    expect(validateEditPlan(v2, { ...contextFor(input), durationBounds: { min: 13, max: 17 } }).ok).toBe(true);
  });

  it('"remove the flashy transitions" leaves only fades and dissolves', () => {
    const varied = { ...DEFAULT_SETTINGS.preferences, transitions: 'varied' as const };
    const v1 = planFor(plannerInput(analyses, { styleId: 'before_after', targetDurationSec: 20, preferences: varied }));
    expect(v1.segments.some((s) => s.transitionIn && !RESTRAINED_TRANSITIONS.includes(s.transitionIn.type))).toBe(true);
    const input = plannerInput(analyses, { styleId: 'before_after', targetDurationSec: 20, preferences: varied, previousPlan: v1, revisionInstruction: 'Remove the flashy transitions' });
    const v2 = planFor(input);
    expect(v2.segments.every((s) => !s.transitionIn || RESTRAINED_TRANSITIONS.includes(s.transitionIn.type))).toBe(true);
    expect(validateEditPlan(v2, contextFor(input, 0.15, true)).ok).toBe(true);
  });

  it('"show more of the fade" gives the fade detail more screen time', () => {
    for (const styleId of ['cinematic_reveal', 'clean_promo', 'process_story'] as const) {
      const v1 = planFor(plannerInput(analyses, { styleId, targetDurationSec: 20 }));
      const input = plannerInput(analyses, { styleId, targetDurationSec: 20, previousPlan: v1, revisionInstruction: 'Show more of the fade' });
      const v2 = planFor(input);
      expect(validateEditPlan(v2, contextFor(input)).ok).toBe(true);
      expect(playOf(v2, 'fade_detail')).toBeGreaterThan(playOf(v1, 'fade_detail') + 0.5);
    }
  });

  it('montage revisions are rebuilt on the beat grid at the new length', () => {
    const v1 = planFor(plannerInput(analyses, { styleId: 'beat_montage', targetDurationSec: 20 }));
    const v2 = planFor(plannerInput(analyses, { styleId: 'beat_montage', targetDurationSec: 20, previousPlan: v1, revisionInstruction: 'Make it shorter and faster' }));
    expect(total(v2)).toBeCloseTo(15, 0);
    const avg = (p: EditPlan) => total(p) / p.segments.length;
    expect(avg(v2)).toBeLessThan(avg(v1));
  });

  it('"no text" and "make the music quieter" are applied', () => {
    const music = clickTrack();
    const v1 = planFor(plannerInput(analyses, { styleId: 'cinematic_reveal', targetDurationSec: 20, music }));
    expect(v1.textOverlays.length).toBe(1);
    const v2 = planFor(plannerInput(analyses, { styleId: 'cinematic_reveal', targetDurationSec: 20, music, previousPlan: v1, revisionInstruction: 'No text. Make the music quieter.' }));
    expect(v2.textOverlays).toEqual([]);
    expect(v2.audio.music!.volume).toBeLessThan(v1.audio.music!.volume);
  });

  it('accepts pre-parsed hints and relative lengths', () => {
    const v1 = planFor(plannerInput(analyses, { styleId: 'process_story', targetDurationSec: 20 }));
    const v2 = planFor(
      plannerInput(analyses, {
        styleId: 'process_story',
        targetDurationSec: 20,
        previousPlan: v1,
        revisionHints: { targetDurationSec: -1, emphasiseLabels: [], deemphasiseLabels: [], transitions: 'none', pacing: 'keep', text: 'keep', music: 'keep', originalSound: 'keep', opening: null, unparsed: [] },
      }),
    );
    expect(total(v2)).toBeGreaterThanOrEqual(15 * 0.95);
    expect(total(v2)).toBeLessThanOrEqual(15 * 1.05);
    expect(v2.segments.every((s) => s.transitionIn === null)).toBe(true);
  });
});

describe('footage limits and honesty', () => {
  it('adds no captions when nothing was transcribed', () => {
    const analyses = labelledProject(false);
    for (const styleId of STYLE_IDS) {
      const plan = planFor(plannerInput(analyses, { styleId, targetDurationSec: 20 }));
      expect(plan.captions).toEqual([]);
    }
  });

  it('before and after refuses footage without a "before" shot', () => {
    const analyses = labelledProject().map((a) => ({ ...a, shots: a.shots.map((s) => (s.label === 'before' ? { ...s, label: 'cutting' as const } : s)) }));
    const attempt = () => planFor(plannerInput(analyses, { styleId: 'before_after', targetDurationSec: 20 }));
    expect(attempt).toThrow(AppError);
    expect(attempt).toThrow(/Before/);
  });

  it('untagged footage still gives a valid beat montage and refuses label-dependent styles', () => {
    const analyses = untaggedProject();
    const input = plannerInput(analyses, { styleId: 'beat_montage', targetDurationSec: 12 });
    const plan = planFor(input);
    expect(validateEditPlan(plan, contextFor(input, 0.05)).ok).toBe(true);
    for (const styleId of ['cinematic_reveal', 'before_after', 'clean_promo', 'process_story'] as const) {
      expect(() => planFor(plannerInput(analyses, { styleId, targetDurationSec: 12 }))).toThrow(AppError);
    }
  });

  it('explains when the chosen music is too short for the edit', () => {
    const input = plannerInput(labelledProject(), { styleId: 'beat_montage', targetDurationSec: 30, music: clickTrack(12) });
    expect(() => planFor(input)).toThrow(/shorter than the 30-second edit/);
  });

  it('keeps long edits valid and under the segment limit', () => {
    for (const styleId of STYLE_IDS) {
      const input = plannerInput(labelledProject(), { styleId, targetDurationSec: 45 });
      const plan = planFor(input);
      expect(plan.segments.length).toBeLessThanOrEqual(40);
      expect(validateEditPlan(plan, contextFor(input, 0.05)).ok).toBe(true);
    }
  });

  it('switches original sound off when the owner says never', () => {
    const plan = planFor(plannerInput(labelledProject(), { styleId: 'process_story', targetDurationSec: 20, keepOriginalSound: 'never' }));
    expect(plan.audio.originalSound.enabled).toBe(false);
    expect(plan.segments.every((s) => !s.keepOriginalSound)).toBe(true);
  });

  it('with music keeps the speech of the process story under the track', () => {
    const plan = planFor(plannerInput(labelledProject(), { styleId: 'process_story', targetDurationSec: 20, music: clickTrack() }));
    expect(plan.audio.originalSound.enabled).toBe(false);
    expect(plan.segments.some((s) => s.keepOriginalSound)).toBe(true);
    expect(plan.audio.music?.trackId).toBe('track-1');
  });
});

describe('music and beats', () => {
  const music = clickTrack();

  it('cuts the montage on the beat and keeps the music inside the track', () => {
    const input = plannerInput(labelledProject(), { styleId: 'beat_montage', targetDurationSec: 20, music });
    const plan = planFor(input);
    expect(validateEditPlan(plan, contextFor(input, 0.05)).ok).toBe(true);
    const m = plan.audio.music!;
    expect(m.startOffsetSec + total(plan)).toBeLessThanOrEqual(music.durationSec);
    // The start offset is a beat of the track.
    expect(music.beatTimesSec.some((b) => Math.abs(b - m.startOffsetSec) < 0.01)).toBe(true);
    const cuts = computeTimeline(plan).segments.slice(1).map((p) => p.startSec + p.transitionInSec);
    expect(plan.audio.beatAlignment?.alignedCutTimesSec.length).toBe(cuts.length);
    expect(plan.audio.beatAlignment?.bpm).toBe(120);
  });

  it('lands the before-and-after reveal on a beat', () => {
    const plan = planFor(plannerInput(labelledProject(), { styleId: 'before_after', targetDurationSec: 20, music }));
    const timeline = computeTimeline(plan);
    const reveal = timeline.segments.find((p) => p.index > 0 && p.segment.role === 'result' && p.transitionInSec > 0) ?? timeline.segments.find((p) => p.index > 0 && p.segment.role === 'result')!;
    const revealAt = reveal.startSec + reveal.transitionInSec + plan.audio.music!.startOffsetSec;
    expect(music.beatTimesSec.some((b) => Math.abs(b - revealAt) < 0.05)).toBe(true);
  });

  it('uses a steady 120 BPM grid for the montage without music', () => {
    const plan = planFor(plannerInput(labelledProject(), { styleId: 'beat_montage', targetDurationSec: 20 }));
    for (const p of computeTimeline(plan).segments.slice(1)) {
      const cut = p.startSec + p.transitionInSec;
      expect(Math.abs(cut / 0.5 - Math.round(cut / 0.5))).toBeLessThan(0.02);
    }
    expect(plan.audio.beatAlignment).toBeNull();
  });
});

describe('the worker acceptance footage (clip-level tags)', () => {
  const analyses = clipTaggedProject();
  const plans = STYLE_IDS.map((styleId) => planFor(plannerInput(analyses, { styleId, targetDurationSec: 12 })));

  it('plans all five styles within the worker bounds, all different, without captions', () => {
    for (const plan of plans) {
      const input = plannerInput(analyses, { styleId: plan.styleId, targetDurationSec: 12 });
      expect(validateEditPlan(plan, { ...contextFor(input), durationBounds: { min: 10, max: 14 } }).ok).toBe(true);
      expect(total(plan)).toBeGreaterThanOrEqual(12 * 0.95);
      expect(total(plan)).toBeLessThanOrEqual(12 * 1.05);
      expect(plan.captions).toEqual([]);
      // No music: the original sound keeps the edit from being silent.
      expect(plan.audio.originalSound.enabled).toBe(true);
    }
    expect(new Set(plans.map((p) => p.segments.map((s) => `${s.assetId.slice(0, 4)}@${s.inSec.toFixed(1)}`).join('>'))).size).toBe(5);
    expect(new Set(plans.map((p) => `${p.segments[0]!.assetId}:${p.segments[0]!.inSec.toFixed(1)}:${p.segments.length}`)).size).toBeGreaterThanOrEqual(3);
  });

  it('revises the clean promo to 15 seconds with calm transitions only', () => {
    const v1 = plans.find((p) => p.styleId === 'clean_promo')!;
    const input = plannerInput(analyses, {
      styleId: 'clean_promo',
      targetDurationSec: 15,
      previousPlan: v1,
      revisionInstruction: 'Make this 15 seconds and remove the flashy transitions',
    });
    const v2 = planFor(input);
    expect(total(v2)).toBeGreaterThanOrEqual(13);
    expect(total(v2)).toBeLessThanOrEqual(17);
    expect(v2.segments.every((s) => !s.transitionIn || RESTRAINED_TRANSITIONS.includes(s.transitionIn.type))).toBe(true);
    expect(validateEditPlan(v2, { ...contextFor(input, 0.15, true), durationBounds: { min: 13, max: 17 } }).ok).toBe(true);
  });

  it('honours the abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(planner.planEdit(plannerInput(analyses), { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
