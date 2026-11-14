import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERTICAL_1080, VERTICAL_PREVIEW, computeTimeline, rectContains, safeZoneFor, type EditPlan, type OutputFormat, type SafeRect } from '@studio/core';
import { probeMedia } from '../src/ffprobe.js';
import { runFfmpeg, runFfmpegToBuffer } from '../src/ffmpeg.js';
import {
  buildLogoFilters,
  buildRenderCommand,
  checkOverlayRects,
  cornerEnableExpression,
  fitInside,
  layoutAssDocument,
  layoutLogo,
  logoRects,
  renderEditPlan,
  resolveRenderFont,
  type AssTextBox,
  type RenderBrand,
  type RenderInputs,
  type RenderLogo,
} from '../src/render/index.js';
import { ASSET_IDS, FONTS_DIR, MUSIC_TRACK_ID, SAMPLE_FILES, TEST_BRAND, fakeProbe, samplePlan } from './render-fixtures.js';

const RENDER_TIMEOUT = 240_000;
const logo = (overrides: Partial<RenderLogo> = {}): RenderLogo => ({ path: '/tmp/logo.png', width: 300, height: 200, placement: 'both', corner: 'top_left', opacity: 0.85, ...overrides });
const box = (overrides: Partial<AssTextBox>): AssTextBox => ({
  kind: 'overlay',
  ref: 'x',
  region: 'strict',
  box: { left: 200, top: 900, right: 700, bottom: 1000 },
  fontSize: 60,
  lines: ['x'],
  startSec: 0,
  endSec: 1,
  anchor: 'bottom',
  ...overrides,
});

