import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CancelledError, type AssetProbe, type Shot, type ShotQuality } from '@studio/core';
import { probeMedia } from '../src/ffprobe.js';
import { ensureSamples, hasFfmpeg, SAMPLE_FILES, samplePath as sample } from './analysis-fixtures.js';
import {
  assembleShots,
  chooseFrameTimes,
  detectScenes,
  extractFrames,
  fitSize,
  issuesFromQuality,
  makeProxy,
  makeThumbnail,
  measureQuality,
  normaliseShotSpans,
  parseShowinfoTimes,
  qualityFromMeasurements,
  spansFromCuts,
  type FrameMeasurement,
} from '../src/analysis/index.js';

async function lavfiClip(outputPath: string, source: string, videoFilter: string | null): Promise<AssetProbe> {
  await execa('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', source,
    ...(videoFilter ? ['-vf', videoFilter] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
  return probeMedia(outputPath);
}

const ffmpegAvailable = await hasFfmpeg();
if (!ffmpegAvailable) console.warn('ffmpeg/ffprobe not found on PATH: skipping the media analysis tests that need them.');

describe.skipIf(!ffmpegAvailable)('footage analysis with FFmpeg', () => {
  let workDir: string;
  const probes: Record<string, AssetProbe> = {};

  beforeAll(async () => {
    await ensureSamples();
    workDir = await mkdtemp(path.join(os.tmpdir(), 'sa-analysis-'));
    for (const name of SAMPLE_FILES) probes[name] = await probeMedia(sample(name));
  }, 300_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('makes an upright, tone-mapped SDR proxy of the rotated HEVC HLG clip', async () => {
    const probe = probes['sample_b_rotated_hevc_hlg.mov']!;
    expect(probe.video?.isHdr).toBe(true);
    expect(probe.video?.rotation).not.toBe(0);
    const out = path.join(workDir, 'proxy_b.mp4');
    const progress: number[] = [];
    const result = await makeProxy(sample('sample_b_rotated_hevc_hlg.mov'), out, { probe, onProgress: (f) => progress.push(f) });
    expect(result.height).toBeLessThanOrEqual(960);
    expect(result.height % 2).toBe(0);
    expect(result.width % 2).toBe(0);
    expect(result.width).toBeLessThan(result.height);
    expect(result.durationSec).toBeCloseTo(probe.durationSec, 0);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= progress[i - 1]!))).toBe(true);

    const written = await probeMedia(out);
    expect(written.video?.codec).toBe('h264');
    expect(written.video?.pixelFormat).toBe('yuv420p');
    expect(written.video?.displayWidth).toBe(540);
    expect(written.video?.displayHeight).toBe(960);
    expect(written.video?.rotation).toBe(0);
    expect(written.video?.colour.transfer).toBe('bt709');
    expect(written.video?.colour.primaries).toBe('bt709');
    expect(written.video?.isHdr).toBe(false);
    expect(written.video?.fps).toBe(30);
    expect(written.audio?.codec).toBe('aac');
    expect(written.audio?.sampleRate).toBe(48000);
  }, 90_000);

  it('makes a proxy without an audio track when the source has no audio', async () => {
    const probe = probes['sample_c_noaudio_scenes.mp4']!;
    const out = path.join(workDir, 'proxy_c.mp4');
    const result = await makeProxy(sample('sample_c_noaudio_scenes.mp4'), out, { probe });
    expect(result).toMatchObject({ width: 540, height: 960 });
    const written = await probeMedia(out);
    expect(written.audio).toBeNull();
    expect(written.video?.codec).toBe('h264');
  }, 60_000);

  it('stops the proxy encode when the signal is aborted', async () => {
    const probe = probes['sample_a_portrait_sdr.mp4']!;
    const controller = new AbortController();
    const out = path.join(workDir, 'proxy_cancelled.mp4');
    const pending = makeProxy(sample('sample_a_portrait_sdr.mp4'), out, { probe, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  }, 30_000);

  it('writes a portrait JPEG thumbnail from the HDR clip', async () => {
    const probe = probes['sample_b_rotated_hevc_hlg.mov']!;
    const out = path.join(workDir, 'thumb.jpg');
    const result = await makeThumbnail(sample('sample_b_rotated_hevc_hlg.mov'), out, { probe, timeSec: 3 });
    expect(result).toEqual({ width: 540, height: 960, timeSec: 3 });
    const written = await probeMedia(out);
    expect(written.video?.codec).toBe('mjpeg');
    expect(written.video?.displayWidth).toBe(540);
    expect(written.video?.displayHeight).toBe(960);
    expect((await stat(out)).size).toBeGreaterThan(5000);
  }, 30_000);

  it('extracts portrait frames no larger than 768 px on the long edge', async () => {
    const probe = probes['sample_b_rotated_hevc_hlg.mov']!;
    const frames = await extractFrames(sample('sample_b_rotated_hevc_hlg.mov'), [1, 5], path.join(workDir, 'frames'), { probe });
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.timeSec)).toEqual([1, 5]);
    for (const frame of frames) {
      expect(frame.path.endsWith('.jpg')).toBe(true);
      expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(768);
      expect(frame.height).toBeGreaterThan(frame.width);
      const written = await probeMedia(frame.path);
      expect(written.video?.codec).toBe('mjpeg');
      expect(written.video?.displayWidth).toBe(frame.width);
      expect(written.video?.displayHeight).toBe(frame.height);
    }
    expect(frames[0]!.path).not.toBe(frames[1]!.path);
  }, 30_000);

  it('finds the hard cuts in the three-scene clip and covers the whole duration', async () => {
    const probe = probes['sample_c_noaudio_scenes.mp4']!;
    const shots = await detectScenes(sample('sample_c_noaudio_scenes.mp4'), { probe });
    expect(shots.length).toBeGreaterThanOrEqual(3);
    expect(shots[0]!.startSec).toBe(0);
    expect(shots[shots.length - 1]!.endSec).toBeCloseTo(probe.durationSec, 3);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.startSec).toBeCloseTo(shots[i - 1]!.endSec, 6);
    const boundaries = shots.slice(1).map((s) => s.startSec);
    expect(boundaries.some((b) => Math.abs(b - 2) <= 0.25)).toBe(true);
    expect(boundaries.some((b) => Math.abs(b - 4) <= 0.25)).toBe(true);
  }, 30_000);

  it('returns one shot for a clip shorter than the minimum shot length', async () => {
    const probe = probes['sample_d_tiny.mp4']!;
    const shots = await detectScenes(sample('sample_d_tiny.mp4'), { probe });
    expect(shots).toEqual([{ startSec: 0, endSec: probe.durationSec }]);
  }, 30_000);

  it('scores blurred footage well below sharp footage and flags dark footage', async () => {
    const sharpPath = path.join(workDir, 'sharp.mp4');
    const blurredPath = path.join(workDir, 'blurred.mp4');
    const darkPath = path.join(workDir, 'dark.mp4');
    const source = 'testsrc2=size=320x568:rate=30:duration=3';
    const sharpProbe = await lavfiClip(sharpPath, source, null);
    const blurredProbe = await lavfiClip(blurredPath, source, 'gblur=sigma=6');
    const darkProbe = await lavfiClip(darkPath, source, 'eq=brightness=-0.45');
    const span = [{ startSec: 0, endSec: 3 }];
    const [sharp] = await measureQuality(sharpPath, span, { probe: sharpProbe });
    const [blurred] = await measureQuality(blurredPath, span, { probe: blurredProbe });
    const [dark] = await measureQuality(darkPath, span, { probe: darkProbe });
    expect(sharp && blurred && dark).toBeTruthy();
    expect(blurred!.sharpness).toBeLessThan(0.5 * sharp!.sharpness);
    expect(sharp!.exposureIssue).toBe('none');
    expect(sharp!.score).toBeGreaterThan(blurred!.score);
    expect(dark!.exposureIssue).toBe('dark');
    expect(dark!.brightness).toBeLessThan(0.18);
    expect(issuesFromQuality(dark!)).toContain('Underexposed');
    expect(issuesFromQuality(blurred!)).toContain('Soft focus');
    for (const q of [sharp!, blurred!, dark!]) {
      for (const key of ['sharpness', 'brightness', 'motion', 'contrast', 'score'] as const) {
        expect(q[key]).toBeGreaterThanOrEqual(0);
        expect(q[key]).toBeLessThanOrEqual(1);
      }
    }
  }, 60_000);

  it('measures one quality record per shot, in order, for the HDR clip', async () => {
    const probe = probes['sample_b_rotated_hevc_hlg.mov']!;
    const shots = [
      { startSec: 0, endSec: 4 },
      { startSec: 4, endSec: 7.5 },
      { startSec: 7.5, endSec: 10 },
    ];
    const qualities = await measureQuality(sample('sample_b_rotated_hevc_hlg.mov'), shots, { probe });
    expect(qualities).toHaveLength(3);
    for (const q of qualities) {
      expect(q.exposureIssue).toBe('none');
      expect(q.sharpness).toBeGreaterThan(0.3);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Pure helpers (no FFmpeg needed).
// ---------------------------------------------------------------------------------------------
describe('scene span maths', () => {
  it('parses pts_time values out of showinfo output', () => {
    const stderr = [
      '[Parsed_showinfo_2 @ 0x1] config in time_base: 1/15360, frame_rate: 30/1',
      'frame=    0 fps=0.0 q=-0.0 size=       0kB time=00:00:02.00 bitrate=   0.0kbits/s speed=  20x    [Parsed_showinfo_2 @ 0x1] n:   0 pts:  30720 pts_time:2       duration:    512 fmt:yuv420p s:320x568',
      '[Parsed_showinfo_2 @ 0x1] color_range:tv color_space:unknown',
      '[Parsed_showinfo_2 @ 0x1] n:   1 pts:  61440 pts_time:4.0333  duration:    512 fmt:yuv420p s:320x568',
    ].join('\n');
    expect(parseShowinfoTimes(stderr)).toEqual([2, 4.033]);
  });

  it('builds contiguous spans from cut times', () => {
    expect(spansFromCuts([4, 2, 2, 12], 10)).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 2, endSec: 4 },
      { startSec: 4, endSec: 10 },
    ]);
  });

  it('merges short spans into neighbours and splits long ones into equal chunks', () => {
    const spans = normaliseShotSpans(
      [
        { startSec: 0, endSec: 0.3 },
        { startSec: 0.3, endSec: 2 },
        { startSec: 2, endSec: 2.5 },
        { startSec: 2.5, endSec: 14.5 },
      ],
      { minShotSec: 0.8, maxShotSec: 5 },
    );
    expect(spans[0]!.startSec).toBe(0);
    expect(spans[spans.length - 1]!.endSec).toBe(14.5);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.startSec).toBe(spans[i - 1]!.endSec);
    for (const s of spans) expect(s.endSec - s.startSec).toBeLessThanOrEqual(5.0001);
    // The 12 s span becomes three 4 s chunks; the two short spans were absorbed.
    expect(spans.filter((s) => Math.abs(s.endSec - s.startSec - 4) < 0.01)).toHaveLength(3);
    expect(spans.every((s) => s.endSec - s.startSec >= 0.8)).toBe(true);
  });

  it('keeps a lone short span and drops empty input', () => {
    expect(normaliseShotSpans([{ startSec: 0, endSec: 0.5 }], { minShotSec: 0.8, maxShotSec: 5 })).toEqual([{ startSec: 0, endSec: 0.5 }]);
    expect(normaliseShotSpans([], { minShotSec: 0.8, maxShotSec: 5 })).toEqual([]);
  });
});

