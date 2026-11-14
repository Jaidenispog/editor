import { AppError, type SegmentLabel, type StyleId } from '@studio/core';
import type { PlannerInput } from '../types.js';
import { MAX_SEGMENTS, MIN_PLAY_SEC, grow, hardMinPlay, largestFree, placeWindow, play, shrink, startTimes, type Draft } from './draft.js';
import { NEUTRAL_LABELS, PROCESS_LABELS, bySource, byScore, bySteadiness, lengthOf, withLabels, type Candidate, type Footage } from './footage.js';
import { nearestBeatIndex, type BeatGrid } from './music.js';
import { clamp, rotate, round } from './random.js';
import { chooseTransition, type EffectiveSettings } from './settings.js';
import { shortText, type TextIntent } from './text.js';

/** Everything a style builder needs. */
export interface BuildContext {
  input: PlannerInput;
  s: EffectiveSettings;
  footage: Footage;
  /** Beat grid (music beats, or the 120 BPM stand-in for the montage); null when beats do not matter. */
  grid: BeatGrid | null;
  rng: () => number;
  nextId: () => string;
  notes: string[];
}

/** How a style grows, shrinks, links and labels an edit; used for fresh plans and for revisions. */
export interface Recipe {
  /** Shots to draw from when the edit needs more material, best first. */
  fillers: Candidate[];
  makeFiller(cand: Candidate, drafts: Draft[], allowReuse: boolean): Draft | null;
  insert(drafts: Draft[], d: Draft): void;
  transitionFor(drafts: Draft[], index: number): Draft['transitionIn'];
  /** Text for a fresh plan, most important first. */
  textIntents(drafts: Draft[]): TextIntent[];
  /** One more line when the owner asks for more text. */
  extraText(drafts: Draft[]): TextIntent | null;
  /** Cosmetic pass after fitting (zoom alternation, beat-aligned reveal). */
  finish(drafts: Draft[]): void;
  minSegments: number;
  allowSlowdown: boolean;
  /** Beat-exact styles are rebuilt on the beat grid rather than re-fitted when revised. */
  exact: boolean;
}

export interface BuildResult {
  drafts: Draft[];
  recipe: Recipe;
}

interface DraftOptions {
  play: number;
  speed?: number;
  /** 0–1 position of the window inside the shot. */
  anchor?: number;
  /** Absolute source time the window should start at (overrides `anchor`). */
  startAt?: number;
  zoom?: Draft['zoom'];
  softMin: number;
  softMax: number;
  pinned?: boolean;
  weight?: number;
  keep?: Draft['keep'];
  slot: string;
  allowReuse?: boolean;
  /** Exact length required (no shorter window accepted). */
  exact?: boolean;
}

function unsupported(message: string): AppError {
  return new AppError('PROCESSING_FAILED', message);
}

/** Emphasised labels first; de-emphasised labels removed unless nothing else is left. */
function prioritise(list: readonly Candidate[], s: EffectiveSettings): Candidate[] {
  const kept = list.filter((c) => !s.deemphasise.includes(c.label));
  const base = kept.length > 0 ? kept : [...list];
  if (s.emphasise.length === 0) return base;
  return [...base.filter((c) => s.emphasise.includes(c.label)), ...base.filter((c) => !s.emphasise.includes(c.label))];
}

function weightFor(cand: Candidate, s: EffectiveSettings, base: number): number {
  if (s.emphasise.includes(cand.label)) return base + 4;
  if (s.deemphasise.includes(cand.label)) return Math.max(0, base - 2);
  return base;
}

function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i] !== undefined) out.push(l[i]!);
  return out;
}

/** Cuts a window from a candidate and wraps it as a draft; null when the shot has no room left. */
export function makeDraft(ctx: BuildContext, cand: Candidate, occupied: readonly Draft[], o: DraftOptions): Draft | null {
  const speed = o.speed ?? 1;
  const wantSrc = Math.max(0.05, o.play * speed);
  const len = lengthOf(cand);
  let anchor = o.anchor ?? 0.5;
  if (o.startAt !== undefined) anchor = len - wantSrc > 0.01 ? (o.startAt - cand.startSec) / (len - wantSrc) : 0;
  let win = placeWindow(cand, occupied, wantSrc, anchor);
  if (!win && !o.exact) {
    const free = largestFree(cand, occupied);
    const minSrc = Math.max(MIN_PLAY_SEC, o.softMin * 0.6) * speed;
    if (free >= minSrc) win = placeWindow(cand, occupied, free, anchor);
  }
  if (!win && o.allowReuse) win = placeWindow(cand, occupied, wantSrc, anchor, { allowReuse: true });
  if (!win) return null;
  const s = ctx.s;
  const emph = s.emphasise.includes(cand.label);
  return {
    id: ctx.nextId(),
    cand,
    inSec: win.inSec,
    outSec: win.outSec,
    speed,
    zoom: o.zoom ?? null,
    transitionIn: null,
    role: cand.label,
    keepOriginalSound: false,
    softMin: emph ? Math.max(o.softMin, Math.min(o.softMax, (win.outSec - win.inSec) / speed)) : o.softMin,
    softMax: emph ? o.softMax * 1.4 : o.softMax,
    pinned: o.pinned ?? false,
    weight: o.weight ?? weightFor(cand, s, 2),
    keep: o.keep ?? 'centre',
    slot: o.slot,
    autoTransition: true,
  };
}

