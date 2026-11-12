import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import type { AssetProbe } from '@studio/core';
import { runFfmpeg } from '../ffmpeg.js';
import { probeMedia } from '../ffprobe.js';
import {
  assertFileWritten,
  clampTime,
  displaySize,
  fitSize,
  formatSecondsArg,
  throwIfAborted,
  tonemapChain,
  type AnalysisToolOptions,
} from './common.js';

export interface MakeProxyOptions extends AnalysisToolOptions {
  /** Probe of `inputPath` (rotation, HDR and audio facts drive the command line). */
  probe: AssetProbe;
  /** Longest allowed height; the default 960 gives 540x960 for portrait phone footage. */
  maxHeight?: number;
  /** Path to ffprobe, used to read back the finished proxy; defaults to `ffprobe` on PATH. */
  ffprobePath?: string;
  /** Called with 0..1 as the encode advances. */
  onProgress?: (fraction: number) => void;
}

export interface ProxyResult {
  width: number;
  height: number;
  durationSec: number;
}

/** Highest frame rate kept in proxies; faster sources are resampled so previews stay light. */
export const PROXY_MAX_FPS = 60;

/**
 * Transcodes a source clip into the working proxy: auto-rotated upright (FFmpeg's default display-matrix
 * handling, so no `-noautorotate`), tone-mapped to SDR BT.709 when the source is HDR, scaled to at most
 * `maxHeight` with even dimensions, H.264 (veryfast, CRF 26, high profile, yuv420p, 2 s keyframes,
 * faststart) with AAC 96 kbps 48 kHz audio when the source has audio and no audio track otherwise.
 * Returns the real size and duration of the written file.
 */
export async function makeProxy(inputPath: string, outputPath: string, options: MakeProxyOptions): Promise<ProxyResult> {
  const { probe, signal } = options;
  throwIfAborted(signal, 'Proxy');
  if (!probe.video) throw new Error('Proxy: the file has no video stream');
  const maxHeight = options.maxHeight ?? 960;
  const size = fitSize(displaySize(probe, 'Proxy'), { maxHeight });
  const fps = Math.min(probe.video.fps, PROXY_MAX_FPS);
  const keyframeInterval = Math.max(1, Math.round(fps * 2));

  const filters: string[] = [`fps=${fps}`, `scale=${size.width}:${size.height}:flags=bicubic`, 'setsar=1'];
  const tonemap = tonemapChain(probe);
  if (tonemap) filters.push(tonemap);
  filters.push('format=yuv420p');

  const audioArgs = probe.audio
    ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', ...(probe.audio.channels > 2 ? ['-ac', '2'] : [])]
    : ['-an'];

  const args = [
    '-i', inputPath,
    '-map', '0:v:0',
    '-map_metadata', '-1',
    '-vf', filters.join(','),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-g', String(keyframeInterval),
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-movflags', '+faststart',
    ...audioArgs,
    '-f', 'mp4',
    outputPath,
  ];

  const duration = probe.durationSec;
  await runFfmpeg(args, {
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(signal ? { signal } : {}),
    ...(options.onProgress
      ? {
          onProgress: (p) => {
            if (duration > 0) options.onProgress?.(Math.min(1, Math.max(0, p.outTimeSec / duration)));
          },
        }
      : {}),
  });
  throwIfAborted(signal, 'Proxy');
  await assertFileWritten(outputPath, 'Proxy');
  const written = await probeMedia(outputPath, options.ffprobePath);
  if (!written.video) throw new Error('Proxy: the written file has no video stream');
  options.onProgress?.(1);
  return { width: written.video.displayWidth, height: written.video.displayHeight, durationSec: written.durationSec };
}

export interface MakeThumbnailOptions extends AnalysisToolOptions {
  probe: AssetProbe;
  /** Time of the frame to grab; clamped into the clip. */
  timeSec: number;
  /** Output width (height follows the aspect ratio); default 540. Never upscales. */
  width?: number;
}

/** Writes one JPEG (quality 3) at `timeSec`, auto-rotated and tone-mapped exactly like the proxy. */
export async function makeThumbnail(inputPath: string, outputPath: string, options: MakeThumbnailOptions): Promise<{ width: number; height: number; timeSec: number }> {
  const { probe, signal } = options;
  throwIfAborted(signal, 'Thumbnail');
  const size = fitSize(displaySize(probe, 'Thumbnail'), { width: options.width ?? 540 });
  const timeSec = clampTime(options.timeSec, probe.durationSec);
  await grabJpeg(inputPath, outputPath, timeSec, size, probe, options);
  return { width: size.width, height: size.height, timeSec };
}

export interface ExtractFramesOptions extends AnalysisToolOptions {
  probe: AssetProbe;
  /** Longest side of the written JPEGs; default 768 (sized for the vision model). Never upscales. */
  longEdge?: number;
}

export interface ExtractedFrame {
  timeSec: number;
  path: string;
  width: number;
  height: number;
}

/** How many single-frame FFmpeg processes run at once while extracting frames. */
const FRAME_EXTRACTION_CONCURRENCY = 2;

/**
 * Writes one JPEG per requested time into `outDir` (named `frame_<ms>.jpg`), each tone-mapped and
 * auto-rotated like the proxy and no larger than `longEdge` on its longest side. Uses accurate seeking
 * (`-ss` before `-i`) with one process per time, so the same inputs always yield the same frames.
 * Results are returned in the order the times were given.
 */
export async function extractFrames(inputPath: string, timesSec: number[], outDir: string, options: ExtractFramesOptions): Promise<ExtractedFrame[]> {
  const { probe, signal } = options;
  throwIfAborted(signal, 'Frame extraction');
  const size = fitSize(displaySize(probe, 'Frame extraction'), { maxLongEdge: options.longEdge ?? 768 });
  await mkdir(outDir, { recursive: true });
  const limit = pLimit(FRAME_EXTRACTION_CONCURRENCY);
  const jobs = timesSec.map((requested) =>
    limit(async (): Promise<ExtractedFrame> => {
      throwIfAborted(signal, 'Frame extraction');
      const timeSec = clampTime(requested, probe.durationSec);
      const filePath = path.join(outDir, `frame_${String(Math.round(timeSec * 1000)).padStart(8, '0')}.jpg`);
      await grabJpeg(inputPath, filePath, timeSec, size, probe, options);
      return { timeSec, path: filePath, width: size.width, height: size.height };
    }),
  );
  return Promise.all(jobs);
}

async function grabJpeg(
  inputPath: string,
  outputPath: string,
  timeSec: number,
  size: { width: number; height: number },
  probe: AssetProbe,
  options: AnalysisToolOptions,
): Promise<void> {
  const filters: string[] = [`scale=${size.width}:${size.height}:flags=lanczos`, 'setsar=1'];
  const tonemap = tonemapChain(probe);
  if (tonemap) filters.push(tonemap);
  filters.push('format=yuvj420p');
  const args = [
    '-ss', formatSecondsArg(timeSec),
    '-i', inputPath,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', filters.join(','),
    '-q:v', '3',
    '-f', 'image2',
    outputPath,
  ];
  await runFfmpeg(args, {
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await assertFileWritten(outputPath, 'Frame extraction');
}
