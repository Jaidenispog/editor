import { describe, expect, it } from 'vitest';
import { AppError, CancelledError, DEFAULT_EDITING_STYLE, DEFAULT_SETTINGS, STYLE_IDS, computeTimeline, durationBoundsFor, validateEditPlan, type EditPlan, type EditingStyle, type StyleId } from '@studio/core';
import { collectFootage } from '../src/rules/footage.js';
import { RulesPlanner, STYLE_FALLBACK_NOTES, STYLE_FALLBACK_REVISION_NOTES, buildWithStyleFallback } from '../src/rules/planner.js';
import { effectiveSettings, plannedTargetSec, type EffectiveSettings, type ResolvedEditingStyle, type StyleFallbackStep } from '../src/rules/settings.js';
import { montageBeatSteps } from '../src/rules/styles.js';
import type { PlannerInput } from '../src/types.js';
import { clickTrack, labelledProject, plannerInput } from './fixtures.js';

/**
 * An accepted editing style must never make an edit fail that builds with the default style, judged the way the worker
 * judges it: its length window (`durationBoundsFor`) around the length both planners aim for (`plannedTargetSec`, which
 * trims a 45 s edit to 39.8 s for a 40 s track). "Cut every N beats" is fitted to the beat montage's shot-length range,
 * an edit trimmed to the track is fitted to what the music leaves when long cross-fades push it past the end, and as a
 * last resort the edit is built without the transitions from the owner's videos (keeping the beat, beats per cut, the
 * reveal and zooms), then without the editing style. Each step's plan note is true of the plan: one that says it keeps
 * the rest of the editing style differs from the plan without it, the others are that plan, and none still mentions
 * the transitions from the owner's videos. A "lands on the biggest lift" note must be true of the final plan. Sweeps
 * beatsPerCut 1/2/4/8, cross-fades of 0.3–1 s with no straight cuts (alone and with the beat, the reveal and punch-ins)
 * and 15/30/45/60 s across all five styles and four music cases (40 s tracks, so a 45 s edit is trimmed to the music;
 * 70 s tracks at 60 s).
 */

const planner = new RulesPlanner();

function track(bpm: number, dropAtSec: number | null, id: string, durationSec = 40): NonNullable<PlannerInput['music']> {
  const iv = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0; t < durationSec; t += iv) beats.push(Math.round(t * 1000) / 1000);
  const energy = Array.from({ length: durationSec * 4 }, (_, i) => {
    const level = dropAtSec !== null && i * 0.25 >= dropAtSec ? 1 : 0.126;
    return Math.round(level * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000;
  });
  return { trackId: id, durationSec, bpm, beatTimesSec: beats, title: `Synthetic ${bpm}`, energy, energyStepSec: 0.25 };
}

const TARGETS = [15, 30, 45, 60];
const musicFor = (target: number): Array<[string, PlannerInput['music']]> => {
  const len = target > 45 ? 70 : 40;
  return [
    ['drop 120', track(120, 24, 'drop-120', len)],
    ['click 120', clickTrack(len)],
    ['92 BPM', track(92, null, 'slow-92', len)],
    ['no music', null],
  ];
};

const crossFades = (durationSec: number) => ({ hardCutShare: 0, types: ['fade' as const], durationSec, accent: null });

const STYLES_TO_TRY: Array<[string, EditingStyle]> = [
  ...([1, 2, 4, 8] as const).map((n): [string, EditingStyle] => [`beatsPerCut ${n}`, { ...DEFAULT_EDITING_STYLE, beatSync: 'on', beatsPerCut: n }]),
  ...[0.3, 0.6, 1].map((d): [string, EditingStyle] => [`cross-fade ${d} s, no straight cuts`, { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(d) }]),
  ['cross-fade 1 s + every 8 beats + reveal on the lift', { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(1), beatSync: 'on', beatsPerCut: 8, reveal: 'strongest_beat' }],
  [
    'cross-fade 0.6 s + every 2 beats + reveal on the lift + punch-ins',
    { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.6), beatSync: 'on', beatsPerCut: 2, reveal: 'strongest_beat', zoom: { mode: 'punch_in', scale: 1.2, shareOfCuts: 0.25 } },
  ],
  ['cross-fade 0.3 s, no straight cuts + every 2 beats + reveal on the lift', { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.3), beatSync: 'on', beatsPerCut: 2, reveal: 'strongest_beat' }],
];

