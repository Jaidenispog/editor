import { describe, expect, it } from 'vitest';
import {
  ApprovePublishPostsSchema,
  ZernioCreatePostBodySchema,
  buildZernioCreateBody,
  disabledInteractionChoices,
  interactionSeedsFrom,
  zernioBindingMatches,
  zernioLookupDelaySeconds,
  zernioPollDelaySeconds,
  zernioWebhookEnvelope,
  type ZernioBinding,
} from '../src/index.js';

describe('Zernio create body (design §7.2.4 step 5b)', () => {
  const base = { targetId: 't1', caption: 'Fresh fade', mediaUrl: 'https://media.example/v.mp4', zernioAccountId: 'acc1', interactions: { allowComment: true, allowDuet: false, allowStitch: true }, coverTimeSec: 7.25, delivery: 'publish' as const };

  it('carries both consent flags, public privacy, the three choices, the cover, the metadata and nothing else', () => {
    expect(buildZernioCreateBody(base)).toEqual({
      content: 'Fresh fade',
      mediaItems: [{ type: 'video', url: 'https://media.example/v.mp4' }],
      platforms: [{ platform: 'tiktok', accountId: 'acc1' }],
      tiktokSettings: { privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: false, allow_stitch: true, content_preview_confirmed: true, express_consent_given: true, video_cover_timestamp_ms: 7250 },
      publishNow: true,
      metadata: { studioTargetId: 't1' },
    });
  });

  it('a draft adds draft: true inside tiktokSettings and keeps publishNow', () => {
    const body = buildZernioCreateBody({ ...base, delivery: 'draft' });
    expect(body.tiktokSettings.draft).toBe(true);
    expect(body.publishNow).toBe(true);
  });

  it('refuses unknown or forbidden fields', () => {
    const body = buildZernioCreateBody(base);
    expect(ZernioCreatePostBodySchema.safeParse({ ...body, isDraft: true }).success).toBe(false);
    expect(ZernioCreatePostBodySchema.safeParse({ ...body, tiktokSettings: { ...body.tiktokSettings, publish_type: 'x' } }).success).toBe(false);
    expect(ZernioCreatePostBodySchema.safeParse({ ...body, tiktokSettings: { ...body.tiktokSettings, privacy_level: 'SELF_ONLY' } }).success).toBe(false);
    expect(ZernioCreatePostBodySchema.safeParse({ ...body, tiktokSettings: { ...body.tiktokSettings, express_consent_given: false } }).success).toBe(false);
  });
});

describe('approval binding and interactions', () => {
  const binding: ZernioBinding = { caption: 'A', coverTimeSec: 3, variant: 'standard', delivery: 'publish', accountRowId: 'r1', handle: 'shop', interactions: { allowComment: true, allowDuet: false, allowStitch: false } };
  it('matches only the exact change and destination the owner saw', () => {
    expect(zernioBindingMatches(binding, { ...binding, handle: 'SHOP' })).toBe(true);
    expect(zernioBindingMatches(binding, { ...binding, caption: 'B' })).toBe(false);
    expect(zernioBindingMatches(binding, { ...binding, coverTimeSec: 4 })).toBe(false);
    expect(zernioBindingMatches(binding, { ...binding, variant: 'no_music' })).toBe(false);
    expect(zernioBindingMatches(binding, { ...binding, delivery: 'draft' })).toBe(false);
    expect(zernioBindingMatches(binding, { ...binding, accountRowId: 'r2' })).toBe(false);
    expect(zernioBindingMatches(binding, { ...binding, interactions: { ...binding.interactions, allowDuet: true } })).toBe(false);
  });

  it('reads creator-info seeds and finds switches TikTok turned off', () => {
    expect(interactionSeedsFrom({})).toBeNull();
    const seeds = interactionSeedsFrom({ allowCommentEnabled: true, allowCommentDefault: true, allowDuetEnabled: true, allowDuetDefault: false, allowStitchEnabled: false, allowStitchDefault: true })!;
    expect(seeds.allowStitch).toEqual({ enabled: false, default: false });
    expect(disabledInteractionChoices({ allowComment: true, allowDuet: true, allowStitch: true }, seeds)).toEqual(['allowStitch']);
    expect(disabledInteractionChoices({ allowComment: true, allowDuet: false, allowStitch: false }, seeds)).toEqual([]);
  });

  it('the approve body accepts the interaction choices', () => {
    const parsed = ApprovePublishPostsSchema.parse({ postIds: ['p'], consent: { tiktokPublic: true, tiktokInteractions: { allowComment: true, allowDuet: false, allowStitch: false } } });
    expect(parsed.consent?.tiktokInteractions).toEqual({ allowComment: true, allowDuet: false, allowStitch: false });
  });
});

