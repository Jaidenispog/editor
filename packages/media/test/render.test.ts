import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, CancelledError, VERTICAL_1080, VERTICAL_PREVIEW, computeTimeline, safeZoneFor, type AssetProbe, type EditPlan, type SafeRect } from '@studio/core';
import { ffprobeRaw, probeMedia } from '../src/ffprobe.js';
import { runFfmpegToBuffer } from '../src/ffmpeg.js';
import { escapeFilterPath, layoutAssDocument, renderEditPlan, verifyExport, type RenderInputs, type RenderResult } from '../src/render/index.js';
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

/**
 * Pixels in `region` whose grey level differs by more than `threshold`. Two encodes of the same
 * footage differ by up to ~60 grey levels near sharp edges in the footage (the encoder spends bits
 * differently once text is in the frame); a text stroke differs from its background by far more
 * (white fill or black outline), so 64 separates the two. The libass-only test below is exact.
 */
function countChanged(a: Buffer, b: Buffer, width: number, region: SafeRect, threshold = 64): { changed: number; pixels: number } {
  let changed = 0;
  let pixels = 0;
  for (let y = region.top; y < region.bottom; y++) {
    for (let x = region.left; x < region.right; x++) {
      const i = y * width + x;
      pixels++;
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > threshold) changed++;
    }
  }
  return { changed, pixels };
}

/** Transcript that makes the safe-zone plan's caption valid. */
const SAFE_ZONE_TRANSCRIPTS = { [ASSET_IDS.a]: [{ startSec: 0.5, endSec: 3.0, text: 'clean skin fade today' }] };

/**
 * The sample plan plus a caption under the centre label, so top, centre, lower text and captions
 * all appear. The last segment is the flat opening scene of sample C: the moving checkerboard at the
 * end of sample A makes the encoder's noise there exceed any sensible threshold whether or not text
 * is present, which would hide what this test is looking for.
 */
function safeZonePlan(): EditPlan {
  const plan = samplePlan();
  plan.segments[3] = { ...plan.segments[3]!, assetId: ASSET_IDS.c, inSec: 0, outSec: 1.95 };
  plan.captions = [{ text: 'Clean skin fade today', startSec: 4.1, endSec: 5.9 }];
  return plan;
}

/**
 * Burns an ASS file over flat grey at the given size and returns a mask (1 = touched) of every
 * pixel any frame changed. Frames are read one second at a time to keep memory small.
 */
