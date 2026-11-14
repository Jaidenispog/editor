import { describe, expect, it } from 'vitest';
import {
  CC_BY_NC_REFUSAL,
  MusicLicenceInputSchema,
  MusicLicenceSchema,
  checkMusicForPlatforms,
  clearanceSummary,
  licenceStateOf,
  missingTrackClearance,
  musicClearanceFor,
  normaliseLicence,
  planNameWarning,
  type MusicLicence,
} from '../src/music.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');

function licence(overrides: Partial<Omit<MusicLicence, 'permitted'>> & { permitted?: Partial<MusicLicence['permitted']> } = {}): MusicLicence {
  const { permitted, ...rest } = overrides;
  return MusicLicenceSchema.parse({
    kind: 'catalogue',
    source: 'Soundstripe',
    planName: 'Business',
    confirmedByOwnerAt: '2026-11-01T00:00:00.000Z',
    ...rest,
    permitted: { promotionalUse: true, instagram: true, tiktok: true, ...permitted },
  });
}

describe('licence passport schema', () => {
  it('still reads licences saved before the passport fields existed', () => {
    const old = MusicLicenceSchema.parse({ kind: 'owner_upload', permitted: { promotionalUse: true, instagram: true }, confirmedByOwnerAt: null });
    expect(old.permitted.facebook).toBe(false);
    expect(old.permitted.paidAds).toBe(false);
    expect(old.destinationLock).toBeNull();
    expect(old.planName).toBe('');
  });

  it('fills the passport defaults for raw rows stored before the passport existed', () => {
    const raw = { kind: 'owner_upload', source: '', licenceName: '', proofUrl: '', notes: '', permitted: { promotionalUse: true, instagram: true, tiktok: false, youtube: false, website: false }, attributionRequired: false, attributionText: '', expiresAt: null, confirmedByOwnerAt: '2026-11-01T00:00:00.000Z' } as unknown as MusicLicence;
    const n = normaliseLicence(raw);
    expect(n).toMatchObject({ planName: '', accountHolder: '', destinationLock: null, downloadedAt: null, permitted: { facebook: false, paidAds: false, instagram: true } });
    expect(musicClearanceFor(raw, NOW).state).toBe('cleared');
  });

  it('refuses CC BY-NC tracks and CC BY tracks without a credit line', () => {
    const nc = MusicLicenceInputSchema.safeParse({ kind: 'cc_by_nc', permitted: { promotionalUse: true } });
    expect(nc.success).toBe(false);
    expect(nc.error?.issues[0]?.message).toBe(CC_BY_NC_REFUSAL);
    expect(MusicLicenceInputSchema.safeParse({ kind: 'cc_by', permitted: {} }).success).toBe(false);
    const ok = MusicLicenceInputSchema.parse({ kind: 'cc_by', attributionText: ' Music: Song by Artist (CC BY 4.0) ', permitted: {} });
    expect(ok.attributionRequired).toBe(true);
    expect(ok.attributionText).toBe('Music: Song by Artist (CC BY 4.0)');
  });

  it('locks Meta Sound Collection tracks to Instagram and Facebook', () => {
    const forced = normaliseLicence(licence({ kind: 'meta_sound_collection', permitted: { facebook: true, tiktok: true, youtube: true, website: true } }));
    expect(forced.destinationLock).toBe('meta_only');
    expect(forced.permitted).toMatchObject({ instagram: true, facebook: true, tiktok: false, youtube: false, website: false });
    // The input schema applies the same forcing.
    const parsed = MusicLicenceInputSchema.parse({ kind: 'meta_sound_collection', permitted: { promotionalUse: true, tiktok: true } });
    expect(parsed.destinationLock).toBe('meta_only');
    expect(parsed.permitted.tiktok).toBe(false);
  });

  it('warns (without blocking) about personal library plans', () => {
    expect(planNameWarning('Creator')).toMatch(/don't cover business promotion/);
    expect(planNameWarning('Personal plan')).not.toBeNull();
    expect(planNameWarning('Business')).toBeNull();
  });
});

describe('musicClearanceFor', () => {
  it('lets an edit without music go anywhere', () => {
    const c = musicClearanceFor(null, NOW);
    expect(c.state).toBe('no_music');
    expect(c.blockedPlatforms).toEqual([]);
    expect(clearanceSummary(c)).toBe('No music in this version.');
  });

  it('clears a confirmed promotional licence for the ticked platforms only', () => {
    const c = musicClearanceFor(licence(), NOW);
    expect(c.state).toBe('cleared');
    expect(c.platforms).toEqual(['instagram', 'tiktok']);
    expect(c.blockedPlatforms).toEqual(['youtube', 'website', 'facebook']);
    expect(c.reasons[0]).toMatch(/doesn't cover YouTube, the website and Facebook/);
    expect(clearanceSummary(c)).toBe('Music cleared for: Instagram and TikTok.');
  });

  it('restricts Meta Sound Collection music to Meta destinations', () => {
    const c = musicClearanceFor(licence({ kind: 'meta_sound_collection', permitted: { facebook: true, tiktok: true } }), NOW);
    expect(c.state).toBe('restricted');
    expect(c.destinationLock).toBe('meta_only');
    expect(c.platforms).toEqual(['instagram', 'facebook']);
    expect(c.blockedPlatforms).toContain('tiktok');
    expect(clearanceSummary(c)).toMatch(/For Instagram\/Facebook upload only/);
  });

  it.each([
    ['not confirmed', licence({ confirmedByOwnerAt: null }), /not been confirmed/],
    ['expired', licence({ expiresAt: '2026-10-01T00:00:00.000Z' }), /expired/],
    ['unknown origin', licence({ kind: 'unknown' }), /hasn't been recorded/],
    ['no promotional use', licence({ permitted: { promotionalUse: false } }), /promoting the business/],
    ['non-commercial', licence({ kind: 'cc_by_nc' }), /Non-commercial/],
    ['no platform ticked', licence({ permitted: { instagram: false, tiktok: false } }), /any place/],
  ])('blocks a licence that is %s', (_name, l, reason) => {
    const c = musicClearanceFor(l, NOW);
    expect(c.state).toBe('blocked');
    expect(c.platforms).toEqual([]);
    expect(c.reasons.join(' ')).toMatch(reason);
    expect(clearanceSummary(c)).toMatch(/isn't cleared for business use/);
  });

  it('keeps a future end date and passes on the CC BY credit', () => {
    const c = musicClearanceFor(licence({ kind: 'cc_by', attributionRequired: true, attributionText: 'Music: X by Y', expiresAt: '2027-01-01T00:00:00.000Z' }), NOW);
    expect(c.state).toBe('cleared');
    expect(c.attributionText).toBe('Music: X by Y');
  });

  it('blocks music whose track was removed', () => {
    expect(missingTrackClearance().state).toBe('blocked');
  });

  it('labels the licence chip', () => {
    expect(licenceStateOf(licence(), NOW)).toBe('confirmed');
    expect(licenceStateOf(licence({ confirmedByOwnerAt: null }), NOW)).toBe('not_confirmed');
    expect(licenceStateOf(licence({ expiresAt: '2026-01-01T00:00:00.000Z' }), NOW)).toBe('expired');
    expect(licenceStateOf(licence({ kind: 'meta_sound_collection' }), NOW)).toBe('meta_only');
  });

  it('never labels an "I\'m not sure" track as confirmed, because its exports stay blocked', () => {
    const unsure = licence({ kind: 'unknown', source: '', planName: '' });
    expect(unsure.confirmedByOwnerAt).not.toBeNull();
    expect(musicClearanceFor(unsure, NOW).state).toBe('blocked');
    expect(licenceStateOf(unsure, NOW)).toBe('not_confirmed');
    expect(licenceStateOf({ ...unsure, kind: 'owner_upload' }, NOW)).toBe('confirmed');
  });

  it('keeps the cross-post check for publishing', () => {
    expect(checkMusicForPlatforms(licence(), ['instagram', 'tiktok']).ok).toBe(true);
    const meta = checkMusicForPlatforms(licence({ kind: 'meta_sound_collection', permitted: { tiktok: true } }), ['instagram', 'tiktok']);
    expect(meta.blockedPlatforms).toEqual(['tiktok']);
  });
});
