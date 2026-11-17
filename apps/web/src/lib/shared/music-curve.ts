import { editLengthForTrack, floorToTenth } from '@studio/core';

/**
 * Helpers for the music start-point picker. Isomorphic (no server imports): the server shrinks the stored
 * energy curve before sending it, the browser maps slider positions to seconds.
 */

/** A loudness curve small enough to send on every status poll. */
export interface EnergyCurve {
  /** 0–1 loudness per step (1 = the loudest part of the track). */
  values: number[];
  /** Seconds covered by each value. */
  stepSec: number;
}

/** Most points the picker draws; more would not be visible at card width. */
export const ENERGY_CURVE_POINTS = 120;

/**
 * Shrinks the analysed energy curve (one value per `stepSec`) to at most `maxPoints` values by averaging
 * neighbouring windows, so the picker can draw it without the full analysis. Returns null when there is
 * nothing usable.
 */
export function downsampleEnergy(energy: readonly number[] | null | undefined, stepSec: number | null | undefined, maxPoints = ENERGY_CURVE_POINTS): EnergyCurve | null {
  if (!energy || energy.length === 0 || !stepSec || !(stepSec > 0) || maxPoints < 1) return null;
  const clean = energy.map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0));
  if (clean.length <= maxPoints) return { values: clean.map(round3), stepSec };
  const factor = Math.ceil(clean.length / maxPoints);
  const values: number[] = [];
  for (let i = 0; i < clean.length; i += factor) {
    const window = clean.slice(i, i + factor);
    values.push(round3(window.reduce((a, b) => a + b, 0) / window.length));
  }
  return { values, stepSec: round3(stepSec * factor) };
}

/**
 * The latest start (seconds, rounded down to 0.1 s) that still lets an edit of `editSec` finish before the track ends;
 * 0 when the track is shorter than the edit or its length is unknown.
 */
export function latestMusicStart(trackSec: number | null | undefined, editSec: number): number {
  if (!trackSec || !(trackSec > 0)) return 0;
  return Math.max(0, floorToTenth(trackSec - editSec));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Seconds with up to two decimals, for the picker's notes ("0.45"). */
function seconds2(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * What the music does to the edit's length by the rule the planners use (`editLengthForTrack`, the music measured from
 * the track's first beat `firstBeatSec`, where the planners start it at the earliest), with the start on automatic or
 * chosen: "The edit will be trimmed to 39.8 s so it ends before the music does." when the track trims it, the rule's
 * refusal when the track is too short, otherwise null (also when its length is not known yet).
 */
export function musicLengthNote(trackSec: number | null | undefined, editSec: number, firstBeatSec = 0): string | null {
  if (!trackSec || !(trackSec > 0)) return null;
  const length = editLengthForTrack(editSec, trackSec, firstBeatSec);
  if (!length.ok) return length.message;
  return length.trimmed ? `The edit will be trimmed to ${length.targetSec} s so it ends before the music does.` : null;
}

/**
 * What the picker says when the start cannot be chosen (the track is not longer than the edit), with where the music
 * starts and what happens to the length by the rule the planners use (`editLengthForTrack`): the edit is trimmed to end
 * before the music, or the track is too short for the edit.
 */
export function automaticStartNote(trackSec: number | null | undefined, editSec: number, firstBeatSec = 0): string {
  if (!trackSec || !(trackSec > 0)) return 'The length of this track is not known yet, so the music starts at the beginning.';
  const length = editLengthForTrack(editSec, trackSec, firstBeatSec);
  if (!length.ok) return length.message;
  const lead = Math.abs(trackSec - editSec) <= 0.05 ? 'This track is as long as the edit' : trackSec < editSec ? 'This track is shorter than the edit' : 'This track is not much longer than the edit';
  const where = firstBeatSec > 0.05 ? `on its first beat, ${seconds2(firstBeatSec)} s in,` : 'at the beginning';
  return length.trimmed
    ? `${lead}, so the music starts ${where} and the edit will be trimmed to ${length.targetSec} s so it ends before the music does.`
    : `${lead}, so the music starts ${where.replace(/,$/, '')}.`;
}