/** A held closing shot: as long as wanted, gently slowed when the shot is short and `allowSlow` is set. */
function holdDraft(
  ctx: BuildContext,
  cand: Candidate,
  occupied: readonly Draft[],
  o: { want: number; min: number; max: number; allowSlow: boolean; zoom: Draft['zoom']; slot: string; anchor?: number },
): Draft | null {
  const free = largestFree(cand, occupied);
  if (free < 0.45) return null;
  let speed = 1;
  let p = Math.min(o.want, free);
  if (p < o.min && o.allowSlow) {
    speed = Math.max(0.6, round(free / o.min, 2));
    p = Math.min(o.want, free / speed);
  }
  return makeDraft(ctx, cand, occupied, {
    play: p,
    speed,
    anchor: o.anchor ?? 1,
    zoom: o.zoom,
    softMin: Math.min(o.min, p),
    softMax: Math.max(o.max, p),
    pinned: true,
    weight: 10,
    keep: 'end',
    slot: o.slot,
  });
}

/** Window start that puts transcribed speech on screen (process story keeps the talking). */
function speechStart(cand: Candidate): number | undefined {
  const first = cand.speech[0];
  if (!first) return undefined;
  return clamp(first.startSec - 0.2, cand.startSec, cand.endSec);
}

function insertBefore(slot: string) {
  return (drafts: Draft[], d: Draft) => {
    const idx = drafts.findIndex((x) => x.slot === slot);
    drafts.splice(idx < 0 ? drafts.length : idx, 0, d);
  };
}

function businessText(ctx: BuildContext): string | null {
  return shortText(ctx.input.businessName) ?? shortText(ctx.input.brand.businessName);
}

// ---------------------------------------------------------------- beat montage

