import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITING_STYLE, DEFAULT_SETTINGS, STYLE_IDS, computeTimeline, type EditPlan, type EditingStyle, type StyleId, type TransitionPalette } from '@studio/core';
import { RulesPlanner } from '../src/rules/planner.js';
import type { PlannerInput } from '../src/types.js';
import { clickTrack, labelledProject, plannerInput } from './fixtures.js';

/**
 * The plan note for the transitions accepted from the owner's videos says what the plan has (design §4.3.1.6): every
 * accent (white flash or dip to black) it claims is in the plan's segments where it says, and every accent the plan has
 * is described. The note is read here as text and checked against the segments, timed as the renderer plays them; this
 * test does not use the planner's own wording code. SYNTHETIC tracks and footage.
 */
const planner = new RulesPlanner();

/** A 40 s, 120 BPM track whose beats start at 0 s (the click track's start at 0.05 s), with a loud part from 24 s. */
function dropTrack(): NonNullable<PlannerInput['music']> {
  const beats = Array.from({ length: 80 }, (_, i) => i * 0.5);
  const energy = Array.from({ length: 160 }, (_, i) => Math.round((i * 0.25 >= 24 ? 1 : 0.126) * (i % 2 === 0 ? 1 : 0.3) * 1000) / 1000);
  return { trackId: 'drop-1', durationSec: 40, bpm: 120, beatTimesSec: beats, title: 'Synthetic drop 120', energy, energyStepSec: 0.25 };
}

const PALETTES: Array<[string, TransitionPalette]> = [
  ['straight cuts, a white flash every 4 beats', { hardCutShare: 1, types: [], durationSec: 0.3, accent: { type: 'fadewhite', everyBeats: 4, durationSec: 0.2 } }],
  ['straight cuts, a white flash every 8 beats', { hardCutShare: 1, types: [], durationSec: 0.3, accent: { type: 'fadewhite', everyBeats: 8, durationSec: 0.2 } }],
  ['straight cuts, a dip to black every 4 beats', { hardCutShare: 1, types: [], durationSec: 0.3, accent: { type: 'fadeblack', everyBeats: 4, durationSec: 0.25 } }],
  ['straight cuts, a dip to black at the reveal', { hardCutShare: 1, types: [], durationSec: 0.3, accent: { type: 'fadeblack', everyBeats: null, durationSec: 0.25 } }],
  ['half cross-fades, a white flash every 4 beats', { hardCutShare: 0.5, types: ['fade'], durationSec: 0.5, accent: { type: 'fadewhite', everyBeats: 4, durationSec: 0.2 } }],
];
const TRACKS: Array<[string, PlannerInput['music']]> = [
  ['click track', clickTrack()],
  ['drop track', dropTrack()],
  ['no music', null],
];

/** The segment index of the finished look: the beat montage's and the cinematic reveal's last shot, otherwise the first result shot. */
function revealAt(plan: EditPlan, styleId: StyleId): number {
  if (styleId === 'beat_montage' || styleId === 'cinematic_reveal') return plan.segments.length - 1;
  return plan.segments.findIndex((s, i) => i > 0 && s.role === 'result');
}

interface Accent {
  index: number;
  peakSec: number;
  /** Index of the beat nearest the peak, counted from where the music starts (the montage's 120 BPM grid without music). */
  beat: number;
  onBeat: boolean;
}

/** The plan's accents of `type`, timed as it plays: each peak 20 % into its transition (as the renderer's xfade peaks). */
function accentsOf(plan: EditPlan, music: PlannerInput['music'], type: 'fadewhite' | 'fadeblack'): Accent[] {
  const start = plan.audio.music?.startOffsetSec ?? 0;
  const beats = music ? music.beatTimesSec.map((b) => b - start).filter((b) => b > -0.001) : Array.from({ length: 200 }, (_, k) => k * 0.5);
  return computeTimeline(plan)
    .segments.map((p, index) => ({ p, index }))
    .filter(({ p, index }) => index > 0 && p.segment.transitionIn?.type === type)
    .map(({ p, index }) => {
      const peakSec = p.startSec + 0.2 * p.segment.transitionIn!.durationSec;
      let beat = 0;
      beats.forEach((b, k) => (Math.abs(b - peakSec) < Math.abs(beats[beat]! - peakSec) ? (beat = k) : null));
      return { index, peakSec, beat, onBeat: Math.abs(beats[beat]! - peakSec) <= 0.04 + 1e-6 };
    });
}

