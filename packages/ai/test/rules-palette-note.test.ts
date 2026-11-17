import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITING_STYLE,
  DEFAULT_SETTINGS,
  STYLES,
  STYLE_IDS,
  computeTimeline,
  type EditPlan,
  type EditingPreferences,
  type EditingStyle,
  type StyleId,
  type TransitionPalette,
  type TransitionType,
} from '@studio/core';
import { RulesPlanner } from '../src/rules/planner.js';
import type { PlannerInput } from '../src/types.js';
import { clickTrack, labelledProject, plannerInput } from './fixtures.js';

/**
 * The plan note for the transitions accepted from the owner's videos says what the plan has (design §4.3.1.6). It
 * credits the owner's videos only with joins their palette can have made, names the style's own joins where the plan
 * keeps them, and describes every join the plan made (straight cuts included); every accent (white flash or dip to black)
 * it claims is in the plan's segments where it says, and every accent the palette placed is described. In a revision,
 * the joins kept from the earlier version (the shots it kept, by segment id) are not the note's to credit or describe,
 * and it never says that nothing comes from the owner's videos. The note is read here as text and checked against the
 * segments, timed as the renderer plays them; this test does not use the planner's own wording code (it also reads the
 * wording before this change, so it fails on what that wording claimed). SYNTHETIC tracks and footage.
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
  ['cross-fades only', { hardCutShare: 0, types: ['fade'], durationSec: 0.4, accent: null }],
  ['half slides, a dip to black every 4 beats', { hardCutShare: 0.5, types: ['slideup'], durationSec: 0.3, accent: { type: 'fadeblack', everyBeats: 4, durationSec: 0.25 } }],
  ['wipes and slides only', { hardCutShare: 0, types: ['wipeleft', 'slideup'], durationSec: 0.3, accent: null }],
];
const TRACKS: Array<[string, PlannerInput['music']]> = [
  ['click track', clickTrack()],
  ['drop track', dropTrack()],
  ['no music', null],
];
/** The Transitions preference: restrained (the default, calm transitions only) or varied (bolder ones allowed). */
const TRANSITIONS: Array<EditingPreferences['transitions']> = ['restrained', 'varied'];

const prefsWith = (palette: TransitionPalette, transitions: EditingPreferences['transitions']): EditingPreferences => ({
  ...DEFAULT_SETTINGS.preferences,
  transitions,
  editingStyle: { ...DEFAULT_EDITING_STYLE, transitionPalette: palette } satisfies EditingStyle,
});

/** The segment index of the finished look: the beat montage's and the cinematic reveal's last shot, otherwise the first result shot. */
function revealAt(plan: EditPlan, styleId: StyleId): number {
  if (styleId === 'beat_montage' || styleId === 'cinematic_reveal') return plan.segments.length - 1;
  return plan.segments.findIndex((s, i) => i > 0 && s.role === 'result');
}

/** The kind of a join in the note's words. */
function kindOf(t: TransitionType | null): string {
  if (t === null) return 'straight cuts';
  if (t === 'fade' || t === 'dissolve') return 'cross-fades';
  if (t === 'slideup' || t === 'slidedown') return 'slides';
  if (t === 'wipeleft' || t === 'wiperight') return 'wipes';
  if (t === 'zoomin') return 'zoom transitions';
  if (t === 'circleopen') return 'iris openings';
  return t === 'fadeblack' ? 'dips to black' : 'white flashes';
}

interface Accent {
  index: number;
  peakSec: number;
  /** Index of the beat nearest the peak, counted from where the music starts (the montage's 120 BPM grid without music). */
  beat: number;
  onBeat: boolean;
}

/**
 * The plan's accents of `type`, timed as it plays: each peak 20 % into its transition (as the renderer's xfade peaks).
 * `kept`: segment indices whose joins a revision kept from the earlier version (left out).
 */
function accentsOf(plan: EditPlan, music: PlannerInput['music'], type: 'fadewhite' | 'fadeblack', kept: ReadonlySet<number> = new Set()): Accent[] {
  const start = plan.audio.music?.startOffsetSec ?? 0;
  const beats = music ? music.beatTimesSec.map((b) => b - start).filter((b) => b > -0.001) : Array.from({ length: 200 }, (_, k) => k * 0.5);
  return computeTimeline(plan)
    .segments.map((p, index) => ({ p, index }))
    .filter(({ p, index }) => index > 0 && !kept.has(index) && p.segment.transitionIn?.type === type)
    .map(({ p, index }) => {
      const peakSec = p.startSec + 0.2 * p.segment.transitionIn!.durationSec;
      let beat = 0;
      beats.forEach((b, k) => (Math.abs(b - peakSec) < Math.abs(beats[beat]! - peakSec) ? (beat = k) : null));
      return { index, peakSec, beat, onBeat: Math.abs(beats[beat]! - peakSec) <= 0.04 + 1e-6 };
    });
}

