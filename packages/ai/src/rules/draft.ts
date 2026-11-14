import type { SegmentLabel, TransitionType } from '@studio/core';
import { lengthOf, type Candidate } from './footage.js';
import { clamp } from './random.js';

/** Shortest segment the rules planner produces (the validator's floor is lower). */
export const MIN_PLAY_SEC = 0.4;
/** Slack added on top of the validator's transition gap so rounding never trips it. */
const TRANSITION_GAP_SEC = 0.17;
/** Gap the planner tries to leave between two windows cut from the same shot. */
const WINDOW_MARGIN_SEC = 0.25;
/** The plan schema allows 40 segments; stay a little under. */
export const MAX_SEGMENTS = 38;

/** A segment being built: a window inside a candidate shot plus everything the plan needs about it. */
export interface Draft {
  id: string;
  cand: Candidate;
  inSec: number;
  outSec: number;
  speed: number;
  zoom: { from: number; to: number } | null;
  transitionIn: { type: TransitionType; durationSec: number } | null;
  role: SegmentLabel;
  keepOriginalSound: boolean;
  /** Preferred play-length range for the style (the fitter may go past it when it has to). */
  softMin: number;
  softMax: number;
  /** Structural segments (opening, the reveal) are never removed by the fitter. */
  pinned: boolean;
  /** Higher is more important; the fitter drops the lowest first. */
  weight: number;
  /** Which part of the window matters most when trimming or extending. */
  keep: 'start' | 'end' | 'centre';
  /** Structural position in the style ('open', 'body', 'final', 'before', 'bridge', 'reveal', 'hold2'). */
  slot: string;
  /** True when the style decides this draft's incoming transition (false keeps a revised plan's choice). */
  autoTransition: boolean;
}

/** Output (play) duration of a draft. */
export function play(d: Pick<Draft, 'inSec' | 'outSec' | 'speed'>): number {
  return (d.outSec - d.inSec) / d.speed;
}

/** Total output length: play durations minus the overlap of every transition. */
export function totalDuration(drafts: readonly Draft[]): number {
  let total = 0;
  drafts.forEach((d, i) => {
    total += play(d);
    if (i > 0 && d.transitionIn) total -= d.transitionIn.durationSec;
  });
  return total;
}

