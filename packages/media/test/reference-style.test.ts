import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancelledError, paletteFromCounts, type ReferenceStyleSignals } from '@studio/core';
import { probeMedia } from '../src/ffprobe.js';
import {
  blendFits,
  blendSpread,
  crossFadeFit,
  measureReferenceStyle,
  movingBand,
  ncc,
  parseFrameScores,
  percentileSpread,
  scaleFit,
  shiftedNcc,
  shiftFit,
  type ReferenceStyleMeasurement,
} from '../src/analysis/reference-style.js';
import { hasFfmpeg } from './analysis-fixtures.js';
import { buildFixture, edgeFixtureSpecs, fixtureSpecs, zoomFixture, type FixtureSpec } from './fixtures/make-reference-fixtures.js';

const W = 72;
const H = 128;

/** A textured grey test frame (smooth blobs so bilinear scaling behaves like real footage). */
function texture(seed = 1): Uint8Array {
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 128 + 50 * Math.sin((x + seed) / 3.1) * Math.cos((y - seed) / 4.3) + 40 * Math.sin((x * 0.7 + y * 1.3 + seed * 5) / 5.7);
      f[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return f;
}

/** Scales a frame about its centre by `s` (bilinear), as a zoom-in by `s` would. */
function zoomed(src: Uint8Array, s: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1.001, Math.max(0, cx + (x - cx) / s));
      const sy = Math.min(H - 1.001, Math.max(0, cy + (y - cy) / s));
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const p = iy * W + ix;
      const top = src[p]! + (src[p + 1]! - src[p]!) * fx;
      const bottom = src[p + W]! + (src[p + W + 1]! - src[p + W]!) * fx;
      out[y * W + x] = Math.round(top + (bottom - top) * fy);
    }
  }
  return out;
}

