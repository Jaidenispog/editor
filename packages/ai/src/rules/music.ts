import type { PlannerMusic } from '../types.js';
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

/** Sorted, de-duplicated beat times inside the track. */
function cleanBeats(music: PlannerMusic): number[] {
  const inside = music.beatTimesSec.filter((t) => Number.isFinite(t) && t >= 0 && t < music.durationSec);
  const sorted = [...new Set(inside.map((t) => round(t, 3)))].sort((a, b) => a - b);
  return sorted.filter((t, i) => i === 0 || t - sorted[i - 1]! > 0.12);
}

/**
 * Builds the beat grid for an edit of `lengthSec`. With music, playback starts on a beat chosen per take
 * (bar-sized steps) so that the whole edit fits inside the track; without music a 120 BPM grid is used.
 */
export function beatGrid(music: PlannerMusic | null, lengthSec: number, attempt: number, preferStartSec?: number): BeatGrid {
  const horizon = lengthSec + 8;
  if (!music) return { startOffsetSec: 0, beats: synthetic(0, FALLBACK_INTERVAL, horizon), interval: FALLBACK_INTERVAL, bpm: null, fromMusic: false };

  const beats = cleanBeats(music);
  const intervals = beats.slice(1).map((t, i) => t - beats[i]!);
  let interval = median(intervals);
  if (!(interval > 0.15 && interval < 2.5)) interval = music.bpm && music.bpm > 30 ? 60 / music.bpm : FALLBACK_INTERVAL;
  const bpm = music.bpm ?? (interval > 0 ? round(60 / interval, 1) : null);

  if (beats.length < 4) {
    const maxStart = Math.max(0, music.durationSec - lengthSec - 0.1);
    const start = Math.min(maxStart, attempt * 4 * interval);
    return { startOffsetSec: round(Math.max(0, start), 3), beats: synthetic(0, interval, horizon), interval, bpm, fromMusic: true };
  }

  const fits = beats.map((t, i) => ({ t, i })).filter(({ t }) => t + lengthSec <= music.durationSec - 0.1);
  const barStarts = fits.filter(({ i }) => i % 4 === 0);
  const pool = barStarts.length > 0 ? barStarts : fits;
  let chosen = pool.length > 0 ? pool[Math.min(pool.length - 1, attempt % Math.max(1, Math.min(pool.length, 4)))]! : { t: beats[0]!, i: 0 };
  if (preferStartSec !== undefined && fits.length > 0) {
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

/** Output cut times that land within 40 ms of a beat (reported in the plan's beat-alignment info). */
export function alignedCuts(grid: BeatGrid, cutTimes: number[]): number[] {
  return cutTimes.filter((c) => grid.beats.some((b) => Math.abs(b - c) <= 0.04)).map((c) => round(c, 3));
}
