import type { AssetProbe } from '@studio/core';
import { runFfmpegCapture } from '../ffmpeg.js';
import { throwIfAborted, type AnalysisToolOptions } from './common.js';

export interface SceneSpan {
  startSec: number;
  endSec: number;
}

export interface DetectScenesOptions extends AnalysisToolOptions {
  probe: AssetProbe;
  /** FFmpeg scene-change score (0–1) above which a cut is declared; default 0.3. */
  threshold?: number;
  /** Shots shorter than this are merged into a neighbour; default 0.8 s. */
  minShotSec?: number;
  /** Shots longer than this are split into equal chunks; default 5 s. */
  maxShotSec?: number;
}

/** Width of the downscaled stream used for scene detection (detail is irrelevant, speed is not). */
const SCENE_DETECTION_WIDTH = 320;

/**
 * Finds hard cuts with FFmpeg's scene score on a downscaled stream and turns them into shot spans that
 * cover [0, duration] exactly: shots shorter than `minShotSec` are merged into neighbours and shots
 * longer than `maxShotSec` are split into equal chunks. Returns an empty array for a zero-length clip.
 */
export async function detectScenes(inputPath: string, options: DetectScenesOptions): Promise<SceneSpan[]> {
  const { probe, signal } = options;
  throwIfAborted(signal, 'Scene detection');
  if (!probe.video) throw new Error('Scene detection: the file has no video stream');
  const threshold = options.threshold ?? 0.3;
  const minShotSec = options.minShotSec ?? 0.8;
  const maxShotSec = options.maxShotSec ?? 5;
  const durationSec = probe.durationSec;
  if (durationSec <= 0) return [];

  const { stderr } = await runFfmpegCapture(
    [
      '-i', inputPath,
      '-map', '0:v:0',
      '-vf', `scale=${SCENE_DETECTION_WIDTH}:-2,select='gt(scene,${threshold})',showinfo`,
      '-an',
      '-f', 'null',
      '-',
    ],
    {
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(signal ? { signal } : {}),
      loglevel: 'info',
    },
  );
  throwIfAborted(signal, 'Scene detection');
  const cuts = parseShowinfoTimes(stderr).filter((t) => t > 0 && t < durationSec);
  return normaliseShotSpans(spansFromCuts(cuts, durationSec), { minShotSec, maxShotSec });
}

/** Extracts the `pts_time` of every frame the showinfo filter reported (sorted, de-duplicated). */
export function parseShowinfoTimes(stderr: string): number[] {
  const times = new Set<number>();
  const pattern = /Parsed_showinfo_\d+ @ [^\]]*\]\s+n:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?\d+(?:\.\d+)?)/g;
  for (const match of stderr.matchAll(pattern)) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) times.add(Math.round(t * 1000) / 1000);
  }
  return [...times].sort((a, b) => a - b);
}

/** Turns cut times into contiguous spans covering [0, durationSec]. */
export function spansFromCuts(cutTimesSec: number[], durationSec: number): SceneSpan[] {
  const spans: SceneSpan[] = [];
  let start = 0;
  for (const cut of [...cutTimesSec].sort((a, b) => a - b)) {
    if (cut <= start || cut >= durationSec) continue;
    spans.push({ startSec: start, endSec: cut });
    start = cut;
  }
  spans.push({ startSec: start, endSec: durationSec });
  return spans;
}

/**
 * Merges spans shorter than `minShotSec` into their shorter neighbour and splits spans longer than
 * `maxShotSec` into equal chunks, keeping the spans contiguous. A lone span shorter than the minimum
 * (a very short clip) is returned as is.
 */
export function normaliseShotSpans(input: SceneSpan[], limits: { minShotSec: number; maxShotSec: number }): SceneSpan[] {
  const spans = input.map((s) => ({ startSec: s.startSec, endSec: s.endSec })).filter((s) => s.endSec > s.startSec);
  if (spans.length === 0) return [];

  // Merge short spans, shortest first, until every span meets the minimum or only one is left.
  for (;;) {
    if (spans.length < 2) break;
    let shortest = -1;
    let shortestLen = Number.POSITIVE_INFINITY;
    spans.forEach((s, i) => {
      const len = s.endSec - s.startSec;
      if (len < limits.minShotSec && len < shortestLen) {
        shortest = i;
        shortestLen = len;
      }
    });
    if (shortest < 0) break;
    const prev = spans[shortest - 1];
    const next = spans[shortest + 1];
    const victim = spans[shortest]!;
    const mergeIntoPrev = prev !== undefined && (next === undefined || prev.endSec - prev.startSec <= next.endSec - next.startSec);
    if (mergeIntoPrev && prev) {
      prev.endSec = victim.endSec;
    } else if (next) {
      next.startSec = victim.startSec;
    }
    spans.splice(shortest, 1);
  }

  // Split long spans into equal chunks.
  const out: SceneSpan[] = [];
  for (const span of spans) {
    const len = span.endSec - span.startSec;
    if (len <= limits.maxShotSec) {
      out.push(span);
      continue;
    }
    const pieces = Math.ceil(len / limits.maxShotSec);
    for (let k = 0; k < pieces; k++) {
      const startSec = k === 0 ? span.startSec : round3(span.startSec + (len * k) / pieces);
      const endSec = k === pieces - 1 ? span.endSec : round3(span.startSec + (len * (k + 1)) / pieces);
      out.push({ startSec, endSec });
    }
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