describe('sizing', () => {
  it('fits sizes with even dimensions and never upscales', () => {
    expect(fitSize({ width: 1080, height: 1920 }, { maxHeight: 960 })).toEqual({ width: 540, height: 960 });
    expect(fitSize({ width: 1920, height: 1080 }, { maxHeight: 960 })).toEqual({ width: 1706, height: 960 });
    expect(fitSize({ width: 1080, height: 1920 }, { maxLongEdge: 768 })).toEqual({ width: 432, height: 768 });
    expect(fitSize({ width: 1080, height: 1920 }, { width: 540 })).toEqual({ width: 540, height: 960 });
    expect(fitSize({ width: 320, height: 568 }, { width: 540 })).toEqual({ width: 320, height: 568 });
    expect(fitSize({ width: 640, height: 480 }, { maxHeight: 960 })).toEqual({ width: 640, height: 480 });
  });
});

describe('quality scoring', () => {
  const frame = (overrides: Partial<FrameMeasurement>): FrameMeasurement => ({
    timeSec: 0,
    laplacianVariance: 400,
    meanLuma: 120,
    lumaStd: 60,
    diffFromPrevious: null,
    ...overrides,
  });

  it('flags exposure problems and penalises heavy motion', () => {
    expect(qualityFromMeasurements([frame({ meanLuma: 20 })], []).exposureIssue).toBe('dark');
    expect(qualityFromMeasurements([frame({ meanLuma: 230 })], []).exposureIssue).toBe('bright');
    expect(qualityFromMeasurements([frame({ lumaStd: 4 })], []).exposureIssue).toBe('flat');
    const steady = qualityFromMeasurements([frame({}), frame({})], [5]);
    const shaky = qualityFromMeasurements([frame({}), frame({})], [45]);
    expect(steady.exposureIssue).toBe('none');
    expect(shaky.motion).toBeGreaterThan(0.6);
    expect(shaky.score).toBeLessThan(steady.score);
    expect(qualityFromMeasurements([], []).score).toBe(0);
  });
});

