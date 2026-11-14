import { describe, expect, it } from 'vitest';
import {
  CURATED_REVIEW_INTERVAL_DAYS,
  NOTED_TREND_PLATFORMS,
  TrendsRefreshPayloadSchema,
  formatTrendDateTime,
  isCuratedDueForReview,
  isLiveTrendStale,
  nextManualRefreshAt,
  normaliseHashtag,
  trendLabel,
  youTubeCategoryName,
  type TrendLabelInput,
} from '../src/index.js';

const CLAIM = /trending|viral/i;

describe('trendLabel', () => {
  it('labels a YouTube chart fetch in Melbourne time (daylight saving)', () => {
    // 19:05 UTC on 13 Nov is 6:05 am AEDT on 14 Nov.
    expect(trendLabel({ kind: 'live', provider: 'youtube_chart', fetchedAt: new Date('2026-11-13T19:05:00Z') })).toBe(
      'YouTube AU popular chart (music/movies/gaming) — fetched 14 Nov 2026, 6:05 am',
    );
  });

  it('labels a fetch in standard time and in the afternoon', () => {
    // 20:30 UTC on 1 Jul is 6:30 am AEST on 2 Jul; 02:00 UTC on 9 Sep is 12:00 pm AEST.
    expect(formatTrendDateTime('2026-07-01T20:30:00Z')).toBe('2 Jul 2026, 6:30 am');
    expect(formatTrendDateTime('2026-09-09T02:00:00Z')).toBe('9 Sep 2026, 12:00 pm');
    expect(formatTrendDateTime('2026-09-09T14:15:00Z')).toBe('10 Sep 2026, 12:15 am');
  });

  it('labels an Instagram hashtag fetch with the normalised tag', () => {
    expect(trendLabel({ kind: 'live', provider: 'instagram_hashtag', hashtag: '#SkinFade ', fetchedAt: '2026-11-13T19:05:00Z' })).toBe(
      'Top posts under #skinfade — Instagram, fetched 14 Nov 2026, 6:05 am',
    );
    expect(normaliseHashtag('##Taper')).toBe('taper');
  });

  it('labels noted trends with the person, day and platform', () => {
    expect(trendLabel({ kind: 'noted', notedByName: 'Sam', seenOn: '2026-11-12', platform: 'tiktok' })).toBe('Noted by Sam on 12 Nov 2026 · seen on TikTok');
    expect(trendLabel({ kind: 'noted', notedByName: 'Sam', seenOn: '2026-11-12', platform: 'in_person' })).toBe('Noted by Sam on 12 Nov 2026 · seen on in the shop');
    expect(trendLabel({ kind: 'noted', notedByName: '', seenOn: '2026-11-12', platform: null })).toBe('Noted by a team member on 12 Nov 2026');
  });

  it('labels curated references with their source, or as an editor suggestion without one', () => {
    const reviewed = new Date('2026-11-09T01:00:00Z');
    expect(trendLabel({ kind: 'curated', sourceName: 'Barber guides', sourceUrl: 'https://example.com/a', lastReviewedAt: reviewed })).toBe('Barber guides · last reviewed 9 Nov 2026');
    expect(trendLabel({ kind: 'curated', sourceName: 'Editor suggestion', sourceUrl: '', lastReviewedAt: reviewed })).toBe(
      'Editor suggestion — no external source · last reviewed 9 Nov 2026',
    );
  });

  it('never produces "trending" or "viral", whatever text it is given', () => {
    const at = ['2026-01-01T00:00:00Z', '2026-04-04T16:30:00Z', '2026-10-03T15:30:00Z', '2026-12-31T12:59:00Z'];
    const words = ['Trending sounds', 'VIRAL cuts', 'viralhaircut', 'Sam', '', 'Fresh fades'];
    const inputs: TrendLabelInput[] = [];
    for (const t of at) {
      inputs.push({ kind: 'live', provider: 'youtube_chart', fetchedAt: t });
      for (const w of words) {
        inputs.push({ kind: 'live', provider: 'instagram_hashtag', hashtag: w || 'fade', fetchedAt: t });
        inputs.push({ kind: 'curated', sourceName: w, sourceUrl: 'https://example.com', lastReviewedAt: t });
        inputs.push({ kind: 'curated', sourceName: w, sourceUrl: '', lastReviewedAt: t });
        for (const p of [...NOTED_TREND_PLATFORMS, null]) inputs.push({ kind: 'noted', notedByName: w, seenOn: t.slice(0, 10), platform: p });
      }
    }
    for (const input of inputs) expect(trendLabel(input), JSON.stringify(input)).not.toMatch(CLAIM);
    expect(trendLabel({ kind: 'curated', sourceName: 'TikTok trending page', sourceUrl: 'https://x.test', lastReviewedAt: at[0]! })).toBe(
      'Source named by the owner · last reviewed 1 Jan 2026',
    );
    expect(trendLabel({ kind: 'live', provider: 'instagram_hashtag', hashtag: 'viralfade', fetchedAt: at[0]! })).toMatch(/^Top posts under a watched hashtag — Instagram/);
  });
});

describe('trend timing rules', () => {
  const now = new Date('2026-11-14T00:00:00Z');

  it('marks live items out of date after their stale time', () => {
    expect(isLiveTrendStale(new Date('2026-11-14T00:00:01Z'), now)).toBe(false);
    expect(isLiveTrendStale(new Date('2026-11-14T00:00:00Z'), now)).toBe(true);
    expect(isLiveTrendStale(null, now)).toBe(true);
  });

  it('marks curated references due for review after 180 days', () => {
    expect(isCuratedDueForReview(new Date(now.getTime() - (CURATED_REVIEW_INTERVAL_DAYS - 1) * 86_400_000), now)).toBe(false);
    expect(isCuratedDueForReview(new Date(now.getTime() - CURATED_REVIEW_INTERVAL_DAYS * 86_400_000), now)).toBe(true);
  });

  it('allows a manual refresh 6 hours after a query, or 5 minutes after a failed one', () => {
    const lastQueriedAt = new Date(now.getTime() - 60 * 60_000);
    expect(nextManualRefreshAt({ status: 'pending', lastQueriedAt: null }, now)).toBeNull();
    expect(nextManualRefreshAt({ status: 'ok', lastQueriedAt }, now)?.toISOString()).toBe('2026-11-14T05:00:00.000Z');
    expect(nextManualRefreshAt({ status: 'quota', lastQueriedAt }, now)?.toISOString()).toBe('2026-11-14T05:00:00.000Z');
    expect(nextManualRefreshAt({ status: 'error', lastQueriedAt }, now)).toBeNull();
    expect(nextManualRefreshAt({ status: 'error', lastQueriedAt: new Date(now.getTime() - 60_000) }, now)?.toISOString()).toBe('2026-11-14T00:04:00.000Z');
  });

  it('names the chart categories plainly and accepts the daily refresh payload', () => {
    expect(youTubeCategoryName('10')).toBe('Music');
    expect(youTubeCategoryName('999')).toBe('Other');
    expect(TrendsRefreshPayloadSchema.parse({})).toEqual({ watchId: null });
    expect(TrendsRefreshPayloadSchema.parse({ watchId: 'w1' })).toEqual({ watchId: 'w1' });
  });
});