describe('poll and lookup schedules', () => {
  it('reads at 1, 2, 5 and 10 minutes, every 15 minutes to 6 hours, then hourly to 50 hours', () => {
    expect(zernioPollDelaySeconds(0)).toBe(60);
    expect(zernioPollDelaySeconds(60)).toBe(60);
    expect(zernioPollDelaySeconds(120)).toBe(180);
    expect(zernioPollDelaySeconds(300)).toBe(300);
    expect(zernioPollDelaySeconds(600)).toBe(900);
    expect(zernioPollDelaySeconds(1500)).toBe(900);
    expect(zernioPollDelaySeconds(6 * 3600)).toBe(3600);
    expect(zernioPollDelaySeconds(7 * 3600 + 600)).toBe(3000);
    expect(zernioPollDelaySeconds(50 * 3600)).toBeNull();
    // The whole schedule stays inside the 50-hour window and never waits more than an hour.
    let t = 60;
    let n = 0;
    for (;;) {
      const d = zernioPollDelaySeconds(t);
      if (d === null) break;
      expect(d).toBeLessThanOrEqual(3600);
      t += d;
      n++;
    }
    expect(t).toBeLessThanOrEqual(50 * 3600);
    expect(n).toBeGreaterThan(60);
  });

  it('always reads once more at exactly 50 hours, so the end of the window is reached and then ends', () => {
    // The last read lands on the window's end, whatever the grid; the read after it is null (check before retry).
    let t = 60;
    for (;;) {
      const d = zernioPollDelaySeconds(t);
      if (d === null) break;
      t += d;
    }
    expect(t).toBe(50 * 3600);
    // Part-way through the last hour, the next read is the window's end itself, not null.
    expect(zernioPollDelaySeconds(49.33 * 3600)).toBe(Math.round(50 * 3600 - 49.33 * 3600));
    expect(zernioPollDelaySeconds(49.5 * 3600)).toBe(1800);
    expect(zernioPollDelaySeconds(50 * 3600 - 100)).toBe(100);
    expect(zernioPollDelaySeconds(50 * 3600 + 60)).toBeNull();
  });

  it('looks a post up four times, honouring Retry-After', () => {
    expect([0, 1, 2, 3, 4].map((a) => zernioLookupDelaySeconds(a))).toEqual([60, 60, 180, 300, null]);
    expect(zernioLookupDelaySeconds(0, 120)).toBe(120);
  });
});

describe('webhook envelope (plan §10.3: ids and type only)', () => {
  it('keeps only ids and the event name', () => {
    const env = zernioWebhookEnvelope({
      id: 'evt_1',
      event: 'post.platform.published',
      timestamp: '2026-11-15T00:00:00Z',
      post: { id: 'p1', content: 'the caption', metadata: { studioTargetId: 't1' } },
      platform: { name: 'tiktok', publishedUrl: 'https://www.tiktok.com/@x/video/1' },
      account: { accountId: 'a1', username: 'shop' },
    });
    expect(env).toEqual({ id: 'evt_1', event: 'post.platform.published', postId: 'p1', studioTargetId: 't1', platform: 'tiktok', accountId: 'a1' });
    expect(JSON.stringify(env)).not.toContain('caption');
    expect(zernioWebhookEnvelope('nonsense')).toEqual({ id: null, event: 'unknown', postId: null, studioTargetId: null, platform: null, accountId: null });
  });
});
