import { execa } from 'execa';
import { assembleReferenceSignals, type AssetProbe, type RawJoin, type RawReferenceStyle, type ReferenceStyleSignals } from '@studio/core';
import { runFfmpegCapture, runFfmpegToBuffer } from '../ffmpeg.js';
import { decodePcm } from './audio.js';
import { detectBeats, MUSIC_ANALYSIS_SAMPLE_RATE } from './beats.js';
import { throwIfAborted, type AnalysisToolOptions } from './common.js';

/**
 * Reference style v2 measuring (preferences design §4.3.1.2–3): on the reference's proxy, before its originals are
 * deleted, three passes measure what makes the owner's editing recognisable:
 *
 * - Pass A, one FFmpeg run at the proxy's frame rate: per-frame scene score, YAVG/YMIN/YMAX/YDIF and blur.
 * - Pass B, one FFmpeg run: tiny grey frames (72 × 128, 30 fps) for the shape tests FFmpeg filters cannot report as
 *   numbers (cross-correlation, the cross-fade fit and its spatial spread, moving bands and shifts, the zoom scale fit,
 *   how uniform a flash frame is, and the change per 1/30 s that marks gradual joins at any frame rate).
 * - Pass C, only with sound: the existing beat tracker on mono PCM (tempo, beat grid, 0.25 s energy).
 *
 * Every number is an estimate. Frames and PCM live only in memory for the duration of the call; the caller keeps
 * only the reduced signals (`assembleReferenceSignals`), never the frames, beats, cut times or the energy curve. The
 * reference's sound is never used for anything but these numbers and is never sent anywhere.
 */

/** Tunables (starting values from the synthetic prototype, design §4.3.1.3; to be tuned on the owner's real videos). */
export const REFERENCE_STYLE_MEASURE = {
  maxSpanSec: 120,
  gridFps: 30,
  /** Pass B frame size for portrait video (swapped for landscape). */
  gridWidth: 72,
  gridHeight: 128,
  cutMinScore: 0.18,
  cutMedianFactor: 8,
  /** NCC(frame t − 2, frame t + 2) at or above this rules out a cut (fast motion, a camera flash). */
  cutMaxNcc: 0.5,
  /** …unless that NCC is at least this much below the NCC within each side (different shots that look alike). */
  cutNccDrop: 0.25,
  /**
   * A shift along an axis explains a spike (a slide or camera move, not a cut) only when the shifted frames look alike:
   * NCC of their overlap at least `cutMaxNcc` and at most this much below the NCC within each side. Stricter than
   * `cutNccDrop`, because the best of many shifts can line up two different shots by chance (a detailed shot cut
   * against a smooth one halves the difference just by cropping).
   */
  cutShiftNccDrop: 0.1,
  /** A spike below this scene score followed by a burst of change is the start of a transition, not a cut. */
  cutWeakScore: 0.25,
  flashWhiteMin: 200,
  flashWhiteLift: 60,
  flashBlackMax: 30,
  /**
   * A flash or dip is a nearly uniform white or black frame: the 10th–90th percentile spread of the Pass B grey frame
   * at its extreme is at most this (a bright or dark shot keeps its picture detail and is joined by cuts instead).
   */
  flashUniformSpread: 24,
  /**
   * A screen (title, end or mid-video card) lasts more than this; a white or black run this long with no screen in it
   * is a shot, a shorter one can be a flash or dip.
   */
  screenMinSec: 0.6,
  /** Without a cut, a screen's uniform frames must start within this of the start of the bright or dark run. */
  screenEntrySec: 0.5,
  /**
   * Uniform frames count as entered by a cut only this long after the start of the run: the last steps of a steep fade
   * into a card score as high as a cut.
   */
  screenCutMinSec: 0.1,
  /**
   * A screen goes on while at least this share of its grey pixels stays within `flashSettle` of its last uniform frame
   * and the pixels that changed stay in part of the frame (below): a logo, banner or text that pops, fades, scales or
   * slides onto the card (up to about 40 % of the frame) keeps it one screen; a change that replaces most of the frame
   * ends it.
   */
  screenCardShare: 0.5,
  /** A row or column of the grey frame counts as changed when at least this share of its pixels changed… */
  screenChangeLine: 0.05,
  /**
   * …and a change that reaches this share of the rows ends the screen: an overlay is a region with untouched rows above
   * or below it, while a cut to another shot changes every row, also into a mostly blown-out (or mostly black) shot…
   */
  screenCutRows: 0.9,
  /** …and so does a change that reaches this share of both the rows and the columns (the rest of a blown-out shot). */
  screenCutSpread: 0.7,
  /** The screen also goes on through a glitch of up to two frames (at 30 fps) after which the card is back. */
  screenGlitchSec: 0.067,
  /**
   * An end screen reached without a cut starts where the fade into it starts: the frames before it whose YAVG moves
   * towards the card's white or black by at least this many levels per second (for up to `gradualMaxSec`).
   */
  screenFadeRate: 30,
  flashSettle: 15,
  /** A frame is part of a gradual change when the grey picture changes this much more than its local median (per 1/30 s). */
  gradualYdifFactor: 1.6,
  /** Gradual joins last 0.13–1.5 s (in seconds, so the limits hold at any proxy frame rate up to 60 fps). */
  gradualMinSec: 0.13,
  gradualMaxSec: 1.5,
  /** A gradual window this close to a cut or flash is a busy shot next to it, not a transition. */
  gradualTouchSec: 0.1,
  /**
   * A gradual window is a camera move inside one shot when the frames 0.1 s either side of it, moved by the summed
   * step-to-step shift, overlap by at least this share of the frame (a slide moves about a whole frame)…
   */
  panMinOverlap: 0.25,
  /** …and the overlap correlates at least this well. */
  panMinNcc: 0.6,
  crossFadeResidual: 0.35,
  /** A cross-fade changes the whole frame at once: per-column (and per-row) blend amounts spread at most this much. */
  crossFadeMaxSpread: 0.35,
  /** A join whose frames are this much blurrier than the shots around it is a blur transition (never a cross-fade). */
  blurTransitionRatio: 1.5,
  punchMin: 1.08,
  punchMax: 1.6,
  punchResidualRatio: 0.4,
  zoomMinShotSec: 0.6,
  zoomMinChange: 0.04,
  zoomResidualRatio: 0.5,
  zoomMinTexture: 4,
  endScreenMinSec: 1.5,
  endScreenMaxSec: 5,
  endScreenMaxLuma: 40,
} as const;
const M = REFERENCE_STYLE_MEASURE;

/** One frame of Pass A. */
export interface FrameScore {
  t: number;
  scene: number;
  yavg: number;
  ymin: number;
  ymax: number;
  ydif: number;
  blur: number | null;
}

/** Parses `select=gte(scene,0),signalstats,blurdetect,metadata=mode=print:file=-` output into per-frame scores. */
export function parseFrameScores(output: string): FrameScore[] {
  const frames: FrameScore[] = [];
  let cur: Partial<FrameScore> | null = null;
  const flush = () => {
    if (cur && cur.t !== undefined && cur.yavg !== undefined) {
      frames.push({ t: cur.t, scene: cur.scene ?? 0, yavg: cur.yavg, ymin: cur.ymin ?? cur.yavg, ymax: cur.ymax ?? cur.yavg, ydif: cur.ydif ?? 0, blur: cur.blur ?? null });
    }
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('frame:')) {
      flush();
      const m = /pts_time:(-?[\d.]+)/.exec(line);
      cur = m ? { t: Number(m[1]) } : null;
      continue;
    }
    if (!cur) continue;
    const m = /^lavfi\.(scene_score|signalstats\.YAVG|signalstats\.YMIN|signalstats\.YMAX|signalstats\.YDIF|blur)=(.+)$/.exec(line);
    if (!m) continue;
    const v = Number(m[2]);
    const value = Number.isFinite(v) ? v : null;
    switch (m[1]) {
      case 'scene_score':
        cur.scene = value ?? 0;
        break;
      case 'signalstats.YAVG':
        if (value !== null) cur.yavg = value;
        break;
      case 'signalstats.YMIN':
        if (value !== null) cur.ymin = value;
        break;
      case 'signalstats.YMAX':
        if (value !== null) cur.ymax = value;
        break;
      case 'signalstats.YDIF':
        cur.ydif = value ?? 0;
        break;
      case 'blur':
        cur.blur = value;
        break;
    }
  }
  flush();
  return frames;
}

