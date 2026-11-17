/**
 * The worker judges a plan by the length both planners aimed for (no database, no FFmpeg): a 45 s edit with a 40 s
 * track is planned to 39.8 s (the shared rule in @studio/core), and the worker's window is the one around 39.8 s. With
 * the window around the requested 45 s, the rules planner's own plans were refused ("Edit runs 39.3s; it must be between
 * 40s and 50s") in 9 of these 45 edits, and now in 15: the beat montages at 120 BPM end on the last whole beat before the
 * music does (39.5 s), where they used to run to 40 s with the music. Uses the planner test fixtures (SYNTHETIC footage
 * descriptions, 45 s of clips).
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { AppError, DEFAULT_EDITING_STYLE, DEFAULT_SETTINGS, STYLE_IDS, computeTimeline, editLengthForTrack, validateEditPlan, type EditPlan, type EditingStyle, type StyleId } from '@studio/core';
import { RulesPlanner, plannedTargetSec, type PlannerInput } from '@studio/ai';
import { planWithFallback } from '../src/lib/planning.js';
import { planningContextFor, validationContextFor } from '../src/handlers/generate.js';
import type { LoadedFootage, LoadedMusic } from '../src/lib/plan-context.js';
import { clickTrack, labelledProject, plannerInput } from '../../../packages/ai/test/fixtures.js';

const rules = new RulesPlanner();
const logger = pino({ level: 'silent' });

/**
 * A synthetic track: beats at `bpm` from `firstBeatSec` (0 by default; the beat tracker puts the first beat anywhere in
 * the first beat period), with a loud section from `dropAtSec` (as in the planner sweep test).
 */
function track(bpm: number, dropAtSec: number | null, id: string, durationSec: number, firstBeatSec = 0): NonNullable<PlannerInput['music']> {
  const beats: number[] = [];
  for (let t = firstBeatSec; t < durationSec; t += 60 / bpm) beats.push(Math.round(t * 1000) / 1000);
  const energy = Array.from({ length: Math.round(durationSec * 4) }, (_, i) => Math.round((dropAtSec !== null && i * 0.25 >= dropAtSec ? 1 : 0.126) * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000);
  return { trackId: id, durationSec, bpm, beatTimesSec: beats, title: `Synthetic ${bpm}`, energy, energyStepSec: 0.25 };
}
const TRACKS_40: Array<NonNullable<PlannerInput['music']>> = [track(120, 24, 'drop-120', 40), clickTrack(40), track(92, null, 'slow-92', 40)];

const crossFades = (durationSec: number) => ({ hardCutShare: 0, types: ['fade' as const], durationSec, accent: null });
/** The editing styles whose 45 s edits the worker refused while the default style's passed (before the fix). */
const STYLES: Array<[string, EditingStyle]> = [
  ['default', DEFAULT_EDITING_STYLE],
  ['every beat', { ...DEFAULT_EDITING_STYLE, beatSync: 'on', beatsPerCut: 1 }],
  ['every 2 beats', { ...DEFAULT_EDITING_STYLE, beatSync: 'on', beatsPerCut: 2 }],
  ['0.3 s cross-fades', { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.3) }],
  ['0.6 s cross-fades', { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.6) }],
  ['0.6 s cross-fades, every 2 beats, punch-ins', { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.6), beatSync: 'on', beatsPerCut: 2, reveal: 'strongest_beat', zoom: { mode: 'punch_in', scale: 1.2, shareOfCuts: 0.25 } }],
  ['0.3 s cross-fades, every 2 beats, reveal', { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.3), beatSync: 'on', beatsPerCut: 2, reveal: 'strongest_beat' }],
];

const inputFor = (styleId: StyleId, music: PlannerInput['music'], targetDurationSec: number, attempt: number, editingStyle: EditingStyle, extra: Partial<PlannerInput> = {}) =>
  plannerInput(labelledProject(), { styleId, music, targetDurationSec, attempt, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle }, ...extra });

/** The loaded footage and music the handlers would pass, built from the planner input. */
function loaded(input: PlannerInput): { footage: LoadedFootage; music: LoadedMusic | null } {
  const transcripts: LoadedFootage['transcripts'] = {};
  for (const a of input.analyses) if (a.transcript?.segments.length) transcripts[a.assetId] = a.transcript.segments;
  const footage = { planAssets: input.assets, transcripts } as unknown as LoadedFootage;
  const music = input.music ? ({ track: { id: input.music.trackId }, durationSec: input.music.durationSec } as unknown as LoadedMusic) : null;
  return { footage, music };
}

/** handleGenerateEdits / handleReviseEdit with AI_PROVIDER=none: the rules planner through planWithFallback. */
async function viaWorker(input: PlannerInput): Promise<string | null> {
  const { footage, music } = loaded(input);
  try {
    await planWithFallback(rules, rules, input, planningContextFor(footage, music, input, false, []), logger, new AbortController().signal);
    return null;
  } catch (err) {
    return err instanceof AppError ? err.message : String(err);
  }
}

