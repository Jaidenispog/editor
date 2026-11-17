import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITING_STYLE, DEFAULT_SETTINGS, durationBoundsFor, type EditPlan, type EditingStyle } from '@studio/core';
import { toPlanCandidate } from '../src/anthropic/planner.js';
import type { PlannerWire } from '../src/anthropic/schemas.js';
import { buildPlannerUserContent, editingStyleBriefFor } from '../src/anthropic/prompts.js';
import { RulesPlanner } from '../src/rules/planner.js';
import { plannedLength, plannedTargetSec } from '../src/rules/settings.js';
import type { PlannerInput } from '../src/types.js';
import { clickTrack, labelledProject, plannerInput } from './fixtures.js';

/**
 * Both planners aim for the same length, and the worker checks a plan against the window around that length: when the
 * chosen track is a little shorter than the edit, the shared rule (`editLengthForTrack` in @studio/core) trims it.
 */
const planner = new RulesPlanner();
const at = (targetDurationSec: number, music: PlannerInput['music'], extra: Partial<PlannerInput> = {}) =>
  plannerInput(labelledProject(), { styleId: 'process_story', targetDurationSec, music, ...extra });
const briefOf = (input: PlannerInput) => JSON.parse(buildPlannerUserContent(input)[0]!.text.replace(/^Job description \(JSON\):\n/, '')) as { target: { durationSec: number; allowedRangeSec: [number, number] } };
/** The AI plan's own fields around the model's segments (taken here from a rules plan). */
const wireFrom = (plan: EditPlan) =>
  ({ title: plan.title, description: plan.description, rationale: plan.rationale, segments: plan.segments, textOverlays: plan.textOverlays, captions: plan.captions, audio: plan.audio, colourPreset: plan.colourPreset }) as unknown as PlannerWire;

describe('the length both planners aim for', () => {
  it('is the requested length without music, with a track that covers it, and when an instruction switches the music off', () => {
    expect(plannedLength(at(45, null))).toEqual({ ok: true, targetSec: 45, trimmed: false });
    expect(plannedLength(at(45, clickTrack(45.2)))).toEqual({ ok: true, targetSec: 45, trimmed: false });
    expect(plannedTargetSec(at(45, clickTrack(40), { instructions: 'No music please' }))).toBe(45);
    expect(briefOf(at(45, clickTrack(40), { instructions: 'No music please' })).target.durationSec).toBe(45);
  });

  it('trims a 45 s edit to 39.8 s for a 40 s track, in the rules plan, the AI brief and the AI plan alike', () => {
    const input = at(45, clickTrack(40));
    expect(plannedLength(input)).toEqual({ ok: true, targetSec: 39.8, trimmed: true });
    expect(plannedTargetSec(input)).toBe(39.8);
    const plan = planner.plan(input);
    expect(plan.targetDurationSec).toBe(39.8);
    expect(plan.rationale).toContain('The edit was trimmed to 39.8 s so it ends before the music does.');
    expect(briefOf(input).target).toEqual({ durationSec: 39.8, allowedRangeSec: [37.81, 41.79] });
    expect((toPlanCandidate(wireFrom(plan), input) as { targetDurationSec: number }).targetDurationSec).toBe(39.8);
    // The worker's window is the one around that length.
    expect(durationBoundsFor(plannedTargetSec(input))).toEqual(durationBoundsFor(39.8));
  });

  it('follows a revised length', () => {
    const previousPlan = planner.plan(at(30, clickTrack(40)));
    const revised = at(30, clickTrack(40), { previousPlan, revisionInstruction: 'Make it 45 seconds.' });
    expect(plannedTargetSec(revised)).toBe(39.8);
    expect(planner.plan(revised).targetDurationSec).toBe(39.8);
  });

  it('refuses a track too short to trim to, with the shared message, and leaves the length as asked elsewhere', () => {
    const input = at(45, clickTrack(30));
    const message = 'The chosen track is 30 seconds long, which is shorter than the 45-second edit. Choose a longer track or a shorter length.';
    expect(plannedLength(input)).toEqual({ ok: false, message });
    expect(() => planner.plan(input)).toThrow(message);
    expect(plannedTargetSec(input)).toBe(45);
    expect(briefOf(input).target.durationSec).toBe(45);
  });

  it("works out the AI brief's reveal on the biggest lift for the trimmed length, with the music where the rules planner starts it", () => {
    // Worked out for the asked length instead, no start of these tracks would leave room for the edit, and the brief
    // would give the AI planner no reveal time at all.
    const style: EditingStyle = { ...DEFAULT_EDITING_STYLE, transitionPalette: { hardCutShare: 0, types: ['fade'], durationSec: 0.3, accent: null }, beatSync: 'on', beatsPerCut: 2, reveal: 'strongest_beat' };
    const cases: Array<{ edit: number; track: number; liftAt: number; firstBeat: number; planned: number; reveal: number; start: number }> = [
      { edit: 45, track: 40, liftAt: 24, firstBeat: 0, planned: 39.8, reveal: 24, start: 0 },
      { edit: 45, track: 40, liftAt: 30, firstBeat: 0, planned: 39.8, reveal: 30, start: 0 },
      { edit: 30, track: 27, liftAt: 18, firstBeat: 0, planned: 26.8, reveal: 18, start: 0 },
      { edit: 20, track: 17.9, liftAt: 12, firstBeat: 0, planned: 17.7, reveal: 12, start: 0 },
      // The lift's beat is 23.8 s into this track; the music starts on its first beat, 0.3 s in.
      { edit: 45, track: 40, liftAt: 24, firstBeat: 0.3, planned: 39.5, reveal: 23.5, start: 0.3 },
    ];
    for (const c of cases) {
      const input = at(c.edit, liftTrack(c.track, c.liftAt, c.firstBeat), { preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle: style } });
      expect(plannedTargetSec(input)).toBe(c.planned);
      expect(editingStyleBriefFor(input)?.['reveal'], JSON.stringify(c)).toEqual({ mode: 'strongest_beat', targetOutputSec: c.reveal, musicStartOffsetSec: c.start });
      expect(planner.plan(input).audio.music?.startOffsetSec).toBe(c.start);
    }
  });
});

/** A SYNTHETIC 120 BPM track of `durationSec` with beats from `firstBeatSec` and a loud section (its biggest lift) from `liftAtSec`. */
function liftTrack(durationSec: number, liftAtSec: number, firstBeatSec: number): NonNullable<PlannerInput['music']> {
  const beats: number[] = [];
  for (let t = firstBeatSec; t < durationSec; t += 0.5) beats.push(Math.round(t * 1000) / 1000);
  const energy = Array.from({ length: Math.round(durationSec * 4) }, (_, i) => Math.round((i * 0.25 >= liftAtSec ? 1 : 0.126) * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000);
  return { trackId: 'lift-120', durationSec, bpm: 120, beatTimesSec: beats, title: 'Synthetic lift 120', energy, energyStepSec: 0.25 };
}
