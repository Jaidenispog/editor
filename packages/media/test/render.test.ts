import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, CancelledError, VERTICAL_PREVIEW, VERTICAL_SAFE_ZONE_1080x1920, computeTimeline, scaleSafeZone, type AssetProbe } from '@studio/core';
import { probeMedia } from '../src/ffprobe.js';
import { runFfmpegToBuffer } from '../src/ffmpeg.js';
import { renderEditPlan, type RenderInputs, type RenderResult } from '../src/render/index.js';
import { ASSET_IDS, FONTS_DIR, MUSIC_TRACK_ID, SAMPLE_FILES, TEST_BRAND, samplePlan, shortPlan } from './render-fixtures.js';

const RENDER_TIMEOUT = 240_000;

let workDir: string;
let assets: RenderInputs['assets'];
let musicProbe: AssetProbe;
let preview: RenderResult;
const previewProgress: number[] = [];

function inputs(overrides: Partial<RenderInputs> = {}): RenderInputs {
  return {
    plan: samplePlan(),
    assets,
    music: { path: SAMPLE_FILES.music, durationSec: musicProbe.durationSec, trackId: MUSIC_TRACK_ID },
    quality: 'preview',
    brand: TEST_BRAND,
    fontsDir: FONTS_DIR,
    tmpDir: join(workDir, 'tmp'),
    ...overrides,
  };
}