const STEPS = Object.keys(STYLE_FALLBACK_NOTES) as StyleFallbackStep[];
const fallbackStep = (rationale: string): StyleFallbackStep | null => STEPS.find((k) => rationale.includes(STYLE_FALLBACK_NOTES[k])) ?? null;
/**
 * The plan notes for transitions from the owner's videos (a fallback plan must not carry one from a failed attempt):
 * the joins and accents taken from them ("Straight cuts and cross-fades with a white flash at the reveal, from your
 * style."), the style's own ("Some joins keep the style's own …", "… rather than the transitions from your videos."),
 * and the clean promo's ("Clean promo stays calm, …", "… follow your style.").
 */
const PALETTE_NOTE =
  /(?:Straight cuts|Cross-fades|Slides|Wipes|Zoom transitions|Iris openings|Dips to black|White flashes|An? (?:white flash|dip to black)|\d+ (?:white flashes|dips to black))[^.]*, from your style\.|Some joins keep the style's own|rather than the transitions from your videos|Clean promo stays calm|follow your style\.|(?:Cross-fades|Transitions) as in your videos/;

const transcriptsOf = (i: PlannerInput) => {
  const out: Record<string, NonNullable<(typeof i.analyses)[number]['transcript']>['segments']> = {};
  for (const a of i.analyses) if (a.transcript?.segments.length) out[a.assetId] = a.transcript.segments;
  return out;
};
/** The worker's check of a first plan: its length window around the length the planners aimed for. */
const workerErrors = (i: PlannerInput, plan: EditPlan) =>
  validateEditPlan(plan, { assets: i.assets, music: i.music ? { trackId: i.music.trackId, durationSec: i.music.durationSec } : null, transcripts: transcriptsOf(i), durationBounds: durationBoundsFor(plannedTargetSec(i)), extraStyleTransitions: ['fade'] }).errors;
const sameApartFromRationale = (a: EditPlan, b: EditPlan) => JSON.stringify({ ...a, rationale: '' }) === JSON.stringify({ ...b, rationale: '' });

/**
 * The step-down at 60 s, recorded on this footage (45 s of clips): only the before & after falls back, and leaving out
 * the transitions is always enough to build it. Palette-only styles drop only their transitions: 4 of 12 edits for
 * 0.3 s cross-fades, 12 of 12 for 0.6 s and 1 s. With the beat and the reveal, the rest of the style is kept where it
 * changes the edit (9 of 12 for 0.6 s + every 2 beats + punch-ins, 4 of 5 for 0.3 s + every 2 beats); where it changes
 * nothing (no music, or every 8 beats across the before & after's short bridges, 12 of 12 for 1 s + every 8 beats) the
 * plan is the one without the editing style and says so.
 */
const BEFORE_AFTER_60_FALLBACKS: Record<string, Partial<Record<StyleFallbackStep, number>>> = {
  'cross-fade 0.3 s, no straight cuts': { transitionsOnly: 4 },
  'cross-fade 0.6 s, no straight cuts': { transitionsOnly: 12 },
  'cross-fade 1 s, no straight cuts': { transitionsOnly: 12 },
  'cross-fade 1 s + every 8 beats + reveal on the lift': { wholeStyle: 12 },
  'cross-fade 0.6 s + every 2 beats + reveal on the lift + punch-ins': { transitionsKeepRest: 9, wholeStyle: 3 },
  'cross-fade 0.3 s, no straight cuts + every 2 beats + reveal on the lift': { transitionsKeepRest: 4, wholeStyle: 1 },
};

const input = (styleId: StyleId, music: PlannerInput['music'], target: number, attempt: number, editingStyle: EditingStyle, extra: Partial<PlannerInput> = {}) =>
  plannerInput(labelledProject(), { styleId, music, targetDurationSec: target, attempt, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle }, ...extra });