// ---------------------------------------------------------------- tiny grey frames

/** Pass B frames: `count` frames of `width × height` bytes at `fps`, starting at time `t0`. */
export interface GreyFrames {
  width: number;
  height: number;
  fps: number;
  t0: number;
  count: number;
  data: Uint8Array;
}

export function frameAt(g: GreyFrames, index: number): Uint8Array {
  const i = Math.min(g.count - 1, Math.max(0, index));
  const size = g.width * g.height;
  return g.data.subarray(i * size, (i + 1) * size);
}

/** The grey frame closest to time `t`. */
export function frameAtTime(g: GreyFrames, t: number): Uint8Array {
  return frameAt(g, Math.round((t - g.t0) * g.fps));
}

/** Normalised cross-correlation of two frames (−1…1; 0 when either is flat). */
export function ncc(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Mean absolute difference of two frames. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!);
  return n ? s / n : 0;
}

export interface ScaleFit {
  /** Best scale of `later` relative to `earlier` (above 1 = pushed in). */
  scale: number;
  /** Mean absolute error at the best scale, inner 80 % of the frame. */
  error: number;
  /** Mean absolute error with no scaling. */
  errorAtOne: number;
}

const ANCHORS = [0.3, 0.5, 0.7];

function scaledError(earlier: Uint8Array, later: Uint8Array, w: number, h: number, s: number, ax: number, ay: number): number {
  const x0 = Math.floor(w * 0.1);
  const x1 = Math.ceil(w * 0.9);
  const y0 = Math.floor(h * 0.1);
  const y1 = Math.ceil(h * 0.9);
  const cx = ax * (w - 1);
  const cy = ay * (h - 1);
  const inv = 1 / s;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const sy = cy + (y - cy) * inv;
    const iy = Math.floor(sy);
    if (iy < 0 || iy >= h - 1) continue;
    const fy = sy - iy;
    for (let x = x0; x < x1; x++) {
      const sx = cx + (x - cx) * inv;
      const ix = Math.floor(sx);
      if (ix < 0 || ix >= w - 1) continue;
      const fx = sx - ix;
      const p = iy * w + ix;
      const top = earlier[p]! + (earlier[p + 1]! - earlier[p]!) * fx;
      const bottom = earlier[p + w]! + (earlier[p + w + 1]! - earlier[p + w]!) * fx;
      const v = top + (bottom - top) * fy;
      sum += Math.abs(v - later[y * w + x]!);
      n++;
    }
  }
  return n ? sum / n : Number.POSITIVE_INFINITY;
}

/**
 * Scale fit (design §4.3.1.3d step 2): predicts `later` by cropping `earlier` around an anchor on a 3 × 3 grid by
 * 1/s and scaling back (bilinear), comparing the inner 80 % of the frame; coarse-to-fine over [min, max].
 */
export function scaleFit(earlier: Uint8Array, later: Uint8Array, w: number, h: number, range: { min: number; max: number } = { min: 0.8, max: 1.4 }): ScaleFit {
  const errorAtOne = scaledError(earlier, later, w, h, 1, 0.5, 0.5);
  let best = { scale: 1, error: errorAtOne, ax: 0.5, ay: 0.5 };
  const tryScale = (s: number, anchors: Array<[number, number]>) => {
    for (const [ax, ay] of anchors) {
      const e = scaledError(earlier, later, w, h, s, ax, ay);
      if (e < best.error - 1e-9) best = { scale: s, error: e, ax, ay };
    }
  };
  const grid: Array<[number, number]> = ANCHORS.flatMap((ax) => ANCHORS.map((ay): [number, number] => [ax, ay]));
  for (let s = range.min; s <= range.max + 1e-9; s += 0.03) tryScale(Math.round(s * 1000) / 1000, grid);
  const coarse = best.scale;
  const anchor: Array<[number, number]> = [[best.ax, best.ay]];
  for (let s = coarse - 0.03; s <= coarse + 0.03 + 1e-9; s += 0.005) if (s >= range.min - 1e-9 && s <= range.max + 1e-9) tryScale(Math.round(s * 1000) / 1000, anchor);
  return { scale: Math.round(best.scale * 1000) / 1000, error: best.error, errorAtOne };
}

/** Best integer shift along one axis: `b(p) ≈ a(p + shift)`; a positive shift on y means the content moved up. */
export function shiftFit(a: Uint8Array, b: Uint8Array, w: number, h: number, axis: 'x' | 'y', maxShift: number): { shift: number; error: number; errorAtZero: number } {
  const errorFor = (d: number) => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      const sy = axis === 'y' ? y + d : y;
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = axis === 'x' ? x + d : x;
        if (sx < 0 || sx >= w) continue;
        sum += Math.abs(b[y * w + x]! - a[sy * w + sx]!);
        n++;
      }
    }
    return n > (w * h) / 3 ? sum / n : Number.POSITIVE_INFINITY;
  };
  const errorAtZero = errorFor(0);
  let best = { shift: 0, error: errorAtZero };
  for (let d = -maxShift; d <= maxShift; d++) {
    if (d === 0) continue;
    const e = errorFor(d);
    if (e < best.error) best = { shift: d, error: e };
  }
  return { ...best, errorAtZero };
}

/** NCC of the parts of two frames that overlap when `b(p) ≈ a(p + shift)` along one axis (as in {@link shiftFit}). */
export function shiftedNcc(a: Uint8Array, b: Uint8Array, w: number, h: number, axis: 'x' | 'y', shift: number): number {
  const dx = axis === 'x' ? shift : 0;
  const dy = axis === 'y' ? shift : 0;
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(h, h - dy);
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sa += a[(y + dy) * w + x + dx]!;
      sb += b[y * w + x]!;
      n++;
    }
  }
  if (!n) return 0;
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = a[(y + dy) * w + x + dx]! - ma;
      const q = b[y * w + x]! - mb;
      num += p * q;
      da += p * p;
      db += q * q;
    }
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * {@link shiftFit} over half the frame along the axis: a 0.15 s slide moves about half the frame between frames 2/30 s
 * apart, beyond a search over a third of the frame (which stopped at its edge, or at a closer minimum that does not
 * explain the change, and left the slide to the cut test: X17).
 */
export function shiftFitWide(a: Uint8Array, b: Uint8Array, w: number, h: number, axis: 'x' | 'y'): { shift: number; error: number; errorAtZero: number } {
  return shiftFit(a, b, w, h, axis, Math.round((axis === 'y' ? h : w) / 2));
}

/** Mean absolute difference of the overlap when `b(p) ≈ a(p + shift)` along one axis (no minimum overlap). */
function shiftError(a: Uint8Array, b: Uint8Array, w: number, h: number, axis: 'x' | 'y', shift: number): number {
  const dx = axis === 'x' ? shift : 0;
  const dy = axis === 'y' ? shift : 0;
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
    for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
      sum += Math.abs(b[y * w + x]! - a[(y + dy) * w + x + dx]!);
      n++;
    }
  }
  return n ? sum / n : Number.POSITIVE_INFINITY;
}

function spearman(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const ranks = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).map((x, r) => ({ ...x, r }));
  const rank = new Array<number>(n);
  for (const x of ranks) rank[x.i] = x.r;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rank[i]! - i) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/** Cross-fade test: every inner frame is a blend of the frames either side, and the blend moves one way. */