/** The accent part of the note for the accepted transitions ("Straight cuts with …, from your style."), or null. */
function accentClaimOf(rationale: string): { note: string; claim: string | null } | null {
  const m = rationale.match(/(?:Straight cuts|(?:Cross-fades|Transitions) as in your videos)(?:,? with (.*?))?, from your style\./);
  return m ? { note: m[0], claim: m[1] ?? null } : null;
}

const NOUN = '(?:white flash|dip to black)';
const NOUNS = '(?:white flashes|dips to black)';
const toSec = (mss: string) => Number(mss.split(':')[0]) * 60 + Number(mss.split(':')[1]);

/** Checks the claim against the plan's accents; returns what does not hold (empty when the note is true). */
function problemsWith(claim: string | null, accents: Accent[], reveal: number, montage: boolean, totalSec: number): string[] {
  const problems: string[] = [];
  const atReveal = accents.filter((a) => a.index === reveal);
  const rest = accents.filter((a) => a.index !== reveal);
  if (!claim) {
    if (accents.length) problems.push(`the note claims no accent but the plan has ${accents.length}`);
    return problems;
  }
  let text = claim;
  let described = 0;
  const take = (re: RegExp) => {
    const m = text.match(re);
    if (m) text = text.slice(m[0].length).replace(/^,(?: and)? /, '');
    return m;
  };
  // "a white flash on every 4th beat (from m:ss to m:ss)", "a white flash on a 4th beat", "3 white flashes, each on a 4th beat"
  const every = take(new RegExp(`^an? ${NOUN} on every (4th|8th) beat(?: from (\\d+:\\d{2}) to (\\d+:\\d{2}))?`));
  const one = every ? null : take(new RegExp(`^an? ${NOUN} on an? (4th|8th) beat`));
  const each = every || one ? null : take(new RegExp(`^(\\d+) ${NOUNS}, each on an? (4th|8th) beat`));
  const n = Number((every ?? one ?? each)?.[each ? 2 : 1]?.charAt(0) ?? 0);
  const onNth = montage ? rest.filter((a) => a.onBeat && n > 0 && a.beat % n === 0) : [];
  if (every) {
    // Every n-th beat in the range has one (the whole edit without a range), and these are all the plan has there.
    const from = every[2] ? toSec(every[2]) : 0;
    const to = every[3] ? toSec(every[3]) + 1 : totalSec;
    const wanted: number[] = [];
    for (let k = n; k * 0.5 < to + 1e-9; k += n) if (k * 0.5 >= from - 1e-9 && k * 0.5 < totalSec) wanted.push(k);
    const have = new Set(onNth.map((a) => a.beat));
    const missing = wanted.filter((k) => !have.has(k));
    if (!montage) problems.push(`claims a flash on every ${n}th beat, but the style places accents only at the reveal`);
    if (missing.length) problems.push(`claims every ${n}th beat${every[2] ? ` from ${every[2]} to ${every[3]}` : ''}, but beats ${missing.join(', ')} have none`);
    if (wanted.length < 3) problems.push(`claims every ${n}th beat for only ${wanted.length} beats`);
    described += onNth.length;
  } else if (one || each) {
    const claimed = one ? 1 : Number(each![1]);
    if (onNth.length !== claimed) problems.push(`claims ${claimed} on ${n}th beats, the plan has ${onNth.length}`);
    described += onNth.length;
  }
  if (take(new RegExp(`^(?:an? ${NOUN}|one) at the reveal`))) {
    if (atReveal.length !== 1) problems.push('claims one at the reveal, the plan has none there');
    described += atReveal.length;
  }
  const more = take(new RegExp(`^(?:(one|\\d+) more|an? ${NOUN}|(\\d+) ${NOUNS})$`));
  if (more) {
    const claimed = more[1] ? (more[1] === 'one' ? 1 : Number(more[1])) : more[2] ? Number(more[2]) : 1;
    const others = rest.length - onNth.length;
    if (others !== claimed) problems.push(`claims ${claimed} more, the plan has ${others} more`);
    described += others;
  }
  if (text.length) problems.push(`unread part of the note: "${text}"`);
  if (described !== accents.length) problems.push(`describes ${described} of the plan's ${accents.length} accents`);
  return problems;
}

