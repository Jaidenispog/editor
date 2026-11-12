import type { AssetProbe, ShotQuality } from '@studio/core';
import { runFfmpegToBuffer } from '../ffmpeg.js';
import { displaySize, evenRound, throwIfAborted, tonemapChain, type AnalysisToolOptions } from './common.js';
import type { SceneSpan } from './scenes.js';

export interface MeasureQualityOptions extends AnalysisToolOptions {
  probe: AssetProbe;
  /** Frames analysed per second of footage; default 2. */
  sampleFps?: number;
  /** Width of the grey analysis frames; default 160 (height follows the display aspect, even). */
  width?: number;
}

/**
 * Normalisation constants for the raw per-frame measurements (8-bit grey frames, 160 px wide).
 * Calibrated on synthetic clips: a sharp `testsrc2` pattern reaches full sharpness while a `gblur=sigma=6`
 * copy of it drops below half; `eq=brightness=-0.45` flags 'dark'; a flat colour card flags 'flat'.
 */
export const QUALITY_CALIBRATION = {
  /** Laplacian variance that counts as fully sharp (sharpness = sqrt(variance / this), clamped). */
  sharpnessFullScale: 400,
  /** Luma standard deviation (0–255) that counts as full contrast. */
  contrastFullScale: 64,
  /** Mean absolute inter-frame difference (0–255, at the sample rate) that counts as maximal motion. */
  motionFullScale: 48,
  /** Mean luma (0–1) below which a frame is underexposed. */
  darkBelow: 0.18,
  /** Mean luma (0–1) above which a frame is overexposed. */
  brightAbove: 0.8,
  /** Normalised contrast below which a correctly exposed frame is 'flat'. */
  flatBelow: 0.15,
  /** Motion (0–1) above which the motion term starts to be penalised. */
  heavyMotionFrom: 0.4,
  /** Motion (0–1) below which a shot is considered static (slightly less lively than moderate motion). */
  staticBelow: 0.05,
} as const;

/** Weights of the usability score (sum to 1). */
export const QUALITY_WEIGHTS = { sharpness: 0.45, exposure: 0.25, contrast: 0.15, motion: 0.15 } as const;

/** Raw measurements of one grey frame. */
export interface FrameMeasurement {
  timeSec: number;
  /** Variance of the 3x3 Laplacian response (0–255 scale), higher = sharper. */
  laplacianVariance: number;
  /** Mean luma 0–255. */
  meanLuma: number;
  /** Luma standard deviation 0–255. */
  lumaStd: number;
  /** Mean absolute difference to the previous sampled frame (0–255), or null for the first frame. */
  diffFromPrevious: number | null;
}

/** Measures sharpness, brightness and contrast of one 8-bit grey frame (row-major, width × height). */
export function measureGreyFrame(frame: Uint8Array, width: number, height: number): Pick<FrameMeasurement, 'laplacianVariance' | 'meanLuma' | 'lumaStd'> {
  const n = width * height;
  if (frame.length < n || n === 0) throw new Error('measureGreyFrame: frame buffer is smaller than width × height');
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = frame[i]!;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);

  // 3x3 Laplacian (0 1 0 / 1 -4 1 / 0 1 0) over interior pixels.
  let lapSum = 0;
  let lapSumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = 4 * frame[i]! - frame[i - 1]! - frame[i + 1]! - frame[i - width]! - frame[i + width]!;
      lapSum += lap;
      lapSumSq += lap * lap;
      count++;
    }
  }
  const lapMean = count > 0 ? lapSum / count : 0;
  const laplacianVariance = count > 0 ? Math.max(0, lapSumSq / count - lapMean * lapMean) : 0;
  return { laplacianVariance, meanLuma: mean, lumaStd: Math.sqrt(variance) };
}

/** Mean absolute pixel difference between two grey frames of the same size (0–255). */
export function meanAbsoluteDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Combines the frame measurements of one shot into its normalised ShotQuality. `motionDiffs` are the
 * inter-frame differences between consecutive frames that both lie inside the shot.
 */
