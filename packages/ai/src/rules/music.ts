import { MIN_GRID_BEATS, findDrop, usableBeats } from '@studio/core';
import type { PlannerMusic } from '../types.js';
import { grow, hardMinPlay, shrink, startTimes, type Draft } from './draft.js';
import { round } from './random.js';

/** Beat positions on the OUTPUT timeline, plus where in the track playback starts. */
export interface BeatGrid {
  /** Seconds into the track where the edit starts (always on a beat when beats are known). */
  startOffsetSec: number;
  /** Output-time beat positions starting at 0, extended past the edit by the median interval. */
  beats: number[];
  /** Median beat interval in seconds. */
  interval: number;
  /** Tempo reported by the analysis, or derived from the beat interval; null for the 120 BPM stand-in grid. */
  bpm: number | null;
  /** True when the grid comes from real music beats (false = the 120 BPM stand-in without music). */
  fromMusic: boolean;
}

const FALLBACK_INTERVAL = 0.5; // 120 BPM

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Seconds of music an edit leaves unplayed at the end of the track, at least: a start beat "fits" an edit when the edit
 * ends this long before the track does, and the rules planner shortens an edit that would end later (see planner.ts).
 */
export const MUSIC_END_GAP_SEC = 0.1;

/** Sorted, de-duplicated beat times inside the track (the same beats the shared length rule starts from). */
function cleanBeats(music: PlannerMusic): number[] {
  return usableBeats(music.beatTimesSec, music.durationSec);
}

/**
 * The owner's chosen music start snapped to the first beat at or after it (the last beat when the choice is
 * past every beat). Without usable beats the choice is kept as given, clamped to the track.
 */
export function snapMusicStart(music: PlannerMusic, startSec: number): number {
  const beats = cleanBeats(music);
  const wanted = Math.max(0, Math.min(startSec, music.durationSec));
  if (beats.length === 0) return round(wanted, 3);
  const after = beats.find((t) => t >= wanted - 0.001);
  return round(after ?? beats[beats.length - 1]!, 3);
}

/**
 * Builds the beat grid for an edit of `lengthSec`. With music, playback starts on a beat chosen per take
 * (bar-sized steps) so that the whole edit fits inside the track; without music a 120 BPM grid is used.
 * `fixedStartSec` (the owner's choice) overrides both the per-take choice and `preferStartSec`: playback starts
 * on the first beat at or after it, or on the latest beat that still fits when that one would run past the
 * end of the track. The track's first beat always fits a length from the shared rule (`plannedLength`, which
 * measures the music from that beat); for a longer length no beat may fit, and playback then starts on the first
 * beat all the same (the rules planner shortens such an edit to the music left after it, never moving the music).
 */
export function beatGrid(music: PlannerMusic | null, lengthSec: number, attempt: number, preferStartSec?: number, fixedStartSec?: number | null): BeatGrid {
  const horizon = lengthSec + 8;
  if (!music) return { startOffsetSec: 0, beats: synthetic(0, FALLBACK_INTERVAL, horizon), interval: FALLBACK_INTERVAL, bpm: null, fromMusic: false };

  const beats = cleanBeats(music);
  const intervals = beats.slice(1).map((t, i) => t - beats[i]!);
  let interval = median(intervals);
  if (!(interval > 0.15 && interval < 2.5)) interval = music.bpm && music.bpm > 30 ? 60 / music.bpm : FALLBACK_INTERVAL;
  const bpm = music.bpm ?? (interval > 0 ? round(60 / interval, 1) : null);

  const fixed = typeof fixedStartSec === 'number' && Number.isFinite(fixedStartSec) ? Math.max(0, fixedStartSec) : null;
  if (beats.length < MIN_GRID_BEATS) {
    const maxStart = Math.max(0, music.durationSec - lengthSec - MUSIC_END_GAP_SEC);
    const start = Math.min(maxStart, fixed ?? attempt * 4 * interval);
    return { startOffsetSec: round(Math.max(0, start), 3), beats: synthetic(0, interval, horizon), interval, bpm, fromMusic: true };
  }

  const fits = beats.map((t, i) => ({ t, i })).filter(({ t }) => t + lengthSec <= music.durationSec - MUSIC_END_GAP_SEC);
  const barStarts = fits.filter(({ i }) => i % 4 === 0);
  const pool = barStarts.length > 0 ? barStarts : fits;
  let chosen = pool.length > 0 ? pool[Math.min(pool.length - 1, attempt % Math.max(1, Math.min(pool.length, 4)))]! : { t: beats[0]!, i: 0 };
  if (fixed !== null && fits.length > 0) {
    // The owner picked the start: the first beat at or after it, unless the edit would then outrun the track.
    const snapped = snapMusicStart(music, fixed);
    chosen = fits.find((f) => f.t >= snapped - 0.001) ?? fits[fits.length - 1]!;
  } else if (preferStartSec !== undefined && fits.length > 0) {
    // A revision keeps the music where it was, snapped to the nearest beat that still fits.
    chosen = fits.reduce((best, f) => (Math.abs(f.t - preferStartSec) < Math.abs(best.t - preferStartSec) ? f : best), fits[0]!);
  }
  const startOffsetSec = chosen.t;
  const out: number[] = [];
  for (let k = chosen.i; k < beats.length; k++) out.push(round(beats[k]! - startOffsetSec, 3));
  let last = out[out.length - 1] ?? 0;
  while (last < horizon) {
    last = round(last + interval, 3);
    out.push(last);
  }
  return { startOffsetSec: round(startOffsetSec, 3), beats: out, interval, bpm, fromMusic: true };
}

