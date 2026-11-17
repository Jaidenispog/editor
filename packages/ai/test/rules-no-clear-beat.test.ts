import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITING_STYLE,
  DEFAULT_SETTINGS,
  STYLE_IDS,
  computePlanFacts,
  computeTimeline,
  validateEditPlan,
  type EditPlan,
  type EditingStyle,
  type PlanValidationContext,
  type StyleId,
} from '@studio/core';
import { toPlanCandidate } from '../src/anthropic/planner.js';
import type { PlannerWire } from '../src/anthropic/schemas.js';
import { NO_CLEAR_BEAT_NOTES } from '../src/rules/music.js';
import { RulesPlanner } from '../src/rules/planner.js';
import type { PlannerInput } from '../src/types.js';
import { labelledProject, plannerInput } from './fixtures.js';

/**
 * A track with no clear beat: the beat tracker finds none (and a track with 3 beats, too few for the planners to cut
 * to). The planners keep a steady stand-in rhythm (the beat montage still cuts to it, and says so), but it is not the
 * music's beat: no plan reports cuts on it, no plan note claims a beat, and nothing is moved onto it for the beat's sake.
 * SYNTHETIC tracks: 40 s, a loud section from 12 s (or `liftAtSec`).
 */
const planner = new RulesPlanner();

function noBeatTrack(beatTimesSec: number[] = [], liftAtSec = 12): NonNullable<PlannerInput['music']> {
  const energy = Array.from({ length: 160 }, (_, i) => Math.round((i * 0.25 >= liftAtSec ? 1 : 0.126) * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000);
  return { trackId: 'ambient', durationSec: 40, bpm: null, beatTimesSec, title: 'Ambient', energy, energyStepSec: 0.25 };
}

const ACCEPTED: EditingStyle = {
  ...DEFAULT_EDITING_STYLE,
  transitionPalette: { hardCutShare: 1, types: [], durationSec: 0.3, accent: { type: 'fadewhite', everyBeats: 4, durationSec: 0.2 } },
  beatSync: 'on',
  beatsPerCut: 2,
  reveal: 'strongest_beat',
  zoom: { mode: 'punch_in', scale: 1.2, shareOfCuts: 0.25 },
};
const STYLES: Array<[string, EditingStyle]> = [
  ['default', DEFAULT_EDITING_STYLE],
  ['accepted', ACCEPTED],
];
/** The beat options of the Sound panel: none, or "Cut to the beat" and "Land the reveal on a beat" both on. */
const OPTIONS: Array<[string, Partial<PlannerInput>]> = [
  ['no options', {}],
  ['beat and reveal on', { beatSync: 'on', revealOnBeat: true }],
];
/** 4K footage, so a 1.2× punch-in is not capped (the zoom cap) and the accepted zoom really applies. */
const project4k = () => labelledProject().map((a) => ({ ...a, probe: { ...a.probe, video: a.probe.video ? { ...a.probe.video, displayWidth: 2160, displayHeight: 3840 } : null } }));

const inputFor = (styleId: StyleId, music: PlannerInput['music'], style: EditingStyle, extra: Partial<PlannerInput> = {}) =>
  plannerInput(project4k(), { styleId, targetDurationSec: 30, music, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle: style }, ...extra });

function contextFor(input: PlannerInput): PlanValidationContext {
  const transcripts: PlanValidationContext['transcripts'] = {};
  for (const a of input.analyses) if (a.transcript?.segments.length) transcripts[a.assetId] = a.transcript.segments;
  const target = input.targetDurationSec;
  return { assets: input.assets, music: input.music ? { trackId: input.music.trackId, durationSec: input.music.durationSec } : null, transcripts, durationBounds: { min: target * 0.85, max: target * 1.15 }, extraStyleTransitions: ['fadewhite'] };
}

/** Output time a segment is fully on screen (its cut, or the end of its incoming transition). */
const feltAt = (p: ReturnType<typeof computeTimeline>['segments'][number]) => p.startSec + (p.segment.transitionIn?.durationSec ?? 0);