function buildBeatMontage(ctx: BuildContext): BuildResult {
  const { s, footage } = ctx;
  const all = footage.candidates;
  const grid = ctx.grid;
  if (!grid) throw new Error('beat montage needs a beat grid');
  const iv = grid.interval;

  // Beats per shot: 0.4–1.25 s (scaled by pacing), widened for long edits so the plan stays under 40 segments.
  const hi = Math.max(clamp(1.25 * s.pacing, 0.6, 2.2), s.target / 34);
  const options = [1, 2, 3, 4, 6, 8].filter((n) => n * iv >= 0.4 - 1e-6 && n * iv <= hi + 1e-6);
  if (options.length === 0) options.push(Math.max(1, Math.ceil(0.4 / iv)));
  const a = options[0]!;
  const b = options[1] ?? a;
  const patterns = [
    [b, a, a],
    [a, b, a, a, b],
    [a, a, b],
    [b, a, b, a],
  ];
  const pattern = patterns[s.attempt % patterns.length]!;
  const candidatesN = [1, 2, 3, 4, 6, 8].filter((n) => n * iv >= 0.4 - 1e-6);
  const hookBeats = candidatesN.reduce((best, n) => (Math.abs(n * iv - 1) < Math.abs(best * iv - 1) ? n : best), candidatesN[0] ?? 1);
  let holdBeats = 4 * iv >= 1.5 && 4 * iv <= 3.2 ? 4 : Math.max(1, Math.ceil(1.5 / iv));

  let totalBeats = nearestBeatIndex(grid, s.target);
  let body = totalBeats - hookBeats - holdBeats;
  if (body < 0) {
    holdBeats = Math.max(1, Math.ceil(1.5 / iv));
    body = Math.max(0, totalBeats - hookBeats - holdBeats);
    totalBeats = hookBeats + holdBeats + body;
  }
  const counts: number[] = [hookBeats];
  let rem = body;
  for (let i = 0; rem > 0; i++) {
    let n = pattern[i % pattern.length]!;
    if (n > rem) n = [...options].reverse().find((x) => x <= rem) ?? rem;
    if (n * iv < 0.4 - 1e-6) {
      counts[counts.length - 1] = (counts[counts.length - 1] ?? 0) + rem;
      break;
    }
    counts.push(n);
    rem -= n;
  }
  counts.push(holdBeats);
  while (counts.length > MAX_SEGMENTS) {
    let best = 1;
    for (let i = 1; i < counts.length - 2; i++) if (counts[i]! + counts[i + 1]! < counts[best]! + counts[best + 1]!) best = i;
    counts.splice(best, 2, counts[best]! + counts[best + 1]!);
  }
  const cum: number[] = [0];
  for (const n of counts) cum.push(cum[cum.length - 1]! + n);
  const beatAt = (k: number) => grid.beats[k] ?? grid.beats[grid.beats.length - 1]! + (k - grid.beats.length + 1) * iv;
  const durations = counts.map((_, j) => beatAt(cum[j + 1]!) - beatAt(cum[j]!));

  // Shot choice: hook = best detail/result, close on the cleanest result, process shots in between.
  const firstGroup = (groups: SegmentLabel[][], exclude?: Candidate) => {
    for (const g of groups) {
      const list = byScore(withLabels(all, g)).filter((c) => c !== exclude);
      if (list.length > 0) return rotate(list, s.attempt);
    }
    return rotate(byScore(all), s.attempt);
  };
  const hookGroups: SegmentLabel[][] = [...(s.opening ? [[s.opening]] : []), ['fade_detail'], ['result'], ['cutting', 'styling'], []];
  const hookCand = firstGroup(hookGroups)[0]!;
  const finalCand = firstGroup([['result'], ['fade_detail'], ['styling'], ['cutting'], []], all.length > 1 ? hookCand : undefined)[0] ?? hookCand;
  const processLists = PROCESS_LABELS.map((l) => rotate(byScore(withLabels(all, [l])), s.attempt));
  if (s.emphasise.length) processLists.sort((x, y) => Number(s.emphasise.includes(y[0]?.label ?? 'unknown')) - Number(s.emphasise.includes(x[0]?.label ?? 'unknown')));
  const tier1 = prioritise([...interleave(processLists), ...rotate(byScore(withLabels(all, NEUTRAL_LABELS)), s.attempt)], s);
  const tier2 = prioritise([...byScore(withLabels(all, ['reaction', 'result'])), ...byScore(withLabels(all, ['before']))], s);
  const body1 = tier1.length > 0 ? tier1 : tier2;

  const placed: Draft[] = [];
  const fadeIntoFinal = s.transitions !== 'none' && s.attempt % 2 === 1;
  const exactWindow = (cand: Candidate, p: number, speed: number, anchor: number, slot: string, keep: Draft['keep'], allowReuse = false): Draft | null => {
    for (const sp of speed !== 1 ? [speed, 1] : [1]) {
      const d = makeDraft(ctx, cand, placed, { play: p, speed: sp, anchor, softMin: p, softMax: p, exact: true, slot, keep, allowReuse });
      if (d) return d;
    }
    const free = largestFree(cand, placed);
    const slow = free / p;
    if (slow >= 0.6) return makeDraft(ctx, cand, placed, { play: p, speed: round(Math.min(1, slow) - 0.005, 3), anchor, softMin: p, softMax: p, exact: true, slot, keep });
    return null;
  };

  const hookDur = durations[0]!;
  const hook = exactWindow(hookCand, hookDur, 1, 0.5, 'open', 'centre');
  if (!hook) throw unsupported('The clips are too short for a beat-synced montage. Add longer clips and try again.');
  hook.pinned = true;
  hook.weight = 10;
  placed.push(hook);

  const lastDur = durations[durations.length - 1]!;
  let finalDraft = fadeIntoFinal ? exactWindow(finalCand, lastDur + 0.2, 1, 1, 'final', 'end') : null;
  const withFade = Boolean(finalDraft);
  if (!finalDraft) finalDraft = exactWindow(finalCand, lastDur, 1, 1, 'final', 'end');
  if (!finalDraft) {
    for (const alt of byScore(all)) {
      finalDraft = exactWindow(alt, lastDur, 1, 1, 'final', 'end', true);
      if (finalDraft) break;
    }
  }
  if (!finalDraft) throw unsupported('The clips are too short for a beat-synced montage. Add longer clips and try again.');
  finalDraft.pinned = true;
  finalDraft.weight = 10;
  if (withFade) finalDraft.transitionIn = { type: 'fade', durationSec: 0.2 };
  placed.push(finalDraft);

  const bodyDrafts: Draft[] = [];
  let pointer = 0;
  let reused = false;
  for (let j = 1; j < durations.length - 1; j++) {
    const p = durations[j]!;
    const ramp = ctx.s.style.pacing.speedRamps && s.pacing <= 1.05 && (j + s.attempt) % 3 === 2;
    const prevCand = (bodyDrafts[bodyDrafts.length - 1] ?? hook).cand;
    let d: Draft | null = null;
    for (const list of [body1, tier2, byScore(all)]) {
      for (let k = 0; k < list.length && !d; k++) {
        const cand = list[(pointer + k) % list.length]!;
        if (cand === prevCand && list.length > 1) continue;
        const speed = ramp && PROCESS_LABELS.includes(cand.label) && lengthOf(cand) >= 3 ? (j % 2 ? 1.25 : 1.5) : 1;
        d = exactWindow(cand, p, speed, ctx.rng(), 'body', 'centre');
        if (d && list === body1) pointer = (pointer + k + 1) % list.length;
      }
      if (d) break;
    }
    if (!d) {
      const cand = body1[pointer % Math.max(1, body1.length)] ?? hookCand;
      pointer++;
      d = exactWindow(cand, p, 1, ctx.rng(), 'body', 'centre', true);
      reused = true;
    }
    if (!d) throw unsupported('There is not enough usable footage for a beat-synced montage of this length. Add more clips or choose a shorter length.');
    d.weight = weightFor(d.cand, s, 2);
    bodyDrafts.push(d);
    placed.push(d);
  }
  if (reused) ctx.notes.push('A few moments appear twice because there was not enough different footage for this length.');
  const drafts = [hook, ...bodyDrafts, finalDraft];
  for (const d of drafts) d.autoTransition = false;

  const hasFade = drafts.some((d) => d.role === 'fade_detail');
  const openers = [
    'Fresh cut',
    hasFade && s.ownerMentionsSkinFade ? 'Skin fade' : null,
    hasFade ? 'In the details' : null,
    businessText(ctx),
  ].filter((t): t is string => Boolean(t));
  const opener = openers[s.attempt % openers.length] ?? 'Fresh cut';
  ctx.notes.push(
    grid.fromMusic
      ? `Every cut lands on a beat of "${ctx.input.music?.title ?? 'the track'}"${grid.bpm ? ` (${Math.round(grid.bpm)} BPM)` : ''}.`
      : 'Without music the cuts follow a steady 120 BPM rhythm.',
  );

  const recipe: Recipe = {
    fillers: [],
    makeFiller: () => null,
    insert: (list, d) => list.splice(Math.max(1, list.length - 1), 0, d),
    transitionFor: (list, i) => list[i]?.transitionIn ?? null,
    textIntents: () => [{ text: opener, at: 'start', placement: 'top', style: 'headline', animation: 'pop', emphasis: 'accent', maxDurSec: 1.6 }],
    extraText: () => {
      const extra = opener === businessText(ctx) ? 'Fresh cut' : businessText(ctx);
      return extra ? { text: extra, at: 'during', slot: 'final', placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal', maxDurSec: 2 } : null;
    },
    finish: () => {},
    minSegments: 2,
    allowSlowdown: false,
    exact: true,
  };
  return { drafts, recipe };
}

// ---------------------------------------------------------------- cinematic reveal

function buildCinematicReveal(ctx: BuildContext): BuildResult {
  const { s, footage } = ctx;
  const c = footage.candidates;
  const results = rotate(byScore(withLabels(c, ['result'])), s.attempt);
  const finalCand = results[0];
  if (!finalCand) throw unsupported('A cinematic reveal needs a shot of the finished haircut. Tag a clip as Result and try again.');
  const shotLen = clamp(2.3 * s.pacing, 1.5, 3);
  const softMin = clamp(1.5 * s.pacing, 1.2, 2.4);
  const softMax = clamp(3 * s.pacing, 2, 3.6);
  const process = withLabels(c, PROCESS_LABELS);
  const neutral = withLabels(c, NEUTRAL_LABELS);
  const support = process.length > 0 ? process : neutral;
  const ranked = prioritise(rotate(byScore(support), s.attempt), s);
  const opening = s.opening ? byScore(withLabels(c, [s.opening])).find((x) => x !== finalCand) : s.attempt === 0 ? bySource(prioritise(support, s))[0] : ranked[0];

  const hold = holdDraft(ctx, finalCand, [], {
    want: clamp(s.target * 0.3, 3, 5),
    min: 3,
    max: 5,
    allowSlow: true,
    zoom: { from: 1.06, to: 1 },
    slot: 'final',
  });
  if (!hold) throw unsupported('The finished-result shot is too short for a cinematic reveal.');
  if (hold.speed < 1) ctx.notes.push('The reveal plays in gentle slow motion so the finished cut can be held for three seconds.');

  const count = clamp(Math.round((s.target - play(hold) + 0.4) / (shotLen - 0.5)), 3, 6);
  const order = opening ? [opening, ...ranked.filter((x) => x !== opening)] : ranked;
  const body: Draft[] = [];
  for (const cand of order) {
    if (body.length >= count) break;
    const i = body.length;
    const d = makeDraft(ctx, cand, [...body, hold], {
      play: shotLen * (i % 2 ? 0.9 : 1.1),
      anchor: i === 0 && s.attempt === 0 ? 0 : 0.15 + ctx.rng() * 0.7,
      softMin,
      softMax,
      pinned: i === 0,
      weight: i === 0 ? 10 : weightFor(cand, s, 3),
      keep: 'centre',
      slot: i === 0 ? 'open' : 'body',
    });
    if (d) body.push(d);
  }
  const drafts = [...body, hold];
  const fillers = prioritise([...ranked, ...(support === process ? byScore(neutral) : []), ...byScore(withLabels(c, ['before']))], s);
  const business = businessText(ctx);
  const line = (s.attempt % 2 === 0 ? business : null) ?? 'Fresh cut';

  const recipe: Recipe = {
    fillers,
    makeFiller: (cand, list, allowReuse) =>
      makeDraft(ctx, cand, list, {
        play: shotLen,
        anchor: 0.15 + ctx.rng() * 0.7,
        softMin,
        softMax,
        weight: weightFor(cand, s, cand.label === 'before' ? 0 : 2),
        slot: 'body',
        allowReuse,
      }),
    insert: insertBefore('final'),
    transitionFor: (list, i) => {
      const d = list[i];
      if (!d) return null;
      if (d.slot === 'final') return chooseTransition(s, s.attempt % 2 ? ['dissolve'] : ['fadeblack', 'dissolve'], s.attempt % 2 ? 0.7 : 0.4);
      return chooseTransition(s, ['dissolve'], 0.5);
    },
    textIntents: () => [{ text: line, at: 'during', slot: 'final', placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal', maxDurSec: 3 }],
    extraText: () => ({ text: line === 'Fresh cut' ? (business ?? 'The finished cut') : 'Fresh cut', at: 'start', placement: 'top', style: 'headline', animation: 'fade', emphasis: 'normal', maxDurSec: 2.2 }),
    finish: (list) => {
      // Alternate slow push-ins through the build; the reveal keeps its gentle pull-out.
      let k = 0;
      for (const d of list) {
        if (d.slot === 'final') continue;
        d.zoom = (k + s.attempt) % 2 === 0 ? { from: 1, to: 1.08 } : null;
        k++;
      }
    },
    minSegments: 3,
    allowSlowdown: true,
    exact: false,
  };
  return { drafts, recipe };
}

// ---------------------------------------------------------------- before and after

function buildBeforeAfter(ctx: BuildContext): BuildResult {
  const { s, footage } = ctx;
  const c = footage.candidates;
  const befores = rotate(byScore(withLabels(c, ['before'])), s.attempt);
  const results = rotate(byScore(withLabels(c, ['result'])), s.attempt);
  if (!befores[0] || !results[0]) {
    throw unsupported('Before and after needs a shot tagged "Before" and a shot tagged "Result". Tag those clips and try again.');
  }
  const holdWant = clamp(s.target * 0.3, 3, 6);
  const r1 = holdDraft(ctx, results[0], [], { want: holdWant, min: 3, max: 6, allowSlow: false, zoom: s.attempt % 2 ? { from: 1, to: 1.05 } : null, slot: 'reveal' });
  if (!r1) throw unsupported('The finished-result shot is too short for a before-and-after edit.');
  const resultBlock: Draft[] = [r1];
  if (play(r1) < 3 - 0.05) {
    const other = results.find((x) => x !== results[0] && largestFree(x, resultBlock) >= 0.8) ?? results[0];
    const r2 = holdDraft(ctx, other, resultBlock, { want: Math.min(holdWant - play(r1), 3), min: 1, max: 3, allowSlow: false, zoom: null, slot: 'hold2' });
    if (r2) resultBlock.push(r2);
  }
  const beforeLen = clamp(2.5 * s.pacing, 2, 3);
  const before = makeDraft(ctx, befores[0], resultBlock, {
    play: beforeLen,
    anchor: s.attempt % 2 ? 0.3 : 0.08,
    softMin: Math.min(2, beforeLen),
    softMax: 3.2,
    pinned: true,
    weight: 10,
    keep: 'start',
    slot: 'before',
  });
  if (!before) throw unsupported('The "Before" shot is too short for a before-and-after edit.');

  const bridgeList = prioritise(rotate(byScore(withLabels(c, PROCESS_LABELS)), s.attempt), s);
  const neutral = byScore(withLabels(c, NEUTRAL_LABELS));
  const bridgeSource = bridgeList.length > 0 ? bridgeList : neutral;
  const bridgeLen = clamp(1.3 * s.pacing, 0.8, 1.6);
  const holdTotal = resultBlock.reduce((n, d) => n + play(d), 0);
  const n = clamp(Math.round((s.target - play(before) - holdTotal) / bridgeLen), 1, 3);
  const bridges: Draft[] = [];
  for (const cand of bridgeSource) {
    if (bridges.length >= n) break;
    const d = makeDraft(ctx, cand, [before, ...bridges, ...resultBlock], {
      play: bridgeLen,
      anchor: 0.1 + ctx.rng() * 0.8,
      softMin: 0.8,
      softMax: 1.8,
      weight: weightFor(cand, s, 3),
      slot: 'bridge',
    });
    if (d) bridges.push(d);
  }
  const drafts = [before, ...bridges, ...resultBlock];
  const business = businessText(ctx);

  const recipe: Recipe = {
    fillers: prioritise([...bridgeSource, ...(bridgeSource === neutral ? [] : neutral)], s),
    makeFiller: (cand, list, allowReuse) =>
      makeDraft(ctx, cand, list, { play: bridgeLen, anchor: 0.1 + ctx.rng() * 0.8, softMin: 0.8, softMax: 1.8, weight: weightFor(cand, s, 2), slot: 'bridge', allowReuse }),
    insert: insertBefore('reveal'),
    transitionFor: (list, i) => {
      const d = list[i];
      const prev = list[i - 1];
      if (!d || !prev) return null;
      if (d.slot === 'reveal') return chooseTransition(s, ['wipeleft', 'slideup'], 0.5, s.attempt);
      if (d.slot === 'hold2') return null;
      if (prev.slot === 'before') return s.attempt % 2 ? chooseTransition(s, ['fade'], 0.3) : null;
      return s.attempt % 3 === 2 ? chooseTransition(s, ['fade'], 0.25) : null;
    },
    textIntents: () => [
      { text: 'After', at: 'during', slot: 'reveal', untilEnd: true, placement: 'top', style: 'label', animation: 'rise', emphasis: 'accent' },
      { text: 'Before', at: 'during', slot: 'before', placement: 'top', style: 'label', animation: 'fade', emphasis: 'normal' },
    ],
    extraText: () => (business ? { text: business, at: 'end', placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal', maxDurSec: 2.2 } : null),
    finish: (list) => alignRevealToBeat(ctx, list),
    minSegments: 3,
    allowSlowdown: false,
    exact: false,
  };
  return { drafts, recipe };
}

/** Nudges the reveal cut onto the nearest beat (when music is present) without changing the total length. */
function alignRevealToBeat(ctx: BuildContext, drafts: Draft[]): void {
  const grid = ctx.grid;
  if (!grid?.fromMusic) return;
  const r = drafts.findIndex((d) => d.slot === 'reveal');
  const prev = drafts[r - 1];
  const last = drafts[drafts.length - 1];
  if (r < 1 || !prev || !last || last === prev) return;
  const starts = startTimes(drafts);
  const reveal = (starts[r] ?? 0) + (drafts[r]?.transitionIn?.durationSec ?? 0);
  const beat = grid.beats[nearestBeatIndex(grid, reveal)] ?? reveal;
  const delta = beat - reveal;
  if (Math.abs(delta) < 0.02 || Math.abs(delta) > 0.6) return;
  if (delta > 0) {
    const g = grow(prev, drafts, delta);
    shrink(last, g, hardMinPlay(drafts, drafts.length - 1));
  } else {
    const cut = shrink(prev, -delta, hardMinPlay(drafts, r - 1));
    grow(last, drafts, cut);
  }
  ctx.notes.push('The reveal is timed to land on a beat of the music.');
}

// ---------------------------------------------------------------- clean promo

function buildCleanPromo(ctx: BuildContext): BuildResult {
  const { s, footage } = ctx;
  const c = footage.candidates;
  const pool = c.filter((x) => x.label !== 'before');
  const process = withLabels(pool, PROCESS_LABELS);
  const results = withLabels(pool, ['result']);
  if (process.length === 0 && results.length === 0) {
    throw unsupported('A clean promo needs a shot of the cut or the finished result. Tag a clip and try again.');
  }
  const shotLen = clamp(2 * s.pacing, 1.5, 2.5);
  const softMin = clamp(1.4 * s.pacing, 1.2, 2);
  const softMax = clamp(2.6 * s.pacing, 2, 3.2);
  const openPool = s.opening ? withLabels(pool, [s.opening]) : process.length ? process : pool.filter((x) => x.label !== 'result');
  const openList = prioritise(rotate(bySteadiness(openPool.length ? openPool : results), s.attempt), s);
  const closeList = rotate(bySteadiness(results.length ? results : process), s.attempt);
  const open = openList[0]!;
  const close = closeList.find((x) => x !== open) ?? closeList[0] ?? open;

  const closing = holdDraft(ctx, close, [], { want: clamp(2.6 * s.pacing, 2, 3), min: 1.5, max: 3.2, allowSlow: false, zoom: { from: 1, to: 1.04 }, slot: 'final' });
  if (!closing) throw unsupported('The clips are too short for a clean promo. Add longer clips and try again.');
  const opening = makeDraft(ctx, open, [closing], {
    play: shotLen * 1.1,
    anchor: 0.3 + 0.2 * (s.attempt % 2),
    softMin,
    softMax,
    pinned: true,
    weight: 10,
    slot: 'open',
  });
  if (!opening) throw unsupported('The clips are too short for a clean promo. Add longer clips and try again.');

  const middleList = prioritise(rotate(bySteadiness(pool.filter((x) => x !== open && x !== close)), s.attempt), s);
  const want = Math.max(0, Math.round((s.target - 0.5) / (shotLen - 0.5)) - 2);
  const middle: Draft[] = [];
  for (const cand of middleList) {
    if (middle.length >= want) break;
    const d = makeDraft(ctx, cand, [opening, ...middle, closing], {
      play: shotLen * (middle.length % 2 ? 0.92 : 1.05),
      anchor: 0.2 + ctx.rng() * 0.6,
      softMin,
      softMax,
      weight: weightFor(cand, s, 3),
      slot: 'body',
    });
    if (d) middle.push(d);
  }
  const drafts = [opening, ...middle, closing];
  const business = businessText(ctx);
  const handle = shortText(ctx.input.brand.socialHandle);
  const tagline = shortText(ctx.input.brand.tagline);

  const recipe: Recipe = {
    fillers: prioritise([...middleList, open, close, ...bySteadiness(withLabels(c, ['before']))], s),
    makeFiller: (cand, list, allowReuse) =>
      makeDraft(ctx, cand, list, {
        play: shotLen,
        anchor: 0.2 + ctx.rng() * 0.6,
        softMin,
        softMax,
        weight: weightFor(cand, s, cand.label === 'before' ? 0 : 2),
        slot: 'body',
        allowReuse,
      }),
    insert: insertBefore('final'),
    transitionFor: () => chooseTransition(s, s.attempt % 2 ? ['fade'] : ['dissolve'], s.attempt % 2 ? 0.4 : 0.5),
    textIntents: () => {
      const out: TextIntent[] = [];
      if (business) out.push({ text: business, at: 'start', placement: s.attempt % 2 ? 'top' : 'lower', style: 'headline', animation: 'rise', emphasis: 'normal', maxDurSec: 2.4 });
      if (handle) out.push({ text: handle, at: 'end', placement: 'lower', style: 'label', animation: 'fade', emphasis: 'accent', maxDurSec: 2.2 });
      else if (tagline) out.push({ text: tagline, at: 'end', placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal', maxDurSec: 2.2 });
      if (out.length === 0) out.push({ text: 'Fresh cut', at: 'during', slot: 'final', placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal', maxDurSec: 2 });
      return out;
    },
    extraText: () => ({ text: 'Fresh cut', at: 'during', slot: 'final', placement: 'top', style: 'label', animation: 'fade', emphasis: 'accent', maxDurSec: 2 }),
    finish: () => {},
    minSegments: 3,
    allowSlowdown: true,
    exact: false,
  };
  return { drafts, recipe };
}

// ---------------------------------------------------------------- process story

function buildProcessStory(ctx: BuildContext): BuildResult {
  const { s, footage } = ctx;
  const chron = bySource(footage.candidates);
  const befores = chron.filter((x) => x.label === 'before');
  const process = chron.filter((x) => PROCESS_LABELS.includes(x.label));
  const results = rotate(byScore(chron.filter((x) => x.label === 'result')), s.attempt);
  if (process.length === 0) throw unsupported('A process story needs footage of the cut itself. Tag a clip as Cutting, Fade detail or Styling and try again.');
  if (!results[0]) throw unsupported('A process story needs a shot of the finished result. Tag a clip as Result and try again.');
  const segLen = clamp(1.8 * s.pacing, 1, 2.5);
  const softMin = clamp(1.1 * s.pacing, 1, 1.8);
  const softMax = clamp(2.6 * s.pacing, 1.8, 3.2);

  const hold = holdDraft(ctx, results[0], [], { want: clamp(2.8 * s.pacing, 2.2, 3.5), min: 2, max: 3.8, allowSlow: false, zoom: null, slot: 'final' });
  if (!hold) throw unsupported('The finished-result shot is too short for a process story.');
  const useBefore = befores.length > 0 && s.attempt % 2 === 0;
  const openCand = useBefore ? befores[Math.floor(s.attempt / 2) % befores.length]! : process[0]!;
  const open = makeDraft(ctx, openCand, [hold], {
    play: useBefore ? clamp(2 * s.pacing, 1.5, 2.5) : segLen,
    ...(speechStart(openCand) !== undefined ? { startAt: speechStart(openCand)! } : { anchor: 0 }),
    softMin,
    softMax,
    pinned: true,
    weight: 10,
    keep: useBefore ? 'start' : 'centre',
    slot: 'open',
  });
  if (!open) throw unsupported('The opening shot is too short for a process story.');

  const neutral = chron.filter((x) => NEUTRAL_LABELS.includes(x.label));
  const pool = prioritise([...process.filter((x) => x !== openCand), ...(process.length < 3 ? neutral : [])], s).sort((x, y) => x.order - y.order);
  const n = clamp(Math.round((s.target - play(open) - play(hold)) / (segLen - 0.3)), 1, 12);
  let picks = pool;
  if (pool.length > n) {
    const offset = (s.attempt * 0.37) % 1;
    const idx = new Set<number>();
    for (let k = 0; k < n; k++) idx.add(Math.min(pool.length - 1, Math.floor(((k + offset) * pool.length) / n)));
    picks = [...idx].sort((x, y) => x - y).map((i) => pool[i]!);
  }
  const middle: Draft[] = [];
  for (const cand of picks) {
    const start = speechStart(cand);
    const d = makeDraft(ctx, cand, [open, ...middle, hold], {
      play: segLen,
      ...(start !== undefined ? { startAt: start } : { anchor: 0.2 + ctx.rng() * 0.6 }),
      softMin,
      softMax,
      weight: weightFor(cand, s, 3),
      slot: 'body',
    });
    if (d) middle.push(d);
  }
  const drafts = [open, ...middle, hold];
  const chronological = (x: Draft, y: Draft) => x.cand.assetIndex - y.cand.assetIndex || x.inSec - y.inSec;
  const business = businessText(ctx);

  const recipe: Recipe = {
    fillers: prioritise([...process, ...neutral], s),
    makeFiller: (cand, list, allowReuse) => {
      const start = speechStart(cand);
      return makeDraft(ctx, cand, list, {
        play: segLen,
        ...(start !== undefined && !list.some((d) => d.cand === cand) ? { startAt: start } : { anchor: 0.2 + ctx.rng() * 0.6 }),
        softMin,
        softMax,
        weight: weightFor(cand, s, 2),
        slot: 'body',
        allowReuse,
      });
    },
    insert: (list, d) => {
      const finalIdx = list.findIndex((x) => x.slot === 'final');
      const end = finalIdx < 0 ? list.length : finalIdx;
      let at = end;
      for (let i = 1; i < end; i++) {
        if (chronological(d, list[i]!) < 0) {
          at = i;
          break;
        }
      }
      list.splice(Math.max(1, at), 0, d);
    },
    transitionFor: (list, i) => chooseTransition(s, ['fade'], list[i]?.slot === 'final' && s.attempt % 2 ? 0.4 : 0.3),
    textIntents: () => [{ text: 'Fresh cut', at: 'during', slot: 'final', placement: 'top', style: 'label', animation: 'fade', emphasis: 'accent', maxDurSec: 2.4 }],
    extraText: () => (business ? { text: business, at: 'start', placement: 'top', style: 'headline', animation: 'fade', emphasis: 'normal', maxDurSec: 2 } : null),
    finish: () => {},
    minSegments: 3,
    allowSlowdown: true,
    exact: false,
  };
  return { drafts, recipe };
}

export const STYLE_BUILDERS: Record<StyleId, (ctx: BuildContext) => BuildResult> = {
  beat_montage: buildBeatMontage,
  cinematic_reveal: buildCinematicReveal,
  before_after: buildBeforeAfter,
  clean_promo: buildCleanPromo,
  process_story: buildProcessStory,
};

/**
 * Puts a shot with the requested opening label first (when the style allows a free opening and such a shot
 * exists). Before-and-after always opens on the before shot and the process story stays chronological.
 */
export function applyOpening(ctx: BuildContext, drafts: Draft[], recipe: Recipe): void {
  const label = ctx.s.opening;
  if (!label || ctx.input.styleId === 'before_after' || ctx.input.styleId === 'process_story') return;
  if (drafts[0]?.role === label) return;
  const existing = drafts.findIndex((d) => d.role === label && d.slot !== 'final');
  if (existing > 0) {
    const [d] = drafts.splice(existing, 1);
    if (d) drafts.unshift(d);
  } else {
    const cand = byScore(withLabels(ctx.footage.candidates, [label]))[0];
    const d = cand ? recipe.makeFiller(cand, drafts, false) : null;
    if (!d) {
      ctx.notes.push('No shot matches the requested opening, so the usual opening was kept.');
      return;
    }
    drafts.unshift(d);
  }
  const first = drafts[0]!;
  first.pinned = true;
  first.weight = 10;
  for (const d of drafts) if (d.slot === 'open' && d !== first) d.slot = 'body';
  first.slot = drafts.length > 1 ? 'open' : first.slot;
}