describe('logo geometry', () => {
  it('keeps both logo rectangles inside R_head and away from every forbidden area at 1080x1920 and 540x960', () => {
    for (const output of [VERTICAL_1080, VERTICAL_PREVIEW]) {
      const zone = safeZoneFor(output.width, output.height);
      for (const corner of ['top_left', 'top_right'] as const) {
        for (const [w, h] of [
          [300, 200],
          [100, 400],
          [2000, 50],
          [512, 512],
        ] as const) {
          const layout = layoutLogo(logo({ corner, width: w, height: h }), output, zone, 10, []);
          expect(layout.corner).not.toBeNull();
          expect(layout.endCard).not.toBeNull();
          const rects = logoRects(layout);
          expect(checkOverlayRects(rects, zone)).toEqual({ ok: true, problems: [] });
          for (const r of rects) {
            expect(rectContains(zone.head, r)).toBe(true);
            for (const v of [r.left, r.top, r.right, r.bottom]) expect(v % 2).toBe(0);
          }
        }
      }
    }
  });

  it('matches the design numbers at 1080x1920', () => {
    const zone = safeZoneFor(1080, 1920);
    const left = layoutLogo(logo({ width: 300, height: 300 }), VERTICAL_1080, zone, 10, []);
    expect(left.corner!.rect).toEqual({ left: 132, top: 282, right: 282, bottom: 432 });
    const right = layoutLogo(logo({ width: 300, height: 300, corner: 'top_right' }), VERTICAL_1080, zone, 10, []);
    expect(right.corner!.rect).toEqual({ left: 798, top: 282, right: 948, bottom: 432 });
    expect(left.endCard!.rect).toEqual({ left: 390, top: 380, right: 690, bottom: 680 });
    expect(left.endCard!.startSec).toBeCloseTo(8, 6);
    // A short edit shows the end card for 30 % of its length.
    expect(layoutLogo(logo(), VERTICAL_1080, zone, 4, []).endCard!.startSec).toBeCloseTo(2.8, 6);
    expect(fitInside(300, 200, 150, 150)).toEqual({ width: 150, height: 100 });
  });

  it('hides the corner mark while top text, a top handle or text over the mark is on screen, and during the end card', () => {
    const zone = safeZoneFor(1080, 1920);
    const boxes = [
      box({ anchor: 'top', startSec: 0.4, endSec: 2.4, box: { left: 150, top: 300, right: 900, bottom: 400 } }),
      box({ kind: 'handle', ref: 'handle', anchor: 'top', startSec: 7.5, endSec: 10 }),
      box({ anchor: 'bottom', startSec: 3, endSec: 4 }),
      box({ anchor: 'centre', startSec: 5, endSec: 6, box: { left: 130, top: 290, right: 300, bottom: 450 } }),
    ];
    const layout = layoutLogo(logo({ placement: 'corner' }), VERTICAL_1080, zone, 10, boxes);
    expect(layout.endCard).toBeNull();
    expect(layout.corner!.hiddenWindows).toEqual([
      [0.4, 2.4],
      [5, 6],
      [7.5, 10],
    ]);
    expect(cornerEnableExpression(layout.corner!.hiddenWindows)).toBe('not(between(t,0.4,2.4)+between(t,5,6)+between(t,7.5,10))');
    expect(cornerEnableExpression([])).toBeNull();
    const both = layoutLogo(logo({ placement: 'both' }), VERTICAL_1080, zone, 10, []);
    expect(both.corner!.hiddenWindows).toEqual([[8, 10]]);
  });

  it('skips the end card when top or centre text overlaps its window, keeping the corner mark with "both"', () => {
    const zone = safeZoneFor(1080, 1920);
    const centre = [box({ anchor: 'centre', startSec: 8.5, endSec: 9.5 })];
    const both = layoutLogo(logo({ placement: 'both' }), VERTICAL_1080, zone, 10, centre);
    expect(both.endCard).toBeNull();
    expect(both.corner).not.toBeNull();
    expect(both.corner!.hiddenWindows).toEqual([]);
    const only = layoutLogo(logo({ placement: 'end_card' }), VERTICAL_1080, zone, 10, [box({ anchor: 'top', startSec: 9, endSec: 10 })]);
    expect(only).toEqual({ corner: null, endCard: null });
    // Lower text below the card does not block it.
    expect(layoutLogo(logo({ placement: 'end_card' }), VERTICAL_1080, zone, 10, [box({ anchor: 'bottom', startSec: 8, endSec: 10 })]).endCard).not.toBeNull();
  });

  it('puts the overlay chain before the ass filter in the render command', () => {
    const zone = safeZoneFor(540, 960);
    const plan = samplePlan();
    const total = computeTimeline(plan).totalDurationSec;
    const brand: RenderBrand = { ...TEST_BRAND, logo: logo() };
    const inputs: RenderInputs = {
      plan,
      assets: {
        [ASSET_IDS.a]: { path: SAMPLE_FILES.a, probe: fakeProbe({ durationSec: 12, hasAudio: true }) },
        [ASSET_IDS.b]: { path: SAMPLE_FILES.b, probe: fakeProbe({ durationSec: 10, hasAudio: true, hdr: true, rotated: true }) },
        [ASSET_IDS.c]: { path: SAMPLE_FILES.c, probe: fakeProbe({ durationSec: 6, hasAudio: false }) },
      },
      music: { path: SAMPLE_FILES.music, durationSec: 40, trackId: MUSIC_TRACK_ID },
      quality: 'preview',
      brand,
      fontsDir: FONTS_DIR,
      tmpDir: '/tmp/studio-render-tests',
    };
    const layout = layoutLogo(brand.logo!, VERTICAL_PREVIEW, zone, total, []);
    const command = buildRenderCommand(inputs, '/tmp/out.mp4', '/tmp/overlay.ass', layout);
    const logoIndex = command.args.indexOf('/tmp/logo.png');
    expect(command.args.slice(logoIndex - 7, logoIndex + 1)).toEqual(['-loop', '1', '-framerate', '30', '-t', expect.any(String), '-i', '/tmp/logo.png']);
    // Inputs: four segments, the music, then the logo at index 5.
    expect(command.filterComplex).toContain('[5:v]format=rgba,split=2[lgsrc0][lgsrc1]');
    const overlayAt = command.filterComplex.indexOf('overlay=');
    const assAt = command.filterComplex.indexOf('ass=filename');
    expect(overlayAt).toBeGreaterThan(0);
    expect(assAt).toBeGreaterThan(overlayAt);
    expect(command.filterComplex).toContain('[vlogo]ass=');
    // Without a layout nothing changes.
    expect(buildRenderCommand(inputs, '/tmp/out.mp4', null).filterComplex).not.toContain('overlay=');
  });

  it('resolves fonts that are not bundled to Inter', async () => {
    const fallbacks: string[] = [];
    expect(await resolveRenderFont('Inter Display', FONTS_DIR)).toBe('Inter Display');
    expect(await resolveRenderFont('Inter', FONTS_DIR)).toBe('Inter');
    expect(await resolveRenderFont('DejaVu Sans', FONTS_DIR, (n) => fallbacks.push(n))).toBe('Inter');
    expect(await resolveRenderFont('Liberation Sans', FONTS_DIR, (n) => fallbacks.push(n))).toBe('Inter');
    expect(fallbacks).toEqual(['DejaVu Sans', 'Liberation Sans']);
  });
});