describe('the worker judges a plan by the length the planners aimed for', () => {
  it('a 45 s edit with a 40 s track: no failure in any style, take or track, with the default style or an accepted one', async () => {
    const failures: string[] = [];
    let refusedByTheRequestedWindow = 0;
    for (const [label, style] of STYLES)
      for (const styleId of STYLE_IDS)
        for (const music of TRACKS_40)
          for (const attempt of [0, 1, 2]) {
            const input = inputFor(styleId, music, 45, attempt, style);
            expect(plannedTargetSec(input)).toBe(39.8);
            const failed = await viaWorker(input);
            if (failed) failures.push(`${label} · ${styleId} · ${music.trackId} · take ${attempt + 1}: ${failed}`);
            // The window around the requested 45 s (what the worker used before) refuses some of these plans: the 9 the
            // review found, and the 6 beat montages at 120 BPM (drop-120 and the click track), which end at 39.5 s.
            const { footage } = loaded(input);
            if (label === 'default' && validateEditPlan(rules.plan(input), validationContextFor(footage, loaded(input).music, 45)).errors.length) refusedByTheRequestedWindow++;
          }
    expect(failures).toEqual([]);
    expect(refusedByTheRequestedWindow).toBe(15);
  });

  it('the step-down still runs in the worker: a 60 s before & after with 1 s cross-fades and a 70 s track', async () => {
    for (const music of [track(120, 24, 'drop-120', 70), clickTrack(70), null])
      for (const attempt of [0, 1, 2]) {
        const input = inputFor('before_after', music, 60, attempt, { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(1) });
        const { footage, music: m } = loaded(input);
        const outcome = await planWithFallback(rules, rules, input, planningContextFor(footage, m, input, false, ['fade']), logger, new AbortController().signal);
        expect(outcome.plan.rationale).toContain("The transitions from your videos could not be fitted to this footage at this length, so this version uses the style's own transitions.");
      }
  });

  it('a revision asking for 45 s with a 40 s track is judged by 39.8 s too', async () => {
    for (const styleId of ['cinematic_reveal', 'before_after', 'process_story'] as const)
      for (const music of TRACKS_40) {
        const previousPlan = rules.plan(inputFor(styleId, music, 30, 0, DEFAULT_EDITING_STYLE));
        const input = inputFor(styleId, music, 45, 0, DEFAULT_EDITING_STYLE, { previousPlan, revisionInstruction: 'Make it 45 seconds.' });
        expect(plannedTargetSec(input)).toBe(39.8);
        expect(await viaWorker(input), `${styleId} · ${music.trackId}`).toBeNull();
      }
  });

  it('a track too short to trim to is refused with the shared message', async () => {
    const input = inputFor('process_story', clickTrack(30), 45, 0, DEFAULT_EDITING_STYLE);
    expect(await viaWorker(input)).toBe('The chosen track is 30 seconds long, which is shorter than the 45-second edit. Choose a longer track or a shorter length.');
  });
});

/** Where a plan's music starts and how its cuts sit on the real track's beats (output time t plays music time start + t). */
function beatFacts(plan: EditPlan, music: NonNullable<PlannerInput['music']>) {
  const start = plan.audio.music!.startOffsetSec;
  const timeline = computeTimeline(plan);
  const offBeat = (t: number) => Math.min(...music.beatTimesSec.map((b) => Math.abs(b - t)));
  return {
    startOffBeat: offBeat(start),
    listedOffBeat: (plan.audio.beatAlignment?.alignedCutTimesSec ?? []).filter((c) => offBeat(start + c) > 0.04 + 1e-6),
    musicLeft: music.durationSec - start - timeline.totalDurationSec,
  };
}

describe('the music starts on the beat the length rule measured from (worker, rules planner)', () => {
  it('a track whose first beat is at 0.3 or 0.45 s, a little shorter than the edit or as long: on the beat, no false claims, music to the end', async () => {
    const problems: string[] = [];
    for (const first of [0.3, 0.45])
      for (const [target, length] of [
        [45, 40],
        [30, 30],
      ] as const)
        for (const [label, style] of STYLES.slice(0, 3))
          for (const styleId of STYLE_IDS)
            for (const attempt of [0, 1]) {
              const music = track(120, 24, 'late-first-beat', length, first);
              const input = inputFor(styleId, music, target, attempt, style);
              const planned = editLengthForTrack(target, length, first);
              expect(planned).toMatchObject({ ok: true, trimmed: true });
              expect(plannedTargetSec(input)).toBe(planned.ok ? planned.targetSec : NaN);
              const { footage, music: m } = loaded(input);
              const key = `${target}/${length} first beat ${first} · ${label} · ${styleId} · take ${attempt + 1}`;
              let plan: EditPlan;
              try {
                plan = (await planWithFallback(rules, rules, input, planningContextFor(footage, m, input, false, []), logger, new AbortController().signal)).plan;
              } catch (err) {
                problems.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
                continue;
              }
              const f = beatFacts(plan, music);
              if (f.startOffBeat > 0.001) problems.push(`${key}: the music starts ${f.startOffBeat.toFixed(3)} s off a beat`);
              if (f.listedOffBeat.length) problems.push(`${key}: listed as on the beat but not: ${f.listedOffBeat.join(', ')}`);
              if (f.musicLeft < 0.1 - 1e-6) problems.push(`${key}: the music ends ${f.musicLeft.toFixed(3)} s after the edit`);
            }
    expect(problems).toEqual([]);
  });
});