describe('reference style frame maths (no FFmpeg)', () => {
  it('parses Pass A output, reading nan blur as null', () => {
    const frames = parseFrameScores(
      'frame:0    pts:0       pts_time:0\nlavfi.scene_score=0.000000\nlavfi.signalstats.YMIN=16\nlavfi.signalstats.YAVG=126.1\nlavfi.signalstats.YMAX=235\nlavfi.signalstats.YDIF=0\nlavfi.blur=nan\nframe:1    pts:1       pts_time:0.0333333\nlavfi.scene_score=0.42\nlavfi.signalstats.YAVG=90\nlavfi.signalstats.YDIF=12.5\nlavfi.blur=3.3\n',
    );
    expect(frames).toEqual([
      { t: 0, scene: 0, yavg: 126.1, ymin: 16, ymax: 235, ydif: 0, blur: null },
      { t: 0.0333333, scene: 0.42, yavg: 90, ymin: 90, ymax: 90, ydif: 12.5, blur: 3.3 },
    ]);
  });

  it('fits known zoom factors on a 72 × 128 frame', () => {
    const base = texture();
    for (const s of [1.05, 1.12, 1.2]) {
      const fit = scaleFit(base, zoomed(base, s), W, H);
      expect(Math.abs(fit.scale - s)).toBeLessThanOrEqual(0.02);
      expect(fit.error).toBeLessThan(0.5 * fit.errorAtOne);
    }
    expect(scaleFit(base, base, W, H).scale).toBe(1);
    expect(scaleFit(zoomed(base, 1.1), base, W, H).scale).toBeLessThan(0.95);
  });

  it('tells a cross-fade from a wipe and finds the wipe direction', () => {
    const a = texture(1);
    const b = texture(40);
    const blend = (alpha: number) => a.map((v, i) => Math.round(v + alpha * (b[i]! - v)));
    const wipe = (k: number) => a.map((v, i) => ((i % W) >= W - (k * W) / 6 ? b[i]! : v));
    expect(crossFadeFit(a, b, [0.2, 0.4, 0.6, 0.8].map(blend)).ok).toBe(true);
    expect(crossFadeFit(a, b, [1, 2, 3, 4, 5].map(wipe)).ok).toBe(false);
    expect(movingBand([a, ...[1, 2, 3, 4, 5].map(wipe), b], W, H)).toEqual({ axis: 'cols', direction: 'left' });
    expect(ncc(a, a)).toBeCloseTo(1, 6);
    expect(ncc(a, a.map((v) => 255 - v))).toBeCloseTo(-1, 6);
  });

  it('tells a soft-edged wipe from a cross-fade by how evenly the frame changes', () => {
    const a = texture(1);
    const b = texture(40);
    const blend = (alpha: number) => a.map((v, i) => Math.round(v + alpha * (b[i]! - v)));
    // A smooth wipe: the blend amount ramps across a soft edge 1/3 of the frame wide, moving right to left.
    const soft = (k: number) => a.map((v, i) => { const x = i % W; const edge = W * (1 - k / 6); const alpha = Math.min(1, Math.max(0, (x - edge) / (W / 3) + 0.5)); return Math.round(v + alpha * (b[i]! - v)); });
    const fades = [0.2, 0.4, 0.6, 0.8].map(blend);
    const wipes = [1, 2, 3, 4, 5].map(soft);
    expect(blendSpread(a, b, fades, W, H)).toBeLessThan(0.1);
    expect(blendSpread(a, b, wipes, W, H)).toBeGreaterThan(0.5);
  });

  it('measures how uniform a frame is and whether ramp frames are blends', () => {
    const white = new Uint8Array(W * H).fill(250);
    // A caption box in the lower part does not stop a white frame being uniform.
    for (let y = H - 10; y < H - 2; y++) for (let x = 5; x < 40; x++) white[y * W + x] = 10;
    expect(percentileSpread(white)).toBeLessThanOrEqual(5);
    const bright = texture(2).map((v) => Math.min(255, v + 110));
    expect(percentileSpread(bright)).toBeGreaterThan(24);
    const a = texture(1);
    const b = texture(40);
    expect(blendFits(a, white, [a.map((v, i) => Math.round(v + 0.5 * (white[i]! - v)))])).toBe(true);
    expect(blendFits(a, white, [b])).toBe(false);
    expect(blendFits(a, white, [])).toBe(true);
  });

  it('finds a vertical shift (content moving up)', () => {
    const a = texture(3);
    const up = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) up[y * W + x] = a[Math.min(H - 1, y + 10) * W + x]!;
    const r = shiftFit(a, up, W, H, 'y', 40);
    expect(r.shift).toBe(10);
    expect(r.error).toBeLessThan(0.5 * r.errorAtZero);
    // The shifted frames line up: the overlap correlates as the same picture.
    expect(shiftedNcc(a, up, W, H, 'y', 10)).toBeGreaterThan(0.99);
    expect(shiftedNcc(a, up, W, H, 'y', 0)).toBeLessThan(0.9);
  });

  it('a shift that only crops does not make two different pictures alike', () => {
    // A detailed frame (bright above, dark below) cut against a smooth dark-to-light ramp: shifting by a third of the
    // frame halves the difference just by cropping, but the overlap stays unlike (the false slide behind a lost cut).
    const tex = texture(5);
    const detail = new Uint8Array(W * H);
    const ramp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = tex[y * W + x]!;
        detail[y * W + x] = Math.max(0, Math.min(255, Math.round(y < (2 * H) / 3 ? 0.5 * v + 120 : 0.5 * v - 20)));
        ramp[y * W + x] = Math.round(80 + (150 * y) / (H - 1));
      }
    }
    const r = shiftFit(detail, ramp, W, H, 'y', Math.round(H / 3));
    expect(Math.abs(r.shift)).toBeGreaterThanOrEqual(2);
    expect(r.error).toBeLessThanOrEqual(0.5 * r.errorAtZero);
    expect(Math.abs(shiftedNcc(detail, ramp, W, H, 'y', r.shift))).toBeLessThan(0.5);
  });
});

const ffmpeg = await hasFfmpeg();

