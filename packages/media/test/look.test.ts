import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyColourLook } from '@studio/core';
import { SATURATION_FULL_SCALE, measureLook, parseSignalStats, summariseLook } from '../src/analysis/look.js';
import { SAMPLE_FILES } from './render-fixtures.js';

/** Captured from `ffmpeg -f lavfi -i testsrc2=s=160x90:d=1:r=2 -vf "signalstats,metadata=mode=print:file=-"` (two frames, trimmed). */
const CAPTURED = `frame:0    pts:0       pts_time:0
lavfi.signalstats.YMIN=22
lavfi.signalstats.YLOW=41
lavfi.signalstats.YAVG=105.995
lavfi.signalstats.YHIGH=170
lavfi.signalstats.YMAX=210
lavfi.signalstats.SATMIN=0
lavfi.signalstats.SATLOW=28
lavfi.signalstats.SATAVG=92.28
lavfi.signalstats.SATHIGH=119
frame:1    pts:1       pts_time:0.5
lavfi.signalstats.YLOW=51
lavfi.signalstats.YAVG=115.995
lavfi.signalstats.YHIGH=180
lavfi.signalstats.SATAVG=82.28
frame:2    pts:2       pts_time:1
lavfi.signalstats.YAVG=10
`;

describe('measureLook parser', () => {
  it('reads YAVG, YLOW, YHIGH and SATAVG per frame and skips incomplete frames', () => {
    const frames = parseSignalStats(CAPTURED);
    expect(frames).toEqual([
      { yavg: 105.995, ylow: 41, yhigh: 170, satavg: 92.28 },
      { yavg: 115.995, ylow: 51, yhigh: 180, satavg: 82.28 },
    ]);
  });

  it('averages into 0–1 luma, saturation and contrast', () => {
    const look = summariseLook(parseSignalStats(CAPTURED))!;
    expect(look.meanLuma).toBeCloseTo(110.995 / 255, 6);
    expect(look.meanSaturation).toBeCloseTo(87.28 / SATURATION_FULL_SCALE, 6);
    expect(look.contrast).toBeCloseTo(129 / 255, 6);
    expect(summariseLook([])).toBeNull();
  });

  it.skipIf(!existsSync(SAMPLE_FILES.c))('measures a real clip with ffmpeg', async () => {
    const look = await measureLook(SAMPLE_FILES.c);
    for (const v of [look.meanLuma, look.meanSaturation, look.contrast]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(['natural', 'clean', 'cinematic', 'punchy']).toContain(classifyColourLook(look));
  });
});