async function textMask(assPath: string, width: number, height: number, durationSec: number, fps: number): Promise<Uint8Array> {
  const source = ['-f', 'lavfi', '-i', `color=c=0x808080:s=${width}x${height}:r=${fps}:d=${durationSec.toFixed(3)}`];
  const background = await runFfmpegToBuffer([...source, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const mask = new Uint8Array(width * height);
  const frameBytes = width * height;
  for (let t = 0; t < durationSec; t += 1) {
    const chunk = await runFfmpegToBuffer([
      ...source,
      '-vf',
      `ass=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(FONTS_DIR)}`,
      '-ss',
      t.toFixed(3),
      '-t',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ]);
    for (let offset = 0; offset + frameBytes <= chunk.length; offset += frameBytes) {
      for (let i = 0; i < frameBytes; i++) {
        if (Math.abs((chunk[offset + i] ?? 0) - (background[i] ?? 0)) > 2) mask[i] = 1;
      }
    }
  }
  return mask;
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
    'exports speed-changed hard cuts (a beat montage) at the exact timeline length',
    async () => {
      // Beat-montage shape: eight hard cuts on 117 BPM beats (0.513 s = 15.39 frames), slowed and
      // sped-up shots, so no segment is a whole number of frames long. Rounding each segment on its
      // own ends the video almost three frames short of the plan (and off the music) and verifyExport
      // refuses it; the frame grid keeps it within half a frame.
      const plan = samplePlan();
      plan.styleId = 'beat_montage';
      plan.targetDurationSec = 6;
      plan.textOverlays = [];
      plan.segments = [
        { id: 's0', assetId: ASSET_IDS.a, inSec: 0.5, outSec: 0.828, speed: 0.64, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'cutting', keepOriginalSound: false },
        { id: 's1', assetId: ASSET_IDS.c, inSec: 0.5, outSec: 0.958, speed: 0.893, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'styling', keepOriginalSound: false },
        { id: 's2', assetId: ASSET_IDS.a, inSec: 3, outSec: 3.641, speed: 1.25, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'cutting', keepOriginalSound: false },
        { id: 's3', assetId: ASSET_IDS.c, inSec: 1.5, outSec: 3.809, speed: 1.5, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'styling', keepOriginalSound: false },
        { id: 's4', assetId: ASSET_IDS.c, inSec: 3.9, outSec: 4.358, speed: 0.893, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'styling', keepOriginalSound: false },
        { id: 's5', assetId: ASSET_IDS.a, inSec: 6, outSec: 6.985, speed: 0.64, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: { from: 1, to: 1.08 }, transitionIn: null, role: 'result', keepOriginalSound: false },
        { id: 's6', assetId: ASSET_IDS.a, inSec: 7.2, outSec: 7.841, speed: 1.25, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'result', keepOriginalSound: false },
        { id: 's7', assetId: ASSET_IDS.c, inSec: 4.5, outSec: 5.27, speed: 1.5, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'styling', keepOriginalSound: false },
      ];
      const total = computeTimeline(plan).totalDurationSec;
      const result = await renderEditPlan(inputs({ plan, quality: 'export' }), join(workDir, 'export-speed.mp4'));
      expect(result.exportCheck).toEqual({ ok: true, problems: [] });
      const counted = await execa('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', result.outputPath]);
      expect(Number(counted.stdout.trim())).toBe(Math.round(total * 30));
    },
    RENDER_TIMEOUT,
  );

  it(
    'renders a 1080x1920 export of the same plan',
    async () => {
      const result = await renderEditPlan(inputs({ quality: 'export' }), join(workDir, 'export.mp4'));
      const total = computeTimeline(samplePlan()).totalDurationSec;
      expect(result.probe.video).toMatchObject({ codec: 'h264', displayWidth: 1080, displayHeight: 1920, pixelFormat: 'yuv420p' });
      expect(result.probe.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
      expect(Math.abs(result.durationSec - total)).toBeLessThan(1 / 30 + 0.001);
      expect(result.ffmpegArgs).toEqual(expect.arrayContaining(['-preset', 'slow', '-crf', '18', '-level:v', '4.1', '-sc_threshold', '0', '-flags', '+cgop']));
      expect(result.exportCheck).toEqual({ ok: true, problems: [] });

      // The preset, read back from the file itself.
      const raw = await ffprobeRaw(result.outputPath);
      const video = raw.streams.find((s) => s.codec_type === 'video')!;
      const audio = raw.streams.find((s) => s.codec_type === 'audio')!;
      expect(video).toMatchObject({ codec_name: 'h264', profile: 'High', level: 41, pix_fmt: 'yuv420p', field_order: 'progressive', r_frame_rate: '30/1' });
      expect(video).toMatchObject({ color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' });
      expect(audio).toMatchObject({ codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2 });

      // Closed 2 s GOP: keyframes exactly every 60 frames, none on scene changes.
      const keyframes = await execa('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'json', result.outputPath]);
      const times = (JSON.parse(keyframes.stdout) as { frames: Array<{ pts_time: string }> }).frames.map((f) => Number(f.pts_time));
      expect(times.map((t) => Math.round(t * 1000) / 1000)).toEqual([0, 2, 4, 6, 8]);
      // A file whose properties do not match the preset is reported, not passed.
      const mismatch = await verifyExport(preview.outputPath, { width: 1080, height: 1920, fps: 30, level: '4.1', hasAudio: true, durationSec: total });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.problems.join('\n')).toMatch(/frame is 540x960, expected 1080x1920/);
    },
    RENDER_TIMEOUT,
  );

  it(
    'keeps burnt-in top, centre, lower text and captions out of every forbidden area of the rendered preview',
    async () => {
      const { width, height } = VERTICAL_PREVIEW;
      const zone = safeZoneFor(width, height);
      const plan = safeZonePlan();
      const withText = await renderEditPlan(inputs({ plan, transcripts: SAFE_ZONE_TRANSCRIPTS }), join(workDir, 'safe-zone-text.mp4'));
      const plain = safeZonePlan();
      plain.textOverlays = [];
      plain.captions = [];
      const withoutText = await renderEditPlan(inputs({ plan: plain, brand: { ...TEST_BRAND, socialHandle: '' } }), join(workDir, 'plain.mp4'));
      expect(withoutText.assPath).toBeNull();
      const layout = layoutAssDocument(plan, computeTimeline(plan), VERTICAL_PREVIEW, zone, TEST_BRAND, { headline: TEST_BRAND.fontHeadline, body: TEST_BRAND.fontBody });

      // 2.0 s: top headline (rise, settled) + lower accent headline (pop, settled).
      // 5.0 s: centre label + caption.   7.6 s: lower subtitle + brand handle at the top.
      const moments: Array<{ at: number; refs: string[] }> = [
        { at: 2.0, refs: ['t1', 't2'] },
        { at: 5.0, refs: ['t3', 'caption-0'] },
        { at: 7.6, refs: ['t4', 'handle'] },
      ];
      for (const { at, refs } of moments) {
        const [a, b] = await Promise.all([greyFrame(withText.outputPath, at), greyFrame(withoutText.outputPath, at)]);
        expect(a.length).toBe(width * height);
        expect(b.length).toBe(width * height);
        for (const area of zone.forbidden) {
          expect(countChanged(a, b, width, area.rect).changed, `${area.name} at ${at}s`).toBe(0);
        }
        for (const ref of refs) {
          const box = layout.boxes.find((x) => x.ref === ref)!;
          expect(box, ref).toBeDefined();
          const region = box.region === 'head' ? zone.head : zone.strict;
          expect(countChanged(a, b, width, box.box).changed, `${ref} at ${at}s`).toBeGreaterThan(100);
          expect(countChanged(a, b, width, region).changed).toBeGreaterThan(100);
        }
      }
    },
    RENDER_TIMEOUT,
  );

  it(
    'draws every frame of every animation inside the laid-out boxes, at preview and export sizes',
    async () => {
      // libass over flat grey (no video codec in the way), every frame of the edit: any pixel that
      // differs from the background is text, outline or shadow.
      const plan = safeZonePlan();
      plan.textOverlays.push(
        { id: 'pop-top', text: 'Sharp lines', startSec: 4.0, endSec: 6.0, placement: 'top', style: 'subtitle', animation: 'pop', emphasis: 'accent' },
        { id: 'rise-lower', text: 'Walk-ins welcome', startSec: 2.6, endSec: 3.8, placement: 'lower', style: 'label', animation: 'rise', emphasis: 'normal' },
      );
      const timeline = computeTimeline(plan);
      for (const output of [VERTICAL_PREVIEW, VERTICAL_1080]) {
        const zone = safeZoneFor(output.width, output.height);
        const layout = layoutAssDocument(plan, timeline, output, zone, TEST_BRAND, { headline: TEST_BRAND.fontHeadline, body: TEST_BRAND.fontBody });
        const assPath = join(workDir, `layout-${output.width}.ass`);
        await writeFile(assPath, layout.document, 'utf8');
        const mask = await textMask(assPath, output.width, output.height, timeline.totalDurationSec, output.fps);
        const touched = (r: SafeRect) => {
          let n = 0;
          for (let y = r.top; y < r.bottom; y++) for (let x = r.left; x < r.right; x++) n += mask[y * output.width + x] ?? 0;
          return n;
        };
        for (const area of zone.forbidden) {
          expect(touched(area.rect), `${area.name} at ${output.width}x${output.height}`).toBe(0);
        }
        for (const box of layout.boxes) {
          expect(touched(box.box), `${box.ref} at ${output.width}`).toBeGreaterThan(50);
        }
        // Nothing is drawn outside the boxes the layout computed, so those boxes are true upper bounds.
        const inBoxes = new Uint8Array(output.width * output.height);
        for (const { box } of layout.boxes) for (let y = box.top; y < box.bottom; y++) inBoxes.fill(1, y * output.width + box.left, y * output.width + box.right);
        let outside = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i] && !inBoxes[i]) outside++;
        expect(outside, `pixels outside the layout boxes at ${output.width}`).toBe(0);
      }
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
      // Wrapped to the 480 px (240 px in the preview) caption width, so lines may break with \N.
      expect(captionLines[0]!.replace(/^.*\}/, '').split('\\N').join(' ')).toBe('Clean skin fade today');
      expect(captionLines[1]!.replace(/^.*\}/, '').split('\\N').join(' ')).toBe('See you next time mate');
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