/** One frame at `timeSec` as 8-bit grey, W*H bytes. */
async function greyFrame(path: string, timeSec: number): Promise<Buffer> {
  return runFfmpegToBuffer(['-ss', timeSec.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
}

function countChanged(a: Buffer, b: Buffer, width: number, region: { x0: number; x1: number; y0: number; y1: number }, threshold = 40): { changed: number; pixels: number } {
  let changed = 0;
  let pixels = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const i = y * width + x;
      pixels++;
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > threshold) changed++;
    }
  }
  return { changed, pixels };
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'studio-render-'));
  const [a, b, c, music] = await Promise.all([probeMedia(SAMPLE_FILES.a), probeMedia(SAMPLE_FILES.b), probeMedia(SAMPLE_FILES.c), probeMedia(SAMPLE_FILES.music)]);
  expect(b.video?.isHdr).toBe(true);
  expect(b.video?.rotation).toBe(90);
  expect(c.audio).toBeNull();
  assets = {
    [ASSET_IDS.a]: { path: SAMPLE_FILES.a, probe: a },
    [ASSET_IDS.b]: { path: SAMPLE_FILES.b, probe: b },
    [ASSET_IDS.c]: { path: SAMPLE_FILES.c, probe: c },
  };
  musicProbe = music;
  preview = await renderEditPlan(inputs({ onProgress: (f) => previewProgress.push(f) }), join(workDir, 'preview.mp4'));
}, RENDER_TIMEOUT);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('renderEditPlan with real footage', () => {
  it('renders a 540x960 H.264/AAC preview whose length matches the timeline', async () => {
    const expected = computeTimeline(samplePlan()).totalDurationSec;
    expect(expected).toBeCloseTo(8.6, 3);
    expect(existsSync(preview.outputPath)).toBe(true);
    expect(preview.byteSize).toBeGreaterThan(10_000);
    expect(preview.probe.video).toMatchObject({ codec: 'h264', displayWidth: 540, displayHeight: 960, pixelFormat: 'yuv420p', isHdr: false });
    expect(preview.probe.video?.colour.transfer).toBe('bt709');
    expect(preview.probe.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(Math.abs(preview.durationSec - expected)).toBeLessThan(0.15);
    expect(preview.ffmpegArgs).toContain('-filter_complex');
    expect(preview.assPath).not.toBeNull();
    expect(existsSync(preview.assPath!)).toBe(true);
    expect(previewProgress.length).toBeGreaterThan(0);
    expect(previewProgress.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect(previewProgress.at(-1)).toBe(1);
  });

  it(
    'renders a 1080x1920 export of the same plan',
    async () => {
      const result = await renderEditPlan(inputs({ quality: 'export' }), join(workDir, 'export.mp4'));
      expect(result.probe.video).toMatchObject({ codec: 'h264', displayWidth: 1080, displayHeight: 1920, pixelFormat: 'yuv420p' });
      expect(result.probe.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
      expect(Math.abs(result.durationSec - computeTimeline(samplePlan()).totalDurationSec)).toBeLessThan(0.15);
      expect(result.ffmpegArgs).toEqual(expect.arrayContaining(['-preset', 'slow', '-crf', '18']));
    },
    RENDER_TIMEOUT,
  );

  it(
    'keeps burnt-in text inside the safe area and out of the platform margins',
    async () => {
      const plain = samplePlan();
      plain.textOverlays = [];
      const withoutText = await renderEditPlan(inputs({ plan: plain, brand: { ...TEST_BRAND, socialHandle: '' } }), join(workDir, 'plain.mp4'));
      expect(withoutText.assPath).toBeNull();

      // At 2.0 s the top headline (rise, settled) and the lower accent headline (pop, settled) are both on screen.
      const { width, height } = VERTICAL_PREVIEW;
      const [withText, noText] = await Promise.all([greyFrame(preview.outputPath, 2.0), greyFrame(withoutText.outputPath, 2.0)]);
      expect(withText.length).toBe(width * height);
      expect(noText.length).toBe(width * height);

      const zone = scaleSafeZone(VERTICAL_SAFE_ZONE_1080x1920, width, height);
      const safe = countChanged(withText, noText, width, { x0: zone.left, x1: width - zone.right, y0: zone.top, y1: height - zone.bottom });
      const bottomBand = countChanged(withText, noText, width, { x0: 0, x1: width, y0: height - zone.bottom, y1: height });
      const topBand = countChanged(withText, noText, width, { x0: 0, x1: width, y0: 0, y1: zone.top });
      const rightRail = countChanged(withText, noText, width, { x0: width - zone.right, x1: width, y0: zone.top, y1: height - zone.bottom });
      const leftGutter = countChanged(withText, noText, width, { x0: 0, x1: zone.left, y0: zone.top, y1: height - zone.bottom });

      expect(safe.changed).toBeGreaterThan(400);
      expect(bottomBand.changed).toBeLessThan(bottomBand.pixels * 0.005);
      expect(topBand.changed).toBeLessThan(topBand.pixels * 0.005);
      expect(rightRail.changed).toBeLessThan(rightRail.pixels * 0.005);
      expect(leftGutter.changed).toBeLessThan(leftGutter.pixels * 0.005);
    },
    RENDER_TIMEOUT,
  );

  it(
    'burns captions that come from the transcript',
    async () => {
      const plan = shortPlan();
      plan.captions = [
        { text: 'Clean skin fade today', startSec: 0.3, endSec: 1.8 },
        { text: 'See you next time mate', startSec: 2.2, endSec: 3.8 },
      ];
      const transcripts = {
        [ASSET_IDS.a]: [
          { startSec: 0.5, endSec: 2.5, text: 'clean skin fade today' },
          { startSec: 8, endSec: 9.5, text: 'see you next time mate' },
        ],
      };
      const result = await renderEditPlan(inputs({ plan, transcripts }), join(workDir, 'captions.mp4'));
      expect(Math.abs(result.durationSec - 4)).toBeLessThan(0.15);
      expect(result.assPath).not.toBeNull();
      const ass = await readFile(result.assPath!, 'utf8');
      const captionLines = ass.split('\n').filter((l) => l.startsWith('Dialogue:') && l.includes(',Caption,'));
      expect(captionLines).toHaveLength(2);
      expect(captionLines[0]).toContain('Clean skin fade today');
      expect(captionLines[1]).toContain('See you next time mate');
      expect(ass).toMatch(/^Style: Caption,Inter,/m);

      // Without a transcript the same captions are refused before FFmpeg runs.
      await expect(renderEditPlan(inputs({ plan }), join(workDir, 'captions-invalid.mp4'))).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(existsSync(join(workDir, 'captions-invalid.mp4'))).toBe(false);
    },
    RENDER_TIMEOUT,
  );

  it(
    'renders a transition that follows a hard cut',
    async () => {
      // concat's output timebase differs from the segment chains'; xfade refuses mismatched inputs unless it is reset.
      const plan = samplePlan();
      plan.segments = [
        { ...plan.segments[0]!, transitionIn: null },
        { ...plan.segments[1]!, transitionIn: null },
        { ...plan.segments[2]!, transitionIn: { type: 'dissolve', durationSec: 0.4 } },
        { ...plan.segments[3]!, transitionIn: null },
      ];
      plan.textOverlays = [];
      const expected = computeTimeline(plan).totalDurationSec;
      const result = await renderEditPlan(inputs({ plan, brand: { ...TEST_BRAND, socialHandle: '' } }), join(workDir, 'cut-then-transition.mp4'));
      expect(result.ffmpegArgs.join(' ')).toMatch(/concat=n=2:v=1:a=0,settb=1\/30\[x_1\];\[x_1\]\[v_2\]xfade=transition=dissolve/);
      expect(result.probe.video).toMatchObject({ codec: 'h264', displayWidth: 540, displayHeight: 960 });
      expect(Math.abs(result.durationSec - expected)).toBeLessThan(0.15);
    },
    RENDER_TIMEOUT,
  );

  it(
    'renders a silent edit with no audio stream at all',
    async () => {
      const plan = samplePlan();
      plan.targetDurationSec = 6;
      plan.segments = [{ ...plan.segments[2]!, transitionIn: null, inSec: 0.5, outSec: 4.5 }];
      plan.textOverlays = [];
      plan.audio.music = null;
      plan.audio.originalSound = { enabled: false, volume: 1 };
      const result = await renderEditPlan(inputs({ plan, music: null, brand: { ...TEST_BRAND, socialHandle: '' } }), join(workDir, 'silent.mp4'));
      expect(result.probe.audio).toBeNull();
      expect(result.probe.video?.displayWidth).toBe(540);
      expect(Math.abs(result.durationSec - 4)).toBeLessThan(0.15);
      expect(result.ffmpegArgs).toContain('-an');
      expect(result.assPath).toBeNull();
    },
    RENDER_TIMEOUT,
  );

  it(
    'stops promptly when cancelled and leaves no partial file behind',
    async () => {
      const controller = new AbortController();
      const outputPath = join(workDir, 'cancelled.mp4');
      const started = Date.now();
      setTimeout(() => controller.abort(), 400);
      await expect(renderEditPlan(inputs({ signal: controller.signal }), outputPath)).rejects.toBeInstanceOf(CancelledError);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(existsSync(outputPath)).toBe(false);

      const already = new AbortController();
      already.abort();
      await expect(renderEditPlan(inputs({ signal: already.signal }), outputPath)).rejects.toBeInstanceOf(CancelledError);
    },
    RENDER_TIMEOUT,
  );

  it('refuses a plan that no longer fits the footage before touching FFmpeg', async () => {
    const plan = samplePlan();
    plan.segments[1]!.outSec = 30;
    const err = await renderEditPlan(inputs({ plan }), join(workDir, 'invalid.mp4')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VALIDATION');
    expect(JSON.stringify((err as AppError).details)).toContain('OUT_OF_BOUNDS');
    expect(existsSync(join(workDir, 'invalid.mp4'))).toBe(false);
  });
});