/** The AI plan's own fields around the model's segments (taken here from a rules plan), claiming every cut is on a beat. */
function wireClaimingEveryCut(plan: EditPlan): PlannerWire {
  const cuts = computeTimeline(plan).segments.slice(1).map((p) => p.startSec);
  return {
    title: plan.title,
    description: plan.description,
    rationale: plan.rationale,
    segments: plan.segments,
    textOverlays: plan.textOverlays,
    captions: plan.captions,
    audio: { ...plan.audio, beatAlignment: { bpm: 120, alignedCutTimesSec: cuts } },
    colourPreset: plan.colourPreset,
  } as unknown as PlannerWire;
}

/** Plan notes that say something lands on, or was moved onto, a beat of the music. */
const BEAT_CLAIM = /on the beat|beat of |onto the beat|lands? on a (down)?beat|starts on a beat|downbeat|whole steps of \d+ beats?|beat cuts/i;

/** The cuts of a plan: each segment without the original-sound flag (which depends on whether music plays). */
const cutsOf = (plan: EditPlan) => plan.segments.map(({ keepOriginalSound: _sound, ...seg }) => seg);

describe('a track with no clear beat', () => {
  it('neither planner reports cuts on the beat, plan facts say none, and no plan note claims a beat', () => {
    let plans = 0;
    for (const beats of [[], [1, 2, 3]])
      for (const styleId of STYLE_IDS)
        for (const [label, style] of STYLES)
          for (const [options, extra] of OPTIONS)
            for (const attempt of [0, 1]) {
              const key = `${beats.length} beats ${styleId} ${label} ${options} take ${attempt + 1}`;
              const input = inputFor(styleId, noBeatTrack(beats), style, { ...extra, attempt });
              const plan = planner.plan(input);
              expect(validateEditPlan(plan, contextFor(input)).errors, key).toEqual([]);
              expect(plan.audio.music?.trackId, key).toBe('ambient');
              expect(plan.audio.beatAlignment, key).toBeNull();
              expect(computePlanFacts(plan).beatAligned, key).toBe(false);
              expect(plan.rationale, key).not.toMatch(BEAT_CLAIM);
              // An AI plan with the same cuts, whose model claims every cut, reports nothing either (3 of its cuts may
              // even fall on the 3 beats: too few for a beat).
              expect((toPlanCandidate(wireClaimingEveryCut(plan), input) as EditPlan).audio.beatAlignment, key).toBeNull();
              plans++;
            }
    expect(plans).toBe(2 * 5 * 2 * 2 * 2);
  });

  it('nothing is moved onto the stand-in rhythm: the cuts are those of the same edit without music', () => {
    for (const beats of [[], [1, 2, 3]])
      for (const styleId of STYLE_IDS)
        for (const [label, style] of STYLES)
          for (const [options, extra] of OPTIONS) {
            // The beat montage cuts to its stand-in: 120 BPM, as without music, for a track without beats; the tempo of
            // the few beats (60 BPM) for the one with 3 (below).
            if (styleId === 'beat_montage' && beats.length > 0) continue;
            const key = `${beats.length} beats ${styleId} ${label} ${options}`;
            const withTrack = planner.plan(inputFor(styleId, noBeatTrack(beats), style, extra));
            const silent = planner.plan(inputFor(styleId, null, style, extra));
            expect(cutsOf(withTrack), key).toEqual(cutsOf(silent));
          }
  });

  it('the beat montage keeps its steady rhythm from where the music starts and says the track has no clear beat', () => {
    for (const attempt of [0, 1]) {
      const plan = planner.plan(inputFor('beat_montage', noBeatTrack(), DEFAULT_EDITING_STYLE, { attempt }));
      // The music starts where it did before (the stand-in starts a bar later on each take), and every cut is on the
      // 120 BPM stand-in from there.
      expect(plan.audio.music?.startOffsetSec).toBe(attempt * 2);
      for (const p of computeTimeline(plan).segments.slice(1)) expect(Math.abs(feltAt(p) / 0.5 - Math.round(feltAt(p) / 0.5))).toBeLessThan(0.02);
      expect(plan.rationale).toContain('Opens on the strongest detail shot, cuts through the work to a steady rhythm and holds the finished cut at the end.');
      expect(plan.rationale).toContain('"Ambient" has no clear beat, so the cuts follow a steady 120 BPM rhythm.');
    }
    // 3 beats a second apart: the stand-in rhythm takes their tempo.
    const three = planner.plan(inputFor('beat_montage', noBeatTrack([1, 2, 3]), DEFAULT_EDITING_STYLE));
    for (const p of computeTimeline(three).segments.slice(1)) expect(Math.abs(feltAt(p) - Math.round(feltAt(p)))).toBeLessThan(0.02);
    expect(three.rationale).toContain('"Ambient" has no clear beat, so the cuts follow a steady 60 BPM rhythm.');
  });

  it('says why the beat options and the reveal on a beat do nothing, in one sentence when both apply', () => {
    const both = planner.plan(inputFor('clean_promo', noBeatTrack(), DEFAULT_EDITING_STYLE, { beatSync: 'on', revealOnBeat: true }));
    expect(both.rationale).toContain(NO_CLEAR_BEAT_NOTES.cutsAndReveal);
    expect(both.rationale).not.toContain(NO_CLEAR_BEAT_NOTES.cuts);
    expect(both.rationale).not.toContain(NO_CLEAR_BEAT_NOTES.reveal);
    const cuts = planner.plan(inputFor('clean_promo', noBeatTrack(), DEFAULT_EDITING_STYLE, { beatSync: 'on' }));
    expect(cuts.rationale).toContain(NO_CLEAR_BEAT_NOTES.cuts);
    const reveal = planner.plan(inputFor('process_story', noBeatTrack(), DEFAULT_EDITING_STYLE, { revealOnBeat: true }));
    expect(reveal.rationale).toContain(NO_CLEAR_BEAT_NOTES.reveal);
    // Nothing is said when nothing was asked.
    const plain = planner.plan(inputFor('clean_promo', noBeatTrack(), DEFAULT_EDITING_STYLE));
    expect(plain.rationale).not.toMatch(/no clear beat/);
  });

  it('still lands the reveal on the biggest lift (from the loudness) when the owner chose the start, never on a downbeat', () => {
    // A 20 s edit with the music from 0 s and the track's lift at 16.5 s: where these styles' reveals can reach it.
    const style: EditingStyle = { ...DEFAULT_EDITING_STYLE, reveal: 'strongest_beat' };
    const landed: StyleId[] = [];
    for (const styleId of STYLE_IDS) {
      const input = inputFor(styleId, noBeatTrack([], 16.5), style, { targetDurationSec: 20, musicStartSec: 0 });
      const plan = planner.plan(input);
      expect(validateEditPlan(plan, contextFor(input)).errors, styleId).toEqual([]);
      expect(plan.audio.music?.startOffsetSec, styleId).toBe(0);
      expect(plan.audio.beatAlignment, styleId).toBeNull();
      expect(plan.rationale, styleId).not.toMatch(BEAT_CLAIM);
      if (plan.rationale.includes("The finished look lands on the biggest lift in 'Ambient' (estimate).")) {
        // The lift starts in the window from 16.5 s (no beat to refine it to).
        const t = computeTimeline(plan);
        const reveal = styleId === 'beat_montage' ? t.segments[t.segments.length - 1]! : t.segments.find((p) => p.index > 0 && p.segment.role === 'result')!;
        expect(Math.abs(feltAt(reveal) - 16.625), styleId).toBeLessThanOrEqual(0.1);
        landed.push(styleId);
      } else expect(plan.rationale, styleId).toContain(NO_CLEAR_BEAT_NOTES.revealOffLift);
    }
    expect(landed).toEqual(['before_after', 'process_story']);
    // With the start on automatic the music is not moved by bars without a beat, so the reveal stays put and says why.
    const auto = planner.plan(inputFor('process_story', noBeatTrack(), style));
    expect(auto.rationale).toContain(NO_CLEAR_BEAT_NOTES.reveal);
    expect(auto.rationale).not.toMatch(BEAT_CLAIM);
  });
});
