import { describe, expect, it } from 'vitest';
import { AppError, CancelledError, DEFAULT_EDITING_STYLE, DEFAULT_SETTINGS, STYLE_IDS, computeTimeline, validateEditPlan, type EditingStyle, type StyleId } from '@studio/core';
import { collectFootage } from '../src/rules/footage.js';
import { RulesPlanner, STYLE_FALLBACK_NOTES, buildWithStyleFallback } from '../src/rules/planner.js';
import { effectiveSettings, type EffectiveSettings, type ResolvedEditingStyle } from '../src/rules/settings.js';
import { montageBeatSteps } from '../src/rules/styles.js';
import type { PlannerInput } from '../src/types.js';
import { clickTrack, labelledProject, plannerInput } from './fixtures.js';

/**
 * An accepted editing style must never make an edit fail that builds with the default style: "cut every N beats" is
 * fitted to the beat montage's shot-length range, an edit trimmed to the track is fitted to what the music leaves when
 * long cross-fades push it past the end, and as a last resort the edit is built without the transitions from the
 * owner's videos (keeping the beat, beats per cut, the reveal and zooms), then without the editing style, each with a
 * plan note. A "lands on the biggest lift" note must be true of the final plan. Sweeps beatsPerCut 1/2/4/8,
 * cross-fades of 0.3–1 s with no straight cuts (alone and with the beat and the reveal) and 15/30/45/60 s across all
 * five styles and four music cases (40 s tracks, so a 45 s edit is trimmed to the music; 70 s tracks at 60 s).
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

type FallbackStep = keyof typeof STYLE_FALLBACK_NOTES;
const fallbackStep = (rationale: string): FallbackStep | null => (Object.keys(STYLE_FALLBACK_NOTES) as FallbackStep[]).find((k) => rationale.includes(STYLE_FALLBACK_NOTES[k])) ?? null;

/**
 * The step-down at 60 s, recorded on this footage (45 s of clips): only the before & after falls back, and leaving out
 * the transitions is always enough. Palette-only styles: 4 of 12 edits for 0.3 s cross-fades, 12 of 12 for 0.6 s and
 * 1 s. With the beat and the reveal: 12 of 12 for 1 s + every 8 beats, 12 of 12 for 0.6 s + every 2 beats + punch-ins,
 * 5 of 12 for 0.3 s + every 2 beats; all keep the beat, beats per cut, the reveal and zooms (whole style 0 times).
 */
const BEFORE_AFTER_60_FALLBACKS: Record<string, number> = {
  'cross-fade 0.3 s, no straight cuts': 4,
  'cross-fade 0.6 s, no straight cuts': 12,
  'cross-fade 1 s, no straight cuts': 12,
  'cross-fade 1 s + every 8 beats + reveal on the lift': 12,
  'cross-fade 0.6 s + every 2 beats + reveal on the lift + punch-ins': 12,
  'cross-fade 0.3 s, no straight cuts + every 2 beats + reveal on the lift': 5,
};

const input = (styleId: StyleId, music: PlannerInput['music'], target: number, attempt: number, editingStyle: EditingStyle) =>
  plannerInput(labelledProject(), { styleId, music, targetDurationSec: target, attempt, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle } });

