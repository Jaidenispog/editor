import { describe, expect, it } from 'vitest';
import {
  VERTICAL_SAFE_ZONE_1080x1920,
  forbiddenAreasTouched,
  isSubtitleBoxSafe,
  isTextBoxSafe,
  rectContains,
  rectHeight,
  rectWidth,
  rectsIntersect,
  regionForBox,
  safeZoneFor,
  scaleSafeZone,
  type SafeRect,
} from '../src/safe-zones.js';

const zone = VERTICAL_SAFE_ZONE_1080x1920;

/** Brute force: is pixel (x, y) inside any forbidden area? */
function forbiddenPixel(x: number, y: number, z = zone): boolean {
  return z.forbidden.some((f) => x >= f.rect.left && x < f.rect.right && y >= f.rect.top && y < f.rect.bottom);
}

describe('VERTICAL_SAFE_ZONE_1080x1920', () => {
  it('matches the researched regions', () => {
    expect(zone.strict).toEqual({ left: 120, top: 270, right: 780, bottom: 1248 });
    expect(zone.head).toEqual({ left: 120, top: 270, right: 960, bottom: 840 });
    expect(zone.subtitle).toEqual({ centreX: 540, maxWidth: 480, maxBottom: 1248, minTypePx: 56 });
    expect(Object.fromEntries(zone.forbidden.map((f) => [f.name, f.rect]))).toEqual({
      top_band: { left: 0, top: 0, right: 1080, bottom: 270 },
      bottom_band: { left: 0, top: 1248, right: 1080, bottom: 1920 },
      left_side: { left: 0, top: 270, right: 120, bottom: 1248 },
      right_side: { left: 960, top: 270, right: 1080, bottom: 1248 },
      action_column: { left: 780, top: 840, right: 960, bottom: 1248 },
    });
  });

  it('partitions the frame: every pixel is either allowed (R_strict or R_head) or forbidden, never both', () => {
    for (let y = 0; y < 1920; y += 6) {
      for (let x = 0; x < 1080; x += 6) {
        const inStrict = x >= 120 && x < 780 && y >= 270 && y < 1248;
        const inHead = x >= 120 && x < 960 && y >= 270 && y < 840;
        expect(forbiddenPixel(x, y)).toBe(!(inStrict || inHead));
      }
    }
    // Edges: the forbidden rules are y < 270, y ≥ 1248, x < 120, x > 960 and x > 780 where y ≥ 840.
    expect(forbiddenPixel(540, 269)).toBe(true);
    expect(forbiddenPixel(540, 270)).toBe(false);
    expect(forbiddenPixel(540, 1247)).toBe(false);
    expect(forbiddenPixel(540, 1248)).toBe(true);
    expect(forbiddenPixel(119, 500)).toBe(true);
    expect(forbiddenPixel(120, 500)).toBe(false);
    expect(forbiddenPixel(959, 839)).toBe(false);
    expect(forbiddenPixel(800, 839)).toBe(false);
    expect(forbiddenPixel(800, 840)).toBe(true);
    expect(forbiddenPixel(779, 1000)).toBe(false);
  });

  it('keeps the subtitle box inside R_strict', () => {
    const box: SafeRect = { left: 300, top: 1100, right: 780, bottom: 1248 };
    expect(isSubtitleBoxSafe(zone, box)).toBe(true);
    expect(rectContains(zone.strict, box)).toBe(true);
  });
});

describe('rectangle helpers', () => {
  it('measures, contains and intersects half-open rectangles', () => {
    const a: SafeRect = { left: 0, top: 0, right: 10, bottom: 20 };
    expect(rectWidth(a)).toBe(10);
    expect(rectHeight(a)).toBe(20);
    expect(rectContains(a, { left: 0, top: 0, right: 10, bottom: 20 })).toBe(true);
    expect(rectContains(a, { left: 1, top: 1, right: 11, bottom: 5 })).toBe(false);
    expect(rectsIntersect(a, { left: 10, top: 0, right: 20, bottom: 20 })).toBe(false);
    expect(rectsIntersect(a, { left: 9, top: 19, right: 20, bottom: 30 })).toBe(true);
  });
});