describe('the note for the transitions from your videos says what the plan has', () => {
  it('every accent the note claims is in the plan where it says, and every accent in the plan is described', () => {
    const problems: string[] = [];
    let plans = 0;
    let withAccents = 0;
    for (const [paletteName, palette] of PALETTES)
      for (const [trackName, music] of TRACKS)
        for (const styleId of STYLE_IDS)
          for (const targetDurationSec of [15, 20, 30])
            for (const attempt of [0, 1]) {
              const style: EditingStyle = { ...DEFAULT_EDITING_STYLE, transitionPalette: palette };
              const plan = planner.plan(plannerInput(labelledProject(), { styleId, targetDurationSec, music, attempt, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle: style } }));
              const where = `${paletteName} | ${trackName} | ${styleId} ${targetDurationSec} s take ${attempt + 1}`;
              const accents = accentsOf(plan, music, palette.accent!.type);
              plans++;
              if (accents.length) withAccents++;
              if (styleId === 'clean_promo') {
                // Clean promo stays calm: it says so and has no accent.
                if (!plan.rationale.includes('Clean promo stays calm, so it keeps straight cuts but no flashes.')) problems.push(`${where}: no calm note`);
                if (accents.length) problems.push(`${where}: ${accents.length} accents in a calm clean promo`);
                continue;
              }
              const parsed = accentClaimOf(plan.rationale);
              if (!parsed) {
                // Only a beat montage with no accent placed has no note for its transitions.
                if (styleId !== 'beat_montage' || accents.length) problems.push(`${where}: no note for the transitions, ${accents.length} accents`);
                continue;
              }
              const total = computeTimeline(plan).totalDurationSec;
              for (const p of problemsWith(parsed.claim, accents, revealAt(plan, styleId), styleId === 'beat_montage', total)) problems.push(`${where}: "${parsed.note}" ${p}`);
            }
    expect(problems).toEqual([]);
    expect(plans).toBe(5 * 3 * 5 * 3 * 2);
    expect(withAccents).toBeGreaterThan(plans / 2);
  });

  it('describes the single accent of a fitted style where it is, and the montage only says "every 4th beat" for an unbroken run', () => {
    const style: EditingStyle = { ...DEFAULT_EDITING_STYLE, transitionPalette: PALETTES[0]![1] };
    const planFor = (styleId: StyleId, targetDurationSec: number, attempt = 0) =>
      planner.plan(plannerInput(labelledProject(), { styleId, targetDurationSec, music: clickTrack(), attempt, preferences: { ...DEFAULT_SETTINGS.preferences, editingStyle: style } }));
    // The cinematic reveal places one flash, into the reveal: before, its note said "a white flash on every 4th beat".
    const cinematic = planFor('cinematic_reveal', 20);
    const flashes = accentsOf(cinematic, clickTrack(), 'fadewhite');
    expect(flashes.map((a) => a.index)).toEqual([revealAt(cinematic, 'cinematic_reveal')]);
    expect(cinematic.rationale).toContain('Straight cuts with a white flash at the reveal, from your style.');
    expect(cinematic.rationale).not.toContain('every 4th beat');
    // A montage whose flashes fall on every 4th beat from 0:04 to 0:12 says so ...
    const run = planFor('beat_montage', 15);
    expect(accentsOf(run, clickTrack(), 'fadewhite').map((a) => a.beat)).toEqual([8, 12, 16, 20, 24]);
    expect(run.rationale).toContain('Straight cuts with a white flash on every 4th beat from 0:04 to 0:12, from your style.');
    // ... one with gaps counts them, and the one at the reveal (into the final shot) is named.
    const gaps = planFor('beat_montage', 15, 1);
    expect(accentsOf(gaps, clickTrack(), 'fadewhite').map((a) => a.beat)).toEqual([12, 20, 24, 26]);
    expect(gaps.rationale).toContain('Straight cuts with 3 white flashes, each on a 4th beat, and one at the reveal, from your style.');
  });
});