export function crossFadeFit(start: Uint8Array, end: Uint8Array, inner: Uint8Array[]): { ok: boolean; residualRatio: number; monotonic: number } {
  const n = start.length;
  let span = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const d = end[i]! - start[i]!;
    span += Math.abs(d);
    norm += d * d;
  }
  span /= n;
  if (norm <= 0 || span < 3) return { ok: false, residualRatio: 1, monotonic: 0 };
  const alphas: number[] = [];
  let residual = 0;
  let worst = 0;
  for (const f of inner) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += (f[i]! - start[i]!) * (end[i]! - start[i]!);
    const a = dot / norm;
    alphas.push(a);
    let r = 0;
    for (let i = 0; i < n; i++) r += Math.abs(f[i]! - (start[i]! + a * (end[i]! - start[i]!)));
    residual += r / n;
    worst = Math.max(worst, r / n);
  }
  const residualRatio = inner.length ? residual / inner.length / span : 1;
  const monotonic = spearman(alphas);
  // Every inner frame must fit (a wipe fits on average but not in the middle, where half the frame is each shot).
  return { ok: worst / span <= M.crossFadeResidual && monotonic >= 0.8, residualRatio, monotonic };
}

/** 10th–90th percentile spread of a grey frame (small for a nearly uniform white or black frame, even with a caption). */
export function percentileSpread(frame: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < frame.length; i++) hist[frame[i]!] = hist[frame[i]!]! + 1;
  const at = (q: number) => {
    const target = q * (frame.length - 1);
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v]!;
      if (acc > target) return v;
    }
    return 255;
  };
  return at(0.9) - at(0.1);
}

/** Is every frame a blend of `start` and `end` (no monotonic check; for one or two ramp frames)? True with no frames. */
export function blendFits(start: Uint8Array, end: Uint8Array, frames: readonly Uint8Array[]): boolean {
  const n = start.length;
  let span = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const d = end[i]! - start[i]!;
    span += Math.abs(d);
    norm += d * d;
  }
  span /= n;
  if (norm <= 0 || span < 3) return true;
  for (const f of frames) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += (f[i]! - start[i]!) * (end[i]! - start[i]!);
    const a = Math.max(0, Math.min(1, dot / norm));
    let r = 0;
    for (let i = 0; i < n; i++) r += Math.abs(f[i]! - (start[i]! + a * (end[i]! - start[i]!)));
    if (r / n / span > M.crossFadeResidual) return false;
  }
  return true;
}

/**
 * How unevenly a join changes the frame (design §4.3.1.3a): for inner frames about a quarter to three quarters of the
 * way from `start` to `end`, the blend amount is estimated per column and per row; the result is the median over those
 * frames of the larger 10th–90th percentile spread. Near 0 for a cross-fade (the whole frame changes at once), near 1
 * for a wipe, even a soft-edged one (one side has changed, the other not yet).
 */
export function blendSpread(start: Uint8Array, end: Uint8Array, inner: readonly Uint8Array[], w: number, h: number): number {
  const n = start.length;
  let norm = 0;
  for (let i = 0; i < n; i++) norm += (end[i]! - start[i]!) ** 2;
  if (norm <= 0) return 0;
  const spreads: number[] = [];
  const spreadOf = (vals: number[]) => {
    if (vals.length < 5) return 0;
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.floor(0.9 * (sorted.length - 1))]! - sorted[Math.floor(0.1 * (sorted.length - 1))]!;
  };
  for (const f of inner) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += (f[i]! - start[i]!) * (end[i]! - start[i]!);
    const a = dot / norm;
    if (a < 0.25 || a > 0.75) continue;
    const colNum = new Float64Array(w);
    const colDen = new Float64Array(w);
    const rowNum = new Float64Array(h);
    const rowDen = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const d = end[p]! - start[p]!;
        if (Math.abs(d) < 8) continue;
        const num = (f[p]! - start[p]!) * d;
        const den = d * d;
        colNum[x] = colNum[x]! + num;
        colDen[x] = colDen[x]! + den;
        rowNum[y] = rowNum[y]! + num;
        rowDen[y] = rowDen[y]! + den;
      }
    }
    const alphas = (num: Float64Array, den: Float64Array, minDen: number) => {
      const out: number[] = [];
      for (let k = 0; k < num.length; k++) if (den[k]! >= minDen) out.push(Math.max(-0.25, Math.min(1.25, num[k]! / den[k]!)));
      return out;
    };
    // A column or row needs enough difference between the shots to say how far it has changed.
    spreads.push(Math.max(spreadOf(alphas(colNum, colDen, h * 64 * 0.2)), spreadOf(alphas(rowNum, rowDen, w * 64 * 0.2))));
  }
  return spreads.length ? medianOf(spreads) : 0;
}

/** Band test: is frame-to-frame change concentrated in a band of rows or columns whose centre moves one way? */
export function movingBand(frames: Uint8Array[], w: number, h: number): { axis: 'rows' | 'cols'; direction: 'up' | 'down' | 'left' | 'right' } | null {
  const results: Array<{ axis: 'rows' | 'cols'; centroid: number }> = [];
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1]!;
    const b = frames[k]!;
    const rows = new Float64Array(h);
    const cols = new Float64Array(w);
    let total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(b[y * w + x]! - a[y * w + x]!);
        rows[y] = rows[y]! + d;
        cols[x] = cols[x]! + d;
        total += d;
      }
    }
    if (total <= 0) continue;
    const concentrated = (arr: Float64Array) => {
      const sorted = [...arr].sort((p, q) => q - p);
      const top = sorted.slice(0, Math.ceil(arr.length * 0.3)).reduce((s, v) => s + v, 0);
      let c = 0;
      arr.forEach((v, i) => (c += v * i));
      return { share: top / total, centroid: c / total };
    };
    const r = concentrated(rows);
    const c = concentrated(cols);
    if (c.share >= 0.55 && c.share >= r.share) results.push({ axis: 'cols', centroid: c.centroid });
    else if (r.share >= 0.55) results.push({ axis: 'rows', centroid: r.centroid });
  }
  for (const axis of ['cols', 'rows'] as const) {
    const cs = results.filter((x) => x.axis === axis).map((x) => x.centroid);
    if (cs.length < 3) continue;
    let up = 0;
    let down = 0;
    for (let i = 1; i < cs.length; i++) {
      if (cs[i]! > cs[i - 1]! + 0.3) up++;
      else if (cs[i]! < cs[i - 1]! - 0.3) down++;
    }
    if (Math.max(up, down) >= 2 && Math.max(up, down) >= 0.7 * (cs.length - 1)) {
      if (axis === 'cols') return { axis, direction: down > up ? 'left' : 'right' };
      return { axis, direction: down > up ? 'up' : 'down' };
    }
  }
  return null;
}

// ---------------------------------------------------------------- detection on the passes

