/**
 * How long an edit is planned and checked to be. One place for the rules both planners, the worker and the web form
 * use, so they always agree: the length window a plan is validated against, where the music can start, and what
 * happens when the chosen track leaves less than the requested length after that start.
 */

/** Seconds of the track left over at the end, so the edit ends before the music does. */
export const MUSIC_TAIL_SEC = 0.15;
/** A track may shorten an edit to no less than this share of the requested length ... */
const MIN_TRIMMED_SHARE = 0.88;
/** ... and never below this many seconds. */
const MIN_TRIMMED_SEC = 5;
/** Fewest usable beats a track needs for the planners to cut to its beats (with fewer, the music starts at 0 s). */
export const MIN_GRID_BEATS = 4;
/** Two beats closer than this are one beat. */
const MIN_BEAT_GAP_SEC = 0.12;
/** Allowance for binary rounding in the length arithmetic (16.15 − 0.15 is 15.999999999999998 in floating point). */
const EPSILON = 1e-9;

/**
 * The total-length window a plan for `targetSec` must land in (the worker's check, and the rules planner's last
 * chance): ±12 %, but never tighter than ±2 s, and never under 3 s.
 */
export function durationBoundsFor(targetSec: number): { min: number; max: number } {
  const slack = Math.max(2, targetSec * 0.12);
  return { min: Math.max(3, targetSec - slack), max: targetSec + slack };
}

/**
 * The beats of a track the planners cut to: finite times inside the track, rounded to the millisecond, sorted, without
 * a beat less than 0.12 s after the one before it. Pure.
 */
export function usableBeats(beatTimesSec: readonly number[], trackSec: number): number[] {
  const inside = beatTimesSec.filter((t) => Number.isFinite(t) && t >= 0 && t < trackSec);
  const sorted = [...new Set(inside.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
  return sorted.filter((t, i) => i === 0 || t - sorted[i - 1]! > MIN_BEAT_GAP_SEC);
}

/**
 * The earliest point (seconds into the track) the music of an edit can start. The planners start the music on a beat,
 * so this is the track's first usable beat (anywhere in its first beat, by how the beat tracker places beats), or 0 s
 * when the track has too few beats to cut to. Pure.
 */
export function earliestMusicStartSec(beatTimesSec: readonly number[], trackSec: number): number {
  const beats = usableBeats(beatTimesSec, trackSec);
  return beats.length >= MIN_GRID_BEATS ? beats[0]! : 0;
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
 * `sec` rounded down to 0.1 s, allowing for binary rounding: 16.15 − 0.15 is 15.999999999999998 in floating point and
 * gives 16.0, and 45.3 − 45 gives 0.3. Pure.
 */
export function floorToTenth(sec: number): number {
  return Math.floor(sec * 10 + EPSILON) / 10;
}

/**
 * The length to plan an edit to when it plays a track of `trackSec` from its first usable beat (`musicStartSec`, see
 * {@link earliestMusicStartSec}; 0 s by default). The requested length when the music from there covers it with
 * 0.15 s to spare; otherwise what it leaves (the track less the start and 0.15 s, rounded down to 0.1 s): a 45 s edit
 * with a 40 s track becomes 39.8 s when the first beat is at 0 s, 39.4 s when it is at 0.45 s. Whether a track is long
 * enough to trim to depends on its length alone: it must leave at least 88 % of the requested length after 0.15 s are
 * kept back (and what it leaves from its first beat at least 5 s), otherwise the edit is refused with a message for
 * the owner. The same with a start the owner chose: the planners then start the music on the first beat at or after
 * it, or on the latest beat that still leaves room for this length. Pure; the rules planner, the AI brief, the
 * worker, the generate route and the form all use it.
 */
export function editLengthForTrack(targetSec: number, trackSec: number, musicStartSec = 0): EditLengthForTrack {
  const start = Number.isFinite(musicStartSec) && musicStartSec > 0 ? musicStartSec : 0;
  const room = floorToTenth(trackSec - start - MUSIC_TAIL_SEC);
  if (room + EPSILON >= targetSec) return { ok: true, targetSec, trimmed: false };
  const longEnough = floorToTenth(trackSec - MUSIC_TAIL_SEC) + EPSILON >= Math.max(MIN_TRIMMED_SEC, targetSec * MIN_TRIMMED_SHARE);
  if (!longEnough || room + EPSILON < MIN_TRIMMED_SEC) {
    const edit = Math.round(targetSec);
    return {
      ok: false,
      message:
        Math.round(trackSec) < edit
          ? `The chosen track is ${Math.round(trackSec)} seconds long, which is shorter than the ${edit}-second edit. Choose a longer track or a shorter length.`
          : `From its first beat the chosen track leaves only ${Math.max(0, room)} seconds of music, which is too short for the ${edit}-second edit. Choose a longer track or a shorter length.`,
    };
  }
  return { ok: true, targetSec: room, trimmed: true };
}
