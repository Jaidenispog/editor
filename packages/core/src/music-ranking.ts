import { editLengthForTrack } from './edit-length.js';
import type { MusicFit } from './editing-style.js';
import { licenceStateOf, type MusicLicence } from './music.js';
import { STYLES, type StyleId } from './styles.js';
import { formatSeconds } from './time.js';

/** The owner's music taste (genres, moods and artists they like). Only ever matched against their own library. */
export interface MusicTaste {
  genres: string[];
  moods: string[];
  artists: string[];
}

/** The library facts ranking needs about one track. */
export interface RankableTrack {
  id: string;
  title: string;
  artist: string;
  genres: string[];
  moods: string[];
  bpm: number | null;
  durationSec: number | null;
  /** Where its music can start at the earliest (`earliestMusicStartSec`, its first beat); 0 s when unknown. */
  firstBeatSec?: number;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  licence: MusicLicence;
  /** The track's strongest lift (from its stored energy curve, `findDrop`); null when it has none or was not measured. */
  drop?: { riseDb: number } | null;
}

/** One track's place in the "Suggested for you" list. */
export interface TrackSuggestion {
  id: string;
  score: number;
  /** 1–3 for the suggested tracks, null otherwise. */
  rank: number | null;
  /** Plain reasons, e.g. ["Matches hip hop", "upbeat", "96 BPM suits the beat montage"]. */
  reasons: string[];
  usable: boolean;
  unusableReason?: string;
}

