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
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  licence: MusicLicence;
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

/** Why a track cannot be used for an edit of this length, or null. */
export function trackUnusableReason(track: RankableTrack, editSec: number, now: Date = new Date()): string | null {
  if (track.status === 'failed') return "This track couldn't be analysed.";
  if (track.status !== 'ready') return 'Still being analysed.';
  const state = licenceStateOf(track.licence, now);
  if (state === 'not_confirmed') return 'Confirm its licence in Settings → Music first.';
  if (state === 'expired') return 'Its licence has expired.';
  if (track.durationSec !== null && track.durationSec + 0.05 < editSec) return `Shorter than the edit (${formatSeconds(track.durationSec)}).`;
  return null;
}

/**
 * Ranks the owner's own tracks for an edit: +3 per matching genre, +2 per matching mood, +3 for an artist they like,
 * +1 when the tempo suits the style. Unusable tracks (not ready, licence not confirmed or expired, shorter than the
 * edit) are kept in the list, last, with the reason. The top three usable tracks with a positive score get a rank.
 * Nothing is ever chosen automatically: "No music" stays a first-class choice in the form. Deterministic.
 */
export function rankTracksForPreferences(
  tracks: readonly RankableTrack[],
  taste: MusicTaste,
  opts: { durationSec: number; styleId?: StyleId | null; now?: Date; limit?: number },
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
    const unusable = trackUnusableReason(t, opts.durationSec, opts.now);
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
