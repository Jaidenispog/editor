import { describe, expect, it } from 'vitest';
import { AppError, CancelledError, DEFAULT_EDITING_STYLE, DEFAULT_SETTINGS, STYLE_IDS, computeTimeline, validateEditPlan, type EditingStyle, type StyleId } from '@studio/core';
import { collectFootage } from '../src/rules/footage.js';
import { RulesPlanner, buildWithStyleFallback } from '../src/rules/planner.js';
import { effectiveSettings, type EffectiveSettings } from '../src/rules/settings.js';
import { montageBeatSteps } from '../src/rules/styles.js';
import type { PlannerInput } from '../src/types.js';
import { clickTrack, labelledProject, plannerInput } from './fixtures.js';

/**
 * An accepted editing style must never make an edit fail that builds with the default style: "cut every N beats" is
 * fitted to the beat montage's shot-length range, an edit trimmed to the track is fitted to what the music leaves when
 * long cross-fades push it past the end, and as a last resort the edit is built without the editing style (with a
 * plan note). A "lands on the biggest lift" note must be true of the final plan. Sweeps beatsPerCut 1/2/4/8, cross-fades of 0.3–1 s with no straight
 * cuts and 15/30/45 s across all five styles and four music cases.
 */

const planner = new RulesPlanner();

function track(bpm: number, dropAtSec: number | null, id: string): NonNullable<PlannerInput['music']> {
  const iv = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0; t < 40; t += iv) beats.push(Math.round(t * 1000) / 1000);
  const energy = Array.from({ length: 160 }, (_, i) => {
    const level = dropAtSec !== null && i * 0.25 >= dropAtSec ? 1 : 0.126;
    return Math.round(level * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000;
  });
  return { trackId: id, durationSec: 40, bpm, beatTimesSec: beats, title: `Synthetic ${bpm}`, energy, energyStepSec: 0.25 };
}

const MUSIC: Array<[string, PlannerInput['music']]> = [
  ['drop 120', track(120, 24, 'drop-120')],
  ['click 120', clickTrack()],
  ['92 BPM', track(92, null, 'slow-92')],
  ['no music', null],
];

const STYLES_TO_TRY: Array<[string, EditingStyle]> = [
  ...([1, 2, 4, 8] as const).map((n): [string, EditingStyle] => [`beatsPerCut ${n}`, { ...DEFAULT_EDITING_STYLE, beatSync: 'on', beatsPerCut: n }]),
  ...[0.3, 0.6, 1].map((d): [string, EditingStyle] => [`cross-fade ${d} s, no straight cuts`, { ...DEFAULT_EDITING_STYLE, transitionPalette: { hardCutShare: 0, types: ['fade'], durationSec: d, accent: null } }]),
  [
    'cross-fade 1 s + every 8 beats + reveal on the lift',
    { ...DEFAULT_EDITING_STYLE, transitionPalette: { hardCutShare: 0, types: ['fade'], durationSec: 1, accent: null }, beatSync: 'on', beatsPerCut: 8, reveal: 'strongest_beat' },
  ],
];

const input = (styleId: StyleId, music: PlannerInput['music'], target: number, attempt: number, editingStyle: EditingStyle) =>
  plannerInput(labelledProject(), { styleId, music, targetDurationSec: target, attempt, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle } });

describe('accepted editing styles never break an edit the defaults can build', () => {
  for (const [label, style] of STYLES_TO_TRY) {
    it(label, () => {
      const failures: string[] = [];
      let checked = 0;
      for (const styleId of STYLE_IDS)
        for (const [musicLabel, music] of MUSIC)
          for (const target of [15, 30, 45])
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

describe('last resort: an edit the editing style cannot build is built without it', () => {
  const i = input('process_story', clickTrack(), 20, 0, { ...DEFAULT_EDITING_STYLE, beatSync: 'on', beatsPerCut: 4 });
  const s = effectiveSettings(i);
  const footage = collectFootage(i.analyses, i.assets);
  const real = (inp: PlannerInput, set: EffectiveSettings, _f: typeof footage) => planner.plan({ ...inp, preferences: { ...inp.preferences, editingStyle: set.styleFromVideos ? inp.preferences.editingStyle : DEFAULT_EDITING_STYLE } });

  it('retries without the editing style and says so in the plan', () => {
    const seen: boolean[] = [];
    const plan = buildWithStyleFallback(i, { ...s, notes: [...s.notes] }, footage, (inp, set, f) => {
      seen.push(Boolean(set.styleFromVideos));
      if (set.styleFromVideos) throw new AppError('PROCESSING_FAILED', 'The process story could not be built from this footage.');
      expect(set.notes.at(-1)).toContain('could not be fitted to this footage');
      return real(inp, set, f);
    });
    expect(seen).toEqual([true, false]);
    expect(plan.segments.length).toBeGreaterThan(1);
  });

  it('passes on cancellations and errors that are not about building', () => {
    expect(() => buildWithStyleFallback(i, s, footage, () => { throw new CancelledError(); })).toThrow(CancelledError);
    expect(() => buildWithStyleFallback(i, s, footage, () => { throw new AppError('UNSUPPORTED', 'x'); })).toThrow('x');
  });
});
