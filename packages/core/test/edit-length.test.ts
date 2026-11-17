import { describe, expect, it } from 'vitest';
import { durationBoundsFor, earliestMusicStartSec, editLengthForTrack, floorToTenth, hasBeatGrid, usableBeats } from '../src/index.js';

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

  it('rounds down to 0.1 s without losing a tenth to binary rounding', () => {
    // 16.15 − 0.15 is 15.999999999999998 in floating point; the room is 16.0 s all the same.
    expect(editLengthForTrack(16, 16.15)).toEqual({ ok: true, targetSec: 16, trimmed: false });
    // 65.2, 79.2 and 8.8 s are at least 88 % of 74, 90 and 10 s (exactly 88 % for the last two).
    expect(editLengthForTrack(74, 65.35)).toEqual({ ok: true, targetSec: 65.2, trimmed: true });
    expect(editLengthForTrack(90, 79.35)).toEqual({ ok: true, targetSec: 79.2, trimmed: true });
    expect(editLengthForTrack(10, 8.95)).toEqual({ ok: true, targetSec: 8.8, trimmed: true });
    expect(editLengthForTrack(45, 45.12)).toEqual({ ok: true, targetSec: 44.9, trimmed: true });
    // The helper behind it (also the music start picker's latest start).
    expect([floorToTenth(16.15 - 0.15), floorToTenth(45.3 - 45), floorToTenth(40.3 - 25), floorToTenth(39.85), floorToTenth(39.8999999)]).toEqual([16, 0.3, 15.3, 39.8, 39.8]);
  });
});

describe('the music measured from the first beat (the planners start the music on a beat)', () => {
  it('trims to what the track leaves after its first beat, for a track a little shorter than the edit or as long', () => {
    expect(editLengthForTrack(45, 40, 0.05)).toEqual({ ok: true, targetSec: 39.8, trimmed: true });
    expect(editLengthForTrack(45, 40, 0.3)).toEqual({ ok: true, targetSec: 39.5, trimmed: true });
    expect(editLengthForTrack(45, 40, 0.45)).toEqual({ ok: true, targetSec: 39.4, trimmed: true });
    expect(editLengthForTrack(30, 30, 0)).toEqual({ ok: true, targetSec: 29.8, trimmed: true });
    expect(editLengthForTrack(30, 30, 0.3)).toEqual({ ok: true, targetSec: 29.5, trimmed: true });
    expect(editLengthForTrack(30, 30.6, 0.3)).toEqual({ ok: true, targetSec: 30, trimmed: false });
    expect(editLengthForTrack(45, 70, 0.45)).toEqual({ ok: true, targetSec: 45, trimmed: false });
  });

  it('decides whether a track is long enough from its length alone', () => {
    // 39.8 s less 0.15 s is 88 % of 45 s: long enough, and from a first beat at 0.45 s it leaves 39.2 s.
    expect(editLengthForTrack(45, 39.8, 0.45)).toEqual({ ok: true, targetSec: 39.2, trimmed: true });
    const refused = 'The chosen track is 40 seconds long, which is shorter than the 45-second edit. Choose a longer track or a shorter length.';
    expect(editLengthForTrack(45, 39.7, 0)).toEqual({ ok: false, message: refused });
    expect(editLengthForTrack(45, 39.7, 0.45)).toEqual({ ok: false, message: refused });
    // A very short edit can be refused by the first beat alone; the message then does not call the track shorter.
    expect(editLengthForTrack(6, 6.1, 1)).toEqual({
      ok: false,
      message: 'From its first beat the chosen track leaves only 4.9 seconds of music, which is too short for the 6-second edit. Choose a longer track or a shorter length.',
    });
  });

  it('finds the first beat the planners can start on: the first usable beat, or 0 s with too few beats', () => {
    expect(earliestMusicStartSec([0.3, 0.8, 1.3, 1.8, 2.3], 40)).toBe(0.3);
    expect(earliestMusicStartSec([1.3, Number.NaN, 0.3, -1, 0.3, 0.8, 1.8, 50], 40)).toBe(0.3);
    expect(earliestMusicStartSec([0.4501, 0.95, 1.45, 1.95], 40)).toBe(0.45);
    expect(earliestMusicStartSec([0.3, 0.8, 1.3], 40)).toBe(0);
    expect(earliestMusicStartSec([], 40)).toBe(0);
    expect(usableBeats([0.3, 0.35, 0.8, 0.8, 1.3], 40)).toEqual([0.3, 0.8, 1.3]);
  });

  it('tells a track with a beat from one with no clear beat (fewer than 4 usable beats)', () => {
    expect(hasBeatGrid([0.3, 0.8, 1.3, 1.8], 40)).toBe(true);
    // The beat tracker finds no beat in a track without a clear one.
    expect(hasBeatGrid([], 40)).toBe(false);
    expect(hasBeatGrid([1, 2, 3], 40)).toBe(false);
    // Only usable beats count: a duplicate, one too close to the last, one past the end and a NaN leave 3.
    expect(hasBeatGrid([0.3, 0.3, 0.35, 0.8, 1.3, 50, Number.NaN], 40)).toBe(false);
  });
});
