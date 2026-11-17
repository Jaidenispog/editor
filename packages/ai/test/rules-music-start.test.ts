import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITING_STYLE, DEFAULT_SETTINGS, STYLE_IDS, computeTimeline, editLengthForTrack, type EditPlan, type EditingStyle, type StyleId } from '@studio/core';
import { toPlanCandidate } from '../src/anthropic/planner.js';
import { buildPlannerUserContent } from '../src/anthropic/prompts.js';
import type { PlannerWire } from '../src/anthropic/schemas.js';
import { RulesPlanner } from '../src/rules/planner.js';
import { plannedTargetSec } from '../src/rules/settings.js';
import type { PlannerInput } from '../src/types.js';
import { labelledProject, plannerInput } from './fixtures.js';

/**
 * Where the music starts, the beats the cuts follow and the cuts a plan reports as on the beat all come from the same
 * start, also for a track whose first beat is not at 0 s (the beat tracker puts it anywhere in the first beat) when the
 * track trims the edit or is about as long as it: the length rule measures the music from the first beat, the music
 * starts on a beat and is never moved off it, and an AI plan's beat-alignment info is worked out from its own cuts.
 * SYNTHETIC tracks: a beat every 60/bpm s from `firstBeat`, with a loud section from `dropAtSec`.
 */
const planner = new RulesPlanner();

function track(bpm: number, firstBeat: number, durationSec: number, dropAtSec: number | null = null): NonNullable<PlannerInput['music']> {
  const beats: number[] = [];
  for (let t = firstBeat; t < durationSec; t += 60 / bpm) beats.push(Math.round(t * 1000) / 1000);
  const energy = Array.from({ length: Math.round(durationSec * 4) }, (_, i) => Math.round((dropAtSec !== null && i * 0.25 >= dropAtSec ? 1 : 0.126) * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000);
  return { trackId: 'sound', durationSec, bpm, beatTimesSec: beats, title: `Synthetic ${bpm}`, energy, energyStepSec: 0.25 };
}

const inputFor = (styleId: StyleId, music: PlannerInput['music'], targetDurationSec: number, attempt: number, editingStyle: EditingStyle = DEFAULT_EDITING_STYLE, extra: Partial<PlannerInput> = {}) =>
  plannerInput(labelledProject(), { styleId, music, targetDurationSec, attempt, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle }, ...extra });

const nearestBeat = (beats: readonly number[], t: number) => Math.min(...beats.map((b) => Math.abs(b - t)));

/** The plan's beat facts against the real track, in music time (output time t plays music time start + t). */
function beatFacts(plan: EditPlan, music: NonNullable<PlannerInput['music']>) {
  const start = plan.audio.music!.startOffsetSec;
  const timeline = computeTimeline(plan);
  const cuts = timeline.segments.slice(1).map((p) => p.startSec + (p.segment.transitionIn?.durationSec ?? 0));
  const listed = plan.audio.beatAlignment?.alignedCutTimesSec ?? [];
  return {
    start,
    startOff: nearestBeat(music.beatTimesSec, start),
    listedOff: listed.filter((c) => nearestBeat(music.beatTimesSec, start + c) > 0.04 + 1e-6),
    cutsOff: cuts.filter((c) => nearestBeat(music.beatTimesSec, start + c) > 0.04 + 1e-6),
    musicLeft: music.durationSec - start - timeline.totalDurationSec,
  };
}

/** The AI plan's own fields around the model's segments (taken here from a rules plan). */
const wireFrom = (plan: EditPlan) =>
  ({ title: plan.title, description: plan.description, rationale: plan.rationale, segments: plan.segments, textOverlays: plan.textOverlays, captions: plan.captions, audio: plan.audio, colourPreset: plan.colourPreset }) as unknown as PlannerWire;
const briefOf = (input: PlannerInput) => JSON.parse(buildPlannerUserContent(input)[0]!.text.replace(/^Job description \(JSON\):\n/, '')) as { target: { durationSec: number }; music: { fixedStartOffsetSec?: number } | null };

const EVERY_TWO_BEATS: EditingStyle = { ...DEFAULT_EDITING_STYLE, beatSync: 'on', beatsPerCut: 2 };
/** Trimmed (45 s edit, 40 s track) and about as long (30 s edit, 30 s and 30.2 s tracks). */
const CASES: Array<[number, number]> = [
  [45, 40],
  [30, 30],
  [30, 30.2],
];