/** Tempo ranges that suit each style (a gentle nudge in the ranking, never a rule). */
const STYLE_BPM: Record<StyleId, [number, number]> = {
  beat_montage: [85, 135],
  cinematic_reveal: [60, 110],
  before_after: [70, 125],
  clean_promo: [80, 125],
  process_story: [70, 115],
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Why a track cannot be used for an edit of this length, or null. Its length is judged by the shared rule the form,
 * the generate route and the planners use (`editLengthForTrack`): a track a little shorter than the edit is usable (it
 * trims the edit), a track too short for that is not.
 */
export function trackUnusableReason(track: RankableTrack, editSec: number, now: Date = new Date()): string | null {
  if (track.status === 'failed') return "This track couldn't be analysed.";
  if (track.status !== 'ready') return 'Still being analysed.';
  const state = licenceStateOf(track.licence, now);
  if (state === 'not_confirmed') return 'Confirm its licence in Settings → Music first.';
  if (state === 'expired') return 'Its licence has expired.';
  if (track.durationSec !== null && !editLengthForTrack(editSec, track.durationSec, track.firstBeatSec ?? 0).ok) {
    return track.durationSec < editSec ? `Shorter than the edit (${formatSeconds(track.durationSec)}).` : `Too short for a ${Math.round(editSec)}-second edit (${formatSeconds(track.durationSec)}).`;
  }
  return null;
}

/** "Trims the edit to 39.8 s" for a usable track a little shorter than the edit (the shared rule), else null. */
export function trackTrimReason(track: Pick<RankableTrack, 'durationSec' | 'firstBeatSec'>, editSec: number): string | null {
  if (track.durationSec === null) return null;
  const length = editLengthForTrack(editSec, track.durationSec, track.firstBeatSec ?? 0);
  return length.ok && length.trimmed ? `Trims the edit to ${length.targetSec} s` : null;
}

/** A track has a clear drop when its strongest lift rises at least this much. */
export const TRACK_DROP_MIN_RISE_DB = 6;

/**
 * Ranks the owner's own tracks for an edit: +3 per matching genre, +2 per matching mood, +3 for an artist they like,
 * +1 when the tempo suits the style. With `fit` (the tempo and energy measured from the owner's own videos and accepted
 * in Settings): +2 when the track's BPM is in the range, +1 when only half or double its BPM is, +1 for a clear drop
 * when the owner's videos have one. Only numbers are compared: nothing is fetched, played or looked up. Unusable tracks (not ready, licence not confirmed or expired, too
 * short for the edit by the shared length rule) are kept in the list, last, with the reason; a track a little shorter
 * than the edit is usable and says it trims the edit ("Trims the edit to 39.8 s"). The top three usable tracks with a
 * positive score get a rank.
 * Nothing is ever chosen automatically: "No music" stays a first-class choice in the form. Deterministic.
 */
export function rankTracksForPreferences(
  tracks: readonly RankableTrack[],
  taste: MusicTaste,
  opts: { durationSec: number; styleId?: StyleId | null; now?: Date; limit?: number; fit?: MusicFit | null },
): TrackSuggestion[] {
  const genres = new Set(taste.genres.map(norm).filter(Boolean));
  const moods = new Set(taste.moods.map(norm).filter(Boolean));
  const artists = taste.artists.map(norm).filter(Boolean);
  const limit = opts.limit ?? 3;
  const scored = tracks.map((t) => {
    const reasons: string[] = [];
    let score = 0;
    const g = t.genres.filter((x) => genres.has(norm(x)));
    if (g.length) {
      score += 3 * g.length;
      reasons.push(`Matches ${g.map((x) => x.toLowerCase()).join(', ')}`);
    }
    const m = t.moods.filter((x) => moods.has(norm(x)));
    if (m.length) {
      score += 2 * m.length;
      reasons.push(m.map((x) => x.toLowerCase()).join(' · '));
    }
    const artist = norm(t.artist);
    if (artist && artists.some((a) => artist === a || artist.includes(a))) {
      score += 3;
      reasons.push('by an artist you like');
    }
    if (opts.styleId && t.bpm) {
      const [lo, hi] = STYLE_BPM[opts.styleId];
      if (t.bpm >= lo && t.bpm <= hi) {
        score += 1;
        reasons.push(`${Math.round(t.bpm)} BPM suits the ${STYLES[opts.styleId].name.toLowerCase()}`);
      }
    }
    const fit = opts.fit;
    if (fit) {
      if (t.bpm && t.bpm >= fit.bpmLow && t.bpm <= fit.bpmHigh) {
        score += 2;
        reasons.push(`Tempo close to your videos (${Math.round(fit.bpmLow)}–${Math.round(fit.bpmHigh)} BPM)`);
      } else if (t.bpm && [t.bpm / 2, t.bpm * 2].some((b) => b >= fit.bpmLow && b <= fit.bpmHigh)) {
        score += 1;
        reasons.push('Half-time feel close to your videos');
      } else if (!t.bpm) reasons.push('tempo unknown');
      if (fit.prefersClearDrop && t.drop && t.drop.riseDb >= TRACK_DROP_MIN_RISE_DB) {
        score += 1;
        reasons.push('Builds to a clear drop, like your videos');
      }
    }
    const unusable = trackUnusableReason(t, opts.durationSec, opts.now);
    const trims = unusable === null ? trackTrimReason(t, opts.durationSec) : null;
    if (trims) reasons.push(trims);
    return { track: t, score, reasons, unusable };
  });
  scored.sort((a, b) => Number(a.unusable !== null) - Number(b.unusable !== null) || b.score - a.score || a.track.title.localeCompare(b.track.title) || a.track.id.localeCompare(b.track.id));
  let rank = 0;
  return scored.map(({ track, score, reasons, unusable }) => {
    const suggested = unusable === null && score > 0 && rank < limit;
    if (suggested) rank++;
    return {
      id: track.id,
      score,
      rank: suggested ? rank : null,
      reasons,
      usable: unusable === null,
      ...(unusable ? { unusableReason: unusable } : {}),
    };
  });
}

/**
 * Artists the owner likes that none of their tracks are by, with a plain next step. No external search happens:
 * the owner finds similar tracks in their own music library subscription and uploads them.
 */
export function artistsWithoutMatch(tracks: readonly Pick<RankableTrack, 'artist'>[], taste: Pick<MusicTaste, 'artists'>): string[] {
  const have = tracks.map((t) => norm(t.artist)).filter(Boolean);
  return taste.artists
    .filter((a) => norm(a) && !have.some((h) => h === norm(a) || h.includes(norm(a))))
    .map((a) => `None of your tracks are by ${a.trim()}. Look for similar tracks in your music library subscription, then upload them here.`);
}

/** Reads the owner's music taste from the editing preferences (genre and artist lists may not exist in older settings). */
export function musicTasteFrom(preferences: { musicMoods: string[]; musicGenres?: string[]; musicArtists?: string[] }): MusicTaste {
  return { genres: preferences.musicGenres ?? [], moods: preferences.musicMoods, artists: preferences.musicArtists ?? [] };
}