describe('regionForBox and isTextBoxSafe', () => {
  it('allows the wide head region only for boxes that end at or above y 840', () => {
    expect(regionForBox(zone, { bottom: 840 })).toBe(zone.head);
    expect(regionForBox(zone, { bottom: 841 })).toBe(zone.strict);
    expect(isTextBoxSafe(zone, { left: 120, top: 300, right: 960, bottom: 840 })).toBe(true);
    expect(isTextBoxSafe(zone, { left: 120, top: 300, right: 960, bottom: 841 })).toBe(false);
    expect(isTextBoxSafe(zone, { left: 120, top: 900, right: 780, bottom: 1248 })).toBe(true);
    expect(isTextBoxSafe(zone, { left: 120, top: 900, right: 781, bottom: 1200 })).toBe(false);
    expect(isTextBoxSafe(zone, { left: 119, top: 900, right: 700, bottom: 1200 })).toBe(false);
    expect(isTextBoxSafe(zone, { left: 200, top: 269, right: 700, bottom: 400 })).toBe(false);
  });

  it('agrees with the forbidden areas for any box', () => {
    const boxes: SafeRect[] = [];
    for (const left of [0, 100, 120, 300, 700, 780, 900]) {
      for (const right of [200, 600, 780, 781, 960, 961, 1080]) {
        for (const top of [0, 270, 500, 839, 840, 1200]) {
          for (const bottom of [300, 800, 840, 841, 1248, 1249]) {
            if (right > left && bottom > top) boxes.push({ left, top, right, bottom });
          }
        }
      }
    }
    for (const box of boxes) {
      expect(isTextBoxSafe(zone, box), JSON.stringify(box)).toBe(forbiddenAreasTouched(zone, box).length === 0);
    }
    expect(forbiddenAreasTouched(zone, { left: 700, top: 800, right: 1000, bottom: 900 }).sort()).toEqual(['action_column', 'right_side']);
  });
});

describe('isSubtitleBoxSafe', () => {
  it('requires a centred, narrow box that ends at or above y 1248', () => {
    expect(isSubtitleBoxSafe(zone, { left: 340, top: 1100, right: 740, bottom: 1240 })).toBe(true);
    expect(isSubtitleBoxSafe(zone, { left: 299, top: 1100, right: 781, bottom: 1240 })).toBe(false); // too wide
    expect(isSubtitleBoxSafe(zone, { left: 200, top: 1100, right: 600, bottom: 1240 })).toBe(false); // off centre
    expect(isSubtitleBoxSafe(zone, { left: 340, top: 1100, right: 740, bottom: 1249 })).toBe(false); // too low
  });
});

describe('scaleSafeZone', () => {
  it('halves exactly for 540x960 previews', () => {
    const preview = scaleSafeZone(zone, 540, 960);
    expect(preview.strict).toEqual({ left: 60, top: 135, right: 390, bottom: 624 });
    expect(preview.head).toEqual({ left: 60, top: 135, right: 480, bottom: 420 });
    expect(preview.subtitle).toEqual({ centreX: 270, maxWidth: 240, maxBottom: 624, minTypePx: 28 });
    expect(preview.forbidden.find((f) => f.name === 'action_column')?.rect).toEqual({ left: 390, top: 420, right: 480, bottom: 624 });
    expect(safeZoneFor(540, 960)).toEqual(preview);
    expect(safeZoneFor(1080, 1920)).toBe(zone);
  });

  it('rounds allowed regions inwards and forbidden areas outwards at odd sizes', () => {
    const odd = scaleSafeZone(zone, 720, 1281);
    const sy = 1281 / 1920;
    expect(odd.strict.top).toBe(Math.ceil(270 * sy));
    expect(odd.strict.bottom).toBe(Math.floor(1248 * sy));
    const bottomBand = odd.forbidden.find((f) => f.name === 'bottom_band')!.rect;
    expect(bottomBand.top).toBe(Math.floor(1248 * sy));
    expect(bottomBand.top).toBeLessThanOrEqual(odd.strict.bottom);
    // No allowed pixel of the scaled zone falls inside a scaled forbidden area.
    for (let y = odd.strict.top; y < odd.strict.bottom; y += 3) {
      for (let x = odd.strict.left; x < odd.strict.right; x += 3) {
        expect(forbiddenPixel(x, y, odd)).toBe(false);
      }
    }
    for (let y = odd.head.top; y < odd.head.bottom; y += 3) {
      for (let x = odd.head.left; x < odd.head.right; x += 3) {
        expect(forbiddenPixel(x, y, odd)).toBe(false);
      }
    }
  });
});