describe('shot assembly', () => {
  const quality = (overrides: Partial<ShotQuality> = {}): ShotQuality => ({
    sharpness: 0.8,
    brightness: 0.5,
    motion: 0.2,
    contrast: 0.6,
    exposureIssue: 'none',
    score: 0.8,
    ...overrides,
  });

  it('builds unlabelled shots with derived issues', () => {
    const assetId = '0192abcd-ef01-7000-8000-000000000001';
    const shots = assembleShots(
      assetId,
      [
        { startSec: 0, endSec: 2 },
        { startSec: 2, endSec: 5 },
      ],
      [quality(), quality({ sharpness: 0.1, exposureIssue: 'bright', motion: 0.9, score: 0.2 })],
    );
    expect(shots.map((s) => s.id)).toEqual(['0192abcd-s0', '0192abcd-s1']);
    expect(shots[0]).toMatchObject({ assetId, startSec: 0, endSec: 2, label: 'unknown', labelSource: 'heuristic', confidence: 0, framing: 'unknown', focus: null, issues: [], description: '' });
    expect(shots[1]!.issues).toEqual(['Soft focus', 'Overexposed', 'Heavy camera movement']);
    expect(() => assembleShots(assetId, [{ startSec: 0, endSec: 1 }], [])).toThrow(/scenes/);
  });

  it('chooses midpoints, preferring better shots while keeping temporal spread', () => {
    const shots: Shot[] = assembleShots(
      'asset-1',
      Array.from({ length: 8 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 })),
      [0.2, 0.9, 0.3, 0.1, 0.95, 0.4, 0.5, 0.6].map((score) => quality({ score })),
    );
    expect(chooseFrameTimes(shots, { maxFrames: 10 }).map((f) => f.timeSec)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    const picked = chooseFrameTimes(shots, { maxFrames: 4 });
    expect(picked).toHaveLength(4);
    // One pick per quarter of the clip, the best-scoring shot of each quarter.
    expect(picked.map((f) => f.shotId)).toEqual(['asset-1-s1', 'asset-1-s2', 'asset-1-s4', 'asset-1-s7']);
    expect(picked.map((f) => f.timeSec)).toEqual([3, 5, 9, 15]);
    expect(chooseFrameTimes(shots, { maxFrames: 0 })).toEqual([]);
    expect(chooseFrameTimes([], { maxFrames: 3 })).toEqual([]);
  });
});
