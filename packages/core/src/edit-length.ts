/**
 * How long an edit is planned and checked to be. One place for the rules both planners, the worker and the web form
 * use, so they always agree: the length window a plan is validated against, and what happens when the chosen track is
 * shorter than the requested length (the music start on automatic).
 */

/** Seconds of the track left over at the end, so the edit ends before the music does. */
const MUSIC_TAIL_SEC = 0.15;
/** A track may shorten an edit to no less than this share of the requested length ... */
const MIN_TRIMMED_SHARE = 0.88;
/** ... and never below this many seconds. */
const MIN_TRIMMED_SEC = 5;

/**
 * The total-length window a plan for `targetSec` must land in (the worker's check, and the rules planner's last
 * chance): ±12 %, but never tighter than ±2 s, and never under 3 s.
 */
export function durationBoundsFor(targetSec: number): { min: number; max: number } {
  const slack = Math.max(2, targetSec * 0.12);
  return { min: Math.max(3, targetSec - slack), max: targetSec + slack };
}

/** The length an edit is planned to once its music is known; see {@link editLengthForTrack}. */
export type EditLengthForTrack =
  | {
      ok: true;
      /** The length to plan to and to validate against. */
      targetSec: number;
      /** True when the track made the edit shorter than asked. */
      trimmed: boolean;
    }
  | {
      ok: false;
      /** Owner-facing reason the edit cannot be made with this track at this length. */
      message: string;
    };

/**
 * The length to plan an edit to when it plays a track of `trackSec` from a start the planner picks: the requested
 * length when the track covers it; otherwise what the track leaves (its length less 0.15 s, rounded down to 0.1 s),
 * when that is at least 5 s and 88 % of the requested length (a 45 s edit with a 40 s track becomes 39.8 s); a shorter
 * track is refused with a message for the owner. Pure; the rules planner, the AI brief, the worker's validation and the
 * generate form all use it.
 */
export function editLengthForTrack(targetSec: number, trackSec: number): EditLengthForTrack {
  const room = Math.floor((trackSec - MUSIC_TAIL_SEC) * 10) / 10;
  if (room >= targetSec) return { ok: true, targetSec, trimmed: false };
  if (room < Math.max(MIN_TRIMMED_SEC, targetSec * MIN_TRIMMED_SHARE)) {
    return {
      ok: false,
      message: `The chosen track is ${Math.round(trackSec)} seconds long, which is shorter than the ${Math.round(targetSec)}-second edit. Choose a longer track or a shorter length.`,
    };
  }
  return { ok: true, targetSec: room, trimmed: true };
}