function synthetic(start: number, interval: number, horizon: number): number[] {
  const out: number[] = [];
  for (let t = start; t <= horizon + 1e-9; t += interval) out.push(round(t, 3));
  return out;
}

/** Index of the grid beat closest to `t`. */
export function nearestBeatIndex(grid: BeatGrid, t: number): number {
  let best = 0;
  grid.beats.forEach((b, i) => {
    if (Math.abs(b - t) < Math.abs((grid.beats[best] ?? 0) - t)) best = i;
  });
  return best;
}

/** A cut this close to a beat is on it (the plan's beat-alignment info). */
const ON_BEAT_SEC = 0.04;

/** The cut times (output time) within {@link ON_BEAT_SEC} of one of `beats` (output time), rounded to the millisecond. */
function onBeats(beats: readonly number[], cutTimes: readonly number[]): number[] {
  return cutTimes.filter((c) => beats.some((b) => Math.abs(b - c) <= ON_BEAT_SEC + 1e-9)).map((c) => round(c, 3));
}

/**
 * Output cut times that land within 40 ms of a beat of the grid the rules planner cut to (reported in the plan's
 * beat-alignment info). Pass the times of the plan as it plays (`feltJoinTimes`): the grid starts where the music does.
 */
export function alignedCuts(grid: BeatGrid, cutTimes: readonly number[]): number[] {
  return onBeats(grid.beats, cutTimes);
}

/**
 * Output cut times that land within 40 ms of a beat of `music` when it starts at `startOffsetSec` (output time t plays
 * music time startOffsetSec + t; beats rounded as in the rules planner's grid, so both planners report the same cuts for
 * the same plan). For a plan the rules planner did not build (the AI plan): its beat-alignment info is worked out from
 * where its music actually starts, never taken from the plan itself.
 */
export function cutsOnTheBeat(music: PlannerMusic, startOffsetSec: number, cutTimes: readonly number[]): number[] {
  return onBeats(
    cleanBeats(music).map((b) => round(b - startOffsetSec, 3)),
    cutTimes,
  );
}

/**
 * The grid beat to aim for near output time `t`: a downbeat (every fourth beat from where the music starts) when one
 * is within `downbeatWindowSec`, otherwise the nearest beat.
 */
export function beatTargetNear(grid: BeatGrid, t: number, downbeatWindowSec = 0.35): number {
  let nearest = grid.beats[0] ?? 0;
  let downbeat: number | null = null;
  grid.beats.forEach((b, i) => {
    if (Math.abs(b - t) < Math.abs(nearest - t)) nearest = b;
    if (i % 4 === 0 && Math.abs(b - t) <= downbeatWindowSec && (downbeat === null || Math.abs(b - t) < Math.abs(downbeat - t))) downbeat = b;
  });
  return downbeat ?? nearest;
}

