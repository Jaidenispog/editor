/**
 * Business Profile response mappers and error mapping (no network, no database): quota 0 is "waiting for approval",
 * missing values stay null, unknown shapes fail with a plain message, and the module's schedules are valid.
 */
import { describe, expect, it } from 'vitest';
import { JOB_PAYLOAD_SCHEMAS } from '@studio/core';
// The registry first, as main.ts loads it (module files import handlers that import the registry).
import { moduleRefIdFor } from '../src/modules/index.js';
import { BusinessProfileError, UNRECOGNISED_RESPONSE_MESSAGE, mapBusinessProfileError, parseAccounts, parseLocations, parseReviewsPage } from '../src/lib/google/business-profile.js';
import { dailyMetricsUrl, keywordMonths, parseDailyMetrics, parseKeywords, performanceWindows, probeWindow } from '../src/lib/google/business-profile-performance.js';
import { businessProfileModule } from '../src/modules/business_profile/index.js';

const unrecognised = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BusinessProfileError);
    expect((err as BusinessProfileError).kind).toBe('unrecognised');
    expect((err as Error).message).toBe(UNRECOGNISED_RESPONSE_MESSAGE);
    return;
  }
  throw new Error('expected an unrecognised-shape error');
};

describe('mapBusinessProfileError', () => {
  it('treats quota 0 (429, or 403 naming a limit of 0) as waiting for approval, never an error', () => {
    expect(mapBusinessProfileError(429, {}, 'X').kind).toBe('awaiting_approval');
    expect(mapBusinessProfileError(403, { error: { status: 'PERMISSION_DENIED', message: 'Quota exceeded', details: [{ metadata: { quota_limit_value: '0' } }] } }, 'X').kind).toBe('awaiting_approval');
    expect(mapBusinessProfileError(403, { error: { message: 'Quota exceeded for quota metric with limit 0 per minute' } }, 'X').kind).toBe('awaiting_approval');
  });

  it('names the API to turn on, asks to reconnect on 401, and keeps other answers plain', () => {
    const off = mapBusinessProfileError(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }, 'Business Profile Performance API');
    expect(off).toMatchObject({ kind: 'api_disabled' });
    expect(off.message).toBe('Turn on the Business Profile Performance API in your Google Cloud project, then press Check again.');
    expect(mapBusinessProfileError(401, {}, 'X').kind).toBe('reauth');
    expect(mapBusinessProfileError(403, { error: { status: 'PERMISSION_DENIED' } }, 'X').kind).toBe('no_access');
    expect(mapBusinessProfileError(404, {}, 'X').message).toMatch(/choose it again/);
    expect(mapBusinessProfileError(503, {}, 'X').kind).toBe('transient');
  });
});

describe('discovery and reviews parsing', () => {
  it('keeps only well-formed account and location names, with a one-line address', () => {
    expect(parseAccounts({ accounts: [{ name: 'accounts/1' }, { name: '../evil' }, {}] })).toEqual(['accounts/1']);
    expect(parseLocations('accounts/1', { locations: [{ name: 'locations/2', title: 'Studio', storefrontAddress: { addressLines: ['1 High St'], locality: 'Ivanhoe', administrativeArea: 'VIC', postalCode: '3079' } }, { name: 'locations/../x' }] })).toEqual([
      { account: 'accounts/1', name: 'locations/2', title: 'Studio', address: '1 High St, Ivanhoe, VIC, 3079' },
    ]);
    unrecognised(() => parseLocations('accounts/1', { locations: 'nope' }));
  });

  it('maps star ratings, anonymous reviewers, replies, and keeps Google’s reply state and policy flag', () => {
    const page = parseReviewsPage({
      reviews: [
        { reviewId: 'a', starRating: 'FIVE', reviewer: { displayName: 'Sam' }, comment: 'Great', createTime: '2026-10-01T00:00:00Z', updateTime: '2026-10-02T00:00:00Z', reviewReply: { comment: 'Thanks', updateTime: '2026-10-02T00:00:00Z' }, reviewReplyState: 'REPLY_PUBLISHED' },
        { reviewId: 'b', starRating: 'STAR_RATING_UNSPECIFIED', reviewer: { displayName: 'Hidden', isAnonymous: true }, updateTime: '2026-10-03T00:00:00Z', policyViolation: { type: 'SPAM' } },
      ],
      averageRating: 4.5,
      totalReviewCount: 2,
      nextPageToken: 'p2',
    });
    expect(page.nextPageToken).toBe('p2');
    expect(page.totalReviewCount).toBe(2);
    expect(page.reviews.map((r) => [r.externalReviewId, r.rating, r.reviewerName, r.replyText, r.reviewReplyState])).toEqual([
      ['a', 5, 'Sam', 'Thanks', 'REPLY_PUBLISHED'],
      ['b', null, 'Anonymous', null, null],
    ]);
    expect(page.reviews[1]?.policyViolation).toEqual({ type: 'SPAM' });
    expect(parseReviewsPage({}).reviews).toEqual([]);
  });

  it('fails with a plain message on an unknown reviews shape', () => {
    unrecognised(() => parseReviewsPage({ reviews: {} }));
    unrecognised(() => parseReviewsPage({ reviews: [{ reviewId: 'x', starRating: 'FIVE' }] }));
  });
});

