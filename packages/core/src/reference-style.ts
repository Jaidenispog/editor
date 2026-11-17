import {
  DEFAULT_EDITING_STYLE,
  EDITING_STYLE_FIELDS,
  flashyPaletteTypes,
  stableJson,
  type BeatsPerCut,
  type EditingStyle,
  type EditingStyleField,
  type MusicFit,
  type ReferenceSummaryField,
  type TransitionPalette,
  type ZoomUse,
} from './editing-style.js';
import { effectivePreferences, type Pin } from './preference-learning.js';
import {
  REFERENCE_STYLE_ANALYSIS_VERSION,
  type BeatNotMeasuredReason,
  type BeatSignal,
  type BeatsPerCutCounts,
  type BoundaryKind,
  type DropSignal,
  type MusicSignal,
  type ReferenceStyleSignals,
  type TransitionFamily,
  type TransitionSignal,
  type ZoomSignal,
} from './reference-signals.js';
import { classifyPacing, isOlderMeasuringVersion, suggestedDuration, type ColourLook, type ReferenceStyleProfileV2, type ReferenceSuggestionField } from './reference.js';
import type { EditingPreferences } from './settings.js';
import type { TransitionType } from './styles.js';

/**
 * Reference style v2, the pure half (preferences design §4.3.1): classifying what was measured on the owner's own
 * posted videos (beat sync with a chance correction, drop, energy shape, transition palette, zoom), combining several
 * videos into "your style", wording every row as an estimate and applying the owner's decisions. No FFmpeg here: the
 * measuring lives in `@studio/media` (`measureReferenceStyle`).
 */

/** Starting thresholds from the synthetic prototype (design §4.3.1.3), to be tuned on the owner's real videos. */
export const REFERENCE_STYLE_THRESHOLDS = {
  /** Tempo confidence needed before cuts are compared with the beat (stricter than detectBeats' own 0.2). */
  minTempoConfidence: 0.35,
  /** Mostly-talking videos need this much confidence. */
  speechTempoConfidence: 0.5,
  minCutsForBeat: 8,
  beatWindowSec: 0.08,
  alignedShareMin: 0.6,
  /** Binomial tail probability a beat-sync claim must beat. */
  chanceAlpha: 0.01,
  minClassifiedJoins: 5,
  maxUnclearShare: 0.3,
  dropMinRiseDb: 6,
  dropLevelWithinDb: 3,
  dropEventWindowSec: 0.15,
  minZoomShots: 6,
  noZoomShots: 12,
  /** Share of agreeing videos needed for a combined suggestion. */
  agreeShare: 0.6,
} as const;

const T = REFERENCE_STYLE_THRESHOLDS;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const round05 = (n: number) => Math.round(n * 20) / 20;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

// ---------------------------------------------------------------- beat sync

/** P(X ≥ k) for X ~ Binomial(n, p). */
export function binomialTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let pmf = Math.pow(1 - p, n);
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += pmf;
    pmf = (pmf * (n - i) * p) / ((i + 1) * (1 - p));
  }
  return Math.min(1, tail);
}

/** Smallest k with P(X ≥ k | n, p0) ≤ alpha (n + 1 when even every cut aligning would not beat chance). */
export function binomialMinAligned(n: number, p0: number, alpha: number = T.chanceAlpha): number {
  for (let k = 0; k <= n; k++) if (binomialTail(n, k, p0) <= alpha) return k;
  return n + 1;
}

/** Chance that a random cut lands within ±80 ms of a beat at this tempo. */
export function chanceShare80ms(bpm: number): number {
  return Math.min(1, ((2 * T.beatWindowSec) * bpm) / 60);
}

function nearestOffset(t: number, sortedBeats: readonly number[]): number {
  let lo = 0;
  let hi = sortedBeats.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sortedBeats[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const a = t - (sortedBeats[lo] ?? Number.POSITIVE_INFINITY);
  const b = t - (sortedBeats[hi] ?? Number.POSITIVE_INFINITY);
  return Math.abs(a) <= Math.abs(b) ? a : b;
}

export interface CutAlignment {
  within1Frame: number;
  within80ms: number;
  offBeatHalf: number;
  /** Median signed offset (cut − beat) in ms over the cuts within 80 ms; negative = before the beat. */
  medianOffsetMs: number;
  /** The cuts within 80 ms of a beat, in time order. */
  alignedCutTimesSec: number[];
}

/** Compares cut times with beat times (both on the video timeline). */
export function alignCutsToBeats(cutTimesSec: readonly number[], beatTimesSec: readonly number[], fps: number): CutAlignment {
  const beats = [...beatTimesSec].sort((a, b) => a - b);
  const halves = beats.slice(1).map((b, i) => (b + beats[i]!) / 2);
  const cuts = [...cutTimesSec].sort((a, b) => a - b);
  const frame = 1 / Math.max(1, fps);
  let within1Frame = 0;
  let offBeatHalf = 0;
  const aligned: number[] = [];
  const offsets: number[] = [];
  if (beats.length === 0) return { within1Frame: 0, within80ms: 0, offBeatHalf: 0, medianOffsetMs: 0, alignedCutTimesSec: [] };
  for (const c of cuts) {
    const off = nearestOffset(c, beats);
    if (Math.abs(off) <= frame + 1e-6) within1Frame++;
    if (Math.abs(off) <= T.beatWindowSec + 1e-6) {
      aligned.push(c);
      offsets.push(off);
    } else if (halves.length && Math.abs(nearestOffset(c, halves)) <= T.beatWindowSec + 1e-6) offBeatHalf++;
  }
  return { within1Frame, within80ms: aligned.length, offBeatHalf, medianOffsetMs: Math.round(median(offsets) * 1000), alignedCutTimesSec: aligned };
}

/** How many beats lie between consecutive aligned cuts, as a histogram over 1, 2, 4, 8 and other. */
export function beatsPerCutCounts(alignedCutTimesSec: readonly number[], beatIntervalSec: number): BeatsPerCutCounts {
  const counts: BeatsPerCutCounts = { one: 0, two: 0, four: 0, eight: 0, other: 0 };
  if (!(beatIntervalSec > 0)) return counts;
  for (let i = 1; i < alignedCutTimesSec.length; i++) {
    const n = Math.round((alignedCutTimesSec[i]! - alignedCutTimesSec[i - 1]!) / beatIntervalSec);
    if (n === 1) counts.one++;
    else if (n === 2) counts.two++;
    else if (n === 4) counts.four++;
    else if (n === 8) counts.eight++;
    else counts.other++;
  }
  return counts;
}

/** The mode of the beats-per-cut histogram when it holds at least half of the gaps, else null. */
export function beatsPerCutMode(counts: BeatsPerCutCounts): BeatsPerCut | null {
  const total = counts.one + counts.two + counts.four + counts.eight + counts.other;
  if (total === 0) return null;
  const options: Array<[BeatsPerCut, number]> = [
    [1, counts.one],
    [2, counts.two],
    [4, counts.four],
    [8, counts.eight],
  ];
  const best = options.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > counts.other && best[1] / total >= 0.5 ? best[0] : null;
}

/** What the beat measurement needs. */
export interface BeatInput {
  hasAudio: boolean;
  bpm: number | null;
  confidence: number;
  /** Beat times on the video timeline (audio/video offset already added). */
  beatTimesSec: readonly number[];
  speechLikely: boolean;
  /** Hard cuts, punch-in jumps and flash peaks. */
  cutTimesSec: readonly number[];
  fps: number;
}

/** Whether the reference's own beat grid is trustworthy, or why not. */
export function beatGridStatus(input: Pick<BeatInput, 'hasAudio' | 'bpm' | 'confidence' | 'speechLikely'>): BeatNotMeasuredReason | null {
  if (!input.hasAudio) return 'no_audio';
  if (input.speechLikely && input.confidence < T.speechTempoConfidence && input.bpm) return 'mostly_speech';
  if (!input.bpm || input.confidence < T.minTempoConfidence) return input.speechLikely ? 'mostly_speech' : 'no_clear_beat';
  return null;
}

/**
 * Beat sync (design §4.3.1.3b): cuts against the reference's own beat grid, with a chance correction. Reportable only
 * when at least 60 % of cuts land within 80 ms of a beat and that is unlikely by chance (binomial p < 0.01). Never
 * reported as "off the beat" when the beat itself was not measured.
 */
export function measureBeatSignal(input: BeatInput): BeatSignal {
  const reason = beatGridStatus(input);
  if (reason) return { status: 'not_measured', reason, bpm: reason === 'mostly_speech' || reason === 'no_clear_beat' || !input.bpm ? null : r1(input.bpm) };
  const bpm = input.bpm!;
  const cuts = input.cutTimesSec.length;
  if (cuts < T.minCutsForBeat) return { status: 'not_measured', reason: 'too_few_cuts', bpm: r1(bpm) };
  const a = alignCutsToBeats(input.cutTimesSec, input.beatTimesSec, input.fps);
  const p0 = chanceShare80ms(bpm);
  const kMin = binomialMinAligned(cuts, p0);
  const reportable = a.within80ms >= Math.max(Math.ceil(T.alignedShareMin * cuts), kMin);
  const counts = beatsPerCutCounts(a.alignedCutTimesSec, 60 / bpm);
  return {
    status: 'measured',
    bpm: r1(bpm),
    confidence: r3(clamp(input.confidence, 0, 1)),
    cuts,
    within1Frame: a.within1Frame,
    within80ms: a.within80ms,
    chanceShare80ms: r3(p0),
    offBeatHalf: a.offBeatHalf,
    medianOffsetMs: a.medianOffsetMs,
    beatsPerCutCounts: counts,
    beatsPerCut: beatsPerCutMode(counts),
    reportable,
  };
}

// ---------------------------------------------------------------- drop and energy

export interface DropResult {
  found: boolean;
  atSec: number;
  riseDb: number;
  levelAfterDb: number;
}

const dbOf = (p: number) => 10 * Math.log10(Math.max(p, 1e-10));

/** Power curve (energy²) smoothed with a moving mean of `windowSec`. */
function smoothedPower(energy: readonly number[], stepSec: number, windowSec = 1): number[] {
  const p = energy.map((e) => e * e);
  const half = Math.max(0, Math.round(windowSec / stepSec / 2));
  return p.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j < Math.min(p.length, i + half); j++) {
      sum += p[j]!;
      n++;
    }
    return n ? sum / n : p[i]!;
  });
}