describe('the music start, the beat grid and the reported beats agree', () => {
  it('rules plans start the music on a beat, list only cuts on the beat and end before the music, for first beats at 0.3 and 0.45 s', () => {
    const problems: string[] = [];
    for (const first of [0.3, 0.45])
      for (const [target, length] of CASES)
        for (const styleId of STYLE_IDS)
          for (const [label, style] of [['default', DEFAULT_EDITING_STYLE], ['every 2 beats', EVERY_TWO_BEATS]] as const)
            for (const attempt of [0, 1]) {
              const music = track(120, first, length);
              const input = inputFor(styleId, music, target, attempt, style);
              const planned = editLengthForTrack(target, length, first);
              expect(planned.ok).toBe(true);
              expect(plannedTargetSec(input)).toBe(planned.ok ? planned.targetSec : NaN);
              const plan = planner.plan(input);
              const f = beatFacts(plan, music);
              const key = `${target}/${length} first ${first} ${styleId} ${label} take ${attempt + 1}`;
              if (f.startOff > 0.001) problems.push(`${key}: music starts at ${f.start}, ${f.startOff.toFixed(3)} s off a beat`);
              if (f.listedOff.length) problems.push(`${key}: listed as on the beat but not: ${f.listedOff.join(', ')}`);
              if (styleId === 'beat_montage' && f.cutsOff.length) problems.push(`${key}: montage cuts off the beat: ${f.cutsOff.join(', ')}`);
              if (f.musicLeft < 0.1 - 1e-6) problems.push(`${key}: the music ends ${f.musicLeft.toFixed(3)} s after the edit`);
              if (planned.ok && planned.trimmed) expect(plan.rationale).toContain(`The edit was trimmed to ${planned.targetSec} s so it ends before the music does.`);
              // The AI plan built from the same cuts reports exactly the same beats.
              expect((toPlanCandidate(wireFrom(plan), input) as EditPlan).audio.beatAlignment, key).toEqual(plan.audio.beatAlignment);
            }
    expect(problems).toEqual([]);
  });

  it('a 30 s edit with a 30 s track whose first beat is at 0.3 s: trimmed to 29.5 s, music from 0.3 s, every montage cut on a beat', () => {
    const music = track(120, 0.3, 30);
    const plan = planner.plan(inputFor('beat_montage', music, 30, 0));
    expect(plan.targetDurationSec).toBe(29.5);
    expect(plan.audio.music?.startOffsetSec).toBe(0.3);
    const f = beatFacts(plan, music);
    expect(f.cutsOff).toEqual([]);
    expect(plan.audio.beatAlignment?.alignedCutTimesSec.length).toBe(computeTimeline(plan).segments.length - 1);
    // A whole number of beats that ends before the music does (rounding up would have run to 30 s).
    expect(computeTimeline(plan).totalDurationSec).toBeLessThanOrEqual(29.55);
  });

  it('the AI brief aims for the same length and leaves room to start on the first beat; a chosen start snaps to a beat that leaves room', () => {
    for (const first of [0.3, 0.45])
      for (const [target, length] of CASES)
        for (const styleId of STYLE_IDS) {
          const music = track(120, first, length);
          const input = inputFor(styleId, music, target, 0);
          const brief = briefOf(input);
          expect(brief.target.durationSec).toBe(plannedTargetSec(input));
          expect(first + brief.target.durationSec).toBeLessThanOrEqual(length - 0.1 + 1e-9);
          const chosen = briefOf(inputFor(styleId, music, target, 0, DEFAULT_EDITING_STYLE, { musicStartSec: 0 }));
          expect(chosen.music?.fixedStartOffsetSec).toBe(first);
          expect(chosen.target.durationSec + first).toBeLessThanOrEqual(length - 0.1 + 1e-9);
        }
  });

  it("an AI plan's beat-alignment info follows where its music actually starts, not the model's own list", () => {
    const music = track(120, 0.3, 40);
    const input = inputFor('beat_montage', music, 30, 0);
    const plan = planner.plan(input);
    expect(plan.audio.music?.startOffsetSec).toBe(0.3);
    const listed = plan.audio.beatAlignment!.alignedCutTimesSec;
    expect(listed.length).toBeGreaterThan(10);
    // The same cuts with the music started at 0 s (0.3 s before the beat) and the model claiming every cut: none is.
    const offBeat = wireFrom(plan);
    offBeat.audio = { ...offBeat.audio, music: { ...offBeat.audio.music!, startOffsetSec: 0 }, beatAlignment: { bpm: 120, alignedCutTimesSec: listed } };
    expect((toPlanCandidate(offBeat, input) as EditPlan).audio.beatAlignment).toEqual({ bpm: 120, alignedCutTimesSec: [] });
    // Started on the first beat, the model's empty list does not hide the cuts that are on the beat.
    const silent = wireFrom(plan);
    silent.audio = { ...silent.audio, beatAlignment: null };
    expect((toPlanCandidate(silent, input) as EditPlan).audio.beatAlignment).toEqual({ bpm: 120, alignedCutTimesSec: listed });
    // Without music in the plan there is nothing to report.
    const none = wireFrom(plan);
    none.audio = { ...none.audio, music: null };
    expect((toPlanCandidate(none, input) as EditPlan).audio.beatAlignment).toBeNull();
  });
});