/** Output start time of every draft (mirrors computeTimeline in @studio/core). */
export function startTimes(drafts: readonly Draft[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  drafts.forEach((d, i) => {
    const t = i === 0 ? 0 : (d.transitionIn?.durationSec ?? 0);
    const start = Math.max(0, cursor - t);
    starts.push(start);
    cursor = start + play(d);
  });
  return starts;
}

/** Shortest play length a draft may have given the transitions on either side of it. */
export function hardMinPlay(drafts: readonly Draft[], index: number): number {
  const d = drafts[index];
  if (!d) return MIN_PLAY_SEC;
  const tIn = index > 0 ? (d.transitionIn?.durationSec ?? 0) : 0;
  const tOut = drafts[index + 1]?.transitionIn?.durationSec ?? 0;
  const needed = tIn + tOut > 0 ? tIn + tOut + TRANSITION_GAP_SEC : 0;
  return Math.max(MIN_PLAY_SEC, needed);
}

/** Source ranges of the same clip already used by other drafts, sorted. */
function occupied(assetId: string, drafts: readonly Draft[], exclude?: Draft): Array<[number, number]> {
  return drafts
    .filter((d) => d !== exclude && d.cand.assetId === assetId)
    .map((d): [number, number] => [d.inSec, d.outSec])
    .sort((a, b) => a[0] - b[0]);
}

/** Free sub-ranges of a candidate shot, optionally keeping a margin from windows already taken. */
export function freeIntervals(cand: Candidate, drafts: readonly Draft[], exclude?: Draft, margin = 0): Array<[number, number]> {
  let pieces: Array<[number, number]> = [[cand.startSec, cand.endSec]];
  for (const [a, b] of occupied(cand.assetId, drafts, exclude)) {
    const lo = a - margin;
    const hi = b + margin;
    const next: Array<[number, number]> = [];
    for (const [s, e] of pieces) {
      if (hi <= s || lo >= e) {
        next.push([s, e]);
        continue;
      }
      if (lo > s) next.push([s, lo]);
      if (hi < e) next.push([hi, e]);
    }
    pieces = next;
  }
  return pieces.filter(([s, e]) => e - s > 0.01);
}

/** Longest free stretch (source seconds) left in a candidate; with `spaced` it keeps clear of other windows. */
export function largestFree(cand: Candidate, drafts: readonly Draft[], exclude?: Draft, spaced = false): number {
  return freeIntervals(cand, drafts, exclude, spaced ? WINDOW_MARGIN_SEC : 0).reduce((m, [s, e]) => Math.max(m, e - s), 0);
}

/**
 * Places a window of `sourceLen` seconds inside a free part of the candidate. `anchor` (0–1) says where in the
 * shot the window should sit (0 = as early as possible). Tries to keep a margin from other windows first.
 * With `allowReuse` the window may overlap footage already used (only when nothing else fits).
 */
export function placeWindow(
  cand: Candidate,
  drafts: readonly Draft[],
  sourceLen: number,
  anchor: number,
  opts: { allowReuse?: boolean; exclude?: Draft } = {},
): { inSec: number; outSec: number } | null {
  if (sourceLen > lengthOf(cand) + 1e-6) return null;
  const len = sourceLen;
  if (len <= 0.05) return null;
  const desiredStart = cand.startSec + clamp(anchor, 0, 1) * (lengthOf(cand) - len);
  const attempts: Array<Array<[number, number]>> = [
    freeIntervals(cand, drafts, opts.exclude, WINDOW_MARGIN_SEC),
    freeIntervals(cand, drafts, opts.exclude, 0),
  ];
  if (opts.allowReuse) attempts.push([[cand.startSec, cand.endSec]]);
  for (const pieces of attempts) {
    let best: { inSec: number; dist: number } | null = null;
    for (const [s, e] of pieces) {
      if (e - s + 1e-6 < len) continue;
      const start = clamp(desiredStart, s, e - len);
      const dist = Math.abs(start - desiredStart);
      if (!best || dist < best.dist) best = { inSec: start, dist };
    }
    if (best) return { inSec: best.inSec, outSec: best.inSec + len };
  }
  return null;
}

/** How far (source seconds) a draft's window can extend forwards and backwards without overlapping others. */
function extension(d: Draft, drafts: readonly Draft[]): { forward: number; backward: number } {
  let forward = d.cand.endSec - d.outSec;
  let backward = d.inSec - d.cand.startSec;
  for (const [a, b] of occupied(d.cand.assetId, drafts, d)) {
    if (a >= d.outSec - 1e-6) forward = Math.min(forward, a - d.outSec);
    if (b <= d.inSec + 1e-6) backward = Math.min(backward, d.inSec - b);
    if (a < d.outSec && b > d.inSec) {
      // Overlapping footage (only after a forced reuse): never extend into it.
      if (a >= d.inSec) forward = 0;
      if (b <= d.outSec) backward = 0;
    }
  }
  return { forward: Math.max(0, forward), backward: Math.max(0, backward) };
}

/** Extends a draft by up to `deltaOut` output seconds; returns how much it actually grew. */
export function grow(d: Draft, drafts: readonly Draft[], deltaOut: number): number {
  if (deltaOut <= 1e-4) return 0;
  const { forward, backward } = extension(d, drafts);
  let needSrc = deltaOut * d.speed;
  const takeForwardFirst = d.keep !== 'start';
  const order: Array<'f' | 'b'> = takeForwardFirst ? ['f', 'b'] : ['b', 'f'];
  let grown = 0;
  for (const dir of order) {
    if (needSrc <= 1e-6) break;
    const avail = dir === 'f' ? forward : backward;
    const take = Math.min(avail, needSrc);
    if (take <= 0) continue;
    if (dir === 'f') d.outSec += take;
    else d.inSec -= take;
    needSrc -= take;
    grown += take;
  }
  return grown / d.speed;
}

/** Shortens a draft by up to `deltaOut` output seconds without going under `floor`; returns the reduction. */
export function shrink(d: Draft, deltaOut: number, floor: number): number {
  const room = play(d) - floor;
  if (room <= 1e-4 || deltaOut <= 1e-4) return 0;
  const cut = Math.min(room, deltaOut);
  const src = cut * d.speed;
  if (d.keep === 'start') d.outSec -= src;
  else if (d.keep === 'end') d.inSec += src;
  else {
    d.inSec += src / 2;
    d.outSec -= src / 2;
  }
  return cut;
}

/** Room a draft has to grow at the given level ('soft' respects the style range, 'hard' allows 1.6×). */
function growRoom(d: Draft, drafts: readonly Draft[], level: 'soft' | 'hard'): number {
  const max = level === 'soft' ? d.softMax : Math.max(d.softMax * 1.6, d.softMax + 1);
  const { forward, backward } = extension(d, drafts);
  return Math.max(0, Math.min(max - play(d), (forward + backward) / d.speed));
}

function shrinkFloor(drafts: readonly Draft[], i: number, level: 'soft' | 'hard'): number {
  const d = drafts[i]!;
  const hard = hardMinPlay(drafts, i);
  return level === 'soft' ? Math.max(hard, d.softMin) : hard;
}

/** Grows drafts in proportion to their room; returns the output seconds gained. */
export function growAll(drafts: Draft[], needed: number, level: 'soft' | 'hard'): number {
  let remaining = needed;
  for (let pass = 0; pass < 8 && remaining > 1e-3; pass++) {
    const rooms = drafts.map((d) => growRoom(d, drafts, level));
    const totalRoom = rooms.reduce((a, b) => a + b, 0);
    if (totalRoom < 1e-3) break;
    const share = Math.min(1, remaining / totalRoom);
    drafts.forEach((d, i) => {
      if (remaining <= 1e-4) return;
      remaining -= grow(d, drafts, Math.min(remaining, (rooms[i] ?? 0) * share));
    });
  }
  return needed - remaining;
}

/** Shrinks drafts in proportion to their spare length; returns the output seconds removed. */
export function shrinkAll(drafts: Draft[], needed: number, level: 'soft' | 'hard'): number {
  let remaining = needed;
  for (let pass = 0; pass < 8 && remaining > 1e-3; pass++) {
    const rooms = drafts.map((d, i) => Math.max(0, play(d) - shrinkFloor(drafts, i, level)));
    const totalRoom = rooms.reduce((a, b) => a + b, 0);
    if (totalRoom < 1e-3) break;
    const share = Math.min(1, remaining / totalRoom);
    drafts.forEach((d, i) => {
      if (remaining <= 1e-4) return;
      remaining -= shrink(d, Math.min(remaining, (rooms[i] ?? 0) * share), shrinkFloor(drafts, i, level));
    });
  }
  return needed - remaining;
}

export interface FitOptions {
  target: number;
  /** Accepted distance from the target in seconds. */
  tolerance: number;
  /** Fewest segments the style may end with. */
  minSegments: number;
  /** Inserts one more draft (fresh footage, or reused footage when `allowReuse`); false when nothing fits. */
  addFiller: (drafts: Draft[], allowReuse: boolean) => boolean;
  /** Re-applies the style's transitions after the structure changed. */
  retransition: (drafts: Draft[]) => void;
  /** Whether gentle slow motion (down to 0.6×) may stretch the footage when it is too short. */
  allowSlowdown: boolean;
  notes: string[];
}

/**
 * Brings the total length within `tolerance` of the target: grow inside the style's range, add shots, grow past
 * the range, slow down (if allowed) and as a last resort reuse footage; or shrink, drop the least important
 * shots and shrink past the range. Every change keeps windows inside their shot and transitions legal.
 */
export function fitDuration(drafts: Draft[], o: FitOptions): void {
  let slowed = false;
  let reused = false;
  for (let iter = 0; iter < 80; iter++) {
    const diff = o.target - totalDuration(drafts);
    if (Math.abs(diff) <= o.tolerance) break;
    if (diff > 0) {
      if (growAll(drafts, diff, 'soft') >= diff - o.tolerance) continue;
      if (drafts.length < MAX_SEGMENTS && o.addFiller(drafts, false)) {
        o.retransition(drafts);
        continue;
      }
      const left = o.target - totalDuration(drafts);
      if (growAll(drafts, left, 'hard') > 1e-3) continue;
      if (o.allowSlowdown && slowDown(drafts)) {
        slowed = true;
        continue;
      }
      if (drafts.length < MAX_SEGMENTS && o.addFiller(drafts, true)) {
        o.retransition(drafts);
        reused = true;
        continue;
      }
      break;
    } else {
      const excess = -diff;
      if (shrinkAll(drafts, excess, 'soft') >= excess - o.tolerance) continue;
      if (drafts.length > o.minSegments && removeLeastImportant(drafts)) {
        o.retransition(drafts);
        continue;
      }
      const left = totalDuration(drafts) - o.target;
      if (shrinkAll(drafts, left, 'hard') > 1e-3) continue;
      if (drafts.length > 1 && removeLeastImportant(drafts)) {
        o.retransition(drafts);
        continue;
      }
      break;
    }
  }
  if (slowed) o.notes.push('Some shots play in gentle slow motion because the footage is shorter than the requested length.');
  if (reused) o.notes.push('A few moments appear twice because there was not enough different footage for this length.');
}

/** Slows the longest normal-speed draft a little; false when nothing can slow further. */
function slowDown(drafts: Draft[]): boolean {
  const options = drafts.filter((d) => d.speed > 0.61).sort((a, b) => play(b) - play(a));
  const d = options[0];
  if (!d) return false;
  d.speed = Math.max(0.6, Math.round(d.speed * 0.85 * 100) / 100);
  return true;
}

/** Removes the non-pinned draft with the lowest weight (shortest first among equals). */
export function removeLeastImportant(drafts: Draft[]): boolean {
  let idx = -1;
  drafts.forEach((d, i) => {
    if (d.pinned) return;
    const cur = drafts[idx];
    if (idx < 0 || !cur || d.weight < cur.weight || (d.weight === cur.weight && play(d) < play(cur))) idx = i;
  });
  if (idx < 0) return false;
  drafts.splice(idx, 1);
  if (drafts[0]) drafts[0].transitionIn = null;
  return true;
}