const haveSamples = existsSync(SAMPLE_FILES.c) && existsSync(SAMPLE_FILES.music);

describe.skipIf(!haveSamples)('logo pixels', () => {
  let dir: string;
  let logoPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-logo-'));
    logoPath = join(dir, 'logo.png');
    // An opaque white 300×200 logo: far brighter than the mid-grey background or the synthetic footage.
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=300x200:d=1', '-frames:v', '1', logoPath]);
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Pixels (grey level) any frame of the logo chain over flat grey changed, as a mask. */
  async function logoMask(output: OutputFormat, totalSec: number, layout: ReturnType<typeof layoutLogo>): Promise<{ mask: Uint8Array; atEnd: Uint8Array; atStart: Uint8Array }> {
    const filters = buildLogoFilters(layout, 1, '0:v', 'out').join(';');
    const raw = await runFfmpegToBuffer([
      '-f',
      'lavfi',
      '-i',
      `color=c=0x808080:s=${output.width}x${output.height}:r=${output.fps}:d=${totalSec}`,
      '-loop',
      '1',
      '-framerate',
      String(output.fps),
      '-t',
      String(totalSec),
      '-i',
      logoPath,
      '-filter_complex',
      `${filters};[out]format=gray[g]`,
      '-map',
      '[g]',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ]);
    const frameBytes = output.width * output.height;
    const frames = Math.floor(raw.length / frameBytes);
    expect(frames).toBeGreaterThanOrEqual(Math.floor(totalSec * output.fps) - 1);
    const mask = new Uint8Array(frameBytes);
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < frameBytes; i++) if (Math.abs((raw[f * frameBytes + i] ?? 128) - 128) > 2) mask[i] = 1;
    }
    const frameAt = (t: number) => {
      const f = Math.min(frames - 1, Math.round(t * output.fps));
      const m = new Uint8Array(frameBytes);
      for (let i = 0; i < frameBytes; i++) if (Math.abs((raw[f * frameBytes + i] ?? 128) - 128) > 2) m[i] = 1;
      return m;
    };
    return { mask, atStart: frameAt(1), atEnd: frameAt(totalSec - 0.3) };
  }

  const countIn = (mask: Uint8Array, width: number, r: SafeRect) => {
    let n = 0;
    for (let y = r.top; y < r.bottom; y++) for (let x = r.left; x < r.right; x++) n += mask[y * width + x] ?? 0;
    return n;
  };

  it('draws logo pixels only inside the expected rectangles, at preview and export sizes', async () => {
    for (const base of [VERTICAL_PREVIEW, VERTICAL_1080]) {
      const output = { ...base, fps: 10 };
      const zone = safeZoneFor(output.width, output.height);
      for (const corner of ['top_left', 'top_right'] as const) {
        const layout = layoutLogo({ path: logoPath, width: 300, height: 200, placement: 'both', corner, opacity: 0.85 }, output, zone, 4, []);
        const { mask, atStart, atEnd } = await logoMask(output, 4, layout);
        const rects = logoRects(layout);
        const inside = new Uint8Array(output.width * output.height);
        for (const r of rects) for (let y = r.top; y < r.bottom; y++) inside.fill(1, y * output.width + r.left, y * output.width + r.right);
        let outside = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i] && !inside[i]) outside++;
        expect(outside, `pixels outside the logo rectangles at ${output.width} (${corner})`).toBe(0);
        for (const area of zone.forbidden) expect(countIn(mask, output.width, area.rect), area.name).toBe(0);
        // The corner mark shows early on; the end card (and not the corner mark) at the end.
        const c = layout.corner!.rect;
        const e = layout.endCard!.rect;
        expect(countIn(atStart, output.width, c)).toBe((c.right - c.left) * (c.bottom - c.top));
        expect(countIn(atStart, output.width, e)).toBe(0);
        expect(countIn(atEnd, output.width, e)).toBe((e.right - e.left) * (e.bottom - e.top));
        expect(countIn(atEnd, output.width, c)).toBe(0);
      }
    }
  }, RENDER_TIMEOUT);

  it(
    'renders a real preview and export with the logo and leaves every forbidden area untouched',
    async () => {
      const probe = await probeMedia(SAMPLE_FILES.c);
      const musicProbe = await probeMedia(SAMPLE_FILES.music);
      const plan: EditPlan = samplePlan();
      plan.segments = [
        { ...plan.segments[2]!, id: 's0', inSec: 0, outSec: 2.5, transitionIn: null },
        { ...plan.segments[2]!, id: 's1', inSec: 3, outSec: 5.5, transitionIn: null },
      ];
      plan.textOverlays = [];
      plan.targetDurationSec = 5;
      const total = computeTimeline(plan).totalDurationSec;
      expect(total).toBeCloseTo(5, 3);
      for (const quality of ['preview', 'export'] as const) {
        const base: RenderInputs = {
          plan,
          assets: { [ASSET_IDS.c]: { path: SAMPLE_FILES.c, probe } },
          music: { path: SAMPLE_FILES.music, durationSec: musicProbe.durationSec, trackId: MUSIC_TRACK_ID },
          quality,
          brand: { ...TEST_BRAND, socialHandle: '' },
          fontsDir: FONTS_DIR,
          tmpDir: join(dir, 'tmp'),
        };
        const withLogo = await renderEditPlan(
          { ...base, brand: { ...base.brand, logo: { path: logoPath, width: 300, height: 200, placement: 'both', corner: 'top_right', opacity: 1 } } },
          join(dir, `logo-${quality}.mp4`),
        );
        const without = await renderEditPlan(base, join(dir, `plain-${quality}.mp4`));
        expect(withLogo.logoLayout?.corner).not.toBeNull();
        expect(withLogo.logoLayout?.endCard).not.toBeNull();
        if (quality === 'export') expect(withLogo.exportCheck?.ok).toBe(true);
        const output = quality === 'preview' ? VERTICAL_PREVIEW : VERTICAL_1080;
        const zone = safeZoneFor(output.width, output.height);
        const grey = (path: string, t: number) => runFfmpegToBuffer(['-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
        for (const [t, rect] of [
          [1, withLogo.logoLayout!.corner!.rect],
          [total - 0.4, withLogo.logoLayout!.endCard!.rect],
        ] as const) {
          const [a, b] = await Promise.all([grey(withLogo.outputPath, t), grey(without.outputPath, t)]);
          // 64 grey levels separates real drawing from encoder noise (see render.test.ts); the end of sample C is a
          // bright green, so the white logo inside its own rectangle is checked at a lower threshold.
          const changed = (r: SafeRect, threshold: number) => {
            let n = 0;
            for (let y = r.top; y < r.bottom; y++) for (let x = r.left; x < r.right; x++) if (Math.abs((a[y * output.width + x] ?? 0) - (b[y * output.width + x] ?? 0)) > threshold) n++;
            return n;
          };
          for (const area of zone.forbidden) expect(changed(area.rect, 64), `${area.name} at ${t}s (${quality})`).toBe(0);
          expect(changed(rect, 24)).toBeGreaterThan(((rect.right - rect.left) * (rect.bottom - rect.top)) / 2);
        }
      }
    },
    RENDER_TIMEOUT,
  );
});
