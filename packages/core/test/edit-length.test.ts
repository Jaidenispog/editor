import { describe, expect, it } from 'vitest';
import { durationBoundsFor, editLengthForTrack } from '../src/index.js';

describe('the length window a plan is checked against', () => {
  it('is ±12 %, never tighter than ±2 s and never under 3 s', () => {
    expect(durationBoundsFor(45)).toEqual({ min: 39.6, max: 50.4 });
    expect(durationBoundsFor(39.8).min).toBeCloseTo(35.024, 9);
    expect(durationBoundsFor(39.8).max).toBeCloseTo(44.576, 9);
    expect(durationBoundsFor(10)).toEqual({ min: 8, max: 12 });
    expect(durationBoundsFor(4)).toEqual({ min: 3, max: 6 });
  });
});

describe('an edit and a track shorter than it (music start on automatic)', () => {
  it('keeps the requested length when the track covers it with 0.15 s to spare', () => {
    expect(editLengthForTrack(45, 70)).toEqual({ ok: true, targetSec: 45, trimmed: false });
    expect(editLengthForTrack(45, 45.15)).toEqual({ ok: true, targetSec: 45, trimmed: false });
  });

  it('trims to what the track leaves (its length less 0.15 s, rounded down to 0.1 s)', () => {
    expect(editLengthForTrack(45, 40)).toEqual({ ok: true, targetSec: 39.8, trimmed: true });
    expect(editLengthForTrack(45, 45.1)).toEqual({ ok: true, targetSec: 44.9, trimmed: true });
    expect(editLengthForTrack(20, 17.9)).toEqual({ ok: true, targetSec: 17.7, trimmed: true });
  });

  it('trims to no less than 88 % of the requested length, and never below 5 s', () => {
    // 45 × 0.88 = 39.6: a 39.8 s track leaves 39.6 s (allowed), a 39.7 s track leaves 39.5 s (refused).
    expect(editLengthForTrack(45, 39.8)).toEqual({ ok: true, targetSec: 39.6, trimmed: true });
    expect(editLengthForTrack(45, 39.7)).toEqual({ ok: false, message: 'The chosen track is 40 seconds long, which is shorter than the 45-second edit. Choose a longer track or a shorter length.' });
    expect(editLengthForTrack(45, 30)).toEqual({ ok: false, message: 'The chosen track is 30 seconds long, which is shorter than the 45-second edit. Choose a longer track or a shorter length.' });
    expect(editLengthForTrack(5.5, 5.1).ok).toBe(false);
    expect(editLengthForTrack(5.5, 5.2)).toEqual({ ok: true, targetSec: 5, trimmed: true });
  });
});
