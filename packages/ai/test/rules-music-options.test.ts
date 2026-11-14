import { describe, expect, it } from 'vitest';
import { STYLE_IDS, computeTimeline, validateEditPlan, type EditPlan, type PlanValidationContext } from '@studio/core';
import { RulesPlanner } from '../src/rules/planner.js';
import { buildPlannerUserContent } from '../src/anthropic/prompts.js';
import type { PlannerInput } from '../src/types.js';
import { labelledProject, plannerInput } from './fixtures.js';

const planner = new RulesPlanner();

/** A slow track (75 BPM, beats every 0.8 s, offset) so "within ±0.25 s of a beat" is a real test. */
function slowTrack(durationSec = 60): NonNullable<PlannerInput['music']> {
  const beats: number[] = [];
  for (let t = 0.37; t < durationSec; t += 0.8) beats.push(Math.round(t * 1000) / 1000);
  return { trackId: 'slow-1', durationSec, bpm: 75, beatTimesSec: beats, title: 'Slow click 75' };
}

function contextFor(input: PlannerInput): PlanValidationContext {
  const transcripts: PlanValidationContext['transcripts'] = {};
  for (const a of input.analyses) if (a.transcript?.segments.length) transcripts[a.assetId] = a.transcript.segments;
  const target = input.targetDurationSec;
  return { assets: input.assets, music: input.music ? { trackId: input.music.trackId, durationSec: input.music.durationSec } : null, transcripts, durationBounds: { min: target * 0.85, max: target * 1.15 } };
}

/** Distance from output time t to the nearest beat of the track as it plays in the plan. */
function distanceToBeat(plan: EditPlan, music: NonNullable<PlannerInput['music']>, t: number): number {
  const offset = plan.audio.music!.startOffsetSec;
  return Math.min(...music.beatTimesSec.map((b) => Math.abs(b - offset - t)));
}

/** Output times at which each segment is fully on screen (cut or end of its incoming transition). */
function cutTimes(plan: EditPlan): number[] {
  return computeTimeline(plan)
    .segments.filter((p) => p.index > 0)
    .map((p) => p.startSec + (p.segment.transitionIn?.durationSec ?? 0));
}

describe('beat options in the rules planner', () => {
  const music = slowTrack();

  it('"Cut to the beat: Off" builds natural shot lengths with no beat snapping', () => {
    for (const styleId of ['before_after', 'cinematic_reveal', 'clean_promo', 'process_story'] as const) {
      const input = plannerInput(labelledProject(), { styleId, targetDurationSec: 20, music, beatSync: 'off', revealOnBeat: false });
      const plan = planner.plan(input);
      expect(validateEditPlan(plan, contextFor(input)).ok).toBe(true);
      // No beat alignment is claimed and the reveal nudge did not run.
      expect(plan.audio.beatAlignment).toBeNull();
      expect(plan.rationale).not.toMatch(/land on a beat|timed to land on a beat|nudged onto the beat/);
      // The music still plays from a beat of the track.
      expect(plan.audio.music?.trackId).toBe('slow-1');
      expect(music.beatTimesSec.some((b) => Math.abs(b - plan.audio.music!.startOffsetSec) < 0.002)).toBe(true);
    }
  });

  it('"Cut to the beat: On" puts more cuts on beats than Off', () => {
    const on = planner.plan(plannerInput(labelledProject(), { styleId: 'clean_promo', targetDurationSec: 20, music, beatSync: 'on' }));
    const off = planner.plan(plannerInput(labelledProject(), { styleId: 'clean_promo', targetDurationSec: 20, music, beatSync: 'off' }));
    const onBeat = (p: EditPlan) => cutTimes(p).slice(0, -1).filter((t) => distanceToBeat(p, music, t) <= 0.05).length;
    expect(onBeat(on)).toBeGreaterThan(onBeat(off));
    expect(validateEditPlan(on, contextFor(plannerInput(labelledProject(), { styleId: 'clean_promo', targetDurationSec: 20, music }))).ok).toBe(true);
  });

  it('the beat montage keeps cutting on the beat even when asked not to', () => {
    const plan = planner.plan(plannerInput(labelledProject(), { styleId: 'beat_montage', targetDurationSec: 16, music, beatSync: 'off' }));
    expect(plan.audio.beatAlignment?.alignedCutTimesSec.length ?? 0).toBeGreaterThan(2);
  });

  it('"Land the reveal on a beat" starts the first result shot within ±0.25 s of a beat', () => {
    let checked = 0;
    for (const styleId of STYLE_IDS) {
      const input = plannerInput(labelledProject(), { styleId, targetDurationSec: 20, music, revealOnBeat: true });
      const plan = planner.plan(input);
      expect(validateEditPlan(plan, contextFor(input)).ok).toBe(true);
      const timeline = computeTimeline(plan);
      const first = timeline.segments.find((p) => p.index > 0 && p.segment.role === 'result');
      if (!first) continue;
      const reveal = first.startSec + (first.segment.transitionIn?.durationSec ?? 0);
      expect(distanceToBeat(plan, music, reveal)).toBeLessThanOrEqual(0.25);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('reads "cut to the beat" and a colour from a revision', () => {
    const v1 = planner.plan(plannerInput(labelledProject(), { styleId: 'clean_promo', targetDurationSec: 20, music, beatSync: 'off' }));
    const v2 = planner.plan(plannerInput(labelledProject(), { styleId: 'clean_promo', targetDurationSec: 20, music, previousPlan: v1, revisionInstruction: 'Make it moodier.' }));
    expect(v2.colourPreset).toBe('cinematic');
  });

  it('tells the AI planner about the beat options', () => {
    const input = plannerInput(labelledProject(), { styleId: 'clean_promo', targetDurationSec: 20, music, beatSync: 'off', revealOnBeat: true });
    const text = buildPlannerUserContent(input).map((b) => b.text).join('\n');
    expect(text).toContain('"beatSync":"off"');
    expect(text).toContain('"revealOnBeat":true');
  });
});