function meanRange(values: readonly number[], from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) {
    sum += values[i]!;
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * The drop (design §4.3.1.3c): the largest rise of mean power over [t, t + 1 s] against [t − 2 s, t], for t in
 * [1.5 s, span − 1 s]. Found when the rise is at least 6 dB, the median power of the second after it rises too (so
 * a single knock is not a drop) and the level after it is within 3 dB of the 75th percentile (a real lift into a loud
 * part). Refined to the nearest beat in [t − 0.4, t + 0.15]
 * when beats are given. Null when the audio is too short to tell. Works on the 0.25 s energy curve stored for the
 * owner's tracks too (the strongest beat of a track).
 */
export function findDrop(energy: readonly number[], stepSec: number, opts: { spanSec?: number; beatTimesSec?: readonly number[] } = {}): DropResult | null {
  if (!(stepSec > 0) || energy.length === 0) return null;
  const span = Math.min(opts.spanSec ?? energy.length * stepSec, energy.length * stepSec);
  const power = energy.map((e) => e * e);
  const afterN = Math.max(1, Math.round(1 / stepSec));
  const beforeN = Math.max(1, Math.round(2 / stepSec));
  const first = Math.ceil(1.5 / stepSec - 1e-9);
  const last = Math.floor((span - 1) / stepSec + 1e-9);
  if (last < first) return null;
  let best = -1;
  let bestRise = Number.NEGATIVE_INFINITY;
  let bestAfter = 0;
  let bestMedianRise = 0;
  for (let j = first; j <= last; j++) {
    const after = meanRange(power, j, j + afterN);
    const before = meanRange(power, j - beforeN, j);
    const rise = dbOf(after) - dbOf(before);
    // Ties (within 0.1 dB) go to the later window: with a beat-periodic energy curve the window just before the
    // lift can score the same, and the lift itself is the later one.
    if (rise >= bestRise - 0.1 && (best < 0 || j - best <= 1 || rise > bestRise)) {
      bestRise = Math.max(bestRise, rise);
      best = j;
      bestAfter = after;
      bestMedianRise = dbOf(median(power.slice(j, j + afterN))) - dbOf(median(power.slice(Math.max(0, j - beforeN), j)));
    }
  }
  if (best < 0) return null;
  const inSpan = Math.max(1, Math.round(span / stepSec));
  const levels = smoothedPower(energy.slice(0, inSpan), stepSec).map(dbOf);
  const p75 = quantile(levels, 0.75);
  const levelAfterDb = dbOf(bestAfter);
  // The lift starts somewhere inside the first louder window: use its middle before refining to a beat.
  let at = (best + 0.5) * stepSec;
  const beats = opts.beatTimesSec ?? [];
  const nearby = beats.filter((b) => b >= at - 0.4 - 1e-9 && b <= at + 0.15 + 1e-9);
  if (nearby.length) at = nearby.reduce((m, b) => (Math.abs(b - at) < Math.abs(m - at) ? b : m), nearby[0]!);
  // A single knock lifts the mean but not the median of the second after it, so it is not a drop.
  const sustained = bestMedianRise >= T.dropMinRiseDb / 2;
  return { found: bestRise >= T.dropMinRiseDb && sustained && levelAfterDb >= p75 - T.dropLevelWithinDb, atSec: r3(at), riseDb: r1(bestRise), levelAfterDb: r1(levelAfterDb) };
}

export interface EnergyShape {
  shape: number[];
  dynamicRangeDb: number;
  /** Second half minus first half, in dB. */
  lift: number;
}

/** The measured span in 8 equal parts, each the mean power in dB relative to the loudest part, mapped to 0–1. */
export function energyShape(energy: readonly number[], stepSec: number, spanSec: number): EnergyShape | null {
  const n = Math.min(energy.length, Math.round(spanSec / stepSec));
  if (n < 8 || !(stepSec > 0)) return null;
  const power = energy.slice(0, n).map((e) => e * e);
  const parts = Array.from({ length: 8 }, (_, k) => meanRange(power, Math.floor((k * n) / 8), Math.floor(((k + 1) * n) / 8)));
  const loudest = Math.max(...parts);
  if (!(loudest > 0)) return null;
  const shape = parts.map((p) => r3(clamp((dbOf(p) - dbOf(loudest) + 24) / 24, 0, 1)));
  const levels = smoothedPower(energy.slice(0, n), stepSec).map(dbOf);
  const dynamicRangeDb = r1(quantile(levels, 0.9) - quantile(levels, 0.1));
  const lift = dbOf(meanRange(power, Math.floor(n / 2), n)) - dbOf(meanRange(power, 0, Math.floor(n / 2)));
  return { shape, dynamicRangeDb, lift: r1(lift) };
}

/** Display word for a music shape (never used to decide anything). */
export function shapeWordFor(e: EnergyShape, hasDrop: boolean): MusicSignal['shapeWord'] {
  if (e.dynamicRangeDb < 4) return 'steady';
  if (e.lift >= 4) return 'builds';
  if (hasDrop) return 'drop';
  return 'varied';
}

// ---------------------------------------------------------------- transitions

/** Shares used by the palette rules (design §4.3.1.3a): flashes are accents on top of the ordinary joins. */
export function transitionShares(t: Pick<TransitionSignal, 'joins' | 'counts'>) {
  const c = (k: BoundaryKind) => t.counts[k] ?? 0;
  const classified = Math.max(0, t.joins - c('unclear') - c('punch_in'));
  const flashes = c('fade_white') + c('fade_black');
  const base = Math.max(0, classified - flashes);
  const motion = c('slide_vertical') + c('wipe_horizontal') + c('zoom') + c('whip_like');
  return {
    classified,
    flash: classified ? flashes / classified : 0,
    base,
    hard: base ? c('hard') / base : 0,
    cross: base ? c('cross_fade') / base : 0,
    motion: base ? motion / base : 0,
    unclearShare: t.joins ? c('unclear') / t.joins : 0,
  };
}

/** The family of joins in one video, or null when nothing could be classified. */
export function transitionFamily(t: Pick<TransitionSignal, 'joins' | 'counts'>): TransitionFamily | null {
  const s = transitionShares(t);
  if (s.classified === 0) return null;
  if (s.hard >= 0.85 && s.flash < 0.08) return 'straight_only';
  if (s.hard >= 0.6 && s.flash >= 0.08) return 'straight_flash';
  if (s.cross >= 0.3) return 'cross_fades';
  if (s.motion >= 0.25) return 'movement';
  return 'mixed';
}

/** At least 5 classified joins and no more than 30 % unclear. */
export function transitionsReportable(t: Pick<TransitionSignal, 'joins' | 'counts'>): boolean {
  const s = transitionShares(t);
  return s.classified >= T.minClassifiedJoins && s.unclearShare <= T.maxUnclearShare;
}

/** The renderer's transition for a measured kind (design §4.3.1.3a mapping table); null for kinds that are not transitions. */
export function transitionTypeForKind(kind: BoundaryKind, directions: TransitionSignal['directions']): TransitionType | null {
  switch (kind) {
    case 'fade_white':
      return 'fadewhite';
    case 'fade_black':
      return 'fadeblack';
    case 'cross_fade':
      return 'fade';
    case 'slide_vertical':
      return directions.down > directions.up ? 'slidedown' : 'slideup';
    case 'wipe_horizontal':
    case 'whip_like':
      return directions.right > directions.left ? 'wiperight' : 'wipeleft';
    case 'zoom':
      return 'zoomin';
    default:
      return null;
  }
}

const BASE_KINDS: BoundaryKind[] = ['cross_fade', 'slide_vertical', 'wipe_horizontal', 'zoom', 'whip_like'];

/**
 * The transition palette for measured joins (design §4.3.1.3a table, first match wins), or null when nothing was
 * classified. Uses only `TRANSITION_TYPES`; `circleopen` is never suggested.
 */
export function paletteFromCounts(t: Pick<TransitionSignal, 'joins' | 'counts' | 'directions' | 'crossFadeMedianSec' | 'flashMedianSec' | 'flashesOnBeat' | 'flashEveryBeats'>): TransitionPalette | null {
  const family = transitionFamily(t);
  if (!family) return null;
  const s = transitionShares(t);
  const c = (k: BoundaryKind) => t.counts[k] ?? 0;
  const flashes = c('fade_white') + c('fade_black');
  const accent = (): TransitionPalette['accent'] => {
    if (s.flash < 0.08 || flashes === 0) return null;
    const type = c('fade_black') > c('fade_white') ? 'fadeblack' : 'fadewhite';
    const onBeat = t.flashesOnBeat ?? 0;
    const spacing = t.flashEveryBeats === null ? null : Math.round(t.flashEveryBeats);
    const everyBeats = flashes >= 3 && t.flashesOnBeat !== null && onBeat / flashes >= 0.6 && (spacing === 4 || spacing === 8) ? spacing : null;
    return { type, everyBeats, durationSec: round05(clamp(t.flashMedianSec ?? 0.2, 0.15, 0.3)) };
  };
  const mapped = (kinds: BoundaryKind[]) => {
    const out: Array<{ type: TransitionType; n: number }> = [];
    for (const k of kinds) {
      const type = transitionTypeForKind(k, t.directions);
      if (!type || c(k) === 0) continue;
      const existing = out.find((o) => o.type === type);
      if (existing) existing.n += c(k);
      else out.push({ type, n: c(k) });
    }
    return out.sort((a, b) => b.n - a.n);
  };
  const shareOf = (n: number) => (s.base ? n / s.base : 0);
  const crossLen = round05(clamp(t.crossFadeMedianSec ?? 0.5, 0.3, 1));
  const hardShare = round05(s.hard);
  switch (family) {
    case 'straight_only':
      return { hardCutShare: 1, types: [], durationSec: 0.3, accent: null };
    case 'straight_flash': {
      const types = mapped(BASE_KINDS).filter((m) => shareOf(m.n) >= 0.1).map((m) => m.type).slice(0, 3);
      return { hardCutShare: hardShare, types, durationSec: types.includes('fade') ? crossLen : 0.3, accent: accent() };
    }
    case 'cross_fades': {
      const others = mapped(BASE_KINDS.filter((k) => k !== 'cross_fade')).filter((m) => shareOf(m.n) >= 0.1).map((m) => m.type);
      return { hardCutShare: hardShare, types: (['fade', ...others] as TransitionType[]).slice(0, 3), durationSec: crossLen, accent: accent() };
    }
    case 'movement':
      return { hardCutShare: hardShare, types: mapped(['slide_vertical', 'wipe_horizontal', 'zoom', 'whip_like']).map((m) => m.type).slice(0, 3), durationSec: 0.3, accent: accent() };
    case 'mixed':
    default:
      return { hardCutShare: hardShare, types: mapped(BASE_KINDS).filter((m) => shareOf(m.n) >= 0.1).map((m) => m.type).slice(0, 2), durationSec: crossLen, accent: accent() };
  }
}

// ---------------------------------------------------------------- assembling one video's signals

/** One join between shots as measured (in memory only; never stored). */
export interface RawJoin {
  kind: BoundaryKind;
  /** The moment the picture changes: the cut frame, the flash peak or the middle of a gradual join. */
  timeSec: number;
  durationSec: number;
  direction?: 'up' | 'down' | 'left' | 'right' | null;
  /** Scale of a punch-in jump. */
  scale?: number | null;
}

/** Everything `measureReferenceStyle` found, before it is reduced to the stored numbers. */
export interface RawReferenceStyle {
  fps: number;
  measuredSec: number;
  endScreenTrimmedSec: number;
  joins: RawJoin[];
  zoomShots: { checked: number; pushScales: number[]; pullScales: number[] };
  /** null when the video has no sound. */
  audio: { bpm: number | null; confidence: number; beatTimesSec: number[]; energy: number[]; energyStepSec: number; speechLikely: boolean } | null;
}

/**
 * Reduces raw measurements to the stored v2 signals: counts, ratios, quartiles, the 8-point energy shape and the drop
 * position. Beat times, cut times and the energy curve are dropped here.
 */
export function assembleReferenceSignals(raw: RawReferenceStyle): ReferenceStyleSignals {
  const span = Math.max(0, raw.measuredSec);
  const joins = raw.joins.filter((j) => j.timeSec > 0 && j.timeSec < span).sort((a, b) => a.timeSec - b.timeSec);
  const counts: Partial<Record<BoundaryKind, number>> = {};
  const directions = { up: 0, down: 0, left: 0, right: 0 };
  for (const j of joins) {
    counts[j.kind] = (counts[j.kind] ?? 0) + 1;
    if (j.direction) directions[j.direction]++;
  }
  // Shots between v2 boundaries, no merging or splitting.
  const edges = [0, ...joins.map((j) => j.timeSec), span];
  const shots = edges.slice(1).map((e, i) => e - edges[i]!).filter((d) => d > 1e-3);

  const audio = raw.audio;
  const gridReason = audio ? beatGridStatus({ hasAudio: true, bpm: audio.bpm, confidence: audio.confidence, speechLikely: audio.speechLikely }) : 'no_audio';
  const beatsKnown = gridReason === null && audio !== null;
  const beatTimes = beatsKnown ? audio.beatTimesSec.filter((b) => b >= -0.5 && b <= span + 0.5) : [];
  const flashes = joins.filter((j) => j.kind === 'fade_white' || j.kind === 'fade_black');
  const changeTimes = joins.filter((j) => j.kind === 'hard' || j.kind === 'punch_in' || j.kind === 'fade_white' || j.kind === 'fade_black').map((j) => j.timeSec);

  let flashesOnBeat: number | null = null;
  let flashEveryBeats: number | null = null;
  if (beatsKnown && audio.bpm) {
    flashesOnBeat = alignCutsToBeats(flashes.map((f) => f.timeSec), beatTimes, raw.fps).within80ms;
    if (flashes.length >= 2) {
      const iv = 60 / audio.bpm;
      flashEveryBeats = r1(median(flashes.slice(1).map((f, i) => (f.timeSec - flashes[i]!.timeSec) / iv)));
    }
  }
  const tBase = {
    joins: joins.length,
    counts,
    directions,
    crossFadeMedianSec: counts.cross_fade ? r2(median(joins.filter((j) => j.kind === 'cross_fade').map((j) => j.durationSec))) : null,
    flashMedianSec: flashes.length ? r2(median(flashes.map((f) => f.durationSec))) : null,
    flashesOnBeat,
    flashEveryBeats,
  };
  const transitions: TransitionSignal = { ...tBase, family: transitionFamily(tBase), reportable: transitionsReportable(tBase) };

  const beat = measureBeatSignal({
    hasAudio: audio !== null,
    bpm: audio?.bpm ?? null,
    confidence: audio?.confidence ?? 0,
    beatTimesSec: beatTimes,
    speechLikely: audio?.speechLikely ?? false,
    cutTimesSec: changeTimes,
    fps: raw.fps,
  });

  let drop: DropSignal = { status: 'not_measured', atSec: null, atShare: null, riseDb: null, visualEvent: null, eventOffsetMs: null };
  let music: MusicSignal = { status: 'not_measured', bpm: null, energyShape: null, shapeWord: null, dynamicRangeDb: null, hasClearDrop: false };
  if (audio && audio.energy.length > 0) {
    const d = findDrop(audio.energy, audio.energyStepSec, { spanSec: span, ...(beatsKnown ? { beatTimesSec: beatTimes } : {}) });
    if (d) {
      let visualEvent: DropSignal['visualEvent'] = null;
      let eventOffsetMs: number | null = null;
      if (d.found && beatsKnown) {
        const near = joins
          .filter((j) => j.kind === 'hard' || j.kind === 'punch_in' || j.kind === 'fade_white' || j.kind === 'fade_black')
          .map((j) => ({ j, off: j.timeSec - d.atSec }))
          .filter((x) => Math.abs(x.off) <= T.dropEventWindowSec + 1e-6)
          .sort((a, b) => Math.abs(a.off) - Math.abs(b.off))[0];
        visualEvent = near ? (near.j.kind === 'hard' ? 'cut' : near.j.kind === 'punch_in' ? 'zoom' : 'flash') : 'none';
        eventOffsetMs = near ? Math.round(near.off * 1000) : null;
      }
      drop = d.found
        ? { status: 'found', atSec: r2(d.atSec), atShare: span > 0 ? r3(clamp(d.atSec / span, 0, 1)) : null, riseDb: d.riseDb, visualEvent, eventOffsetMs }
        : { status: 'none', atSec: null, atShare: null, riseDb: d.riseDb, visualEvent: null, eventOffsetMs: null };
    }
    if (audio.bpm && audio.confidence >= T.minTempoConfidence) {
      const shape = energyShape(audio.energy, audio.energyStepSec, span);
      const hasClearDrop = drop.status === 'found';
      music = {
        status: 'measured',
        bpm: r1(audio.bpm),
        energyShape: shape?.shape ?? null,
        shapeWord: shape ? shapeWordFor(shape, hasClearDrop) : null,
        dynamicRangeDb: shape?.dynamicRangeDb ?? null,
        hasClearDrop,
      };
    }
  }

  const punch = joins.filter((j) => j.kind === 'punch_in' && typeof j.scale === 'number').map((j) => j.scale as number);
  const zoom: ZoomSignal = {
    shotsChecked: raw.zoomShots.checked,
    pushIns: raw.zoomShots.pushScales.length,
    pullOuts: raw.zoomShots.pullScales.length,
    punchIns: counts.punch_in ?? 0,
    medianPushScale: raw.zoomShots.pushScales.length ? r2(median(raw.zoomShots.pushScales)) : null,
    medianPunchScale: punch.length ? r2(median(punch)) : null,
  };

  return {
    analysisVersion: REFERENCE_STYLE_ANALYSIS_VERSION,
    estimate: true,
    measuredSec: r2(span),
    endScreenTrimmedSec: r2(raw.endScreenTrimmedSec),
    fps: r2(raw.fps),
    shots: { count: shots.length, medianSec: r3(median(shots)), p25Sec: r3(quantile(shots, 0.25)), p75Sec: r3(quantile(shots, 0.75)) },
    transitions,
    beat,
    drop,
    zoom,
    music,
  };
}

// ---------------------------------------------------------------- per-video values

/** One video's zoom suggestion, or the reason there is none. */
export function zoomUseForVideo(style: ReferenceStyleSignals): { value: ZoomUse | null; reason: string | null } {
  const z = style.zoom;
  const cuts = (style.transitions.counts.hard ?? 0) + (style.transitions.counts.punch_in ?? 0);
  if (cuts > 0 && z.punchIns / cuts >= 0.15 && z.medianPunchScale !== null) {
    return { value: { mode: 'punch_in', scale: r2(clamp(z.medianPunchScale, 1.08, 1.25)), shareOfCuts: round05(clamp(z.punchIns / cuts, 0.1, 0.5)) }, reason: null };
  }
  if (z.shotsChecked < T.minZoomShots) return { value: null, reason: 'too_few_shots' };
  if (z.pushIns / z.shotsChecked >= 0.3 && z.medianPushScale !== null) return { value: { mode: 'push_in', scale: r2(clamp(z.medianPushScale, 1.03, 1.12)) }, reason: null };
  if (z.shotsChecked >= T.noZoomShots && z.pushIns + z.pullOuts + z.punchIns === 0) return { value: { mode: 'none' }, reason: null };
  return { value: null, reason: 'no_clear_zoom' };
}

/** Folds a tempo by ×2 or ÷2 when that brings it closer to `centre` (half/double time is common). */
export function foldTempo(bpm: number, centre: number): number {
  const options = [bpm, bpm * 2, bpm / 2];
  return options.reduce((best, b) => (Math.abs(Math.log(b / centre)) < Math.abs(Math.log(best / centre)) ? b : best), bpm);
}

// ---------------------------------------------------------------- combining videos

export type SummaryRowState = 'open' | 'matches' | 'differs' | 'accepted' | 'dismissed' | 'not_measured';

export interface SummaryEvidence {
  measured: number;
  agreeing: number;
  total: number;
  notMeasured: Array<{ reason: string; count: number }>;
}

/** Side effects of accepting a row, shown before the owner presses the button. */
export interface SummaryAlsoChange {
  field: 'transitions' | EditingStyleField;
  value: unknown;
}

/** One row of "Your style from your videos". */
export interface SummarySuggestion {
  field: ReferenceSummaryField;
  label: string;
  /** null when nothing can be suggested. */
  value: unknown;
  valueKey: string | null;
  /** What was seen, in plain words (always an estimate). */
  seen: string;
  /** The button wording, e.g. "Use half-second cross-fades"; null when there is no button. */
  action: string | null;
  evidence: SummaryEvidence;
  alsoChanges: SummaryAlsoChange[];
  state: SummaryRowState;
  /**
   * True when the value in use came from your videos. It stays `inUse` while that value is in use, also when the videos
   * now suggest another one (`state` open or dismissed, `seen` ending with {@link STILL_IN_USE_LINE}), and for an
   * editing-style row when nothing measured backs it any more (`value` null: the videos were removed, or measured with
   * an older version of the measuring), so the card can still show it and, on an editing-style row, offer to stop it.
   */
  inUse: boolean;
}

/**
 * Added to a row whose value from the videos is still in use while the videos now suggest another one, and to an
 * editing-style row whose value from the videos is still in use when nothing measured backs it now.
 */
export const STILL_IN_USE_LINE = 'What you accepted earlier from your videos is still in use.';

export interface ReferenceStyleSummary {
  /** Profiles combined into the rows (of the latest 12 ready ones, those not from an older version of the measuring). */
  total: number;
  /** Profiles with v2 signals measured by the current version of the measuring. */
  measured: number;
  /** Profiles measured before transitions and beat were added (they count for length, pace, colour and text only). */
  olderMeasurement: number;
  /** Profiles measured by an older version of the measuring: not combined into any row (upload them again). */
  olderVersion: number;
  /** Latest measurement time combined (ISO), or null. */
  updatedAt: string | null;
  referenceAssetIds: string[];
  suggestions: SummarySuggestion[];
}

/** Most profiles combined. */
export const SUMMARY_MAX_PROFILES = 12;

/** Plain row labels in display order. */
export const SUMMARY_ROW_LABELS: Record<Exclude<ReferenceSummaryField, 'beatsPerCut'>, string> = {
  pacing: 'Pace',
  defaultDurationSec: 'Length',
  colour: 'Colour',
  textDensity: 'On-screen text',
  transitionPalette: 'Transitions',
  beatSync: 'Cutting to the beat',
  reveal: 'Big moment (reveal)',
  zoom: 'Zooms',
  musicFit: 'Music',
};
const ROW_ORDER = Object.keys(SUMMARY_ROW_LABELS) as Array<keyof typeof SUMMARY_ROW_LABELS>;

/** The rows that set the editing style (each with **Change: use each style's own** while a value from the videos is in use). */
export const EDITING_STYLE_ROW_FIELDS = ['transitionPalette', 'beatSync', 'reveal', 'zoom', 'musicFit'] as const satisfies readonly EditingStyleField[];
export type EditingStyleRowField = (typeof EDITING_STYLE_ROW_FIELDS)[number];

/**
 * The editing-style values a row sets when it is accepted: its own, and for "Cutting to the beat" also the beats per cut
 * (the value its `alsoChanges` carry, or none). A row is in use from the videos while any of them is, and stopping it
 * (`resetEditingStyle(prefs, row)`) resets all of them, so nothing accepted with a row stays in use unseen. A bolder
 * palette's `transitions: 'varied'` is an ordinary preference shown under Transitions, and stays, as with the reset.
 */
export const SUMMARY_ROW_STYLE_FIELDS: Readonly<Record<EditingStyleRowField, readonly EditingStyleField[]>> = {
  transitionPalette: ['transitionPalette'],
  beatSync: ['beatSync', 'beatsPerCut'],
  reveal: ['reveal'],
  zoom: ['zoom'],
  musicFit: ['musicFit'],
};

export function isEditingStyleRow(field: string): field is EditingStyleRowField {
  return (EDITING_STYLE_ROW_FIELDS as readonly string[]).includes(field);
}

const REASON_WORDS: Record<string, string> = {
  no_audio: 'had no sound',
  no_clear_beat: 'had no clear beat',
  mostly_speech: 'was mostly talking',
  too_few_cuts: 'had too few cuts to tell',
  not_above_chance: "had cuts near the beat no more often than chance",
  too_few_joins: 'had too few joins to tell',
  too_many_unclear: 'had too many unclear joins',
  older_measurement: 'was measured before transitions and beat were added',
  text_not_measured: 'had no on-screen text estimate',
  too_few_shots: 'had too few shots to tell',
  no_clear_zoom: 'showed no clear zoom pattern',
  no_drop: 'had no clear lift in the music',
  too_short: 'was too short or too long to suggest a length',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function seenIn(e: SummaryEvidence): string {
  const base = `Seen in ${e.agreeing} of ${e.total} video${e.total === 1 ? '' : 's'}`;
  if (e.notMeasured.length === 0) return `${base}.`;
  const parts = e.notMeasured.map((r) => `${r.count} ${REASON_WORDS[r.reason] ?? 'could not be measured'}`);
  return `${base} (${parts.join(', ')}).`;
}

interface Vote<V> {
  assetId: string;
  value: V | null;
  reason: string | null;
}

function evidenceFrom<V>(votes: Vote<V>[], agreeing: number): SummaryEvidence {
  const reasons = new Map<string, number>();
  for (const v of votes) if (v.value === null && v.reason) reasons.set(v.reason, (reasons.get(v.reason) ?? 0) + 1);
  return { measured: votes.filter((v) => v.value !== null).length, agreeing, total: votes.length, notMeasured: [...reasons.entries()].map(([reason, count]) => ({ reason, count })) };
}

/** Majority of categorical values (ties go to the newest video's value). */
function majority<V>(votes: Vote<V>[], key: (v: V) => string): { value: V; agreeing: Vote<V>[] } | null {
  const measured = votes.filter((v): v is Vote<V> & { value: V } => v.value !== null);
  if (!measured.length) return null;
  const groups = new Map<string, Array<Vote<V> & { value: V }>>();
  for (const v of measured) {
    const k = key(v.value);
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  let best: Array<Vote<V> & { value: V }> | null = null;
  for (const g of groups.values()) if (!best || g.length > best.length) best = g;
  return { value: best![0]!.value, agreeing: best! };
}

function reportable(e: SummaryEvidence): boolean {
  if (e.measured === 0) return false;
  return e.agreeing / e.measured >= T.agreeShare && (e.measured >= 2 || e.total === 1);
}

interface Candidate {
  value: unknown;
  seen: string;
  action: string;
  alsoChanges: SummaryAlsoChange[];
  evidence: SummaryEvidence;
  /** Value currently in use, for "matches your settings". */
  current: unknown;
  /** Source of the value in use was a summary accept. */
  fromVideos: boolean;
}

function paletteWords(p: TransitionPalette): { seen: string; action: string } {
  const pct = Math.round(p.hardCutShare * 100);
  const accent = p.accent
    ? `${p.accent.type === 'fadewhite' ? 'a quick white flash' : 'a quick dip to black'}${p.accent.everyBeats ? ` every ${p.accent.everyBeats} beats` : ' at the big moment'}`
    : null;
  const typeWords = (types: TransitionType[]) =>
    [...new Set(types.map((t) => ({ fade: 'soft cross-fades', dissolve: 'soft cross-fades', fadeblack: 'dips to black', fadewhite: 'white flashes', wipeleft: 'wipes', wiperight: 'wipes', slideup: 'slides', slidedown: 'slides', circleopen: 'iris openings', zoomin: 'zoom transitions' })[t]))].join(' and ');
  const len = p.durationSec <= 0.55 && p.durationSec >= 0.45 ? 'about half a second' : `about ${p.durationSec.toFixed(2).replace(/0$/, '')} s`;
  if (p.types.length === 0 && p.hardCutShare >= 0.95) {
    return accent
      ? { seen: `Mostly straight cuts, with ${accent}.`, action: `Use straight cuts with ${accent.replace('a quick ', 'a ')}` }
      : { seen: 'Straight cuts between almost every shot.', action: 'Use straight cuts' };
  }
  if (p.types[0] === 'fade') {
    return {
      seen: `${pct >= 50 ? `Mostly straight cuts (about ${pct} %), with soft` : 'Soft'} cross-fades of ${len}${accent ? `, and ${accent}` : ''}.`,
      action: p.durationSec >= 0.45 && p.durationSec <= 0.55 ? 'Use half-second cross-fades' : `Use ${p.durationSec.toFixed(2).replace(/0$/, '')} s cross-fades`,
    };
  }
  return {
    seen: `${pct > 0 ? `Straight cuts for about ${pct} % of joins, the rest ` : ''}${typeWords(p.types) || 'straight cuts'}${accent ? `, with ${accent}` : ''}.`,
    action: `Use ${typeWords(p.types) || 'straight cuts'}${pct > 0 ? ' between some shots' : ''}`,
  };
}

function zoomWords(z: ZoomUse, checked: number): { seen: string; action: string } {
  if (z.mode === 'punch_in') {
    const oneIn = Math.max(2, Math.round(1 / z.shareOfCuts));
    return { seen: `Quick punch-in zooms on about 1 in ${oneIn} cuts (estimate).`, action: `Use punch-in zooms (up to ${z.scale.toFixed(2).replace(/0$/, '')}×)` };
  }
  if (z.mode === 'push_in') return { seen: `Slow push-ins (zoom or moving closer) in many shots, to about ${z.scale.toFixed(2).replace(/0$/, '')}×.`, action: 'Use slow push-ins' };
  if (z.mode === 'none') return { seen: `No zooms seen in ${plural(checked, 'shot')}.`, action: 'Keep shots unzoomed' };
  return { seen: "Each style's own zooms.", action: "Use each style's own zooms" };
}

/**
 * Combines the latest reference profiles (all projects) into "your style" (design §4.3.1.4). Each video counts once;
 * a row is offered only when at least 60 % of the measured videos agree and at least two were measured (or exactly
 * one video was uploaded). Older v1-only profiles count for the length, pace, colour and text rows only. Profiles
 * measured by another version of the measuring (`style.analysisVersion` is not `opts.analysisVersion`, by default
 * REFERENCE_STYLE_ANALYSIS_VERSION) are not combined into any row: every number in them, the shot lengths behind the
 * pace included, came from that measuring. They are counted in `olderVersion` so the owner can be told. Pure.
 */
export function summariseReferenceStyle(profilesNewestFirst: readonly ReferenceStyleProfileV2[], prefs: EditingPreferences, opts: { analysisVersion?: number } = {}): ReferenceStyleSummary {
  const latest = profilesNewestFirst.slice(0, SUMMARY_MAX_PROFILES);
  const profiles = latest.filter((p) => !isOlderMeasuringVersion(p, opts.analysisVersion));
  const effective = effectivePreferences(prefs);
  const style: EditingStyle = prefs.editingStyle ?? DEFAULT_EDITING_STYLE;
  const v2 = profiles.filter((p) => p.style !== null);
  const candidates = new Map<keyof typeof SUMMARY_ROW_LABELS, Candidate | { evidence: SummaryEvidence; seen: string; differs: boolean }>();
  const fromVideos = (field: ReferenceSuggestionField) => effective.learning.pinned[field]?.by === 'reference' && (effective.learning.pinned[field]?.referenceAssetIds.length ?? 0) > 0;
  const styleFromVideos = (field: EditingStyleField) => style.sources[field]?.by === 'reference';

  const settle = <V>(field: keyof typeof SUMMARY_ROW_LABELS, votes: Vote<V>[], key: (v: V) => string, make: (value: V, agreeing: Vote<V>[], e: SummaryEvidence) => Omit<Candidate, 'evidence'> | null, emptySeen: string) => {
    const maj = majority(votes, key);
    const e = evidenceFrom(votes, maj?.agreeing.length ?? 0);
    if (!maj) return void candidates.set(field, { evidence: e, seen: emptySeen, differs: false });
    if (!reportable(e)) {
      const split = e.measured >= 2;
      return void candidates.set(field, { evidence: e, seen: split ? 'Your videos differ here.' : `Seen in only 1 of ${e.total} videos — another video or two will help.`, differs: split });
    }
    const made = make(maj.value, maj.agreeing, e);
    if (!made) return void candidates.set(field, { evidence: e, seen: emptySeen, differs: false });
    candidates.set(field, { ...made, evidence: e });
  };

  // --- v1 rows (every profile counts)
  settle(
    'pacing',
    profiles.map((p) => ({ assetId: p.assetId, value: p.shotCount >= (p.style ? 3 : 1) ? classifyPacing(p.shotSec.median) : null, reason: 'too_few_shots' })),
    (v) => v,
    (value, agreeing) => {
      const med = median(profiles.filter((p) => agreeing.some((a) => a.assetId === p.assetId)).map((p) => p.shotSec.median));
      return { value, seen: `Shots last about ${med.toFixed(1)} s (median), which reads as ${value === 'fast' ? 'fast' : value === 'slow' ? 'slow' : 'balanced'} pacing.`, action: `Use ${value} pacing`, alsoChanges: [], current: effective.pacing, fromVideos: fromVideos('pacing') };
    },
    'Pace: not measured yet.',
  );
  {
    const lens: Array<Vote<number>> = profiles.map((p) => ({ assetId: p.assetId, value: suggestedDuration(p.durationSec), reason: 'too_short' }));
    const measured = lens.filter((l): l is Vote<number> & { value: number } => l.value !== null);
    const med = measured.length ? Math.min(90, Math.max(10, Math.round(median(measured.map((m) => m.value)) / 5) * 5)) : 0;
    const agree = measured.filter((m) => Math.abs(m.value - med) <= Math.max(5, med * 0.2));
    const e = evidenceFrom(lens, agree.length);
    if (!measured.length) candidates.set('defaultDurationSec', { evidence: e, seen: 'Length: not measured yet.', differs: false });
    else if (!reportable(e)) candidates.set('defaultDurationSec', { evidence: e, seen: e.measured >= 2 ? 'Your videos differ here.' : `Seen in only 1 of ${e.total} videos — another video or two will help.`, differs: e.measured >= 2 });
    else candidates.set('defaultDurationSec', { value: med, seen: `Your videos run for about ${med} seconds.`, action: `Make edits ${med} seconds long by default`, alsoChanges: [], current: effective.defaultDurationSec, fromVideos: fromVideos('defaultDurationSec'), evidence: e });
  }
  settle(
    'colour',
    profiles.map((p) => ({ assetId: p.assetId, value: p.colourLook as ColourLook, reason: null })),
    (v) => v,
    (value) => ({ value, seen: `${value.charAt(0).toUpperCase()}${value.slice(1)} colour (estimated from brightness, saturation and contrast).`, action: `Use ${value} colour`, alsoChanges: [], current: effective.colour, fromVideos: fromVideos('colour') }),
    'Colour: not measured yet.',
  );
  settle(
    'textDensity',
    profiles.map((p) => ({ assetId: p.assetId, value: p.text.source === 'vision_model' ? p.text.density : null, reason: 'text_not_measured' })),
    (v) => v,
    (value) => ({ value, seen: value === 'none' ? 'No added on-screen text in the checked frames.' : `${value === 'light' ? 'Light' : 'Plenty of'} on-screen text in the checked frames.`, action: `Use ${value === 'none' ? 'no' : value} on-screen text`, alsoChanges: [], current: effective.textDensity, fromVideos: fromVideos('textDensity') }),
    'On-screen text: not measured (it is only estimated when you tick the box on upload).',
  );

  const older = (p: ReferenceStyleProfileV2) => (p.style === null ? 'older_measurement' : null);

  // --- transitions
  settle(
    'transitionPalette',
    profiles.map((p) => {
      const t = p.style?.transitions;
      if (!t) return { assetId: p.assetId, value: null, reason: older(p) };
      if (!t.reportable || !t.family) return { assetId: p.assetId, value: null, reason: transitionShares(t).classified < T.minClassifiedJoins ? 'too_few_joins' : 'too_many_unclear' };
      return { assetId: p.assetId, value: t.family as TransitionFamily, reason: null };
    }),
    (v) => v,
    (_family, agreeing) => {
      // Pool the join counts of the agreeing videos (videos with more joins carry more evidence).
      const ids = new Set(agreeing.map((a) => a.assetId));
      const pooled = v2.filter((p) => ids.has(p.assetId)).map((p) => p.style!.transitions);
      const counts: Partial<Record<BoundaryKind, number>> = {};
      const directions = { up: 0, down: 0, left: 0, right: 0 };
      let joins = 0;
      let flashesOnBeat: number | null = 0;
      const cross: number[] = [];
      const flash: number[] = [];
      const every: number[] = [];
      for (const t of pooled) {
        joins += t.joins;
        for (const [k, n] of Object.entries(t.counts)) counts[k as BoundaryKind] = (counts[k as BoundaryKind] ?? 0) + (n ?? 0);
        for (const d of ['up', 'down', 'left', 'right'] as const) directions[d] += t.directions[d];
        if (t.crossFadeMedianSec !== null) cross.push(t.crossFadeMedianSec);
        if (t.flashMedianSec !== null) flash.push(t.flashMedianSec);
        if (t.flashEveryBeats !== null) every.push(t.flashEveryBeats);
        const flashes = (t.counts.fade_white ?? 0) + (t.counts.fade_black ?? 0);
        if (flashes > 0) flashesOnBeat = t.flashesOnBeat === null || flashesOnBeat === null ? null : flashesOnBeat + t.flashesOnBeat;
      }
      const palette = paletteFromCounts({ joins, counts, directions, crossFadeMedianSec: cross.length ? median(cross) : null, flashMedianSec: flash.length ? median(flash) : null, flashesOnBeat, flashEveryBeats: every.length ? median(every) : null });
      if (!palette) return null;
      const words = paletteWords(palette);
      const alsoChanges: SummaryAlsoChange[] = flashyPaletteTypes(palette).length > 0 ? [{ field: 'transitions', value: 'varied' }] : [];
      return { value: palette, seen: words.seen, action: words.action, alsoChanges, current: style.transitionPalette, fromVideos: styleFromVideos('transitionPalette') };
    },
    'Transitions: not measured yet.',
  );

  // --- beat
  {
    const votes: Array<Vote<'on' | 'off_chance'>> = profiles.map((p) => {
      const b = p.style?.beat;
      if (!b) return { assetId: p.assetId, value: null, reason: older(p) };
      if (b.status === 'not_measured') return { assetId: p.assetId, value: null, reason: b.reason };
      return { assetId: p.assetId, value: b.reportable ? 'on' : 'off_chance', reason: null };
    });
    settle(
      'beatSync',
      votes,
      (v) => v,
      (value, agreeing) => {
        const beats = v2.filter((p) => agreeing.some((a) => a.assetId === p.assetId)).map((p) => p.style!.beat).filter((b): b is Extract<BeatSignal, { status: 'measured' }> => b.status === 'measured');
        if (value === 'off_chance') return null;
        const per = majority(
          beats.map((b, i) => ({ assetId: String(i), value: b.beatsPerCut, reason: null })),
          (v) => String(v),
        );
        const n = per && per.agreeing.length / Math.max(1, beats.length) >= T.agreeShare ? per.value : null;
        const cuts = beats.reduce((s, b) => s + b.cuts, 0);
        const aligned = beats.reduce((s, b) => s + b.within80ms, 0);
        const bpm = Math.round(median(beats.map((b) => b.bpm)));
        const alsoChanges: SummaryAlsoChange[] = n ? [{ field: 'beatsPerCut', value: n }] : [];
        return {
          value: 'on',
          seen: `Your cuts land on the beat: ${aligned} of ${cuts} within 80 ms (about ${bpm} BPM).`,
          action: n ? `Cut on the beat, about every ${n === 1 ? 'beat' : `${n} beats`}` : 'Cut on the beat',
          alsoChanges,
          current: style.beatSync,
          fromVideos: styleFromVideos('beatSync'),
        };
      },
      'Cutting to the beat: not measured yet.',
    );
    const row = candidates.get('beatSync');
    if (row && !('value' in row)) {
      const maj = majority(votes, (v) => v);
      if (maj?.value === 'off_chance' && reportable(row.evidence)) {
        row.seen = "Some cuts are near a beat, but no more than you'd expect by chance, so we're not suggesting beat-synced cuts.";
      } else if (row.evidence.measured === 0 && row.evidence.notMeasured.length > 0) {
        const r = row.evidence.notMeasured[0]!.reason;
        const word: Record<string, string> = { no_clear_beat: 'the sound in your videos has no clear beat', mostly_speech: "it's mostly talking", no_audio: 'it has no sound', too_few_cuts: 'it has too few cuts to tell', older_measurement: 'they were measured before the beat was added' };
        row.seen = `Beat: not measured — ${word[r] ?? 'it could not be measured'}.`;
      }
    }
  }

  // --- reveal on the strongest beat
  settle(
    'reveal',
    profiles.map((p) => {
      const d = p.style?.drop;
      if (!d) return { assetId: p.assetId, value: null, reason: older(p) };
      if (d.status !== 'found') return { assetId: p.assetId, value: null, reason: d.status === 'none' ? 'no_drop' : 'no_audio' };
      if (d.visualEvent === null) return { assetId: p.assetId, value: null, reason: 'no_clear_beat' };
      return { assetId: p.assetId, value: d.visualEvent === 'none' ? 'no_event' : 'event', reason: null };
    }),
    (v) => v,
    (value, agreeing, e) =>
      value === 'event'
        ? {
            value: 'strongest_beat',
            seen: `The music's biggest lift lands on a cut, flash or zoom in ${agreeing.length} of ${e.measured} video${e.measured === 1 ? '' : 's'}.`,
            action: 'Land the finished look on the strongest beat of your track',
            alsoChanges: [],
            current: style.reveal,
            fromVideos: styleFromVideos('reveal'),
          }
        : null,
    'Big moment: not measured yet (it needs music with a clear lift).',
  );

  // --- zoom
  settle(
    'zoom',
    profiles.map((p) => {
      if (!p.style) return { assetId: p.assetId, value: null, reason: older(p) };
      const z = zoomUseForVideo(p.style);
      return { assetId: p.assetId, value: z.value, reason: z.reason };
    }),
    (v) => v.mode,
    (value, agreeing) => {
      const ids = new Set(agreeing.map((a) => a.assetId));
      const vals = agreeing.map((a) => a.value!);
      let z: ZoomUse = value;
      if (value.mode === 'punch_in') {
        const ps = vals.filter((v): v is Extract<ZoomUse, { mode: 'punch_in' }> => v.mode === 'punch_in');
        z = { mode: 'punch_in', scale: r2(clamp(median(ps.map((p) => p.scale)), 1.08, 1.25)), shareOfCuts: round05(clamp(median(ps.map((p) => p.shareOfCuts)), 0.1, 0.5)) };
      } else if (value.mode === 'push_in') {
        const ps = vals.filter((v): v is Extract<ZoomUse, { mode: 'push_in' }> => v.mode === 'push_in');
        z = { mode: 'push_in', scale: r2(clamp(median(ps.map((p) => p.scale)), 1.03, 1.12)) };
      }
      const checked = v2.filter((p) => ids.has(p.assetId)).reduce((s, p) => s + p.style!.zoom.shotsChecked, 0);
      const words = zoomWords(z, checked);
      return { value: z, seen: words.seen, action: words.action, alsoChanges: [], current: style.zoom, fromVideos: styleFromVideos('zoom') };
    },
    'Zooms: not measured yet.',
  );

  // --- music fit
  {
    const votes: Array<Vote<number>> = profiles.map((p) => {
      const m = p.style?.music;
      if (!m) return { assetId: p.assetId, value: null, reason: older(p) };
      if (m.status !== 'measured' || m.bpm === null) {
        const b = p.style!.beat;
        return { assetId: p.assetId, value: null, reason: b.status === 'not_measured' && b.reason !== 'too_few_cuts' ? b.reason : 'no_clear_beat' };
      }
      return { assetId: p.assetId, value: m.bpm, reason: null };
    });
    const measured = votes.filter((v): v is Vote<number> & { value: number } => v.value !== null);
    const centre = median(measured.map((m) => m.value));
    const folded = measured.map((m) => ({ ...m, value: foldTempo(m.value, centre) }));
    const centre2 = median(folded.map((f) => f.value));
    const agree = folded.filter((f) => Math.abs(f.value / centre2 - 1) <= 0.06);
    const e = evidenceFrom(votes, agree.length);
    if (!measured.length) candidates.set('musicFit', { evidence: e, seen: 'Music: not measured yet (it needs videos with a clear beat).', differs: false });
    else if (!reportable(e)) candidates.set('musicFit', { evidence: e, seen: e.measured >= 2 ? 'Your videos differ here.' : `Seen in only 1 of ${e.total} videos — another video or two will help.`, differs: e.measured >= 2 });
    else {
      const ids = new Set(agree.map((a) => a.assetId));
      const music = v2.filter((p) => ids.has(p.assetId)).map((p) => p.style!.music);
      const tempos = agree.map((a) => a.value);
      const low = Math.round(clamp(Math.min(...tempos) * 0.97, 40, 220));
      const high = Math.round(clamp(Math.max(...tempos) * 1.03, 40, 220));
      const withDrop = music.filter((m) => m.hasClearDrop).length;
      const ranges = music.map((m) => m.dynamicRangeDb).filter((d): d is number => d !== null);
      const fit: MusicFit = { bpmLow: low, bpmHigh: high, prefersClearDrop: music.length > 0 && withDrop / music.length >= T.agreeShare, dynamicRangeDb: ranges.length ? r1(median(ranges)) : null };
      const seenLow = Math.round(Math.min(...tempos));
      const seenHigh = Math.round(Math.max(...tempos));
      candidates.set('musicFit', {
        value: fit,
        seen: `Music around ${seenLow === seenHigh ? seenLow : `${seenLow}–${seenHigh}`} BPM${fit.prefersClearDrop ? ' that builds to a clear drop' : ''}. Only your own licensed tracks are suggested. The sound from your videos is never used or kept.`,
        action: `Suggest tracks from your library around ${low}–${high} BPM${fit.prefersClearDrop ? ' with a clear drop' : ''}`,
        alsoChanges: [],
        current: style.musicFit,
        fromVideos: styleFromVideos('musicFit'),
        evidence: e,
      });
    }
  }

  /**
   * True while an editing-style value a row set when it was accepted from the videos is in use (its source is the videos
   * and it is not the default): "Cutting to the beat" also counts the beats per cut accepted with it.
   */
  const rowFromVideos = (field: EditingStyleRowField) => SUMMARY_ROW_STYLE_FIELDS[field].some((f) => styleFromVideos(f) && stableJson(style[f]) !== stableJson(DEFAULT_EDITING_STYLE[f]));

  const suggestions: SummarySuggestion[] = ROW_ORDER.map((field) => {
    const c = candidates.get(field)!;
    const label = SUMMARY_ROW_LABELS[field];
    if (!('value' in c)) {
      const evidenceLine = c.evidence.measured > 0 || c.evidence.notMeasured.length ? ` ${seenIn(c.evidence)}` : '';
      // An editing-style value accepted from the videos stays in use until the owner changes it, even when no current
      // video backs it (all removed, or measured with an older version of the measuring): the row says so.
      const stillInUse = isEditingStyleRow(field) && rowFromVideos(field);
      return {
        field,
        label,
        value: null,
        valueKey: null,
        seen: `${c.seen}${c.differs ? evidenceLine : ''}${stillInUse ? ` ${STILL_IN_USE_LINE}` : ''}`,
        action: null,
        evidence: c.evidence,
        alsoChanges: [],
        state: c.differs ? 'differs' : 'not_measured',
        inUse: stillInUse,
      };
    }
    const valueKey = stableJson({ value: c.value, alsoChanges: c.alsoChanges });
    const decision = style.summaryDecisions[field];
    const matches = stableJson(c.value) === stableJson(c.current) && c.alsoChanges.every((a) => (a.field === 'transitions' ? effective.transitions === a.value : stableJson(style[a.field as EditingStyleField]) === stableJson(a.value)));
    let state: SummaryRowState;
    if (decision && decision.valueKey === valueKey && decision.decision === 'dismissed') state = 'dismissed';
    else if (matches) state = decision && decision.valueKey === valueKey && decision.decision === 'accepted' ? 'accepted' : 'matches';
    else state = 'open';
    // A value accepted from the videos stays in use until the owner chooses, also when the videos now suggest another
    // one (measured again, or other videos added): the row offers the new suggestion and still says the earlier one is
    // in use (with Change on an editing-style row), so the card never hides what is applied.
    const inUse = isEditingStyleRow(field) ? rowFromVideos(field) : c.fromVideos;
    return {
      field,
      label,
      value: c.value,
      valueKey,
      seen: `${c.seen} ${seenIn(c.evidence)}${inUse && !matches ? ` ${STILL_IN_USE_LINE}` : ''}`,
      action: state === 'open' || state === 'dismissed' ? c.action : null,
      evidence: c.evidence,
      alsoChanges: c.alsoChanges,
      state,
      inUse,
    };
  });

  const times = profiles.map((p) => p.measuredAt).sort();
  return {
    total: profiles.length,
    measured: v2.length,
    olderMeasurement: profiles.length - v2.length,
    olderVersion: latest.length - profiles.length,
    updatedAt: times[times.length - 1] ?? null,
    referenceAssetIds: profiles.map((p) => p.assetId),
    suggestions,
  };
}

// ---------------------------------------------------------------- accepting

export interface SummaryDecisionInput {
  accept: readonly ReferenceSummaryField[];
  dismiss: readonly ReferenceSummaryField[];
  /** The valueKey the owner saw for each field; a mismatch means the summary changed meanwhile. */
  valueKeys: Readonly<Partial<Record<ReferenceSummaryField, string>>>;
}

export interface SummaryDecisionResult {
  preferences: EditingPreferences;
  /** Fields whose valueKey no longer matches (the caller answers 409). */
  conflicts: ReferenceSummaryField[];
  /** Fields that cannot be decided (no suggestion). */
  invalid: ReferenceSummaryField[];
}

const V1_FIELDS: readonly string[] = ['defaultDurationSec', 'pacing', 'colour', 'textDensity'];

/**
 * Applies the owner's decisions on summary rows (design §4.3.1.5 "Accepting"): v1 fields set the declared value and
 * pin it `by: 'reference'`; `editingStyle` fields set the value with `sources[field] = { by: 'reference' }`;
 * `alsoChanges` are applied with the row; every decision is recorded with its valueKey. Nothing changes when a
 * valueKey does not match. Pure.
 */
export function applySummaryDecisions(prefs: EditingPreferences, summary: ReferenceStyleSummary, input: SummaryDecisionInput, at: string): SummaryDecisionResult {
  const rows = new Map(summary.suggestions.map((s) => [s.field, s]));
  const conflicts: ReferenceSummaryField[] = [];
  const invalid: ReferenceSummaryField[] = [];
  for (const f of [...input.accept, ...input.dismiss]) {
    const row = rows.get(f);
    if (!row || row.value === null || row.valueKey === null) invalid.push(f);
    else if (input.valueKeys[f] !== row.valueKey) conflicts.push(f);
  }
  if (conflicts.length || invalid.length) return { preferences: prefs, conflicts, invalid };

  const ids = summary.referenceAssetIds.slice(0, 12);
  const referenceName = `Your videos (${summary.total})`;
  const pin: Pin = { by: 'reference', at, referenceAssetId: null, referenceName, referenceAssetIds: ids };
  const source = { by: 'reference' as const, at, referenceAssetIds: ids, referenceName };
  const declared: Record<string, unknown> = {};
  const pinned = { ...prefs.learning.pinned };
  const style: EditingStyle = { ...(prefs.editingStyle ?? DEFAULT_EDITING_STYLE) };
  const sources = { ...style.sources };
  const decisions = { ...style.summaryDecisions };
  const setStyle = (field: EditingStyleField, value: unknown) => {
    (style as Record<string, unknown>)[field] = value;
    sources[field] = source;
  };
  for (const f of input.accept) {
    const row = rows.get(f)!;
    if (V1_FIELDS.includes(f)) {
      declared[f] = row.value;
      pinned[f as ReferenceSuggestionField] = pin;
    } else setStyle(f as EditingStyleField, row.value);
    for (const extra of row.alsoChanges) {
      if (extra.field === 'transitions') {
        declared['transitions'] = extra.value;
        pinned.transitions = pin;
      } else setStyle(extra.field, extra.value);
    }
    if (f === 'beatSync' && !row.alsoChanges.some((a) => a.field === 'beatsPerCut')) setStyle('beatsPerCut', null);
    decisions[f] = { decision: 'accepted', valueKey: row.valueKey!, at };
  }
  for (const f of input.dismiss) decisions[f] = { decision: 'dismissed', valueKey: rows.get(f)!.valueKey!, at };
  return {
    preferences: { ...prefs, ...declared, learning: { ...prefs.learning, pinned }, editingStyle: { ...style, sources, summaryDecisions: decisions } } as EditingPreferences,
    conflicts: [],
    invalid: [],
  };
}

/**
 * "Go back to each style's own": transitions, beat, reveal, zoom and music matching return to their defaults (and
 * their summary decisions are forgotten so the rows can be accepted again). Length, pace, colour and text stay, and so
 * does `preferences.transitions` ('varied', pinned by the reference) when accepting a bolder palette turned it on: it
 * is an ordinary preference the owner changes in Settings, and the reset copy says it stays.
 *
 * With `row`, only that row ("Change: use each style's own" on it): every editing-style value accepting it set
 * ({@link SUMMARY_ROW_STYLE_FIELDS}: "Cutting to the beat" also resets the beats per cut) returns to its default, with its
 * source and the row's decision forgotten. Pure.
 */
export function resetEditingStyle(prefs: EditingPreferences, row?: EditingStyleRowField): EditingPreferences {
  const style = prefs.editingStyle ?? DEFAULT_EDITING_STYLE;
  const decisions = { ...style.summaryDecisions };
  const sources = { ...style.sources };
  const values: Partial<Record<EditingStyleField, unknown>> = {};
  for (const f of row ? SUMMARY_ROW_STYLE_FIELDS[row] : EDITING_STYLE_FIELDS) {
    values[f] = DEFAULT_EDITING_STYLE[f];
    delete sources[f];
    delete decisions[f];
  }
  return { ...prefs, editingStyle: { ...style, ...values, sources, summaryDecisions: decisions } as EditingStyle };
}

// ---------------------------------------------------------------- wording for one video

/** The per-video v2 line, e.g. "28 s · 24 shots (median 0.9 s) · mostly straight cuts with 6 white flashes · …". */
export function describeStyleSignals(style: ReferenceStyleSignals, colourLook?: ColourLook): string {
  const parts = [`${Math.round(style.measuredSec)} s`, `${plural(style.shots.count, 'shot')} (median ${style.shots.medianSec.toFixed(1)} s)`];
  const t = style.transitions;
  const c = (k: BoundaryKind) => t.counts[k] ?? 0;
  const flashes = c('fade_white') + c('fade_black');
  const flashWord = flashes ? ` with ${plural(flashes, c('fade_black') > c('fade_white') ? 'dip to black' : 'white flash', c('fade_black') > c('fade_white') ? 'dips to black' : 'white flashes')}` : '';
  const fam = t.family;
  if (!t.reportable || !fam) parts.push('transitions: too few joins to tell');
  else if (fam === 'straight_only' || fam === 'straight_flash') parts.push(`mostly straight cuts${flashWord}`);
  else if (fam === 'cross_fades') parts.push(`soft cross-fades${t.crossFadeMedianSec ? ` of about ${t.crossFadeMedianSec.toFixed(1)} s` : ''}${flashWord}`);
  else if (fam === 'movement') parts.push(`slides and wipes between shots${flashWord}`);
  else parts.push(`a mix of cuts and transitions${flashWord}`);
  const b = style.beat;
  if (b.status === 'measured') parts.push(b.reportable ? `cuts on the beat (${b.within80ms} of ${b.cuts}, about ${Math.round(b.bpm)} BPM)` : `cuts not clearly on the beat (about ${Math.round(b.bpm)} BPM)`);
  else parts.push({ no_audio: 'beat: no sound', no_clear_beat: 'beat: no clear beat', mostly_speech: 'beat: mostly talking', too_few_cuts: 'beat: too few cuts to tell' }[b.reason]);
  const z = style.zoom;
  if (z.punchIns) parts.push(`punch-in zooms at ${plural(z.punchIns, 'cut')}`);
  if (z.pushIns) parts.push(`push-ins in ${plural(z.pushIns, 'shot')}`);
  if (!z.punchIns && !z.pushIns && z.shotsChecked >= T.minZoomShots) parts.push('no zooms seen');
  if (colourLook) parts.push(`${colourLook} colour`);
  return `${parts.join(' · ')} (estimates)`;
}

/** "Skipped a dark end screen in the last 3 s." or null. */
export function describeEndScreen(style: ReferenceStyleSignals): string | null {
  return style.endScreenTrimmedSec >= 1 ? `Skipped a dark end screen in the last ${Math.round(style.endScreenTrimmedSec)} s.` : null;
}

/** Shown on a reference measured before v2. */
export const OLDER_MEASUREMENT_NOTE = 'Measured before transitions and beat were added. Upload it again to include it.';

/**
 * Shown on a reference measured by an older version of the measuring (see {@link isOlderMeasuringVersion}). Uploading
 * the video again adds a new copy and keeps this one, so the note says to remove it: it stays true until then.
 */
export const OLDER_VERSION_NOTE = 'Measured with an older version of the measuring, so it is not used. Upload the video again, then remove this copy.';

/**
 * The summary's line for videos measured by an older version of the measuring, e.g. "2 videos were measured …". Like
 * {@link OLDER_VERSION_NOTE}, it stays true after the videos are uploaded again, until the old copies are removed.
 */
export function olderVersionNotice(count: number): string {
  return count === 1
    ? '1 video was measured with an older version of the measuring and is not used. Upload it again, then remove the old copy from its project.'
    : `${count} videos were measured with an older version of the measuring and are not used. Upload them again, then remove the old copies from their projects.`;
}

/** Words the reference-style wording never uses. */
export const FORBIDDEN_STYLE_WORDS = /\b(exact|exactly|precise|precisely|detected|trending|viral|your tiktok)\b/i;