describe('accepted editing styles never break an edit the defaults can build', () => {
  for (const [label, style] of STYLES_TO_TRY) {
    it(label, () => {
      const failures: string[] = [];
      let checked = 0;
      const steps: Record<StyleFallbackStep, number> = { transitionsOnly: 0, transitionsKeepRest: 0, wholeStyle: 0 };
      for (const styleId of STYLE_IDS)
        for (const target of TARGETS)
          for (const [musicLabel, music] of musicFor(target))
            for (const attempt of [0, 1, 2]) {
              const plain = input(styleId, music, target, attempt, DEFAULT_EDITING_STYLE);
              let def: EditPlan | null = null;
              try {
                def = planner.plan(plain);
              } catch {
                def = null;
              }
              // Only edits the default style builds, as the worker judges them.
              if (!def || workerErrors(plain, def).length) continue;
              checked++;
              const where = `${styleId} ${musicLabel} ${target}s attempt ${attempt}`;
              try {
                const i = input(styleId, music, target, attempt, style);
                const plan = planner.plan(i);
                const errors = workerErrors(i, plan);
                if (errors.length) failures.push(`${where}: ${errors.map((e) => e.code).join(', ')}`);
                const step = fallbackStep(plan.rationale);
                if (step) {
                  steps[step]++;
                  if (styleId !== 'before_after' || target !== 60) failures.push(`${where}: fell back (${step})`);
                  // Kept means applied: "keeps the rest of your editing style" only on a plan the rest changed; the other
                  // steps are the plan without the editing style.
                  const same = sameApartFromRationale(plan, def);
                  if (step === 'transitionsKeepRest' && same) failures.push(`${where}: says it keeps the rest of the editing style but is the plan without it`);
                  if (step !== 'transitionsKeepRest' && !same) failures.push(`${where}: left the editing style out (${step}) but is not the plan without it`);
                  // No note from a failed attempt reaches the plan.
                  if (PALETTE_NOTE.test(plan.rationale)) failures.push(`${where}: fell back (${step}) but still notes the transitions from your videos`);
                  // The reveal is still planned on the track's biggest lift (or the plan says why not).
                  if (step === 'transitionsKeepRest' && style.reveal === 'strongest_beat' && musicLabel === 'drop 120' && !plan.rationale.includes('biggest lift')) failures.push(`${where}: kept the reveal but did not plan it`);
                }
                // A note that the finished look lands on the biggest lift must be true.
                if (plan.rationale.includes('lands on the biggest lift')) {
                  const placed = computeTimeline(plan).segments;
                  const reveal = styleId === 'beat_montage' ? placed[placed.length - 1] : placed.find((p) => p.index > 0 && p.segment.role === 'result');
                  const tr = reveal?.segment.transitionIn;
                  const felt = reveal ? reveal.startSec + (tr ? (tr.type === 'fadewhite' || tr.type === 'fadeblack' ? 0.2 : 1) * tr.durationSec : 0) : Number.NaN;
                  const lift = 24 - (plan.audio.music?.startOffsetSec ?? 0);
                  if (!(Math.abs(felt - lift) <= 0.1)) failures.push(`${where}: says the reveal lands on the biggest lift but it is ${(felt - lift).toFixed(2)} s away`);
                }
              } catch (err) {
                failures.push(`${where}: ${(err as Error).message}`);
              }
            }
      expect(checked).toBeGreaterThan(200);
      expect(failures).toEqual([]);
      // A style that only differs in its transitions loses just those; one that also cuts to the beat or lands the
      // reveal keeps those wherever they change the edit.
      if (style.transitionPalette && style.beatSync === 'auto') expect(steps.transitionsKeepRest).toBe(0);
      if (style.transitionPalette && style.beatSync !== 'auto') expect(steps.transitionsOnly).toBe(0);
      expect(Object.fromEntries(STEPS.filter((k) => steps[k] > 0).map((k) => [k, steps[k]]))).toEqual(BEFORE_AFTER_60_FALLBACKS[label] ?? {});
    });
  }

  it('a 45 s edit with a 40 s track is planned to 39.8 s and passes the worker\'s window for that length, in every style and take', () => {
    for (const styleId of STYLE_IDS)
      for (const [, music] of musicFor(45).filter(([, m]) => m !== null))
        for (const attempt of [0, 1, 2]) {
          const i = input(styleId, music, 45, attempt, DEFAULT_EDITING_STYLE);
          expect(plannedTargetSec(i)).toBe(39.8);
          const plan = planner.plan(i);
          expect(plan.rationale).toContain('The edit was trimmed to 39.8 s so it ends before the music does.');
          expect(workerErrors(i, plan), `${styleId} attempt ${attempt}`).toEqual([]);
        }
  });
});