describe('accepted editing styles never break an edit the defaults can build', () => {
  for (const [label, style] of STYLES_TO_TRY) {
    it(label, () => {
      const failures: string[] = [];
      let checked = 0;
      const steps: Record<FallbackStep, number> = { transitionsOnly: 0, transitionsKeepRest: 0, wholeStyle: 0 };
      let beforeAfter60 = 0;
      for (const styleId of STYLE_IDS)
        for (const target of TARGETS)
          for (const [musicLabel, music] of musicFor(target))
            for (const attempt of [0, 1, 2]) {
              let defaultOk = true;
              try {
                planner.plan(input(styleId, music, target, attempt, DEFAULT_EDITING_STYLE));
              } catch {
                defaultOk = false;
              }
              if (!defaultOk) continue;
              checked++;
              const where = `${styleId} ${musicLabel} ${target}s attempt ${attempt}`;
              try {
                const i = input(styleId, music, target, attempt, style);
                const plan = planner.plan(i);
                const transcripts: Record<string, NonNullable<(typeof i.analyses)[number]['transcript']>['segments']> = {};
                for (const a of i.analyses) if (a.transcript?.segments.length) transcripts[a.assetId] = a.transcript.segments;
                const res = validateEditPlan(plan, { assets: i.assets, music: music ? { trackId: music.trackId, durationSec: music.durationSec } : null, transcripts, durationBounds: { min: target * 0.85, max: target * 1.15 }, extraStyleTransitions: ['fade'] });
                if (res.errors.length) failures.push(`${where}: ${res.errors.map((e) => e.code).join(', ')}`);
                const step = fallbackStep(plan.rationale);
                if (step) {
                  steps[step]++;
                  if (styleId !== 'before_after' || target !== 60) failures.push(`${where}: fell back (${step})`);
                  else beforeAfter60++;
                  // Kept means applied: the reveal is still planned on the track's biggest lift (or says why not).
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
      expect(checked).toBeGreaterThan(100);
      expect(failures).toEqual([]);
      // Never the whole editing style: a style that only differs in its transitions loses just those, and one that also
      // cuts to the beat or lands the reveal keeps those.
      expect(steps.wholeStyle).toBe(0);
      if (style.transitionPalette && style.beatSync === 'auto') expect(steps.transitionsKeepRest).toBe(0);
      if (style.transitionPalette && style.beatSync !== 'auto') expect(steps.transitionsOnly).toBe(0);
      expect(beforeAfter60).toBe(BEFORE_AFTER_60_FALLBACKS[label] ?? 0);
    });
  }
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

  it('first leaves out only the transitions, keeping the beat, beats per cut, the reveal and zooms', () => {
    const { i, s, footage } = setup(withFades);
    const seen: string[] = [];
    const plan = buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      if (set.styleFromVideos?.palette) fail();
      expect(set.styleFromVideos).toMatchObject({ palette: null, accent: null, beatSync: 'on', beatsPerCut: 4, reveal: 'strongest_beat', zoom: { mode: 'push_in', scale: 1.08 } });
      expect(set.notes.at(-1)).toBe(STYLE_FALLBACK_NOTES.transitionsKeepRest);
      return real(inp, set);
    });
    expect(seen).toEqual(['full', 'without transitions']);
    expect(plan.segments.length).toBeGreaterThan(1);
  });

  it('then leaves out the whole editing style, with only that note in the plan', () => {
    const { i, s, footage } = setup(withFades);
    const seen: string[] = [];
    buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      if (set.styleFromVideos) fail();
      expect(set.notes.at(-1)).toBe(STYLE_FALLBACK_NOTES.wholeStyle);
      expect(set.notes).not.toContain(STYLE_FALLBACK_NOTES.transitionsKeepRest);
      return real(inp, set);
    });
    expect(seen).toEqual(['full', 'without transitions', 'none']);
  });

  it('says only the transitions were left out when they were the whole editing style', () => {
    const { i, s, footage } = setup(fadesOnly);
    const seen: string[] = [];
    buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      if (set.styleFromVideos) fail();
      expect(set.notes.at(-1)).toBe(STYLE_FALLBACK_NOTES.transitionsOnly);
      return real(inp, set);
    });
    expect(seen).toEqual(['full', 'none']);
  });

  it("goes straight to the style's own timing and transitions when there are no transitions to leave out", () => {
    const { i, s, footage } = setup(beatsOnly);
    const seen: string[] = [];
    const plan = buildWithStyleFallback(i, s, footage, (inp, set) => {
      seen.push(label(set.styleFromVideos));
      if (set.styleFromVideos) fail();
      expect(set.notes.at(-1)).toBe(STYLE_FALLBACK_NOTES.wholeStyle);
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
  });
});
