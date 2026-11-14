import type { LookMeasurement } from '@studio/core';
import { runFfmpegCapture } from '../ffmpeg.js';
import { throwIfAborted, type AnalysisToolOptions } from './common.js';

/** Options for {@link measureLook}. */
export interface MeasureLookOptions extends AnalysisToolOptions {
  /** Frames measured per second; default 2. */
  sampleFps?: number;
}

/** 8-bit chroma distance maximum (√(127² + 128²) ≈ 181), used to scale `SATAVG` to 0–1. */
export const SATURATION_FULL_SCALE = 181;

/** One frame's `signalstats` values. */
export interface SignalStatsFrame {
  yavg: number;
  ylow: number;
  yhigh: number;
  satavg: number;
}

/**
 * Parses the output of `signalstats,metadata=mode=print:file=-` into per-frame values. Frames missing any of the four
 * values are skipped.
 */
export function parseSignalStats(output: string): SignalStatsFrame[] {
  const frames: SignalStatsFrame[] = [];
  let current: Partial<SignalStatsFrame> | null = null;
  const flush = () => {
    if (current && current.yavg !== undefined && current.ylow !== undefined && current.yhigh !== undefined && current.satavg !== undefined) {
      frames.push(current as SignalStatsFrame);
    }
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('frame:')) {
      flush();
      current = {};
      continue;
    }
    const m = /^lavfi\.signalstats\.(YAVG|YLOW|YHIGH|SATAVG)=(-?[\d.]+)$/.exec(line);
    if (!m || !current) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    const key = m[1] === 'YAVG' ? 'yavg' : m[1] === 'YLOW' ? 'ylow' : m[1] === 'YHIGH' ? 'yhigh' : 'satavg';
    current[key] = value;
  }
  flush();
  return frames;
}

/**
 * Averages per-frame stats into a look measurement (each 0–1): mean luma `YAVG/255`, mean saturation
 * `SATAVG/181`, contrast `(YHIGH − YLOW)/255`. Null when there are no frames.
 */
export function summariseLook(frames: SignalStatsFrame[]): LookMeasurement | null {
  if (frames.length === 0) return null;
  const mean = (f: (s: SignalStatsFrame) => number) => frames.reduce((acc, s) => acc + f(s), 0) / frames.length;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    meanLuma: clamp(mean((s) => s.yavg) / 255),
    meanSaturation: clamp(mean((s) => s.satavg) / SATURATION_FULL_SCALE),
    contrast: clamp(mean((s) => s.yhigh - s.ylow) / 255),
  };
}

/**
 * Measures the overall look of a video (brightness, saturation, contrast) with FFmpeg's `signalstats` at a few frames
 * per second. Run it on the SDR proxy so HDR sources are measured after tone mapping. Throws when no frame could be
 * measured.
 */
export async function measureLook(input: string, opts: MeasureLookOptions = {}): Promise<LookMeasurement> {
  throwIfAborted(opts.signal, 'Look measurement');
  const fps = opts.sampleFps ?? 2;
  const { stdout } = await runFfmpegCapture(['-i', input, '-vf', `fps=${fps},scale=270:-2,signalstats,metadata=mode=print:file=-`, '-an', '-f', 'null', '-'], {
    ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    loglevel: 'error',
  });
  const look = summariseLook(parseSignalStats(stdout));
  if (!look) throw new Error('Look measurement: no frames could be measured');
  return look;
}