function localMedian(values: readonly number[], i: number, half: number): number {
  const lo = Math.max(0, i - half);
  const hi = Math.min(values.length - 1, i + half);
  const w: number[] = [];
  for (let k = lo; k <= hi; k++) w.push(values[k]!);
  w.sort((a, b) => a - b);
  const m = Math.floor(w.length / 2);
  return w.length % 2 ? w[m]! : (w[m - 1]! + w[m]!) / 2;
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A detected event on the frame timeline (in memory only). */
export interface DetectedEvent extends RawJoin {
  /** First and last Pass A frame index the event covers. */
  from: number;
  to: number;
  inShot?: boolean;
}

export interface DetectionResult {
  events: DetectedEvent[];
  /** Long black/white runs (title or end screens), as [startSec, endSec]. */
  screens: Array<[number, number]>;
}

/**
 * Finds screens (cards), flashes, cuts, punch-in jumps and gradual joins on the Pass A scores and Pass B frames (design
 * §4.3.1.3a), in that order, then an end card reached by a slow fade; each frame belongs to at most one event or
 * screen. Camera moves inside one shot are dropped. Every duration limit is in seconds, so detection holds at any proxy
 * frame rate up to 60 fps.
 */
export function detectJoins(frames: readonly FrameScore[], grey: GreyFrames, fps: number, signal?: AbortSignal): DetectionResult {
  const n = frames.length;
  const used = new Uint8Array(n);
  const events: DetectedEvent[] = [];
  const screens: Array<[number, number]> = [];
  /** Screens found in the flash pass with how they were entered (to count the cut into a screen inside the video). */
  const screenRuns: Array<{ from: number; entry: number; to: number; kind: 'white' | 'black' }> = [];
  const y = frames.map((f) => f.yavg);
  const sec = (s: number) => Math.max(1, Math.round(s * fps));
  const g = (t: number) => frameAtTime(grey, t);
  const dt = 1 / fps;
  const w = grey.width;
  const h = grey.height;
  // Change per 1/30 s from the Pass B grey frames (fixed rate, so a slow cross-fade at 60 fps changes as much per step
  // as at 30 fps; YDIF between 60 fps frames halves while sensor noise does not).
  const greyStep = new Float64Array(grey.count);
  for (let k = 1; k < grey.count; k++) greyStep[k] = meanAbsDiff(frameAt(grey, k - 1), frameAt(grey, k));
  const change = frames.map((f) => greyStep[Math.min(grey.count - 1, Math.max(1, Math.round((f.t - grey.t0) * grey.fps + 1e-6)))]!);
  /** The picture changes clearly more than usual for this part of the video (a transition, not the shot's own motion). */
  const busy = change.map((v, i) => v >= M.gradualYdifFactor * Math.max(0.5, localMedian(change, i, sec(1.5))));
  const busyShare = (from: number, to: number) => {
    let c = 0;
    let k = 0;
    for (let q = Math.max(0, from); q <= Math.min(n - 1, to); q++, k++) if (busy[q]) c++;
    return k ? c / k : 0;
  };
  const uniformAt = (k: number) => percentileSpread(g(frames[k]!.t)) <= M.flashUniformSpread;
  /** The largest scene score within a frame of `k` (the grey frames are on a 1/30 s grid, the scores on the proxy's). */
  const sceneNear = (k: number) => Math.max(frames[k - 1]?.scene ?? 0, frames[k]!.scene, frames[k + 1]?.scene ?? 0);
  /**
   * Does frame `k` still show the card `ref`? At least half of its grey pixels stay within `flashSettle` of the card,
   * and the pixels that changed stay in part of the frame: they reach fewer than `screenCutRows` of the rows, and not
   * `screenCutSpread` of both the rows and the columns (a row or column is reached when `screenChangeLine` of it
   * changed). An overlay changes a region; a cut to another shot changes the picture across the frame, also where that
   * shot keeps most of the card's white (blown out) or black.
   */
  const showsCard = (ref: Uint8Array, k: number) => {
    const f = g(frames[k]!.t);
    const inColumn = new Uint16Array(w);
    let changed = 0;
    let rows = 0;
    for (let r = 0; r < h; r++) {
      let inRow = 0;
      for (let x = 0; x < w; x++) {
        if (Math.abs(f[r * w + x]! - ref[r * w + x]!) <= M.flashSettle) continue;
        inRow++;
        inColumn[x] = inColumn[x]! + 1;
      }
      changed += inRow;
      if (inRow >= M.screenChangeLine * w) rows++;
    }
    if (f.length - changed < M.screenCardShare * f.length) return false;
    let columns = 0;
    for (let x = 0; x < w; x++) if (inColumn[x]! >= M.screenChangeLine * h) columns++;
    return rows < M.screenCutRows * h && !(rows >= M.screenCutSpread * h && columns >= M.screenCutSpread * w);
  };
  const glitchFrames = sec(M.screenGlitchSec);
  /**
   * The last frame of a card whose uniform frames end at `e`: the card goes on while the frame still shows it
   * (`showsCard`: an overlay that pops, fades, scales or slides in), also through a glitch of up to two frames after
   * which the card is back, and ends at a change that replaces most of the frame or reaches across it (a cut, also into
   * a mostly blown-out or mostly black shot, or a fade out of the card).
   */
  const cardEnd = (e: number) => {
    const ref = g(frames[e]!.t);
    let c = e;
    while (c + 1 < n && !used[c + 1]) {
      if (showsCard(ref, c + 1)) {
        c++;
        continue;
      }
      let back = -1;
      for (let q = c + 2; q < n && q <= c + 1 + glitchFrames && !used[q]; q++) {
        if (showsCard(ref, q)) {
          back = q;
          break;
        }
      }
      if (back < 0) break;
      c = back;
    }
    // The cut out of the card is the larger scene score of the last frame and the next: at 60 or 24 fps the cut frame
    // can be looked up on the grey frame before it, which still shows the card.
    if (c > e && c + 1 < n && frames[c]!.scene >= M.cutMinScore && frames[c]!.scene > frames[c + 1]!.scene) c--;
    return c;
  };
  /** The first frame of the fade into an end card starting at frame `s` (YAVG moving towards it, `screenFadeRate`). */
  const fadeStart = (s: number, kind: 'white' | 'black') => {
    const step = M.screenFadeRate / fps;
    let r = s;
    while (r - 2 >= 0 && !used[r - 1] && s - r < sec(M.gradualMaxSec) && (kind === 'white' ? y[r - 1]! - y[r - 2]! : y[r - 2]! - y[r - 1]!) >= step) r--;
    return r;
  };

  // 1. Screens, flashes and dips in each run of white or black frames (YAVG against the median of the 0.5 s before):
  //    a screen (card) first; otherwise a run of up to 0.6 s is a flash or dip (a nearly uniform white or black frame,
  //    entered from a steady picture or by a blend towards the extreme), and a longer run is a shot. A bright or dark
  //    shot keeps its detail and is left to the cut test.
  for (let i = 1; i < n; i++) {
    if (used[i]) continue;
    if (i % 256 === 0) throwIfAborted(signal, 'Reference style');
    const base = y.slice(Math.max(0, i - sec(0.5)), i);
    if (base.length === 0) continue;
    const yb = medianOf(base);
    const isWhite = (v: number) => v >= Math.max(M.flashWhiteMin, yb + M.flashWhiteLift);
    const isBlack = (v: number) => v <= M.flashBlackMax && yb - v >= 0.5 * yb;
    const kind = isWhite(y[i]!) ? 'white' : isBlack(y[i]!) ? 'black' : null;
    if (!kind) continue;
    const test = kind === 'white' ? isWhite : isBlack;
    let runEnd = i;
    while (runEnd + 1 < n && test(y[runEnd + 1]!)) runEnd++;
    // Title, end and mid-video screens (cards), judged frame by frame inside the run (not by its brightest or darkest
    // frame). A screen starts at nearly uniform frames at the extreme:
    // - right after a cut into them (a scene score of 0.18 or more within a frame, at least 0.1 s after the run start,
    //   because the last steps of a steep fade into a card score as high): the screen starts at the cut frame, and the
    //   frames with picture detail before it go to the cut test, so a bright shot before a white end card keeps its
    //   cut;
    // - otherwise only within 0.5 s of the start of the run, taking the run (and a ramp of up to 0.5 s before it) into
    //   the screen: a cut or fade into the card, but also a short bright or dark shot softly cut into it. A shot that
    //   drifts towards white or black later in the run stays a shot.
    // The screen then goes on while the frame still shows the card (`cardEnd`), also after the run's brightness test
    // fails (a dark banner on a white card), and must last more than 0.6 s from the cut into it or from its first
    // uniform frame. A screen without a cut into it that goes on to the end of the span starts with the whole fade into
    // it (`fadeStart`), as the run of a slow fade starts late.
    let lastScreen = -1;
    for (let k = i; k <= runEnd; k++) {
      if (used[k] || !uniformAt(k)) continue;
      let e = k;
      while (e + 1 <= runEnd && uniformAt(e + 1)) e++;
      const cutInto = k - i >= sec(M.screenCutMinSec) && sceneNear(k) >= M.cutMinScore;
      if (!cutInto && k - i > sec(M.screenEntrySec)) {
        k = e;
        continue;
      }
      // The cut frame itself: at 60 or 24 fps a Pass A frame can be looked up on the grey frame before it.
      let entry = i;
      if (cutInto) {
        entry = k;
        for (const q of [k - 1, k + 1]) if (q >= i && q <= runEnd && !used[q] && frames[q]!.scene > frames[entry]!.scene) entry = q;
      }
      const c = cardEnd(e);
      if ((c - (cutInto ? entry : k) + 1) / fps <= M.screenMinSec || entry > c) {
        k = e;
        continue;
      }
      let s = entry;
      if (!cutInto) while (s - 1 >= 0 && !used[s - 1] && Math.abs(y[s - 1]! - yb) >= M.flashSettle && i - s < sec(M.screenEntrySec)) s--;
      // An end card reached by a slow fade: the run starts late in the fade (the 0.5 s baseline follows the ramp).
      if (!cutInto && c === n - 1) s = fadeStart(s, kind);
      screenRuns.push({ from: s, entry, to: c, kind });
      for (let q = s; q <= c; q++) used[q] = 1;
      lastScreen = c;
      k = c;
    }
    if (lastScreen >= 0) {
      i = Math.max(runEnd, lastScreen);
      continue;
    }
    // A long bright or dark run with picture detail is just a shot.
    if ((runEnd - i + 1) / fps > M.screenMinSec) {
      i = runEnd;
      continue;
    }
    let peak = i;
    for (let k = i; k <= runEnd; k++) if (kind === 'white' ? y[k]! > y[peak]! : y[k]! < y[peak]!) peak = k;
    const uniform = uniformAt(peak);
    let s = i;
    while (s - 1 >= 0 && !used[s - 1] && Math.abs(y[s - 1]! - yb) >= M.flashSettle && i - s < sec(1.5)) s--;
    const nextLevel = medianOf(y.slice(Math.min(n, runEnd + 1 + sec(0.2)), Math.min(n, runEnd + 1 + sec(0.5))));
    let e = runEnd;
    while (e + 1 < n && Math.abs(y[e + 1]! - nextLevel) >= M.flashSettle && e - s < sec(1.5)) e++;
    const before = g(frames[Math.max(0, s - 1)]!.t);
    const after = g(frames[Math.min(n - 1, e + 1)]!.t);
    const extreme = g(frames[peak]!.t);
    const rampIn: Uint8Array[] = [];
    for (let k = s; k < i; k++) rampIn.push(g(frames[k]!.t));
    const rampOut: Uint8Array[] = [];
    for (let k = runEnd + 1; k <= e; k++) rampOut.push(g(frames[k]!.t));
    // Uniform at its extreme, or (for a flash that does not reach full white or black) ramping over 2+ frames each way.
    const shaped = uniform || (i - s >= 2 && e - runEnd >= 2);
    // Reached by blending towards the extreme, not by zooming into a flat part of the picture (FFmpeg's zoomin
    // passes through a single-colour frame that can be white).
    const ts = frames[s]!.t;
    const lead = scaleFit(g(ts - 3 / grey.fps), g(ts - 1 / grey.fps), w, h);
    const zoomingIn = lead.scale >= 1.06 && lead.errorAtOne >= M.zoomMinTexture && lead.error <= M.zoomResidualRatio * lead.errorAtOne;
    const blended = blendFits(before, extreme, rampIn) && blendFits(extreme, after, rampOut);
    if (!shaped || zoomingIn || !blended) {
      i = runEnd;
      continue;
    }
    events.push({
      kind: kind === 'white' ? 'fade_white' : 'fade_black',
      timeSec: frames[peak]!.t,
      durationSec: (e - s + 1) / fps,
      from: s,
      to: e,
      inShot: ncc(before, after) >= 0.6,
    });
    for (let k = Math.max(0, s - 1); k <= Math.min(n - 1, e + 1); k++) used[k] = 1;
    i = e;
  }

  // 2. Hard cuts and 3. punch-in jumps.
  const scene = frames.map((f) => f.scene);
  const thresholds = scene.map((_, i) => Math.max(M.cutMinScore, M.cutMedianFactor * localMedian(scene, i, sec(1))));
  const near = sec(0.1);
  for (let i = 1; i < n; i++) {
    if (used[i]) continue;
    if (i % 256 === 0) throwIfAborted(signal, 'Reference style');
    const s = scene[i]!;
    if (s < thresholds[i]!) continue;
    let isMax = true;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) if (k !== i && scene[k]! > s) isMax = false;
    if (!isMax) continue;
    if ((scene[i - 1] ?? 0) > 0.5 * s || (scene[i + 1] ?? 0) > 0.5 * s) continue;
    // A spike inside a short burst of change (a zoom into a flat frame, a blur) belongs to a gradual join: busy on both
    // sides, or a weak spike followed by a burst that is over within 0.6 s (a busy shot keeps changing).
    const busyAfter = busyShare(i + 1, i + near) >= 0.6;
    const burstEnds = busyShare(i + sec(0.6), i + sec(1)) < 0.5;
    if (busyAfter && (busyShare(i - near, i - 1) >= 0.6 || (s < M.cutWeakScore && burstEnds))) continue;
    const t = frames[i]!.t;
    // Pass B steps (1/30 s), so the frames either side are different grey frames at any proxy frame rate.
    const gs = 1 / grey.fps;
    const a = g(t - 2 * gs);
    const b = g(t + 2 * gs);
    /** How alike the frames within each side are (each shot's own motion and noise). */
    const within = Math.min(ncc(g(t - 4 * gs), a), ncc(b, g(t + 4 * gs)));
    const fit = () => scaleFit(g(t - gs), g(t + gs), grey.width, grey.height, { min: 1, max: M.punchMax });
    // The picture sliding or wiping along an axis is a transition (or camera motion), not a cut. The shift has to
    // explain the change: the shifted frames must look alike, nearly as alike as the frames within each side. A shift
    // that only lowers the difference by cropping (a detailed shot cut against a smooth one) leaves the cut a cut.
    const before = g(t - gs);
    const after = g(t + gs);
    const moving = (['y', 'x'] as const).some((axis) => {
      const r = shiftFitWide(before, after, grey.width, grey.height, axis);
      if (Math.abs(r.shift) < 2 || r.error > 0.5 * r.errorAtZero) return false;
      const alike = shiftedNcc(before, after, grey.width, grey.height, axis, r.shift);
      return alike >= M.cutMaxNcc && alike >= within - M.cutShiftNccDrop;
    });
    if (moving) continue;
    // Frames either side that still look alike rule out a cut (fast motion, a camera flash), unless they look clearly
    // less alike than the frames within each side do (two different but similar-looking shots).
    const across = ncc(a, b);
    const correlated = across >= M.cutMaxNcc && across >= within - M.cutNccDrop;
    const f = fit();
    const punch = f.scale >= M.punchMin && f.scale <= M.punchMax && f.error <= M.punchResidualRatio * f.errorAtOne;
    if (correlated && !punch) continue;
    events.push(punch ? { kind: 'punch_in', timeSec: t, durationSec: 0, scale: f.scale, from: i, to: i } : { kind: 'hard', timeSec: t, durationSec: 0, from: i, to: i });
    used[i] = 1;
  }

  // 4. Gradual joins: runs where the picture keeps changing more than usual without a cut.
  // Frames with a scene spike that was not a cut (it failed the tests above) can be part of a gradual join.
  const active = frames.map((_, i) => !used[i] && busy[i]!);
  const blurs = frames.map((f) => f.blur);
  const medianBlur = (from: number, to: number) => {
    const vals: number[] = [];
    for (let k = Math.max(0, from); k <= Math.min(n - 1, to); k++) if (blurs[k] !== null && blurs[k] !== undefined) vals.push(blurs[k]!);
    return vals.length ? medianOf(vals) : null;
  };
  const touch = sec(M.gradualTouchSec);
  /**
   * Camera motion inside one shot (a pan or tilt, even a whip pan): the frame after the window is the frame before it,
   * moved by the sum of the shifts from step to step (one before/after shift is searched over half the frame at most).
   * A slide between two shots also moves the picture, but by about a whole frame, so the frames must still overlap by
   * `panMinOverlap` of the frame; they are taken 0.1 s outside the window (no cut or flash lies that close), where a
   * slide that eases in and out has finished. The moved frames must look alike (`panMinNcc`), and the move must explain
   * the change (at most half the difference left).
   */
  const cameraMove = (tStart: number, tEnd: number): boolean => {
    const t0 = tStart - M.gradualTouchSec;
    const t1 = tEnd + M.gradualTouchSec;
    const steps: Uint8Array[] = [];
    for (let t = t0; t <= t1 + 1e-6; t += 1 / grey.fps) steps.push(g(t));
    const a = steps[0]!;
    const b = steps[steps.length - 1]!;
    for (const axis of ['y', 'x'] as const) {
      const dim = axis === 'y' ? h : w;
      let sum = 0;
      for (let k = 1; k < steps.length; k++) {
        const r = shiftFitWide(steps[k - 1]!, steps[k]!, w, h, axis);
        if (r.error <= 0.5 * r.errorAtZero) sum += r.shift;
      }
      // No measured motion (a wipe, a zoom), or about a whole frame of it (a slide, or a whip too fast to check).
      if (Math.abs(sum) < 2 || dim - Math.abs(sum) < M.panMinOverlap * dim) continue;
      // The move: the best shift near that sum, or the one before/after shift where it points the same way (slow steps
      // of under a grey pixel each add up to less than the move).
      const tol = Math.max(2, Math.round(0.15 * Math.abs(sum)));
      const candidates: number[] = [];
      let near = { shift: 0, error: Number.POSITIVE_INFINITY };
      for (let d = sum - tol; d <= sum + tol; d++) {
        if (d === 0 || dim - Math.abs(d) < M.panMinOverlap * dim) continue;
        const e = shiftError(a, b, w, h, axis, d);
        if (e < near.error) near = { shift: d, error: e };
      }
      if (Number.isFinite(near.error)) candidates.push(near.shift);
      const direct = shiftFitWide(a, b, w, h, axis).shift;
      if (Math.sign(direct) === Math.sign(sum) && Math.abs(direct) >= 2 && !candidates.includes(direct)) candidates.push(direct);
      const still = shiftError(a, b, w, h, axis, 0);
      for (const d of candidates) {
        if (shiftError(a, b, w, h, axis, d) <= 0.5 * still && shiftedNcc(a, b, w, h, axis, d) >= M.panMinNcc) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    let j = i;
    let gaps = 0;
    while (j + 1 < n && !used[j + 1] && (active[j + 1] || (j + 2 < n && active[j + 2] && gaps < 2))) {
      if (!active[j + 1]) gaps++;
      j++;
    }
    const len = j - i + 1;
    const start = i;
    i = j;
    if (len / fps < M.gradualMinSec - 1e-9 || len / fps > M.gradualMaxSec + 1e-9) continue;
    // A join needs a shot on each side: a window running into a cut or flash is a busy shot, not a transition.
    let touches = false;
    for (let k = Math.max(0, start - touch); k < start; k++) if (used[k]) touches = true;
    for (let k = j + 1; k <= Math.min(n - 1, j + touch); k++) if (used[k]) touches = true;
    if (touches) continue;
    const tStart = frames[start]!.t;
    const tEnd = frames[j]!.t;
    const before = g(tStart - 2 / grey.fps);
    const after = g(tEnd + 2 / grey.fps);
    if (ncc(before, after) >= 0.6) continue;
    throwIfAborted(signal, 'Reference style');
    const inner: Uint8Array[] = [];
    for (let t = tStart; t <= tEnd + 1e-6; t += 1 / grey.fps) inner.push(g(t));
    const ev: DetectedEvent = { kind: 'unclear', timeSec: (tStart + tEnd) / 2, durationSec: len / fps, from: start, to: j };
    const seq = [before, ...inner, after];
    const shifts = (axis: 'x' | 'y') =>
      seq.slice(1).map((f, k) => {
        const r = shiftFit(seq[k]!, f, w, h, axis, Math.round((axis === 'y' ? h : w) / 3));
        return r.error <= 0.5 * r.errorAtZero ? Math.sign(r.shift) : 0;
      });
    const consistent = (signs: number[]) => {
      const pos = signs.filter((v) => v > 0).length;
      const neg = signs.filter((v) => v < 0).length;
      return Math.max(pos, neg) >= 3 && Math.min(pos, neg) <= 1 ? (pos > neg ? 1 : -1) : 0;
    };
    const blurIn = medianBlur(start, j);
    const aroundBlurs = [...frames.slice(Math.max(0, start - sec(0.5)), start), ...frames.slice(j + 1, j + 1 + sec(0.5))].map((f) => f.blur).filter((b): b is number => b !== null);
    const blurAround = aroundBlurs.length ? medianOf(aroundBlurs) : null;
    const blurry = blurIn !== null && blurAround !== null && blurAround > 0 && blurIn >= M.blurTransitionRatio * blurAround;
    // A cross-fade blends the whole frame at once: a soft-edged wipe fits a blend on average but changes one side first.
    if (!blurry && crossFadeFit(before, after, inner).ok && blendSpread(before, after, inner, w, h) <= M.crossFadeMaxSpread) ev.kind = 'cross_fade';
    // A pan or tilt inside one shot (the camera moving, not a join): neither a join nor a shot boundary.
    else if (cameraMove(tStart, tEnd)) continue;
    else {
      const sy = consistent(shifts('y'));
      const sx = sy === 0 ? consistent(shifts('x')) : 0;
      const band = sy === 0 && sx === 0 ? movingBand(seq, w, h) : null;
      if (sy !== 0) {
        ev.kind = 'slide_vertical';
        ev.direction = sy > 0 ? 'up' : 'down';
      } else if (sx !== 0) {
        ev.kind = 'wipe_horizontal';
        ev.direction = sx > 0 ? 'left' : 'right';
      } else if (band) {
        ev.kind = band.axis === 'cols' ? 'wipe_horizontal' : 'slide_vertical';
        ev.direction = band.direction;
        // Sideways movement through blurred frames is a whip (FFmpeg's blur transitions read the same way).
        if (band.axis === 'cols' && blurry) ev.kind = 'whip_like';
      } else if (!blurry) {
        // A zoom: consecutive frames fit a scale change (with little error left over on textured frames), one way.
        const scales = seq.slice(1).map((f, k) => {
          const fit = scaleFit(seq[k]!, f, w, h);
          return fit.errorAtOne >= M.zoomMinTexture && fit.error <= M.zoomResidualRatio * fit.errorAtOne ? fit.scale : 1;
        });
        const ups = scales.filter((v) => v >= 1.03).length;
        const downs = scales.filter((v) => v <= 1 / 1.03).length;
        if (Math.max(ups, downs) >= 3 && Math.min(ups, downs) <= Math.floor(Math.max(ups, downs) / 4)) ev.kind = 'zoom';
      }
    }
    events.push(ev);
    for (let k = start; k <= j; k++) used[k] = 1;
  }

  // 5. An end card reached by a slow fade: from an ordinary shot, a fade of more than about 0.5 s into a white card
  //    never makes a bright run (the 0.5 s baseline follows the ramp), so steps 1–4 read the fade as a gradual join, or
  //    find nothing there when the card's overlay animates in soon after (the local median of the change rises). Among
  //    the last three events, latest first, a gradual join (cross-fade or unclear) belongs to an end card when the card
  //    goes on (as in step 1) to the end of the span for more than 0.6 s from uniform frames at the white or black
  //    extreme that follow the join within 0.5 s (the join is the fade into it) or come right before it with no event
  //    before them (the join is its overlay animating in; the screen then starts with the YAVG ramp into those frames,
  //    `fadeStart`). Either way the join and any events after it inside the card are not joins.
  const extremeAt = (u: number) => (y[u]! >= M.flashWhiteMin ? 'white' : y[u]! <= M.flashBlackMax ? 'black' : null);
  const byTime = [...events].sort((a, b) => a.timeSec - b.timeSec);
  for (let j = byTime.length - 1; j >= Math.max(0, byTime.length - 3); j--) {
    const join = byTime[j]!;
    if (join.kind !== 'cross_fade' && join.kind !== 'unclear') continue;
    if (screenRuns.some((r) => r.from > join.to)) break;
    const inside = byTime.slice(j + 1);
    for (const ev of inside) for (let q = ev.from; q <= ev.to; q++) used[q] = 0;
    let screen: { from: number; kind: 'white' | 'black' } | null = null;
    for (let u = join.to + 1; u < n && u <= join.to + sec(M.screenEntrySec); u++) {
      if (used[u] || !uniformAt(u)) continue;
      const kind = extremeAt(u);
      if (kind && (n - u) / fps > M.screenMinSec) {
        let e = u;
        while (e + 1 < n && uniformAt(e + 1)) e++;
        if (cardEnd(e) === n - 1) screen = { from: join.from, kind };
      }
      break;
    }
    if (!screen) {
      for (let q = join.from; q <= join.to; q++) used[q] = 0;
      const u = join.from - 1;
      const kind = u > 0 && !used[u] && uniformAt(u) ? extremeAt(u) : null;
      if (kind && cardEnd(u) === n - 1) {
        let u0 = u;
        while (u0 - 1 >= 0 && !used[u0 - 1] && uniformAt(u0 - 1)) u0--;
        // Not when an earlier event runs into those frames (the fade into the card, found when its turn comes).
        if ((n - u0) / fps > M.screenMinSec && (u0 === 0 || !used[u0 - 1])) screen = { from: fadeStart(u0, kind), kind };
      }
      if (!screen) for (let q = join.from; q <= join.to; q++) used[q] = 1;
    }
    if (screen) {
      for (const ev of [join, ...inside]) events.splice(events.indexOf(ev), 1);
      screenRuns.push({ from: screen.from, entry: screen.from, to: n - 1, kind: screen.kind });
      for (let q = screen.from; q < n; q++) used[q] = 1;
      break;
    }
    for (const ev of inside) for (let q = ev.from; q <= ev.to; q++) used[q] = 1;
  }

  // Screens: only a screen at the very start or after the last join is a title or end screen, and the cut or fade into
  // it is not a join (measureReferenceStyle leaves an end screen out of every measurement; a title stays the first
  // shot). The cut (or fade) into a screen inside the video is a join, and the screen stays in the shots around it.
  for (const r of screenRuns) {
    const startT = frames[r.from]!.t;
    const endT = frames[r.to]!.t + dt;
    const later = events.some((e) => e.timeSec > endT - dt / 2);
    if (r.from <= sec(0.1) || !later) {
      screens.push([startT, endT]);
      continue;
    }
    const entryT = frames[r.entry]!.t;
    events.push(r.from === r.entry ? { kind: 'hard', timeSec: entryT, durationSec: 0, from: r.entry, to: r.entry } : { kind: r.kind === 'white' ? 'fade_white' : 'fade_black', timeSec: entryT, durationSec: (r.entry - r.from + 1) / fps, from: r.from, to: r.entry });
  }
  events.sort((a, b) => a.timeSec - b.timeSec);
  return { events, screens };
}

/** Zoom inside shots (design §4.3.1.3d): scale fit between 15 % and 85 % of each shot of at least 0.6 s. */
export function measureShotZooms(
  shots: Array<[number, number]>,
  grey: GreyFrames,
  signal?: AbortSignal,
): { checked: number; pushScales: number[]; pullScales: number[]; perShot: Array<{ startSec: number; endSec: number; scale: number | null; zoom: 'push' | 'pull' | null }> } {
  const out = { checked: 0, pushScales: [] as number[], pullScales: [] as number[], perShot: [] as Array<{ startSec: number; endSec: number; scale: number | null; zoom: 'push' | 'pull' | null }> };
  const w = grey.width;
  const h = grey.height;
  for (const [s, e] of shots) {
    if (e - s < M.zoomMinShotSec) continue;
    throwIfAborted(signal, 'Reference style');
    const a = s + 0.1;
    const b = e - 0.1;
    const at = (q: number) => frameAtTime(grey, a + q * (b - a));
    const f15 = at(0.15);
    const f50 = at(0.5);
    const f85 = at(0.85);
    const main = scaleFit(f15, f85, w, h);
    out.checked++;
    let zoom: 'push' | 'pull' | null = null;
    if (Math.abs(main.scale - 1) >= M.zoomMinChange && main.error <= M.zoomResidualRatio * main.errorAtOne && main.errorAtOne >= M.zoomMinTexture) {
      const first = scaleFit(f15, f50, w, h).scale;
      const second = scaleFit(f50, f85, w, h).scale;
      const dir = Math.sign(main.scale - 1);
      if (Math.sign(first - 1) === dir && Math.sign(second - 1) === dir) {
        zoom = dir > 0 ? 'push' : 'pull';
        (dir > 0 ? out.pushScales : out.pullScales).push(main.scale);
      }
    }
    out.perShot.push({ startSec: s, endSec: e, scale: main.scale, zoom });
  }
  return out;
}

// ---------------------------------------------------------------- the passes

export interface MeasureReferenceStyleOptions extends AnalysisToolOptions {
  probe: AssetProbe;
  /** From the reference's audio analysis at ingest (`analyseAudio`). */
  speechLikely: boolean;
  ffprobePath?: string;
  /** Progress callback with the owner-facing step ("Measuring transitions", "Measuring the beat"). */
  onProgress?: (fraction: number, message: string) => void;
}

/** What `measureReferenceStyle` returns: the stored signals plus in-memory details (for tests; never stored). */
export interface ReferenceStyleMeasurement {
  signals: ReferenceStyleSignals;
  details: {
    events: DetectedEvent[];
    screens: Array<[number, number]>;
    shots: Array<{ startSec: number; endSec: number; scale: number | null; zoom: 'push' | 'pull' | null }>;
    beatTimesSec: number[];
    bpm: number | null;
    tempoConfidence: number;
    audioOffsetSec: number;
    raw: RawReferenceStyle;
  };
}

async function streamStartTimes(input: string, ffprobePath: string, signal?: AbortSignal): Promise<{ video: number; audio: number | null }> {
  try {
    const { stdout } = await execa(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', input], { ...(signal ? { cancelSignal: signal } : {}), timeout: 60_000 });
    const streams = (JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; start_time?: string }> }).streams ?? [];
    const start = (type: string) => {
      const s = streams.find((x) => x.codec_type === type);
      const v = s?.start_time !== undefined ? Number(s.start_time) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    return { video: start('video') ?? 0, audio: start('audio') };
  } catch {
    throwIfAborted(signal, 'Reference style');
    return { video: 0, audio: null };
  }
}

/**
 * Measures transitions, beat sync, the drop, zooms and the music's tempo and energy shape on a reference proxy
 * (design §4.3.1.2). Honours the AbortSignal between passes and inside the frame loops. A failed audio pass leaves the
 * beat, drop and music unmeasured; a failed picture pass throws (the job retries while the originals still exist).
 */
export async function measureReferenceStyle(proxyPath: string, opts: MeasureReferenceStyleOptions): Promise<ReferenceStyleMeasurement> {
  const { probe, signal } = opts;
  if (!probe.video) throw new Error('Reference style: the file has no video stream');
  throwIfAborted(signal, 'Reference style');
  const tool = { ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}), ...(signal ? { signal } : {}) };
  const span = Math.min(probe.durationSec > 0 ? probe.durationSec : M.maxSpanSec, M.maxSpanSec);
  const portrait = probe.video.displayHeight >= probe.video.displayWidth;
  opts.onProgress?.(0.05, 'Measuring transitions');

  // Pass A.
  const small = portrait ? '144:256' : '256:144';
  const { stdout } = await runFfmpegCapture(
    ['-i', proxyPath, '-map', '0:v:0', '-an', '-t', span.toFixed(3), '-vf', `scale=${small}:flags=area,format=yuv420p,select='gte(scene\\,0)',signalstats,blurdetect=block_width=16:block_height=16:planes=1,metadata=mode=print:file=-`, '-f', 'null', '-'],
    { ...tool, loglevel: 'error' },
  );
  const frames = parseFrameScores(stdout);
  if (frames.length < 3) throw new Error('Reference style: no frames could be measured');
  throwIfAborted(signal, 'Reference style');
  const starts = await streamStartTimes(proxyPath, opts.ffprobePath ?? 'ffprobe', signal);
  const t0 = frames[0]!.t;
  for (const f of frames) f.t = Math.round((f.t - starts.video) * 1e6) / 1e6;
  const deltas = frames.slice(1).map((f, i) => f.t - frames[i]!.t).filter((d) => d > 0);
  const fps = deltas.length ? Math.min(120, 1 / medianOf(deltas)) : probe.video.fps;
  opts.onProgress?.(0.25, 'Measuring transitions');

  // Pass B.
  const gw = portrait ? M.gridWidth : M.gridHeight;
  const gh = portrait ? M.gridHeight : M.gridWidth;
  const buffer = await runFfmpegToBuffer(['-i', proxyPath, '-map', '0:v:0', '-an', '-t', span.toFixed(3), '-vf', `fps=${M.gridFps},scale=${gw}:${gh}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], tool);
  const size = gw * gh;
  const grey: GreyFrames = { width: gw, height: gh, fps: M.gridFps, t0: Math.round((t0 - starts.video) * 1e6) / 1e6, count: Math.floor(buffer.length / size), data: new Uint8Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / size) * size) };
  if (grey.count < 2) throw new Error('Reference style: no frames could be measured');
  throwIfAborted(signal, 'Reference style');

  const detected = detectJoins(frames, grey, fps, signal);
  const lastT = frames[frames.length - 1]!.t + 1 / fps;
  const fullSpan = Math.min(span, lastT);

  // End screen, left out of every measurement (shots, zooms, beat, drop, music): a white or black end screen found
  // after the last join that runs to the end of the span (design §4.3.1.3a), or else a dark part after the last
  // boundary, 1.5–5 s long. A screen that stops earlier is followed by a shot whose cut was not found, so nothing is
  // trimmed then.
  const lastJoin = Math.max(0, ...detected.events.map((e) => e.timeSec));
  const endScreen = detected.screens.find(([a, b]) => a > lastJoin && a > 0.1 && a < fullSpan && b >= fullSpan - 0.25);
  const boundaries = [0, ...detected.events.map((e) => e.timeSec), ...detected.screens.map((s) => s[0])].filter((t) => t < fullSpan);
  const lastBoundary = Math.max(...boundaries);
  const tail = fullSpan - lastBoundary;
  let measuredSec = fullSpan;
  let trimmed = 0;
  if (endScreen) {
    measuredSec = endScreen[0];
    trimmed = fullSpan - endScreen[0];
  } else if (tail >= M.endScreenMinSec && tail <= M.endScreenMaxSec) {
    const ys = frames.filter((f) => f.t >= lastBoundary + 1 / fps).map((f) => f.yavg);
    if (ys.length && ys.reduce((a, b) => a + b, 0) / ys.length <= M.endScreenMaxLuma) {
      measuredSec = lastBoundary;
      trimmed = tail;
    }
  }
  const events = detected.events.filter((e) => e.timeSec > 0 && e.timeSec < measuredSec - 1 / fps / 2);

  // Shots between v2 boundaries (gradual joins split at their edges) for the zoom check.
  const shotEdges: Array<[number, number]> = [];
  let cursor = 0;
  for (const e of events) {
    const startT = e.durationSec > 0 ? frames[e.from]!.t : e.timeSec;
    const endT = e.durationSec > 0 ? frames[e.to]!.t + 1 / fps : e.timeSec;
    if (startT > cursor) shotEdges.push([cursor, startT]);
    cursor = Math.max(cursor, endT);
  }
  if (measuredSec > cursor) shotEdges.push([cursor, measuredSec]);
  const zooms = measureShotZooms(shotEdges, grey, signal);
  opts.onProgress?.(0.6, 'Measuring the beat');

  // Pass C: the reference's own sound, measured only (never kept, used or sent anywhere).
  let audio: RawReferenceStyle['audio'] = null;
  let beatTimes: number[] = [];
  let bpm: number | null = null;
  let confidence = 0;
  const offset = starts.audio !== null ? starts.audio - starts.video : 0;
  if (probe.audio) {
    try {
      let pcm = await decodePcm(proxyPath, { ...tool, sampleRate: MUSIC_ANALYSIS_SAMPLE_RATE, channels: 1 });
      const keep = Math.min(pcm.length, Math.round(measuredSec * MUSIC_ANALYSIS_SAMPLE_RATE));
      pcm = pcm.subarray(0, keep);
      throwIfAborted(signal, 'Reference style');
      const beats = detectBeats(pcm, MUSIC_ANALYSIS_SAMPLE_RATE);
      bpm = beats.bpm;
      confidence = beats.confidence;
      beatTimes = beats.beatTimesSec.map((b) => Math.round((b + offset) * 1e4) / 1e4);
      audio = { bpm: beats.bpm, confidence: beats.confidence, beatTimesSec: beatTimes, energy: beats.energy, energyStepSec: beats.energyStepSec, speechLikely: opts.speechLikely };
    } catch (err) {
      throwIfAborted(signal, 'Reference style');
      if (err instanceof Error && err.name === 'CancelledError') throw err;
      // The sound could not be read: beat, drop and music stay unmeasured rather than guessed.
      audio = { bpm: null, confidence: 0, beatTimesSec: [], energy: [], energyStepSec: 0.25, speechLikely: opts.speechLikely };
    }
  }

  const raw: RawReferenceStyle = {
    fps,
    measuredSec,
    endScreenTrimmedSec: trimmed,
    joins: events.map(({ kind, timeSec, durationSec, direction, scale }) => ({ kind, timeSec, durationSec, ...(direction ? { direction } : {}), ...(scale ? { scale } : {}) })),
    zoomShots: { checked: zooms.checked, pushScales: zooms.pushScales, pullScales: zooms.pullScales },
    audio,
  };
  opts.onProgress?.(0.95, 'Measuring the beat');
  return {
    signals: assembleReferenceSignals(raw),
    details: { events, screens: detected.screens, shots: zooms.perShot, beatTimesSec: beatTimes, bpm, tempoConfidence: confidence, audioOffsetSec: offset, raw },
  };
}