export function qualityFromMeasurements(frames: FrameMeasurement[], motionDiffs: number[]): ShotQuality {
  const c = QUALITY_CALIBRATION;
  if (frames.length === 0) {
    return { sharpness: 0, brightness: 0, motion: 0, contrast: 0, exposureIssue: 'dark', score: 0 };
  }
  const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
  const sharpness = clamp01(Math.sqrt(mean(frames.map((f) => f.laplacianVariance)) / c.sharpnessFullScale));
  const brightness = clamp01(mean(frames.map((f) => f.meanLuma)) / 255);
  const contrast = clamp01(mean(frames.map((f) => f.lumaStd)) / c.contrastFullScale);
  const motion = motionDiffs.length > 0 ? clamp01(mean(motionDiffs) / c.motionFullScale) : 0;

  let exposureIssue: ShotQuality['exposureIssue'] = 'none';
  if (brightness < c.darkBelow) exposureIssue = 'dark';
  else if (brightness > c.brightAbove) exposureIssue = 'bright';
  else if (contrast < c.flatBelow) exposureIssue = 'flat';

  const exposureScore = exposureIssue === 'none' ? 1 : exposureIssue === 'flat' ? 0.5 : 0.15;
  let motionScore: number;
  if (motion < c.staticBelow) motionScore = 0.7;
  else if (motion <= c.heavyMotionFrom) motionScore = 1;
  else motionScore = clamp01(1 - (motion - c.heavyMotionFrom) / (1 - c.heavyMotionFrom));

  const score = clamp01(
    QUALITY_WEIGHTS.sharpness * sharpness +
      QUALITY_WEIGHTS.exposure * exposureScore +
      QUALITY_WEIGHTS.contrast * contrast +
      QUALITY_WEIGHTS.motion * motionScore,
  );
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    sharpness: round(sharpness),
    brightness: round(brightness),
    motion: round(motion),
    contrast: round(contrast),
    exposureIssue,
    score: round(score),
  };
}

/** Size of the grey analysis frames for a probed file: `width` wide, height from the display aspect, both even. */
export function analysisFrameSize(probe: AssetProbe, width: number): { width: number; height: number } {
  const display = displaySize(probe, 'Quality analysis');
  const w = evenRound(width);
  return { width: w, height: evenRound((w * display.height) / display.width) };
}

/**
 * Decodes the clip once as small grey frames (`sampleFps` per second) and measures each shot: Laplacian
 * variance → sharpness, mean luma → brightness, luma spread → contrast, inter-frame difference → motion,
 * all normalised to 0–1 with QUALITY_CALIBRATION, plus an exposure flag and a weighted usability score.
 * Frames are assigned to shots by timestamp; a shot too short to contain a sampled frame uses the frame
 * nearest its midpoint. HDR sources are tone-mapped first so brightness is comparable to SDR footage.
 */
export async function measureQuality(inputPath: string, shots: SceneSpan[], options: MeasureQualityOptions): Promise<ShotQuality[]> {
  const { probe, signal } = options;
  throwIfAborted(signal, 'Quality analysis');
  if (shots.length === 0) return [];
  const sampleFps = options.sampleFps ?? 2;
  const size = analysisFrameSize(probe, options.width ?? 160);

  const filters: string[] = [`fps=${sampleFps}`, `scale=${size.width}:${size.height}:flags=bicubic`];
  const tonemap = tonemapChain(probe);
  if (tonemap) filters.push(tonemap);
  filters.push('format=gray');
  const buffer = await runFfmpegToBuffer(
    ['-i', inputPath, '-map', '0:v:0', '-vf', filters.join(','), '-an', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    {
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(signal ? { signal } : {}),
    },
  );
  throwIfAborted(signal, 'Quality analysis');

  const frameBytes = size.width * size.height;
  if (buffer.length % frameBytes !== 0) {
    throw new Error(`Quality analysis: decoded ${buffer.length} bytes, not a whole number of ${size.width}x${size.height} frames`);
  }
  const frameCount = buffer.length / frameBytes;
  const measurements: FrameMeasurement[] = [];
  let previous: Uint8Array | null = null;
  for (let i = 0; i < frameCount; i++) {
    const frame = new Uint8Array(buffer.buffer, buffer.byteOffset + i * frameBytes, frameBytes);
    const m = measureGreyFrame(frame, size.width, size.height);
    measurements.push({
      timeSec: i / sampleFps,
      ...m,
      diffFromPrevious: previous ? meanAbsoluteDifference(frame, previous) : null,
    });
    previous = frame;
  }
  return shots.map((shot) => qualityForShot(shot, measurements));
}

/** Picks the frames of one shot (by timestamp, nearest-to-midpoint fallback) and scores them. */
export function qualityForShot(shot: SceneSpan, measurements: FrameMeasurement[]): ShotQuality {
  const inside: FrameMeasurement[] = [];
  const motionDiffs: number[] = [];
  let previousInside = false;
  for (const m of measurements) {
    const isInside = m.timeSec >= shot.startSec && m.timeSec < shot.endSec;
    if (isInside) {
      inside.push(m);
      if (previousInside && m.diffFromPrevious !== null) motionDiffs.push(m.diffFromPrevious);
    }
    previousInside = isInside;
  }
  if (inside.length === 0 && measurements.length > 0) {
    const mid = (shot.startSec + shot.endSec) / 2;
    let nearest = measurements[0]!;
    for (const m of measurements) {
      if (Math.abs(m.timeSec - mid) < Math.abs(nearest.timeSec - mid)) nearest = m;
    }
    inside.push(nearest);
  }
  return qualityFromMeasurements(inside, motionDiffs);
}
