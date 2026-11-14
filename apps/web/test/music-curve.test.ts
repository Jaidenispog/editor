import { describe, expect, it } from 'vitest';
import { moveInOrder } from '../src/lib/shared/clip-order';
import { downsampleEnergy, latestMusicStart } from '../src/lib/shared/music-curve';

describe('downsampleEnergy', () => {
  it('keeps short curves as they are (clamped to 0–1)', () => {
    expect(downsampleEnergy([0, 0.5, 1.2, -1], 0.25)).toEqual({ values: [0, 0.5, 1, 0], stepSec: 0.25 });
  });

  it('averages long curves down to at most the point limit and widens the step to match', () => {
    const energy = Array.from({ length: 1000 }, (_, i) => (i % 2 ? 1 : 0));
    const curve = downsampleEnergy(energy, 0.25, 120)!;
    expect(curve.values.length).toBeLessThanOrEqual(120);
    expect(curve.stepSec).toBe(0.25 * Math.ceil(1000 / 120));
    // Every full window averages the alternating loud/quiet steps (the last window may be partial).
    expect(curve.values.slice(0, -1).every((v) => v >= 0.4 && v <= 0.6)).toBe(true);
  });

  it('returns null when there is nothing to draw', () => {
    expect(downsampleEnergy([], 0.25)).toBeNull();
    expect(downsampleEnergy(null, 0.25)).toBeNull();
    expect(downsampleEnergy([0.5], 0)).toBeNull();
  });
});

describe('latestMusicStart', () => {
  it('leaves room for the whole edit', () => {
    expect(latestMusicStart(40, 25)).toBe(15);
    expect(latestMusicStart(40.37, 25)).toBe(15.3);
    expect(latestMusicStart(20, 25)).toBe(0);
    expect(latestMusicStart(null, 25)).toBe(0);
  });
});

describe('moveInOrder', () => {
  it('moves a clip one step and leaves the ends alone', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', 'up')).toEqual(['a', 'b', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 'c', 'down')).toEqual(['a', 'b', 'c']);
    expect(moveInOrder(['a', 'b'], 'zzz', 'up')).toEqual(['a', 'b']);
  });
});