describe.skipIf(!ffmpeg)('reference style on SYNTHETIC fixtures (FFmpeg)', () => {
  let dir: string;
  const results = new Map<string, ReferenceStyleMeasurement>();
  const truths = new Map<string, Record<string, unknown>>();
  let pushTruth = 0;
  const specs = fixtureSpecs();
  const measure = async (key: string, file: string, speechLikely = false) => {
    const probe = await probeMedia(file);
    results.set(key, await measureReferenceStyle(file, { probe, speechLikely }));
    truths.set(key, JSON.parse(await readFile(file.replace(/\.mp4$/, '.json'), 'utf8')) as Record<string, unknown>);
  };
  const sig = (key: string): ReferenceStyleSignals => results.get(key)!.signals;
  const count = (key: string, kind: string) => sig(key).transitions.counts[kind as keyof ReferenceStyleSignals['transitions']['counts']] ?? 0;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'studio-reference-fixtures-'));
    const keys = Object.keys(specs);
    // Three at a time keeps the machine responsive.
    for (let i = 0; i < keys.length; i += 3) {
      await Promise.all(keys.slice(i, i + 3).map(async (key) => measure(key, await buildFixture(dir, specs[key]!), key === 'r9')));
    }
    const zoom = await zoomFixture(dir);
    pushTruth = zoom.truthPushScale;
    await measure('r4', zoom.file);
    const noAudio: FixtureSpec = { ...specs['r1']!, name: 'r1-no-audio', audio: null };
    await measure('silent', await buildFixture(dir, noAudio));
    const edge = edgeFixtureSpecs();
    const edgeKeys = Object.keys(edge);
    for (let i = 0; i < edgeKeys.length; i += 3) {
      await Promise.all(edgeKeys.slice(i, i + 3).map(async (key) => measure(key, await buildFixture(dir, edge[key]!))));
    }
  }, 600_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('names every fixture synthetic-*.mp4 with a ground-truth JSON', async () => {
    const files = await readdir(dir);
    const videos = files.filter((f) => f.endsWith('.mp4'));
    expect(videos.length).toBeGreaterThanOrEqual(13);
    for (const v of videos) {
      expect(v).toMatch(/^synthetic-.*\.mp4$/);
      expect(files).toContain(v.replace(/\.mp4$/, '.json'));
    }
    expect(truths.get('r1')).toMatchObject({ synthetic: true });
  });

  it('R1: hard cuts on every second beat at 120 BPM', () => {
    const s = sig('r1');
    expect(Math.abs(s.transitions.joins - 15)).toBeLessThanOrEqual(1);
    expect(count('r1', 'hard')).toBeGreaterThanOrEqual(14);
    expect(s.beat.status).toBe('measured');
    if (s.beat.status !== 'measured') return;
    expect(Math.abs(s.beat.bpm - 120)).toBeLessThanOrEqual(1.5);
    expect(s.beat.within1Frame).toBeGreaterThanOrEqual(13);
    expect(s.beat.within80ms).toBeGreaterThanOrEqual(14);
    expect(Math.abs(s.beat.medianOffsetMs)).toBeLessThanOrEqual(15);
    expect(s.beat.beatsPerCut).toBe(2);
    expect(s.beat.reportable).toBe(true);
    expect(s.transitions.family).toBe('straight_only');
    expect(s.zoom.pushIns + s.zoom.pullOuts + s.zoom.punchIns).toBe(0);
    // Every detected cut is within a frame of a true cut.
    const truth = truths.get('r1')!['cuts'] as number[];
    for (const e of results.get('r1')!.details.events) expect(Math.min(...truth.map((t) => Math.abs(t - e.timeSec)))).toBeLessThanOrEqual(1 / 30 + 1e-6);
  });

  it('R2: a white flash every 4th beat', () => {
    const s = sig('r2');
    expect(Math.abs(count('r2', 'fade_white') - 7)).toBeLessThanOrEqual(1);
    expect(Math.abs(count('r2', 'hard') - 8)).toBeLessThanOrEqual(1);
    expect(s.transitions.flashesOnBeat).toBeGreaterThanOrEqual(6);
    expect(s.transitions.flashEveryBeats).toBeGreaterThanOrEqual(3.5);
    expect(s.transitions.flashEveryBeats).toBeLessThanOrEqual(4.5);
    expect(Math.abs(s.transitions.flashMedianSec! - 0.2)).toBeLessThanOrEqual(0.07);
    expect(paletteFromCounts(s.transitions)).toMatchObject({ hardCutShare: 1, accent: { type: 'fadewhite', everyBeats: 4 } });
  });

  it.each(['r3', 'r3b'])('%s: cross-fades (linear and pixel dissolve both map to fade)', (key) => {
    const s = sig(key);
    expect(count(key, 'cross_fade')).toBeGreaterThanOrEqual(4);
    expect(count(key, 'hard')).toBeLessThanOrEqual(1);
    expect(Math.abs(s.transitions.crossFadeMedianSec! - 0.5)).toBeLessThanOrEqual(0.1);
    expect(s.beat).toMatchObject({ status: 'not_measured', reason: 'no_clear_beat' });
    const palette = paletteFromCounts(s.transitions)!;
    expect(palette.types[0]).toBe('fade');
    expect(Math.abs(palette.durationSec - 0.5)).toBeLessThanOrEqual(0.1);
  });

  it('R4: one push-in, one punch-in jump (not a transition), static shots unzoomed', () => {
    const s = sig('r4');
    expect(s.zoom.pushIns).toBe(1);
    expect(Math.abs(s.zoom.medianPushScale! - pushTruth)).toBeLessThanOrEqual(0.03);
    expect(s.zoom.punchIns).toBe(1);
    expect(Math.abs(s.zoom.medianPunchScale! - 1.25)).toBeLessThanOrEqual(0.04);
    expect(s.zoom.pullOuts).toBe(0);
    expect(s.transitions.family).toBe('straight_only');
    const shots = results.get('r4')!.details.shots.filter((x) => x.zoom === null);
    expect(shots.length).toBeGreaterThanOrEqual(2);
    for (const shot of shots) expect(Math.abs((shot.scale ?? 1) - 1)).toBeLessThan(0.02);
  });

  it('R5: the drop lands on a cut or flash; R5b: nothing happens at the drop', () => {
    const d = sig('r5').drop;
    expect(d.status).toBe('found');
    expect(Math.abs(d.atSec! - 8)).toBeLessThanOrEqual(0.15);
    expect(d.riseDb).toBeGreaterThanOrEqual(10);
    expect(['cut', 'flash']).toContain(d.visualEvent);
    expect(Math.abs(d.eventOffsetMs!)).toBeLessThanOrEqual(150);
    expect(sig('r5').music.hasClearDrop).toBe(true);
    const b = sig('r5b').drop;
    expect(b.status).toBe('found');
    expect(b.visualEvent).toBe('none');
  });

  it('R6: slides and wipes with the right axis and direction, no cross-fades', () => {
    const truth = truths.get('r6')!['motion'] as Array<{ axis: 'x' | 'y'; direction: string }>;
    const events = results.get('r6')!.details.events;
    let right = 0;
    truth.forEach((t, i) => {
      const e = events.find((x) => Math.abs(x.timeSec - (2 * (i + 1) + 0.15)) <= 0.2);
      const kind = t.axis === 'y' ? 'slide_vertical' : 'wipe_horizontal';
      if (e && e.kind === kind && e.direction === t.direction) right++;
    });
    expect(right).toBeGreaterThanOrEqual(4);
    expect(count('r6', 'cross_fade')).toBe(0);
  });

  it('R7: a busy single shot has no joins and no zooms', () => {
    expect(sig('r7').transitions.joins).toBeLessThanOrEqual(1);
    expect(sig('r7').zoom.pushIns + sig('r7').zoom.punchIns).toBe(0);
  });

  it('R8: skips a dark end screen', () => {
    const s = sig('r8');
    expect(Math.abs(s.endScreenTrimmedSec - 3)).toBeLessThanOrEqual(0.2);
    expect(results.get('r8')!.details.events.every((e) => e.timeSec < 16 - 1e-3)).toBe(true);
    expect(Math.abs(s.transitions.joins - 15)).toBeLessThanOrEqual(1);
  });

  it('R9: a talking video has no musical beat and is never called off the beat', () => {
    const b = sig('r9').beat;
    expect(b.status).toBe('not_measured');
    if (b.status === 'not_measured') expect(['mostly_speech', 'no_clear_beat']).toContain(b.reason);
  });

  it('R10: a cut on every beat at 124 BPM (beats off the frame grid)', () => {
    const b = sig('r10').beat;
    expect(b.status).toBe('measured');
    if (b.status !== 'measured') return;
    expect(Math.abs(b.bpm - 124)).toBeLessThanOrEqual(2);
    expect(b.within1Frame / b.cuts).toBeGreaterThanOrEqual(0.85);
    expect(b.beatsPerCut).toBe(1);
  });

  it('R11: random cuts are not reported as beat-synced', () => {
    const b = sig('r11').beat;
    expect(b.status).toBe('measured');
    if (b.status === 'measured') expect(b.reportable).toBe(false);
  });

  it('a proxy without sound leaves beat and music unmeasured and still measures transitions', () => {
    const s = sig('silent');
    expect(s.beat).toMatchObject({ status: 'not_measured', reason: 'no_audio' });
    expect(s.music.status).toBe('not_measured');
    expect(s.drop.status).toBe('not_measured');
    expect(count('silent', 'hard')).toBeGreaterThanOrEqual(14);
  });

  it('X1: dark and bright shots joined by hard cuts are cuts (not flashes or screens), and shots keep their length', () => {
    const truth = truths.get('x1')!['cuts'] as number[];
    expect(count('x1', 'hard')).toBe(5);
    expect(count('x1', 'fade_white') + count('x1', 'fade_black')).toBe(0);
    expect(results.get('x1')!.details.screens).toEqual([]);
    for (const t of truth) expect(results.get('x1')!.details.events.some((e) => e.kind === 'hard' && Math.abs(e.timeSec - t) <= 1 / 30 + 1e-6)).toBe(true);
    expect(sig('x1').shots.count).toBe(6);
  });

  // X9 and X10 are X2 with the last shot's colours that lost a cut while FFmpeg still picked them at random: the cut into
  // a smooth gradient read as a slide (cropping halved the difference), and a light gradient drifting towards a nearly
  // uniform frame turned the insert and itself into a white end screen.
  it.each(['x2', 'x9', 'x10'])('%s: a short bright insert between two hard cuts is two cuts, not a white flash', (key) => {
    expect(count(key, 'fade_white')).toBe(0);
    expect(count(key, 'hard')).toBe(4);
    const truth = truths.get(key)!['cuts'] as number[];
    for (const t of truth) expect(results.get(key)!.details.events.some((e) => e.kind === 'hard' && Math.abs(e.timeSec - t) <= 1 / 30 + 1e-6), `cut at ${t}`).toBe(true);
    expect(results.get(key)!.details.screens).toEqual([]);
  });

  it('X11: a bright shot keeps its cut when a white end card follows it', () => {
    const m = results.get('x11')!;
    const truth = truths.get('x11')! as { cuts: number[]; endScreenStartSec: number };
    expect(count('x11', 'hard')).toBe(3);
    expect(count('x11', 'fade_white')).toBe(0);
    for (const t of truth.cuts) expect(m.details.events.some((e) => e.kind === 'hard' && Math.abs(e.timeSec - t) <= 1 / 30 + 1e-6), `cut at ${t}`).toBe(true);
    expect(m.details.screens).toHaveLength(1);
    expect(Math.abs(m.details.screens[0]![0] - truth.endScreenStartSec)).toBeLessThanOrEqual(1 / 30 + 1e-6);
  });

  it('X3: dips to black are read as dips', () => {
    expect(count('x3', 'fade_black')).toBe(5);
    expect(Math.abs(sig('x3').transitions.flashMedianSec! - 0.4)).toBeLessThanOrEqual(0.1);
  });

  it("X4: FFmpeg's zoomin is a zoom (4 or 5 of 5) and never a white flash", () => {
    expect(count('x4', 'zoom')).toBeGreaterThanOrEqual(4);
    expect(count('x4', 'fade_white')).toBe(0);
    expect(count('x4', 'cross_fade')).toBe(0);
  });

  it('X5: a horizontal blur transition is neither a zoom nor a cross-fade', () => {
    expect(count('x5', 'zoom')).toBe(0);
    expect(count('x5', 'cross_fade')).toBe(0);
  });

  it('X6: soft-edged wipes keep their axis and direction and are never cross-fades', () => {
    const truth = truths.get('x6')!['motion'] as Array<{ axis: 'x' | 'y'; direction: string }>;
    const events = results.get('x6')!.details.events;
    let right = 0;
    truth.forEach((t, i) => {
      const e = events.find((x) => Math.abs(x.timeSec - (2 * (i + 1) + 0.2)) <= 0.25);
      const kind = t.axis === 'y' ? 'slide_vertical' : 'wipe_horizontal';
      if (e && e.kind === kind && e.direction === t.direction) right++;
    });
    expect(right).toBeGreaterThanOrEqual(4);
    expect(count('x6', 'cross_fade')).toBe(0);
  });

  it.each([
    ['x7', 60],
    ['x8', 25],
  ] as const)('%s: 0.5 s and 1 s cross-fades and beat cuts at %i fps', (key, fps) => {
    const m = results.get(key)!;
    expect(Math.abs(m.details.raw.fps - fps)).toBeLessThanOrEqual(0.1);
    const truth = truths.get(key)! as { cuts: number[]; crossFades: Array<{ atSec: number; durationSec: number }> };
    const fades = m.details.events.filter((e) => e.kind === 'cross_fade');
    expect(fades.length).toBeGreaterThanOrEqual(3);
    for (const f of fades) {
      const t = truth.crossFades.find((c) => f.timeSec >= c.atSec - 0.1 && f.timeSec <= c.atSec + c.durationSec + 0.1);
      expect(t, `cross-fade at ${f.timeSec}`).toBeDefined();
      expect(Math.abs(f.durationSec - t!.durationSec)).toBeLessThanOrEqual(0.15);
    }
    expect(fades.some((f) => f.durationSec >= 0.85)).toBe(true);
    const hard = m.details.events.filter((e) => e.kind === 'hard');
    expect(hard.length).toBeGreaterThanOrEqual(truth.cuts.length - 1);
    for (const e of hard) expect(Math.min(...truth.cuts.map((t) => Math.abs(t - e.timeSec)))).toBeLessThanOrEqual(1 / fps + 1e-6);
    const b = sig(key).beat;
    expect(b.status).toBe('measured');
    if (b.status !== 'measured') return;
    expect(Math.abs(b.bpm - 120)).toBeLessThanOrEqual(1.5);
    expect(b.within80ms / b.cuts).toBeGreaterThanOrEqual(0.85);
  });

  it('keeps only numbers in the signals: no array longer than 8', () => {
    for (const m of results.values()) {
      const lengths: number[] = [];
      JSON.stringify(m.signals, (_k, v) => {
        if (Array.isArray(v)) lengths.push(v.length);
        return v;
      });
      expect(Math.max(0, ...lengths)).toBeLessThanOrEqual(8);
      expect(m.signals.estimate).toBe(true);
    }
  });

  it('stops when the AbortSignal fires', async () => {
    const file = path.join(dir, `synthetic-${specs['r1']!.name}.mp4`);
    const probe = await probeMedia(file);
    const controller = new AbortController();
    const run = measureReferenceStyle(file, { probe, speechLikely: false, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    const already = new AbortController();
    already.abort();
    await expect(measureReferenceStyle(file, { probe, speechLikely: false, signal: already.signal })).rejects.toBeInstanceOf(CancelledError);
  });
});