describe('fitting "cut every N beats" to the beat montage', () => {
  it('keeps whole multiples of N inside the 0.4 s–hi shot range', () => {
    expect(montageBeatSteps(2, 0.5, 1.25)).toEqual({ options: [2], note: null });
    expect(montageBeatSteps(1, 0.25, 1.25)).toEqual({ options: [2, 4], note: null });
    expect(montageBeatSteps(1, 0.5, 1.25)).toEqual({ options: [1, 2], note: null });
  });

  it('uses the largest whole divisor of N when N beats are longer than a montage shot, with a note', () => {
    const eight = montageBeatSteps(8, 0.5, 1.25);
    expect(eight.options).toEqual([2]);
    expect(eight.note).toContain('every 8 beats');
    expect(eight.note).toContain('every 2 beats instead');
    expect(montageBeatSteps(4, 60 / 92, 1.32).options).toEqual([2]);
    const none = montageBeatSteps(8, 2, 1.25);
    expect(none.options).toEqual([]);
    expect(none.note).toContain('keeps its own beat steps');
  });
});

describe('last resort: an edit the editing style cannot build steps down', () => {
  const beatsOnly: EditingStyle = { ...DEFAULT_EDITING_STYLE, beatSync: 'on', beatsPerCut: 4 };
  const withFades: EditingStyle = { ...beatsOnly, transitionPalette: crossFades(0.6), reveal: 'strongest_beat', zoom: { mode: 'push_in', scale: 1.08 } };
  const fadesOnly: EditingStyle = { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.6) };
  const setup = (style: EditingStyle) => {
    const i = input('process_story', clickTrack(), 20, 0, style);
    const s = effectiveSettings(i);
    return { i, s: { ...s, notes: [...s.notes] }, footage: collectFootage(i.analyses, i.assets) };
  };
  // A real plan for the editing style a step uses (the accepted one with its transitions as passed, or the default).
  const real = (inp: PlannerInput, set: EffectiveSettings) =>
    planner.plan({ ...inp, preferences: { ...inp.preferences, editingStyle: set.styleFromVideos ? { ...inp.preferences.editingStyle, transitionPalette: set.styleFromVideos.palette } : DEFAULT_EDITING_STYLE } });
  const fail = () => {
    throw new AppError('PROCESSING_FAILED', 'The process story could not be built from this footage.');
  };
  const label = (es: ResolvedEditingStyle | null) => (!es ? 'none' : es.palette ? 'full' : 'without transitions');
  // A real build writes notes into the settings it is given before it can fail; no later step may see them.
  const LEFT_BEHIND = 'Written by an attempt that then failed.';
  const failLeavingANote = (set: EffectiveSettings) => {
    set.notes.push(LEFT_BEHIND);
    fail();
  };

  it('first leaves out only the transitions, keeping the beat, beats per cut, the reveal and zooms', () => {
    const { i, s, footage } = setup(withFades);
    const seen: string[] = [];
    let keptRest: EditPlan | null = null;
    const plan = buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      expect(set.notes).not.toContain(LEFT_BEHIND);
      if (set.styleFromVideos?.palette) failLeavingANote(set);
      if (set.styleFromVideos) {
        expect(set.styleFromVideos).toMatchObject({ palette: null, accent: null, beatSync: 'on', beatsPerCut: 4, reveal: 'strongest_beat', zoom: { mode: 'push_in', scale: 1.08 } });
        expect(set.styleFallback).toBe('transitionsKeepRest');
        keptRest = real(inp, set);
        return keptRest;
      }
      // The plan without the editing style is built only to compare: the push-ins make the two differ.
      expect(set.styleFallback).toBe('wholeStyle');
      return real(inp, set);
    });
    expect(seen).toEqual(['full', 'without transitions', 'none']);
    expect(plan).toBe(keptRest);
    expect(plan.segments.length).toBeGreaterThan(1);
  });

  it('uses the plan without the editing style, with its note, when the rest of the style changes nothing', () => {
    const { i, s, footage } = setup(withFades);
    const steps: Array<StyleFallbackStep | null> = [];
    const base = real(i, { ...s, styleFromVideos: null });
    const plan = buildWithStyleFallback(i, s, footage, (_inp, set) => {
      steps.push(set.styleFallback);
      expect(set.notes).not.toContain(LEFT_BEHIND);
      if (set.styleFromVideos?.palette) failLeavingANote(set);
      // Both later builds give the same edit; only their notes differ.
      return { ...base, rationale: `step ${set.styleFallback}` };
    });
    expect(steps).toEqual([null, 'transitionsKeepRest', 'wholeStyle']);
    expect(plan.rationale).toBe('step wholeStyle');
  });

  it('keeps the plan without the transitions when the plan without the editing style cannot be built', () => {
    const { i, s, footage } = setup(withFades);
    const seen: string[] = [];
    const plan = buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      expect(set.notes).not.toContain(LEFT_BEHIND);
      if (!set.styleFromVideos || set.styleFromVideos.palette) failLeavingANote(set);
      return { ...real(inp, set), rationale: 'kept the rest' };
    });
    expect(seen).toEqual(['full', 'without transitions', 'none']);
    expect(plan.rationale).toBe('kept the rest');
  });

  it('then leaves out the whole editing style, with only that note in the plan', () => {
    const { i, s, footage } = setup(withFades);
    const seen: string[] = [];
    buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      expect(set.notes).not.toContain(LEFT_BEHIND);
      if (set.styleFromVideos) failLeavingANote(set);
      expect(set.styleFallback).toBe('wholeStyle');
      return real(inp, set);
    });
    expect(seen).toEqual(['full', 'without transitions', 'none']);
  });

  it('says only the transitions were left out when they were the whole editing style', () => {
    const { i, s, footage } = setup(fadesOnly);
    const seen: string[] = [];
    buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      expect(set.notes).not.toContain(LEFT_BEHIND);
      if (set.styleFromVideos) failLeavingANote(set);
      expect(set.styleFallback).toBe('transitionsOnly');
      return real(inp, set);
    });
    expect(seen).toEqual(['full', 'none']);
  });

  it("goes straight to the style's own timing and transitions when there are no transitions to leave out", () => {
    const { i, s, footage } = setup(beatsOnly);
    const seen: string[] = [];
    const plan = buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      expect(set.notes).not.toContain(LEFT_BEHIND);
      if (set.styleFromVideos) failLeavingANote(set);
      expect(set.styleFallback).toBe('wholeStyle');
      return real(inp, set);
    });
    expect(seen).toEqual(['without transitions', 'none']);
    expect(plan.segments.length).toBeGreaterThan(1);
  });

  it('passes on cancellations and errors that are not about building, at every step', () => {
    const { i, s, footage } = setup(withFades);
    expect(() => buildWithStyleFallback(i, s, footage, () => { throw new CancelledError(); })).toThrow(CancelledError);
    expect(() => buildWithStyleFallback(i, s, footage, () => { throw new AppError('UNSUPPORTED', 'x'); })).toThrow('x');
    const calls: string[] = [];
    expect(() =>
      buildWithStyleFallback(i, s, footage, (_inp, set) => {
        calls.push(label(set.styleFromVideos));
        if (set.styleFromVideos?.palette) fail();
        throw new CancelledError();
      }),
    ).toThrow(CancelledError);
    expect(calls).toEqual(['full', 'without transitions']);
    // Including the build without the editing style that is only made to compare.
    const compared: string[] = [];
    expect(() =>
      buildWithStyleFallback(i, s, footage, (inp, set) => {
        compared.push(label(set.styleFromVideos));
        if (set.styleFromVideos?.palette) fail();
        if (!set.styleFromVideos) throw new CancelledError();
        return real(inp, set);
      }),
    ).toThrow(CancelledError);
    expect(compared).toEqual(['full', 'without transitions', 'none']);
  });
});

