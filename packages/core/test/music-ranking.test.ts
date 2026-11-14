import { describe, expect, it } from 'vitest';
import { MusicLicenceSchema } from '../src/music.js';
import { artistsWithoutMatch, musicTasteFrom, rankTracksForPreferences, type RankableTrack } from '../src/music-ranking.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const confirmed = MusicLicenceSchema.parse({ kind: 'catalogue', permitted: { promotionalUse: true, instagram: true }, confirmedByOwnerAt: '2026-11-01T00:00:00.000Z' });

function track(id: string, o: Partial<RankableTrack> = {}): RankableTrack {
  return { id, title: id, artist: '', genres: [], moods: [], bpm: null, durationSec: 60, status: 'ready', licence: confirmed, ...o };
}

const taste = { genres: ['Hip hop', 'lo-fi'], moods: ['upbeat'], artists: ['Kendrick'] };

describe('rankTracksForPreferences', () => {
  it('scores genre, mood, artist and tempo, and explains each match', () => {
    const list = rankTracksForPreferences(
      [
        track('plain'),
        track('genre', { genres: ['hip hop'] }),
        track('all', { genres: ['Hip Hop'], moods: ['Upbeat'], artist: 'Kendrick Lamar', bpm: 96 }),
        track('mood', { moods: ['upbeat'] }),
      ],
      taste,
      { durationSec: 25, styleId: 'beat_montage', now: NOW },
    );
    expect(list.map((t) => t.id)).toEqual(['all', 'genre', 'mood', 'plain']);
    expect(list[0]).toMatchObject({ rank: 1, usable: true, score: 9 });
    expect(list[0]?.reasons).toEqual(['Matches hip hop', 'upbeat', 'by an artist you like', '96 BPM suits the beat-synced montage']);
    expect(list.map((t) => t.rank)).toEqual([1, 2, 3, null]);
  });

  it('lists unusable tracks last with the reason and never ranks them', () => {
    const list = rankTracksForPreferences(
      [
        track('short', { genres: ['hip hop'], durationSec: 12 }),
        track('analysing', { genres: ['hip hop'], status: 'processing' }),
        track('unconfirmed', { genres: ['hip hop'], licence: { ...confirmed, confirmedByOwnerAt: null } }),
        track('expired', { genres: ['hip hop'], licence: { ...confirmed, expiresAt: '2026-01-01T00:00:00.000Z' } }),
        track('fine'),
      ],
      taste,
      { durationSec: 25, now: NOW },
    );
    expect(list[0]).toMatchObject({ id: 'fine', usable: true, rank: null });
    const byId = Object.fromEntries(list.map((t) => [t.id, t]));
    expect(byId['short']?.unusableReason).toMatch(/Shorter than the edit/);
    expect(byId['analysing']?.unusableReason).toBe('Still being analysed.');
    expect(byId['unconfirmed']?.unusableReason).toMatch(/Confirm its licence/);
    expect(byId['expired']?.unusableReason).toMatch(/expired/);
    expect(list.every((t) => t.usable || t.rank === null)).toBe(true);
  });

  it('treats an "I\'m not sure" track as unusable even when the rights box was ticked', () => {
    const unsure = MusicLicenceSchema.parse({ kind: 'unknown', permitted: { promotionalUse: true, instagram: true, tiktok: true }, confirmedByOwnerAt: '2026-11-01T00:00:00.000Z' });
    const list = rankTracksForPreferences([track('unsure', { genres: ['hip hop'], moods: ['upbeat'], licence: unsure }), track('fine')], taste, { durationSec: 25, now: NOW });
    const byId = Object.fromEntries(list.map((t) => [t.id, t]));
    expect(byId['unsure']).toMatchObject({ usable: false, rank: null, unusableReason: 'Confirm its licence in Settings → Music first.' });
    // Matching the taste never lifts an unusable track above a usable one.
    expect(list.map((t) => t.id)).toEqual(['fine', 'unsure']);
  });

  it('never suggests anything without a match, and is deterministic', () => {
    const tracks = [track('b'), track('a')];
    const one = rankTracksForPreferences(tracks, { genres: [], moods: [], artists: [] }, { durationSec: 20, now: NOW });
    expect(one.every((t) => t.rank === null)).toBe(true);
    expect(rankTracksForPreferences(tracks, taste, { durationSec: 20, now: NOW })).toEqual(rankTracksForPreferences([...tracks].reverse(), taste, { durationSec: 20, now: NOW }));
  });

  it('says plainly when no track is by a liked artist', () => {
    expect(artistsWithoutMatch([track('x', { artist: 'Someone Else' })], { artists: ['Drake'] })).toEqual([
      'None of your tracks are by Drake. Look for similar tracks in your music library subscription, then upload them here.',
    ]);
    expect(artistsWithoutMatch([track('x', { artist: 'Drake' })], { artists: ['drake'] })).toEqual([]);
  });

  it('reads taste from preferences saved before genres and artists existed', () => {
    expect(musicTasteFrom({ musicMoods: ['calm'] })).toEqual({ genres: [], moods: ['calm'], artists: [] });
  });
});
