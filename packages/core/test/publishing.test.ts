import { describe, expect, it } from 'vitest';
import {
  CreatePublishPostsSchema,
  MusicLicenceSchema,
  checkMediaForPlatform,
  checkPublishEligibility,
  composeCaption,
  defaultCoverTimeSec,
  derivePostStatus,
  graphemeCount,
  instagramPollDelaySeconds,
  melbourneLocalToUtc,
  methodVariantRefusal,
  resolveSchedule,
  targetActionsFor,
  validateCaption,
  validateEditPlan,
  validatePostLink,
  withoutMusic,
  type AssetProbe,
  type EditPlan,
  type TargetActionFacts,
  type TargetStatus,
} from '../src/index.js';

const confirmed = (over: Record<string, unknown> = {}, permitted: Record<string, boolean> = {}) =>
  MusicLicenceSchema.parse({ kind: 'owner_upload', confirmedByOwnerAt: '2026-11-01T00:00:00Z', permitted: { promotionalUse: true, instagram: true, tiktok: true, ...permitted }, ...over });
const both = ['instagram', 'tiktok'] as const;
const by = (r: ReturnType<typeof checkPublishEligibility>, p: 'instagram' | 'tiktok') => r.perPlatform.find((x) => x.platform === p)!;

describe('checkPublishEligibility (design §3.2)', () => {
  it('allows the standard file everywhere when the plan has no music', () => {
    const r = checkPublishEligibility({ hasMusic: false, licence: null, originalSoundEnabled: false, platforms: [...both] });
    expect(r.perPlatform.every((p) => p.allowedVariants.join() === 'standard' && p.automationAllowedForStandard)).toBe(true);
    expect(r.captionSuffix).toBeNull();
    expect(r.licenceSnapshot).toBeNull();
  });

  it('allows both files on both platforms for a licence covering both', () => {
    const r = checkPublishEligibility({ hasMusic: true, licence: confirmed(), originalSoundEnabled: false, platforms: [...both] });
    expect(by(r, 'instagram')).toMatchObject({ allowedVariants: ['standard', 'no_music'], automationAllowedForStandard: true, downloadLabel: null });
    expect(by(r, 'tiktok').allowedVariants).toEqual(['standard', 'no_music']);
    expect(r.licenceSnapshot?.kind).toBe('owner_upload');
  });

  it('gives TikTok only the music-free file when the licence does not tick TikTok', () => {
    const r = checkPublishEligibility({ hasMusic: true, licence: confirmed({}, { tiktok: false }), originalSoundEnabled: false, platforms: [...both] });
    expect(by(r, 'tiktok')).toMatchObject({ allowedVariants: ['no_music'], automationAllowedForStandard: false, manualStepHint: 'Add a Commercial Sound in the TikTok app if you want music.' });
    expect(by(r, 'tiktok').reasons[0]).toMatch(/doesn't cover TikTok/);
    expect(by(r, 'instagram').allowedVariants).toEqual(['standard', 'no_music']);
  });

  it.each([
    ['unconfirmed', confirmed({ confirmedByOwnerAt: null }), /not been confirmed/],
    ['non-promotional', confirmed({}, { promotionalUse: false }), /promoting the business/],
    ['expired', confirmed({ expiresAt: '2026-01-01T00:00:00Z' }), /expired/],
  ])('blocks every platform for an %s licence', (_n, licence, reason) => {
    const r = checkPublishEligibility({ hasMusic: true, licence, originalSoundEnabled: false, platforms: [...both], now: new Date('2026-11-14T00:00:00Z') });
    for (const p of r.perPlatform) {
      expect(p.allowedVariants).toEqual(['no_music']);
      expect(p.reasons.join(' ')).toMatch(reason);
    }
    expect(by(r, 'instagram').manualStepHint).toMatch(/Add music in the Instagram app/);
  });

  it('treats a deleted track as unknown: music-free only', () => {
    const r = checkPublishEligibility({ hasMusic: true, licence: null, originalSoundEnabled: false, platforms: [...both] });
    expect(r.perPlatform.every((p) => p.allowedVariants.join() === 'no_music')).toBe(true);
    expect(by(r, 'tiktok').reasons).toEqual(["The music track was removed, so its licence can't be checked."]);
  });

  it('locks Meta Sound Collection music to Instagram even if TikTok was ticked, and labels the Instagram file', () => {
    const licence = MusicLicenceSchema.parse({ kind: 'meta_sound_collection', confirmedByOwnerAt: '2026-11-01T00:00:00Z', permitted: { promotionalUse: true, instagram: true, facebook: true, tiktok: true } });
    const r = checkPublishEligibility({ hasMusic: true, licence, originalSoundEnabled: false, platforms: [...both] });
    expect(by(r, 'tiktok')).toMatchObject({ allowedVariants: ['no_music'], reasons: ["This track is from Meta's Sound Collection, which is licensed for Instagram and Facebook only."] });
    expect(by(r, 'instagram')).toMatchObject({ allowedVariants: ['standard', 'no_music'], downloadLabel: 'For Instagram/Facebook upload only' });
    expect(methodVariantRefusal(by(r, 'tiktok'), 'manual', 'standard')).toMatch(/only get the version without music/);
  });

  it('adds the CC BY credit as the caption suffix, and the original-sound note', () => {
    const licence = confirmed({ kind: 'cc_by', attributionText: 'Music: "Fade" by A. Artist (CC BY 4.0)' });
    const r = checkPublishEligibility({ hasMusic: true, licence, originalSoundEnabled: true, platforms: ['instagram'] });
    expect(r.captionSuffix).toBe('Music: "Fade" by A. Artist (CC BY 4.0)');
    expect(r.notes[0]).toMatch(/Instagram's copyright check may flag it/);
  });

  it('refuses automation of a standard file the licence does not cover, never the music-free one', () => {
    const r = checkPublishEligibility({ hasMusic: true, licence: confirmed({}, { instagram: false }), originalSoundEnabled: false, platforms: ['instagram'] });
    expect(methodVariantRefusal(by(r, 'instagram'), 'instagram_api', 'standard')).not.toBeNull();
    expect(methodVariantRefusal(by(r, 'instagram'), 'instagram_api', 'no_music')).toBeNull();
  });
});

describe('removing music keeps a valid plan', () => {
  const plan: EditPlan = {
    version: 1,
    styleId: 'beat_montage',
    title: 'Test',
    description: 'A test plan',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 10,
    segments: [
      { id: 's1', assetId: 'a1', inSec: 0, outSec: 4, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'cutting', keepOriginalSound: false },
      { id: 's2', assetId: 'a2', inSec: 2, outSec: 6, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: { type: 'fade', durationSec: 0.5 }, role: 'fade_detail', keepOriginalSound: false },
      { id: 's3', assetId: 'a1', inSec: 10, outSec: 13, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'result', keepOriginalSound: false },
    ],
    textOverlays: [],
    captions: [],
    audio: { music: { trackId: 'm1', startOffsetSec: 5, volume: 0.8, fadeInSec: 0.3, fadeOutSec: 1, duckUnderOriginal: true }, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'natural',
  };
  const ctx = { assets: [{ id: 'a1', durationSec: 20, hasAudio: true }, { id: 'a2', durationSec: 12, hasAudio: false }], music: { trackId: 'm1', durationSec: 60 }, transcripts: {}, durationBounds: { min: 8, max: 14 } };
  it('validateEditPlan still passes with audio.music = null', () => {
    expect(validateEditPlan(plan, ctx).ok).toBe(true);
    const silent = withoutMusic(plan);
    expect(silent.audio.music).toBeNull();
    expect(validateEditPlan(silent, ctx)).toMatchObject({ ok: true, errors: [] });
  });
  it('defaults the cover to the middle of the last segment', () => {
    // Timeline: 4 + 4 + 3 - 0.5 = 10.5 s; the last segment plays 7.5–10.5.
    expect(defaultCoverTimeSec(plan)).toBe(9);
    expect(defaultCoverTimeSec(null)).toBe(0);
  });
});

describe('Melbourne scheduling', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  it('converts AEST and AEDT dates and labels them', () => {
    expect(melbourneLocalToUtc('2026-07-01', '10:00')).toMatchObject({ ok: true, instant: new Date('2026-07-01T00:00:00Z') });
    expect(melbourneLocalToUtc('2026-12-01', '10:00')).toMatchObject({ ok: true, instant: new Date('2026-11-30T23:00:00Z') });
    const r = resolveSchedule({ date: '2026-10-10', time: '10:00' }, now);
    expect(r.ok && r.label).toMatch(/AEDT$/);
  });
  it('refuses the nonexistent hour and marks the repeated one', () => {
    const gap = resolveSchedule({ date: '2026-10-04', time: '02:30' }, now);
    expect(gap.ok).toBe(false);
    expect(!gap.ok && gap.message).toMatch(/doesn't exist/);
    const amb = resolveSchedule({ date: '2027-04-04', time: '02:30' }, new Date('2027-03-01T00:00:00Z'));
    expect(amb).toMatchObject({ ok: true, ambiguous: true, instant: new Date('2027-04-03T15:30:00Z') });
    expect(amb.ok && amb.label).toMatch(/first time/);
    expect(melbourneLocalToUtc('2027-04-04', '03:30')).toMatchObject({ ok: true, instant: new Date('2027-04-03T17:30:00Z'), ambiguous: false });
  });
  it('keeps the 10 minute to 90 day window and refuses invalid input', () => {
    expect(resolveSchedule({ date: '2026-09-30', time: '10:05' }, new Date('2026-09-30T00:00:00Z'))).toMatchObject({ ok: false });
    expect(resolveSchedule({ date: '2027-01-15', time: '10:00' }, now)).toMatchObject({ ok: false });
    expect(resolveSchedule({ date: '2026-02-30', time: '10:00' }, now)).toMatchObject({ ok: false, message: 'Enter a real date and time.' });
    expect(resolveSchedule({ date: '2026-09-29', time: '10:00' }, now).ok).toBe(false);
  });
});

describe('checkMediaForPlatform', () => {
  const probe = (over: Partial<AssetProbe> = {}, v: Partial<NonNullable<AssetProbe['video']>> = {}): AssetProbe => ({
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSec: 20,
    fileSizeBytes: 30_000_000,
    video: { codec: 'h264', codedWidth: 1080, codedHeight: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, fps: 30, pixelFormat: 'yuv420p', bitDepth: 8, colour: {} as never, isHdr: false, hdrFormat: null, bitrate: 12_000_000, ...v },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, bitrate: 128_000 },
    ...over,
  });
  it('passes the Stage A export shape on both platforms', () => {
    expect(checkMediaForPlatform(probe(), 30_000_000, 'instagram', { method: 'instagram_api' }).ok).toBe(true);
    expect(checkMediaForPlatform(probe(), 30_000_000, 'tiktok').ok).toBe(true);
  });
  it('checks the boundaries', () => {
    expect(checkMediaForPlatform(probe({ durationSec: 2.9 }), 1, 'instagram').issues[0]?.code).toBe('too_short');
    expect(checkMediaForPlatform(probe({ durationSec: 3 }), 1, 'instagram').ok).toBe(true);
    expect(checkMediaForPlatform(probe({}, { fps: 61 }), 1, 'instagram').issues[0]?.code).toBe('fps');
    expect(checkMediaForPlatform(probe({}, { displayWidth: 1921 }), 1, 'instagram').issues[0]?.code).toBe('width');
    expect(checkMediaForPlatform(probe(), 300 * 1024 * 1024 + 1, 'instagram').issues[0]?.code).toBe('too_large');
    expect(checkMediaForPlatform(probe({}, { bitrate: 26_000_000 }), 1, 'instagram').issues[0]?.code).toBe('bitrate');
    expect(checkMediaForPlatform(probe({ audio: { codec: 'aac', sampleRate: 48_000, channels: 2, bitrate: 192_000 } }), 1, 'instagram').issues[0]?.code).toBe('audio_bitrate');
    expect(checkMediaForPlatform(probe({ container: 'matroska,webm' }, { codec: 'vp9' }), 1, 'instagram').issues.map((i) => i.code)).toEqual(['container', 'codec']);
    expect(checkMediaForPlatform(probe({ container: 'matroska,webm' }, { codec: 'vp9' }), 1, 'tiktok').ok).toBe(true);
    expect(checkMediaForPlatform(probe({ durationSec: 601 }), 1, 'tiktok').issues[0]?.code).toBe('too_long');
  });
  it('routes a file over the resumable cap to manual posting', () => {
    const r = checkMediaForPlatform(probe(), 104_857_601, 'instagram', { method: 'instagram_api' });
    expect(r).toMatchObject({ ok: false, manualStep: 'file_too_large_for_upload' });
    expect(checkMediaForPlatform(probe(), 104_857_601, 'instagram', { method: 'manual' }).ok).toBe(true);
    expect(checkMediaForPlatform(probe(), 200_000_000, 'instagram', { method: 'instagram_api', resumableMaxBytes: 300 * 1024 * 1024 }).ok).toBe(true);
  });
});

describe('captions', () => {
  it('counts graphemes, so one emoji counts once', () => {
    expect(graphemeCount('👨‍👩‍👧‍👦✂️')).toBe(2);
    expect(validateCaption('a'.repeat(2200), null).ok).toBe(true);
    expect(validateCaption('a'.repeat(2201), null).ok).toBe(false);
    expect(validateCaption('💈'.repeat(2200), null)).toMatchObject({ ok: true, length: 2200 });
  });
  it('appends the credit line exactly once and counts it', () => {
    const credit = 'Music: Track by Artist (CC BY 4.0)';
    const once = composeCaption('Fresh fade', credit);
    expect(once).toBe(`Fresh fade\n\n${credit}`);
    expect(composeCaption(once, credit)).toBe(once);
    expect(validateCaption('a'.repeat(2190), credit).ok).toBe(false);
  });
  it('warns, never blocks, above 30 hashtags', () => {
    const r = validateCaption(Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' '), null);
    expect(r).toMatchObject({ ok: true, hashtags: 31 });
    expect(r.warnings).toHaveLength(1);
  });
});

describe('derivePostStatus', () => {
  const s = (...xs: TargetStatus[]) => xs.map((status) => ({ status }));
  it.each([
    [false, s('queued'), 'draft'],
    [true, s('queued', 'queued'), 'approved'],
    [true, s('processing', 'queued'), 'in_progress'],
    [true, s('published', 'queued'), 'in_progress'],
    [true, s('published', 'published'), 'complete'],
    [true, s('published', 'failed'), 'partial'],
    [true, s('published', 'manual_step_required'), 'partial'],
    [true, s('manual_step_required', 'manual_step_required'), 'in_progress'],
    [true, s('failed', 'manual_step_required'), 'in_progress'],
    [true, s('failed', 'failed'), 'failed'],
    [true, s('failed', 'cancelled'), 'failed'],
    [true, s('cancelled', 'cancelled'), 'cancelled'],
    [true, s('published', 'cancelled'), 'partial'],
  ] as const)('approved=%s %j → %s', (approved, targets, expected) => {
    expect(derivePostStatus(approved, targets)).toBe(expected);
  });
});

describe('target actions', () => {
  const base: TargetActionFacts = { status: 'queued', method: 'manual', manualStep: null, variant: 'standard', submittedAt: null, publishedUrl: null, confirmedAt: null, mediaReady: false, retryable: true };
  it('offers the right buttons per state', () => {
    expect(targetActionsFor(base)).toEqual(['cancel']);
    expect(targetActionsFor({ ...base, status: 'manual_step_required', manualStep: 'post_in_app', mediaReady: true })).toEqual(['download', 'confirm', 'cancel']);
    expect(targetActionsFor({ ...base, method: 'instagram_api', status: 'manual_step_required', manualStep: 'review_copyright_match' })).toEqual(['post_without_music', 'post_manually', 'cancel']);
    expect(targetActionsFor({ ...base, method: 'instagram_api', status: 'manual_step_required', manualStep: 'review_copyright_match', variant: 'no_music' })).toEqual(['post_manually', 'cancel']);
    expect(targetActionsFor({ ...base, method: 'instagram_api', status: 'manual_step_required', manualStep: 'check_before_retry' })).toEqual(['confirm', 'retry_anyway']);
    expect(targetActionsFor({ ...base, method: 'instagram_api', status: 'failed' })).toEqual(['retry', 'post_manually']);
    expect(targetActionsFor({ ...base, method: 'instagram_api', status: 'failed', retryable: false })).toEqual(['post_manually']);
    expect(targetActionsFor({ ...base, status: 'published', confirmedAt: new Date() })).toEqual(['undo', 'confirm']);
    expect(targetActionsFor({ ...base, method: 'instagram_api', status: 'published', publishedUrl: 'https://www.instagram.com/reel/abcde/' })).toEqual([]);
    expect(targetActionsFor({ ...base, method: 'instagram_api', status: 'queued', submittedAt: new Date() })).toEqual([]);
  });
});

describe('post links', () => {
  it('accepts only real Instagram and TikTok post links', () => {
    expect(validatePostLink('instagram', 'https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=xyz')).toBe('https://www.instagram.com/reel/C1a2B3c4D5e/');
    expect(validatePostLink('instagram', 'https://instagram.com/p/C1a2B3c4D5e')).toBe('https://www.instagram.com/p/C1a2B3c4D5e/');
    expect(validatePostLink('instagram', 'https://www.instagram.com.evil.com/reel/C1a2B3c4D5e/')).toBeNull();
    expect(validatePostLink('instagram', 'http://www.instagram.com/reel/C1a2B3c4D5e/')).toBeNull();
    expect(validatePostLink('instagram', 'https://www.instagram.com/ivanhoe/')).toBeNull();
    expect(validatePostLink('tiktok', 'https://www.tiktok.com/@ivanhoe.cuts/video/7312345678901234567?lang=en')).toBe('https://www.tiktok.com/@ivanhoe.cuts/video/7312345678901234567');
    expect(validatePostLink('tiktok', 'https://vm.tiktok.com/ZSabc123/')).toBe('https://vm.tiktok.com/ZSabc123/');
    expect(validatePostLink('tiktok', 'https://www.instagram.com/reel/C1a2B3c4D5e/')).toBeNull();
    expect(validatePostLink('tiktok', 'javascript:alert(1)')).toBeNull();
  });
});

describe('request contracts and polling', () => {
  const item = { editVersionId: 'v', caption: 'x', coverTimeSec: 1, mode: 'now' as const, targets: [{ platform: 'instagram' as const, method: 'manual' as const, variant: 'standard' as const }] };
  it('caps a batch at 5 videos, refuses a platform twice and needs a schedule for scheduled posts', () => {
    expect(CreatePublishPostsSchema.safeParse({ items: Array.from({ length: 5 }, () => item) }).success).toBe(true);
    expect(CreatePublishPostsSchema.safeParse({ items: Array.from({ length: 6 }, () => item) }).success).toBe(false);
    expect(CreatePublishPostsSchema.safeParse({ items: [] }).success).toBe(false);
    expect(CreatePublishPostsSchema.safeParse({ items: [{ ...item, targets: [item.targets[0], item.targets[0]] }] }).success).toBe(false);
    expect(CreatePublishPostsSchema.safeParse({ items: [{ ...item, mode: 'scheduled' }] }).success).toBe(false);
    expect(CreatePublishPostsSchema.safeParse({ items: [{ ...item, mode: 'draft_handoff', targets: [{ platform: 'instagram', method: 'instagram_api', variant: 'standard' }] }] }).success).toBe(false);
  });
  it('polls every minute five times, then every five minutes until the container is a day old', () => {
    expect(instagramPollDelaySeconds(0, 0)).toBe(60);
    expect(instagramPollDelaySeconds(5, 400)).toBe(300);
    expect(instagramPollDelaySeconds(40, 24 * 3600 - 100)).toBeNull();
  });
});