describe('in a revision, the fallback keeps the earlier version\'s joins and its note says so', () => {
  // Before & after at 30 s with 0.6 s cross-fades and no straight cuts, then "Make it 60 seconds.": the full style cannot
  // be built at 60 s, and the revision keeps the earlier shots with their joins (the owner's cross-fades among them).
  const music = track(120, 24, 'drop-120', 70);
  const fadesOnly: EditingStyle = { ...DEFAULT_EDITING_STYLE, transitionPalette: crossFades(0.6) };
  const fadesPlus: EditingStyle = { ...fadesOnly, beatSync: 'on', beatsPerCut: 2, reveal: 'strongest_beat', zoom: { mode: 'punch_in', scale: 1.2, shareOfCuts: 0.25 } };
  const revise = (style: EditingStyle, previousPlan: EditPlan) => planner.plan(input('before_after', music, 30, 0, style, { previousPlan, revisionInstruction: 'Make it 60 seconds.' }));
  const joinsById = (plan: EditPlan) => new Map(plan.segments.map((seg, k) => [seg.id, k === 0 ? 'first' : JSON.stringify(seg.transitionIn)]));

  it('uses the revision wording, keeps every earlier join, and adds shots with the style\'s own transitions', () => {
    const prev = planner.plan(input('before_after', music, 30, 0, fadesOnly));
    expect(prev.segments.filter((seg) => seg.transitionIn?.type === 'fade').length).toBeGreaterThan(5);
    const plan = revise(fadesOnly, prev);
    expect(plan.rationale).toContain(STYLE_FALLBACK_REVISION_NOTES.transitionsOnly);
    expect(plan.rationale).not.toContain(STYLE_FALLBACK_NOTES.transitionsOnly);
    const before = joinsById(prev);
    const kept = plan.segments.filter((seg, k) => k > 0 && before.has(seg.id) && before.get(seg.id) !== 'first');
    expect(kept.length).toBeGreaterThan(5);
    for (const seg of kept) expect(JSON.stringify(seg.transitionIn), seg.id).toBe(before.get(seg.id));
    expect(kept.some((seg) => seg.transitionIn?.type === 'fade')).toBe(true);
    // The added shots are joined as without the editing style: the whole plan is the same revision made without it.
    const plain = planner.plan(input('before_after', music, 30, 0, DEFAULT_EDITING_STYLE, { previousPlan: prev, revisionInstruction: 'Make it 60 seconds.' }));
    expect(sameApartFromRationale(plan, plain)).toBe(true);
    expect(plan.segments.length).toBeGreaterThan(prev.segments.length);
  });

  it('keeps the rest of the editing style with the revision wording when it changes the revision', () => {
    const prev = planner.plan(input('before_after', music, 30, 0, fadesPlus));
    const plan = revise(fadesPlus, prev);
    expect(plan.rationale).toContain(STYLE_FALLBACK_REVISION_NOTES.transitionsKeepRest);
    expect(plan.rationale).not.toContain(STYLE_FALLBACK_NOTES.transitionsKeepRest);
    const plain = planner.plan(input('before_after', music, 30, 0, DEFAULT_EDITING_STYLE, { previousPlan: prev, revisionInstruction: 'Make it 60 seconds.' }));
    expect(sameApartFromRationale(plan, plain)).toBe(false);
  });

  it('leaves to the request its own change to kept joins ("remove the flashy transitions"), with its own note', () => {
    const slides: EditingStyle = { ...DEFAULT_EDITING_STYLE, transitionPalette: { hardCutShare: 0.2, types: ['fade', 'slideup'], durationSec: 0.5, accent: null } };
    const preferences = { ...DEFAULT_SETTINGS.preferences, transitions: 'varied' as const, editingStyle: slides };
    const prev = planner.plan(input('before_after', music, 30, 0, slides, { preferences }));
    expect(prev.segments.some((seg) => seg.transitionIn?.type === 'slideup')).toBe(true);
    const plan = planner.plan(input('before_after', music, 30, 0, slides, { preferences, previousPlan: prev, revisionInstruction: 'Make it 60 seconds and remove the flashy transitions' }));
    // Leaving out the owner's transitions changed only the added shots; the request turned the kept slides into dissolves.
    expect(plan.rationale).toContain(STYLE_FALLBACK_REVISION_NOTES.transitionsOnly);
    expect(plan.rationale).toContain('Flashy transitions were replaced with simple dissolves.');
    expect(plan.segments.some((seg) => seg.transitionIn?.type === 'slideup')).toBe(false);
  });

  it('uses the wording for a new edit when the revision could keep nothing from the earlier version', () => {
    const prev = planner.plan(input('before_after', music, 30, 0, fadesOnly));
    // The earlier version's clips are gone, so the revision is rebuilt from scratch: no join is kept.
    const gone = { ...prev, segments: prev.segments.map((seg) => ({ ...seg, assetId: 'deleted-clip' })) };
    const plan = revise(fadesOnly, gone);
    expect(plan.rationale).toContain('rebuilt from scratch');
    expect(plan.rationale).toContain(STYLE_FALLBACK_NOTES.transitionsOnly);
    expect(plan.rationale).not.toContain(STYLE_FALLBACK_REVISION_NOTES.transitionsOnly);
  });
});