/** Output time at which draft `i` is fully on screen (its start plus its incoming transition). */
export function cutTime(drafts: readonly Draft[], i: number): number {
  return (startTimes(drafts)[i] ?? 0) + (drafts[i]?.transitionIn?.durationSec ?? 0);
}

/**
 * Moves the cut into draft `i` by lengthening or shortening the draft before it, and gives the difference back
 * at the end so the total length stays the same. Returns the shift that was made (it may be less than asked
 * when the footage or the minimum shot length does not allow it).
 */
export function shiftCut(drafts: Draft[], i: number, delta: number): number {
  const prev = drafts[i - 1];
  const last = drafts[drafts.length - 1];
  if (!prev || !last || last === prev || i < 1) return 0;
  if (delta > 0) {
    const g = grow(prev, drafts, delta);
    const back = shrink(last, g, hardMinPlay(drafts, drafts.length - 1));
    if (back + 1e-3 < g) shrink(prev, g - back, hardMinPlay(drafts, i - 1));
    return Math.min(g, back);
  }
  const cut = shrink(prev, -delta, hardMinPlay(drafts, i - 1));
  const given = grow(last, drafts, cut);
  if (given + 1e-3 < cut) grow(prev, drafts, cut - given);
  return -Math.min(cut, given);
}

/**
 * "Cut to the beat: On" for styles that do not cut on every beat by themselves: each cut is nudged onto the
 * nearest music beat (at most half a beat away), left to right, keeping the total length. Cuts the footage
 * cannot reach stay where they are.
 */
export function snapCutsToBeats(drafts: Draft[], grid: BeatGrid): number {
  if (!grid.fromMusic) return 0;
  let moved = 0;
  // The last draft absorbs the changes, so the cut into it is left alone.
  for (let i = 1; i < drafts.length - 1; i++) {
    const t = cutTime(drafts, i);
    const beat = grid.beats[nearestBeatIndex(grid, t)] ?? t;
    const delta = beat - t;
    if (Math.abs(delta) < 0.02 || Math.abs(delta) > grid.interval / 2 + 1e-3) continue;
    if (Math.abs(shiftCut(drafts, i, delta)) > 0.01) moved++;
  }
  return moved;
}

/**
 * "Land the reveal on a beat": the first shot of the finished result starts on a beat (a downbeat when one is
 * close), within ±0.25 s, keeping the total length. Returns false when there is no result shot after the opening
 * or the footage cannot move the cut that far.
 */
export function landRevealOnBeat(drafts: Draft[], grid: BeatGrid): boolean {
  if (!grid.fromMusic) return false;
  const r = drafts.findIndex((d, i) => i > 0 && d.role === 'result');
  if (r < 1) return false;
  const t = cutTime(drafts, r);
  const beat = beatTargetNear(grid, t);
  if (Math.abs(beat - t) <= 0.02) return true;
  if (Math.abs(beat - t) > Math.max(0.6, grid.interval)) return false;
  shiftCut(drafts, r, beat - t);
  return Math.abs(cutTime(drafts, r) - beat) <= 0.25;
}

/** The strongest beat of a track: its biggest lift, refined to a beat (design §4.3.1.3c on the stored energy curve). */
export interface StrongestBeat {
  /** Seconds into the track. */
  atSec: number;
  riseDb: number;
  /** True for a clear drop (at least 6 dB into a loud part). */
  found: boolean;
}

/** Runs the reference drop finder on a track's stored energy curve and beat grid; null when the track has no curve. */
export function strongestBeat(music: Pick<PlannerMusic, 'energy' | 'energyStepSec' | 'beatTimesSec' | 'durationSec'>): StrongestBeat | null {
  if (!music.energy?.length || !music.energyStepSec) return null;
  const d = findDrop(music.energy, music.energyStepSec, { spanSec: music.durationSec, beatTimesSec: music.beatTimesSec });
  return d ? { atSec: d.atSec, riseDb: d.riseDb, found: d.found } : null;
}

/** Beats (seconds into the track) at which an edit of `lengthSec` can start and still fit inside the track. */
export function startBeatsThatFit(music: PlannerMusic, lengthSec: number): number[] {
  return cleanBeats(music).filter((t) => t + lengthSec <= music.durationSec - MUSIC_END_GAP_SEC);
}
