import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITING_STYLE,
  DEFAULT_SETTINGS,
  STYLE_IDS,
  computeTimeline,
  validateEditPlan,
  type EditPlan,
  type EditingPreferences,
  type EditingStyle,
  type PlanValidationContext,
  type StyleId,
} from '@studio/core';
import { RulesPlanner } from '../src/rules/planner.js';
import { strongestBeat } from '../src/rules/music.js';
import { allowedTransitionsFor, buildPlannerUserContent } from '../src/anthropic/prompts.js';
import type { PlannerInput } from '../src/types.js';
import { clickTrack, labelledProject, plannerInput } from './fixtures.js';

const planner = new RulesPlanner();

/** A synthetic 120 BPM track (beat every 0.5 s from 0) with a clear drop at 24 s, 40 s long. */
function dropTrack(): NonNullable<PlannerInput['music']> {
  const beats: number[] = [];
  for (let t = 0; t < 40; t += 0.5) beats.push(Math.round(t * 1000) / 1000);
  const energy = Array.from({ length: 160 }, (_, i) => {
    const t = i * 0.25;
    const level = t >= 24 ? 1 : 0.126;
    return Math.round(level * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000;
  });
  return { trackId: 'drop-1', durationSec: 40, bpm: 120, beatTimesSec: beats, title: 'Synthetic drop 120', energy, energyStepSec: 0.25 };
}

const ACCEPTED: EditingStyle = {
  ...DEFAULT_EDITING_STYLE,
  transitionPalette: { hardCutShare: 1, types: [], durationSec: 0.3, accent: { type: 'fadewhite', everyBeats: 4, durationSec: 0.2 } },
  beatSync: 'on',
  beatsPerCut: 2,
  reveal: 'strongest_beat',
  zoom: { mode: 'punch_in', scale: 1.2, shareOfCuts: 0.25 },
};

const prefsWith = (style: EditingStyle): EditingPreferences => ({ ...DEFAULT_SETTINGS.preferences, editingStyle: style });

function contextFor(input: PlannerInput, extra: Partial<PlanValidationContext> = {}): PlanValidationContext {
  const transcripts: PlanValidationContext['transcripts'] = {};
  for (const a of input.analyses) if (a.transcript?.segments.length) transcripts[a.assetId] = a.transcript.segments;
  const target = input.targetDurationSec;
  return {
    assets: input.assets,
    music: input.music ? { trackId: input.music.trackId, durationSec: input.music.durationSec } : null,
    transcripts,
    durationBounds: { min: target * 0.85, max: target * 1.15 },
    extraStyleTransitions: ['fadewhite'],
    ...extra,
  };
}

const music = dropTrack();
/** The labelled project filmed in 4K, so a 1.2× punch-in does not soften the export (the zoom cap). */
const project4k = () => labelledProject().map((a) => ({ ...a, probe: { ...a.probe, video: a.probe.video ? { ...a.probe.video, displayWidth: 2160, displayHeight: 3840 } : null } }));
const inputFor = (styleId: StyleId, style: EditingStyle, extra: Partial<PlannerInput> = {}) =>
  plannerInput(project4k(), { styleId, targetDurationSec: 20, music, preferences: prefsWith(style), ...extra });

/** Felt moment of each join: an accent's peak (20 % in), otherwise the end of its transition. */
function joins(plan: EditPlan): Array<{ t: number; type: string | null }> {
  return computeTimeline(plan)
    .segments.filter((p) => p.index > 0)
    .map((p) => {
      const tr = p.segment.transitionIn;
      const accent = tr && (tr.type === 'fadewhite' || tr.type === 'fadeblack');
      return { t: p.startSec + (tr ? (accent ? 0.2 * tr.durationSec : tr.durationSec) : 0), type: tr?.type ?? null };
    });
}

/** Beat index (from where the music starts) and distance of output time t to the nearest track beat. */
function beatOf(plan: EditPlan, t: number): { index: number; dist: number } {
  const offset = plan.audio.music!.startOffsetSec;
  let best = { index: -1, dist: Number.POSITIVE_INFINITY };
  for (const b of music.beatTimesSec) {
    const d = Math.abs(b - offset - t);
    if (d < best.dist) best = { index: Math.round((b - offset) / 0.5), dist: d };
  }
  return best;
}

describe('editing style from your videos in the rules planner', () => {
  it('defaults: all plans are identical to before this feature (stored snapshot)', () => {
    const plans: unknown[] = [];
    for (const styleId of STYLE_IDS)
      for (const m of [null, clickTrack()])
        for (const attempt of [0, 1])
          for (const beatSync of [undefined, 'on'] as const) plans.push(planner.plan(plannerInput(labelledProject(), { styleId, music: m, attempt, ...(beatSync ? { beatSync } : {}), revealOnBeat: beatSync === 'on' })));
    // Hash of the same 40 plans computed on commit 5801c8c, before the editing style existed.
    expect(createHash('sha256').update(JSON.stringify(plans)).digest('hex')).toBe('a3db9b9764310e7a2e2c148fe40be720014bd9523edd103607ff8efe5f5f398d');
  });

  it('finds the strongest beat of the synthetic track', () => {
    expect(strongestBeat(music)).toMatchObject({ found: true, atSec: 24 });
    expect(strongestBeat(clickTrack())).toBeNull();
  });

  const accepted = new Map<StyleId, EditPlan>();
  const defaults = new Map<StyleId, EditPlan>();
  for (const styleId of STYLE_IDS) {
    accepted.set(styleId, planner.plan(inputFor(styleId, ACCEPTED)));
    defaults.set(styleId, planner.plan(inputFor(styleId, DEFAULT_EDITING_STYLE)));
  }

  it('every plan passes validateEditPlan with no errors and the five still differ', () => {
    for (const styleId of STYLE_IDS) {
      const res = validateEditPlan(accepted.get(styleId)!, contextFor(inputFor(styleId, ACCEPTED)));
      expect(res.errors, styleId).toEqual([]);
      expect(res.warnings.filter((w) => w.code === 'OFF_STYLE_TRANSITION')).toEqual([]);
      expect(JSON.stringify(accepted.get(styleId)!.segments)).not.toBe(JSON.stringify(defaults.get(styleId)!.segments));
    }
    const signatures = new Set(STYLE_IDS.map((id) => accepted.get(id)!.segments.map((s) => `${s.assetId}@${s.inSec.toFixed(2)}`).join('>')));
    expect(signatures.size).toBe(5);
  });

  it('beat montage: hard cuts except accents, white flashes peaking on every 4th beat, 2-beat shots', () => {
    const plan = accepted.get('beat_montage')!;
    const js = joins(plan);
    expect(js.every((j) => j.type === null || j.type === 'fadewhite')).toBe(true);
    const flashes = js.filter((j) => j.type === 'fadewhite');
    expect(flashes.length).toBeGreaterThanOrEqual(1);
    for (const f of flashes) {
      const b = beatOf(plan, f.t);
      expect(b.dist).toBeLessThanOrEqual(0.04);
      expect(b.index % 4).toBe(0);
    }
    const plays = computeTimeline(plan).segments.slice(1, -1).map((p) => p.playDurationSec).sort((a, b) => a - b);
    const median = plays[Math.floor(plays.length / 2)]!;
    expect(median / 0.5).toBeGreaterThanOrEqual(1.5);
    expect(median / 0.5).toBeLessThanOrEqual(2.5);
    expect(plan.rationale).toContain('white flash on every 4th beat, from your style');
  });

  it('process story: at least 70 % of cuts land within 40 ms of a beat', () => {
    const plan = accepted.get('process_story')!;
    const js = joins(plan);
    const onBeat = js.filter((j) => beatOf(plan, j.t).dist <= 0.04).length;
    expect(onBeat / js.length).toBeGreaterThanOrEqual(0.7);
  });

  it('reveal: the first result shot lands on the strongest beat (music start automatic)', () => {
    let checked = 0;
    for (const styleId of ['cinematic_reveal', 'before_after', 'process_story'] as const) {
      const plan = accepted.get(styleId)!;
      const placed = computeTimeline(plan).segments;
      const reveal = styleId === 'before_after' ? placed.find((p) => p.index > 0 && p.segment.role === 'result') : placed.find((p) => p.index > 0 && p.segment.role === 'result');
      if (!reveal) continue;
      const tr = reveal.segment.transitionIn;
      const felt = reveal.startSec + (tr ? (tr.type === 'fadewhite' ? 0.2 * tr.durationSec : tr.durationSec) : 0);
      const strongestOut = 24 - plan.audio.music!.startOffsetSec;
      expect(Math.abs(felt - strongestOut), styleId).toBeLessThanOrEqual(0.1);
      expect(plan.rationale).toContain("biggest lift in 'Synthetic drop 120' (estimate)");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it('punch-in: the same shot continues with a static 1.2× zoom; never above 1.25', () => {
    let pairs = 0;
    for (const styleId of STYLE_IDS) {
      const segs = accepted.get(styleId)!.segments;
      for (const s of segs) if (s.zoom) expect(Math.max(s.zoom.from, s.zoom.to)).toBeLessThanOrEqual(1.25);
      for (let i = 1; i < segs.length; i++) {
        const a = segs[i - 1]!;
        const b = segs[i]!;
        if (a.assetId === b.assetId && Math.abs(a.outSec - b.inSec) < 0.002 && b.zoom && b.zoom.from === 1.2 && b.zoom.to === 1.2) pairs++;
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(1);
  });

  it('clean promo stays calm: no flash and no punch-in', () => {
    const plan = accepted.get('clean_promo')!;
    expect(plan.segments.some((s) => s.transitionIn?.type === 'fadewhite')).toBe(false);
    expect(plan.segments.some((s) => s.zoom && s.zoom.from === s.zoom.to && s.zoom.from > 1)).toBe(false);
    expect(plan.rationale).toContain('Clean promo stays calm');
  });

  it('"remove the flashy transitions" removes every accent and passes restrained validation', () => {
    for (const styleId of STYLE_IDS) {
      const input = inputFor(styleId, ACCEPTED, { previousPlan: accepted.get(styleId)!, revisionInstruction: 'remove the flashy transitions' });
      const plan = planner.plan(input);
      expect(plan.segments.some((s) => s.transitionIn?.type === 'fadewhite'), styleId).toBe(false);
      expect(validateEditPlan(plan, contextFor(input, { restrainedTransitionsOnly: true })).errors, styleId).toEqual([]);
    }
  });

  it('dismissed suggestions leave plans as the defaults, and plans are deterministic', () => {
    const dismissed: EditingStyle = { ...DEFAULT_EDITING_STYLE, summaryDecisions: { transitionPalette: { decision: 'dismissed', valueKey: 'x', at: '2026-11-15T00:00:00Z' } } };
    for (const styleId of STYLE_IDS) {
      expect(planner.plan(inputFor(styleId, dismissed))).toEqual(defaults.get(styleId));
      expect(planner.plan(inputFor(styleId, ACCEPTED))).toEqual(accepted.get(styleId));
    }
  });

  it('a style without a beat still gets its palette (cross-fades) and push-ins', () => {
    const style: EditingStyle = { ...DEFAULT_EDITING_STYLE, transitionPalette: { hardCutShare: 0.5, types: ['fade'], durationSec: 0.5, accent: null }, zoom: { mode: 'push_in', scale: 1.06 } };
    for (const styleId of STYLE_IDS) {
      const input = plannerInput(labelledProject(), { styleId, targetDurationSec: 20, preferences: prefsWith(style) });
      const plan = planner.plan(input);
      expect(validateEditPlan(plan, contextFor(input, { extraStyleTransitions: ['fade'] })).errors, styleId).toEqual([]);
      for (const s of plan.segments) if (s.zoom) expect(s.zoom.to <= 1.06 + 1e-9 || s.zoom.from > 1).toBe(true);
    }
  });
});

describe('editing style in the AI brief', () => {
  it('includes editingStyle with the reveal time and allows the palette types', () => {
    const input = inputFor('process_story', ACCEPTED);
    const text = buildPlannerUserContent(input)[0]!.text;
    const job = JSON.parse(text.replace(/^Job description \(JSON\):\n/, '')) as Record<string, any>;
    expect(job['editingStyle']).toMatchObject({ beatSync: 'on', beatsPerCut: 2, reveal: { mode: 'strongest_beat' }, zoom: { mode: 'punch_in', scale: 1.2 } });
    expect(typeof job['editingStyle'].reveal.targetOutputSec).toBe('number');
    expect(job['constraints'].allowedTransitions).toContain('fadewhite');
    const flashy = { ...DEFAULT_EDITING_STYLE, transitionPalette: { hardCutShare: 0.5, types: ['slideup' as const], durationSec: 0.3, accent: null } };
    expect(allowedTransitionsFor(inputFor('clean_promo', flashy, { preferences: { ...prefsWith(flashy), transitions: 'varied' } }))).toContain('slideup');
    // With restrained transitions (the default preference) the flashy palette type is not offered.
    expect(allowedTransitionsFor(inputFor('clean_promo', flashy))).not.toContain('slideup');
    const plain = JSON.parse(buildPlannerUserContent(plannerInput(labelledProject()))[0]!.text.replace(/^Job description \(JSON\):\n/, '')) as Record<string, unknown>;
    expect(plain['editingStyle']).toBeUndefined();
  });

  it('a fake AI plan using the palette types raises no OFF_STYLE_TRANSITION warning', () => {
    const input = inputFor('process_story', ACCEPTED);
    const plan = structuredClone(planner.plan(input));
    const i = plan.segments.findIndex((s, k) => k > 0 && !s.transitionIn);
    if (i > 0) plan.segments[i]!.transitionIn = { type: 'fadewhite', durationSec: 0.2 };
    const res = validateEditPlan(plan, contextFor(input));
    expect(res.warnings.filter((w) => w.code === 'OFF_STYLE_TRANSITION')).toEqual([]);
    const without = validateEditPlan(plan, contextFor(input, { extraStyleTransitions: [] }));
    expect(without.warnings.some((w) => w.code === 'OFF_STYLE_TRANSITION')).toBe(true);
  });
});
