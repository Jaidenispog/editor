import { describe, expect, it } from 'vitest';
import { durationBoundsFor, type EditPlan } from '@studio/core';
import { toPlanCandidate } from '../src/anthropic/planner.js';
import type { PlannerWire } from '../src/anthropic/schemas.js';
import { buildPlannerUserContent } from '../src/anthropic/prompts.js';
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
});