describe('Performance parsing', () => {
  it('stores a missing value as null (never 0), reads int64 strings, and ignores metrics it did not ask for', () => {
    const rows = parseDailyMetrics({
      multiDailyMetricTimeSeries: [
        {
          dailyMetricTimeSeries: [
            { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 1 }, value: '12' }, { date: { year: 2026, month: 11, day: 2 } }, { date: { year: 2026, month: 11, day: 3 }, value: '0' }] } },
            { dailyMetric: 'BUSINESS_CONVERSATIONS', timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 1 }, value: '9' }] } },
          ],
        },
      ],
    });
    expect(rows).toEqual([
      { date: '2026-11-01', metric: 'CALL_CLICKS', value: 12 },
      { date: '2026-11-02', metric: 'CALL_CLICKS', value: null },
      { date: '2026-11-03', metric: 'CALL_CLICKS', value: 0 },
    ]);
    expect(parseDailyMetrics({})).toEqual([]);
  });

  it('fails with a plain message on an unknown Performance shape', () => {
    unrecognised(() => parseDailyMetrics({ multiDailyMetricTimeSeries: { a: 1 } }));
    unrecognised(() => parseDailyMetrics({ multiDailyMetricTimeSeries: [{ timeSeries: [] }] }));
    unrecognised(() => parseDailyMetrics({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: '2026-11-01', value: '1' }] } }] }] }));
    unrecognised(() => parseDailyMetrics({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 1 }, value: 'lots' }] } }] }] }));
    unrecognised(() => parseKeywords({ searchKeywordsCounts: [{ searchKeyword: 'barber', insightsValue: {} }] }));
  });

  it('keeps "fewer than N" keywords as thresholds', () => {
    expect(parseKeywords({ searchKeywordsCounts: [{ searchKeyword: 'barber', insightsValue: { value: '40' } }, { searchKeyword: 'fade', insightsValue: { threshold: '15' } }], nextPageToken: 'n' })).toEqual({
      rows: [
        { keyword: 'barber', value: 40, threshold: null },
        { keyword: 'fade', value: null, threshold: 15 },
      ],
      nextPageToken: 'n',
    });
  });

  it('asks for every metric including MESSAGING_CLICKS and never BUSINESS_CONVERSATIONS', () => {
    const url = new URL(dailyMetricsUrl('locations/9', { startDate: '2026-11-01', endDate: '2026-11-07' }));
    expect(url.pathname).toBe('/v1/locations/9:fetchMultiDailyMetricsTimeSeries');
    expect(url.searchParams.getAll('dailyMetrics')).toContain('MESSAGING_CLICKS');
    expect(url.searchParams.getAll('dailyMetrics')).not.toContain('BUSINESS_CONVERSATIONS');
    expect(url.searchParams.get('dailyRange.startDate.day')).toBe('1');
    expect(url.searchParams.get('dailyRange.endDate.day')).toBe('7');
  });

  it('plans windows: 18 months on a backfill, 35 days later; complete months for keywords', () => {
    const back = performanceWindows(true, '2026-11-14');
    expect(back[0]?.startDate).toBe('2025-05-14');
    expect(back.at(-1)?.endDate).toBe('2026-11-14');
    expect(back.length).toBeLessThanOrEqual(7);
    expect(performanceWindows(false, '2026-11-14')).toEqual([{ startDate: '2026-10-11', endDate: '2026-11-14' }]);
    expect(probeWindow('2026-11-14')).toEqual({ startDate: '2026-11-08', endDate: '2026-11-14' });
    expect(keywordMonths(false, '2026-01-10')).toEqual(['2025-11', '2025-12']);
    expect(keywordMonths(true, '2026-11-14')).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  });
});

describe('module registration', () => {
  it('schedules valid payloads in Melbourne time and labels jobs with the shared connection', () => {
    for (const cron of businessProfileModule.crons ?? []) {
      expect(() => JOB_PAYLOAD_SCHEMAS[cron.type].parse(cron.payload)).not.toThrow();
    }
    expect((businessProfileModule.crons ?? []).map((c) => c.key)).toEqual(['gbp_daily', 'gbp_weekly_full', 'business_profile_daily', 'business_profile_performance_weekly']);
    expect(moduleRefIdFor('reviews.gbp.sync', { reason: 'daily' })).toBe('google_business_profile');
    expect(moduleRefIdFor('search.sync', { source: 'business_profile', reason: 'daily' })).toBe('google_business_profile');
    expect(moduleRefIdFor('search.sync', { source: 'search_console', reason: 'daily' })).toBe('google_search_console');
  });
});
