import { stat } from 'node:fs/promises';
import { CancelledError, type AssetProbe } from '@studio/core';

/** Options shared by every FFmpeg-backed analysis step. */
export interface AnalysisToolOptions {
  /** Path to the ffmpeg binary; defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Aborting the signal kills the running FFmpeg process and rejects with CancelledError. */
  signal?: AbortSignal;
}

export interface PixelSize {
  width: number;
  height: number;
}

/** Throws CancelledError when the signal has already been aborted (checked between processing steps). */
export function throwIfAborted(signal: AbortSignal | undefined, step: string): void {
  if (signal?.aborted) throw new CancelledError(`${step} cancelled`);
}

/** Nearest even integer, never below 2 (video encoders and 4:2:0 chroma need even dimensions). */
export function evenRound(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Largest even integer not above n, never below 2. */
export function evenFloor(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** The displayed (post-rotation) picture size of a probed file, or an explicit error when it has no video. */
export function displaySize(probe: AssetProbe, step: string): PixelSize {
  if (!probe.video) throw new Error(`${step}: the file has no video stream`);
  return { width: probe.video.displayWidth, height: probe.video.displayHeight };
}

/**
 * Fits a picture into the given limits, keeping its aspect ratio and even dimensions. Never upscales.
 * `maxHeight` caps the height, `maxLongEdge` caps the longer side and `width` requests a fixed width.
 */
export function fitSize(source: PixelSize, limits: { maxHeight?: number; maxLongEdge?: number; width?: number }): PixelSize {
  const aspect = source.width / source.height;
  let width = source.width;
  let height = source.height;
  if (limits.width !== undefined && limits.width > 0) {
    width = Math.min(limits.width, source.width);
    height = width / aspect;
  }
  if (limits.maxHeight !== undefined && height > limits.maxHeight) {
    height = limits.maxHeight;
    width = height * aspect;
  }
  if (limits.maxLongEdge !== undefined) {
    const longEdge = Math.max(width, height);
    if (longEdge > limits.maxLongEdge) {
      const factor = limits.maxLongEdge / longEdge;
      width *= factor;
      height *= factor;
    }
  }
  return { width: evenRound(width), height: evenRound(height) };
}

/**
 * HDR (HLG or PQ) → SDR BT.709 conversion for the FFmpeg filtergraph, or null for SDR sources.
 * Linearises with zscale, tone-maps with the Hable curve, then re-encodes to BT.709 limited range.
 * Verified on 10-bit HLG HEVC footage with FFmpeg 6.1 (zimg + tonemap filters).
 */
export function tonemapChain(probe: AssetProbe): string | null {
  if (!probe.video?.isHdr) return null;
  return 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
}

/** Clamps a requested time into the playable range of the file (slightly before the end so a frame exists). */
export function clampTime(timeSec: number, durationSec: number): number {
  const latest = Math.max(0, durationSec - 0.05);
  if (!Number.isFinite(timeSec)) return 0;
  return Math.min(Math.max(0, timeSec), latest);
}

/** Formats seconds for FFmpeg arguments (millisecond precision, no exponent notation). */
export function formatSecondsArg(sec: number): string {
  return (Math.round(sec * 1000) / 1000).toFixed(3);
}

/** Throws a plain error when FFmpeg finished without producing the expected file. */
export async function assertFileWritten(filePath: string, step: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (info.size === 0) throw new Error('empty');
  } catch {
    throw new Error(`${step}: no output was produced for ${filePath}`);
  }
}