/** What the note for the accepted transitions claims, read from the plan notes. */
interface Claims {
  /** The sentences read. */
  text: string;
  /** Join kinds credited to the owner's videos (clean promo: "cross-fade lengths"). */
  credited: string[];
  /** The accent part ("a white flash at the reveal"), checked by accentProblems. */
  accents: string | null;
  /** Join kinds the note says are the style's own. */
  own: string[];
  /** "… rather than the transitions from your videos": nothing from the palette. */
  nothingFromVideos: boolean;
  /** Clean promo's "but no white flashes" (the accent kind it leaves out; "flashes" in the wording before). */
  noAccent: string | null;
}

const KIND_START = '(?:Straight cuts|Cross-fades|Slides|Wipes|Zoom transitions|Iris openings|Dips to black|White flashes)';
const ACCENT_START = '(?:An? (?:white flash|dip to black)|\\d+ (?:white flashes|dips to black))';
const wordsOf = (list: string) => list.split(/, | and /).map((w) => w.trim().toLowerCase()).filter(Boolean);

function claimsOf(rationale: string, palette: TransitionPalette): Claims | null {
  const c: Claims = { text: '', credited: [], accents: null, own: [], nothingFromVideos: false, noAccent: null };
  for (const sentence of rationale.split(/(?<=\.)\s+/)) {
    let m: RegExpMatchArray | null;
    // The wording before plan-derived joins: "Cross-fades as in your videos" / "Transitions as in your videos" credited the
    // palette's joins whatever the plan had (read generously: "Transitions" as all of them, its straight cuts included).
    if ((m = sentence.match(/^(Cross-fades|Transitions) as in your videos(?:, with (.*))?, from your style\.$/))) {
      const paletteCuts = palette.hardCutShare > 0 || palette.types.length === 0;
      c.credited.push(...(m[1] === 'Cross-fades' ? ['cross-fades'] : [...(paletteCuts ? ['straight cuts'] : []), ...palette.types.map(kindOf)]));
      c.accents = m[2] ?? null;
    } else if ((m = sentence.match(new RegExp(`^(${KIND_START}.*?|${ACCENT_START}.*?), from your style\\.$`)))) {
      const body = m[1]!;
      if (new RegExp(`^${ACCENT_START}`).test(body)) c.accents = body;
      else {
        const at = body.indexOf(' with ');
        c.credited.push(...wordsOf(at >= 0 ? body.slice(0, at) : body));
        c.accents = at >= 0 ? body.slice(at + ' with '.length) : null;
      }
    } else if ((m = sentence.match(/^Some joins keep the style's own (.*)\.$/))) c.own.push(...wordsOf(m[1]!));
    else if ((m = sentence.match(/^This style keeps its own (.*) rather than the transitions from your videos\.$/))) {
      c.own.push(...wordsOf(m[1]!));
      c.nothingFromVideos = true;
    } else if ((m = sentence.match(/^Clean promo stays calm, so it (?:uses (?:(.*) from your style but )?no (.*?)(?: from your style)?|keeps (.*) but no (flashes))\.$/))) {
      c.credited.push(...wordsOf(m[1] ?? m[3] ?? ''));
      c.noAccent = m[2] ?? m[4] ?? null;
    } else if ((m = sentence.match(/^(.*) follow your style\.$/))) c.credited.push(...wordsOf(m[1]!));
    else continue;
    c.text = `${c.text} ${sentence}`.trim();
  }
  return c.text ? c : null;
}

const NOUN = '(?:white flash|dip to black)';
const NOUNS = '(?:white flashes|dips to black)';
const toSec = (mss: string) => Number(mss.split(':')[0]) * 60 + Number(mss.split(':')[1]);

/**
 * Checks the accent part against the accents this version placed (`accents`: a revision's kept joins left out); returns
 * what does not hold (empty when it is true). `ownAccentKind`: the note names the accent's kind among the style's own (a
 * calm style's own dips to black), which accounts for any of that kind the accent part does not describe.
 */
function accentProblems(claim: string | null, accents: Accent[], reveal: number, montage: boolean, totalSec: number, ownAccentKind: boolean): string[] {
  const problems: string[] = [];
  const atReveal = accents.filter((a) => a.index === reveal);
  const rest = accents.filter((a) => a.index !== reveal);
  if (!claim) {
    if (accents.length && !ownAccentKind) problems.push(`claims no accent, but this version placed ${accents.length}`);
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
  const every = take(new RegExp(`^an? ${NOUN} on every (4th|8th) beat(?: from (\\d+:\\d{2}) to (\\d+:\\d{2}))?`, 'i'));
  const one = every ? null : take(new RegExp(`^an? ${NOUN} on an? (4th|8th) beat`, 'i'));
  const each = every || one ? null : take(new RegExp(`^(\\d+) ${NOUNS}, each on an? (4th|8th) beat`, 'i'));
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
    if (onNth.length !== claimed) problems.push(`claims ${claimed} on ${n}th beats, this version placed ${onNth.length}`);
    described += onNth.length;
  }
  if (take(new RegExp(`^(?:an? ${NOUN}|one) at the reveal`, 'i'))) {
    if (atReveal.length !== 1) problems.push('claims one at the reveal, but this version placed none there');
    described += atReveal.length;
  }
  const more = take(new RegExp(`^(?:(one|\\d+) more|an? ${NOUN}|(\\d+) ${NOUNS})$`, 'i'));
  if (more) {
    const claimed = more[1] ? (more[1] === 'one' ? 1 : Number(more[1])) : more[2] ? Number(more[2]) : 1;
    const others = rest.length - onNth.length;
    if (others !== claimed && !ownAccentKind) problems.push(`claims ${claimed} more, this version placed ${others} more`);
    described += Math.min(claimed, others);
  }
  if (text.length) problems.push(`unread part of the note: "${text}"`);
  if (ownAccentKind ? described > accents.length : described !== accents.length) problems.push(`describes ${described} of the ${accents.length} accents this version placed`);
  return problems;
}

/**
 * Checks what the note says about the joins against the plan's segments; returns what does not hold. `kept`: segment
 * indices whose joins a revision kept from the earlier version (the note neither credits nor describes them).
 */
function joinProblems(c: Claims, plan: EditPlan, styleId: StyleId, palette: TransitionPalette, kept: ReadonlySet<number>): string[] {
  const problems: string[] = [];
  const all = plan.segments.slice(1).map((s) => s.transitionIn);
  // The joins this version made.
  const joins = plan.segments.flatMap((s, i) => (i > 0 && !kept.has(i) ? [s.transitionIn] : []));
  const has = (kind: string) => joins.some((t) => kindOf(t?.type ?? null) === kind);
  const paletteKinds = new Set(palette.types.map(kindOf));
  const paletteCuts = palette.hardCutShare > 0 || palette.types.length === 0;
  const paletteFades = palette.types.some((t) => t === 'fade' || t === 'dissolve');
  // Any style may cut straight; its transitions are the ones it lists.
  const styleKinds = new Set(['straight cuts', ...STYLES[styleId].transitions.map(kindOf)]);
  const accentType = palette.accent?.type ?? null;
  // Every join kind credited to the owner's videos is among the joins this version made, and is one their palette has.
  for (const kind of c.credited) {
    if (kind === 'straight cuts') {
      if (!has(kind)) problems.push('credits straight cuts, the plan made none');
      if (!paletteCuts) problems.push('credits straight cuts, but the palette has none (it never cuts straight)');
    } else if (kind === 'cross-fade lengths') {
      if (styleId !== 'clean_promo' || !paletteFades) problems.push('credits cross-fade lengths, but the palette has no cross-fades');
      else if (!joins.some((t) => t && kindOf(t.type) === 'cross-fades' && Math.abs(t.durationSec - palette.durationSec) <= 0.005)) problems.push(`credits cross-fade lengths, but no cross-fade it made is ${palette.durationSec} s long`);
    } else if (!paletteKinds.has(kind)) problems.push(`credits ${kind}, which the palette does not have`);
    else if (!has(kind)) problems.push(`credits ${kind}, the plan made none`);
  }
  // Every kind called the style's own is among the joins this version made, and is one the style uses.
  for (const kind of c.own) {
    if (!styleKinds.has(kind)) problems.push(`calls ${kind} the style's own, but the style does not use them`);
    else if (!has(kind)) problems.push(`calls ${kind} the style's own, the plan made none`);
  }
  // "Rather than the transitions from your videos": no join the palette alone can have made, and none kept from an
  // earlier version (where the note cannot know who chose it).
  if (c.nothingFromVideos) {
    if (kept.size) problems.push('says nothing comes from the videos, but it kept joins from the earlier version, which may');
    for (const t of joins) if (t && t.type !== accentType && paletteKinds.has(kindOf(t.type)) && !styleKinds.has(kindOf(t.type))) problems.push(`says nothing comes from the videos, but the plan has ${kindOf(t.type)}`);
    if (accentType && !styleKinds.has(kindOf(accentType)) && joins.some((t) => t?.type === accentType)) problems.push("says nothing comes from the videos, but the plan has the palette's accent");
  }
  // Clean promo's "no white flashes": the palette's accent, and none in the plan.
  if (c.noAccent) {
    if (!accentType) problems.push(`says no ${c.noAccent}, but the palette has no accent`);
    else if (all.some((t) => t?.type === accentType)) problems.push(`says no ${c.noAccent}, the plan has ${kindOf(accentType)}`);
    else if (c.noAccent !== 'flashes' && c.noAccent !== kindOf(accentType)) problems.push(`says no ${c.noAccent}, but the palette's accent is ${kindOf(accentType)}`);
  }
  // Every join this version made is described: credited, called the style's own, or an accent (checked separately).
  for (const t of joins) {
    if (t && t.type === accentType) continue;
    const kind = kindOf(t?.type ?? null);
    const lengthOnly = t !== null && kind === 'cross-fades' && c.credited.includes('cross-fade lengths') && Math.abs(t.durationSec - palette.durationSec) <= 0.005;
    if (!c.credited.includes(kind) && !c.own.includes(kind) && !lengthOnly) problems.push(`does not describe the plan's ${kind}`);
  }
  return [...new Set(problems)];
}

/** What the note for the accepted transitions gets wrong about `plan`, and what it claims. */
function noteProblems(plan: EditPlan, styleId: StyleId, palette: TransitionPalette, music: PlannerInput['music'], kept: ReadonlySet<number> = new Set()): { problems: string[]; claims: Claims | null; accents: number } {
  const accents = palette.accent ? accentsOf(plan, music, palette.accent.type, kept) : [];
  const c = claimsOf(plan.rationale, palette);
  if (!c) {
    // No note only when this version made no join: a single shot, or a revision that kept every join.
    const made = plan.segments.some((_, i) => i > 0 && !kept.has(i));
    return { problems: made ? ['no note for the transitions'] : [], claims: null, accents: accents.length };
  }
  const ownAccentKind = Boolean(palette.accent && c.own.includes(kindOf(palette.accent.type)));
  const total = computeTimeline(plan).totalDurationSec;
  const problems = [...joinProblems(c, plan, styleId, palette, kept), ...accentProblems(c.accents, accents, revealAt(plan, styleId), styleId === 'beat_montage', total, ownAccentKind)];
  return { problems: problems.map((p) => `"${c.text}" ${p}`), claims: c, accents: accents.length };
}

describe('the note for the transitions from your videos says what the plan has', () => {
  it('credits only joins the palette can have made, names the style\'s own, and describes every join and accent', () => {
    const problems: string[] = [];
    let plans = 0;
    let withAccents = 0;
    let withOwn = 0;
    for (const [paletteName, palette] of PALETTES)
      for (const transitions of TRANSITIONS)
        for (const [trackName, music] of TRACKS)
          for (const styleId of STYLE_IDS)
            for (const targetDurationSec of [15, 20, 30])
              for (const attempt of [0, 1]) {
                const plan = planner.plan(plannerInput(labelledProject(), { styleId, targetDurationSec, music, attempt, preferences: prefsWith(palette, transitions) }));
                const where = `${paletteName} | ${transitions} | ${trackName} | ${styleId} ${targetDurationSec} s take ${attempt + 1}`;
                const checked = noteProblems(plan, styleId, palette, music);
                plans++;
                if (checked.accents) withAccents++;
                if (checked.claims?.own.length) withOwn++;
                for (const p of checked.problems) problems.push(`${where}: ${p}`);
              }
    expect(problems).toEqual([]);
    expect(plans).toBe(PALETTES.length * TRANSITIONS.length * TRACKS.length * STYLE_IDS.length * 3 * 2);
    expect(withAccents).toBeGreaterThan(plans / 3);
    expect(withOwn).toBeGreaterThan(50);
  });

  it('describes the single accent of a fitted style where it is, and the montage only says "every 4th beat" for an unbroken run', () => {
    const palette = PALETTES[0]![1];
    const planFor = (styleId: StyleId, targetDurationSec: number, attempt = 0) => planner.plan(plannerInput(labelledProject(), { styleId, targetDurationSec, music: clickTrack(), attempt, preferences: prefsWith(palette, 'restrained') }));
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

  it('a calm cinematic reveal with slides from your videos says it keeps its own cross-fades, not "Transitions as in your videos"', () => {
    // Half straight cuts, half slides, a dip to black every 4 beats; the Transitions preference left on restrained (calm).
    const palette = PALETTES[6]![1];
    const plan = planner.plan(plannerInput(labelledProject(), { styleId: 'cinematic_reveal', targetDurationSec: 20, music: clickTrack(), preferences: prefsWith(palette, 'restrained') }));
    const kinds = plan.segments.slice(1).map((s) => s.transitionIn?.type ?? 'cut');
    expect(kinds).not.toContain('slideup');
    expect(kinds).toContain('dissolve');
    expect(plan.rationale).not.toContain('as in your videos');
    expect(plan.rationale).toContain("Straight cuts with a dip to black at the reveal, from your style. Some joins keep the style's own cross-fades.");
    // Without a straight cut or an accent in the palette, nothing in the plan comes from it, and the note says so.
    const none = planner.plan(plannerInput(labelledProject(), { styleId: 'cinematic_reveal', targetDurationSec: 20, music: clickTrack(), preferences: prefsWith(PALETTES[7]![1], 'restrained') }));
    expect(none.rationale).toMatch(/This style keeps its own cross-fades( and dips to black)? rather than the transitions from your videos\./);
  });

  it('in a revision, credits your videos only with the joins this version made, and never says none are from them', () => {
    const REVISIONS = [
      ['same palette before', 'Make it 30 seconds.', 30],
      ['no palette before', 'Make it 30 seconds.', 30],
      ['same palette before', 'Make it faster.', 20],
    ] as const;
    const problems: string[] = [];
    let revisions = 0;
    let withKept = 0;
    let withMade = 0;
    for (const [paletteName, palette] of PALETTES)
      for (const transitions of TRANSITIONS)
        for (const styleId of STYLE_IDS)
          for (const [before, revisionInstruction, targetDurationSec] of REVISIONS) {
            const earlierPrefs = before === 'same palette before' ? prefsWith(palette, transitions) : { ...DEFAULT_SETTINGS.preferences, transitions };
            const previousPlan = planner.plan(plannerInput(labelledProject(), { styleId, targetDurationSec: 20, music: clickTrack(), preferences: earlierPrefs }));
            const plan = planner.plan(plannerInput(labelledProject(), { styleId, targetDurationSec, music: clickTrack(), preferences: prefsWith(palette, transitions), previousPlan, revisionInstruction }));
            // The joins of the shots it kept (by segment id) are the earlier version's.
            const earlier = new Set(previousPlan.segments.map((s) => s.id));
            const kept = new Set(plan.segments.flatMap((s, i) => (i > 0 && earlier.has(s.id) ? [i] : [])));
            revisions++;
            if (kept.size) withKept++;
            if (plan.segments.length - 1 > kept.size) withMade++;
            const where = `${paletteName} | ${transitions} | ${styleId} | ${before} | ${revisionInstruction}`;
            for (const p of noteProblems(plan, styleId, palette, clickTrack(), kept).problems) problems.push(`${where}: ${p}`);
          }
    expect(problems).toEqual([]);
    expect(revisions).toBe(PALETTES.length * TRANSITIONS.length * STYLE_IDS.length * REVISIONS.length);
    expect(withKept).toBeGreaterThan(revisions / 2);
    expect(withMade).toBeGreaterThan(revisions / 2);

    // A calm cinematic reveal made faster keeps the earlier version's straight cuts and dip to black (from the slides
    // palette) and adds a shot joined by the style's own cross-fade: it says only that.
    const palette = PALETTES[6]![1];
    const at = (previousPlan?: EditPlan) =>
      planner.plan(plannerInput(labelledProject(), { styleId: 'cinematic_reveal', targetDurationSec: 20, music: clickTrack(), preferences: prefsWith(palette, 'restrained'), ...(previousPlan ? { previousPlan, revisionInstruction: 'Make it faster.' } : {}) }));
    const earlier = at();
    const faster = at(earlier);
    const ids = new Set(earlier.segments.map((s) => s.id));
    const keptKinds = faster.segments.filter((s, i) => i > 0 && ids.has(s.id)).map((s) => s.transitionIn?.type ?? 'cut');
    expect(keptKinds).toContain('fadeblack');
    expect(keptKinds).toContain('cut');
    expect(faster.segments.filter((s, i) => i > 0 && !ids.has(s.id)).map((s) => s.transitionIn?.type ?? 'cut')).toEqual(['dissolve']);
    expect(faster.rationale).toContain("Some joins keep the style's own cross-fades.");
    expect(faster.rationale).not.toContain('rather than the transitions from your videos');
    expect(faster.rationale).not.toContain('as in your videos');
  });
});
