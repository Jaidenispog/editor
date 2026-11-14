import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from '../../src/lib/google/oauth.js';
import { fakeFetch, json, type FakeCall } from '../helpers/fakes.js';

/** A Google review as the fake returns it (v4 `reviews.list` shape described in the email design §8.3). */
export interface FakeReview {
  reviewId: string;
  starRating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  displayName?: string;
  isAnonymous?: boolean;
  createTime: string;
  updateTime: string;
  reply?: string;
  reviewReplyState?: string;
  policyViolation?: unknown;
  /** Left out of every page while true (simulates Google's "missing from page 2 onward" known issue). */
  hidden?: boolean;
}

/**
 * An in-memory fake of the Business Profile APIs answering through the worker's injected `fetch` (no network): the
 * token endpoint, account and location discovery, v4 reviews (page size 2 so paging is exercised) and Performance.
 * `quotaZero` answers 429 like a project Google has not approved yet. Every call is recorded.
 */
export function fakeBusinessProfile() {
  const state = {
    grant: 'ok' as 'ok' | 'invalid',
    quotaZero: false,
    performanceQuotaZero: false,
    performanceShape: 'ok' as 'ok' | 'weird',
    accounts: ['accounts/111'],
    locations: [{ name: 'locations/222', title: 'Ivanhoe Barber Co', storefrontAddress: { addressLines: ['12 Upper Heidelberg Rd'], locality: 'Ivanhoe', administrativeArea: 'VIC', postalCode: '3079' } }] as Array<Record<string, unknown>>,
    reviews: [] as FakeReview[],
    pageSize: 2,
    /** Daily values: metric → date → value (undefined = listed without a value). */
    daily: {} as Record<string, Record<string, string | number | undefined>>,
    keywords: [] as Array<{ searchKeyword: string; insightsValue: Record<string, string> }>,
    refreshes: 0,
    revoked: 0,
    /** Leaves Google's averageRating and totalReviewCount out of the reviews answer. */
    omitTotals: false,
    /** Called before a reviews page is answered, with the page's offset (tests use it to act between pages). */
    beforeReviewsPage: null as null | ((offset: number) => Promise<void>),
    /** Called before the locations list is answered (tests use it to act while discovery runs). */
    beforeLocations: null as null | (() => Promise<void>),
    /** Called before a Performance request is answered (tests use it to act while a probe or sync runs). */
    beforePerformance: null as null | (() => Promise<void>),
  };
  const quota = () => json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'.", details: [{ metadata: { quota_limit_value: '0' } }] } });
  const respond = async (call: FakeCall): Promise<Response> => {
    const url = new URL(call.url);
    if (call.url === GOOGLE_REVOKE_URL) {
      state.revoked++;
      return json(200, {});
    }
    if (call.url === GOOGLE_TOKEN_URL) {
      state.refreshes++;
      return state.grant === 'ok' ? json(200, { access_token: `access-${state.refreshes}`, expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) : json(400, { error: 'invalid_grant' });
    }
    if (call.headers['authorization'] !== `Bearer access-${state.refreshes}`) return json(401, { error: { code: 401 } });
    if (url.hostname === 'businessprofileperformance.googleapis.com') {
      if (state.beforePerformance) await state.beforePerformance();
      if (state.performanceQuotaZero || state.quotaZero) return quota();
      if (url.pathname.endsWith(':fetchMultiDailyMetricsTimeSeries')) {
        if (state.performanceShape === 'weird') return json(200, { multiDailyMetricTimeSeries: [{ series: 'unexpected' }] });
        const start = `${url.searchParams.get('dailyRange.startDate.year')}-${url.searchParams.get('dailyRange.startDate.month')?.padStart(2, '0')}-${url.searchParams.get('dailyRange.startDate.day')?.padStart(2, '0')}`;
        const end = `${url.searchParams.get('dailyRange.endDate.year')}-${url.searchParams.get('dailyRange.endDate.month')?.padStart(2, '0')}-${url.searchParams.get('dailyRange.endDate.day')?.padStart(2, '0')}`;
        const metrics = url.searchParams.getAll('dailyMetrics');
        return json(200, {
          multiDailyMetricTimeSeries: [
            {
              dailyMetricTimeSeries: metrics.map((metric) => ({
                dailyMetric: metric,
                timeSeries: {
                  datedValues: Object.entries(state.daily[metric] ?? {})
                    .filter(([d]) => d >= start && d <= end)
                    .map(([d, v]) => {
                      const [year, month, day] = d.split('-').map(Number);
                      return v === undefined ? { date: { year, month, day } } : { date: { year, month, day }, value: v };
                    }),
                },
              })),
            },
          ],
        });
      }
      if (url.pathname.endsWith('/searchkeywords/impressions/monthly')) return json(200, { searchKeywordsCounts: state.keywords });
      return json(404, {});
    }
    if (state.quotaZero) return quota();
    if (url.hostname === 'mybusinessaccountmanagement.googleapis.com' && url.pathname === '/v1/accounts') return json(200, { accounts: state.accounts.map((name) => ({ name, accountName: 'Studio' })) });
    if (url.hostname === 'mybusinessbusinessinformation.googleapis.com' && url.pathname.endsWith('/locations')) {
      if (state.beforeLocations) await state.beforeLocations();
      return json(200, { locations: state.locations });
    }
    if (url.hostname === 'mybusiness.googleapis.com' && url.pathname.endsWith('/reviews')) {
      const visible = state.reviews.filter((r) => !r.hidden).sort((a, b) => b.updateTime.localeCompare(a.updateTime));
      const offset = Number(url.searchParams.get('pageToken') ?? '0');
      if (state.beforeReviewsPage) await state.beforeReviewsPage(offset);
      const page = visible.slice(offset, offset + state.pageSize);
      const more = offset + state.pageSize < visible.length;
      return json(200, {
        reviews: page.map((r) => ({
          name: `accounts/111/locations/222/reviews/${r.reviewId}`,
          reviewId: r.reviewId,
          reviewer: { displayName: r.displayName ?? 'Client', isAnonymous: r.isAnonymous ?? false },
          starRating: r.starRating,
          comment: r.comment ?? '',
          createTime: r.createTime,
          updateTime: r.updateTime,
          ...(r.reply ? { reviewReply: { comment: r.reply, updateTime: r.updateTime } } : {}),
          ...(r.reviewReplyState ? { reviewReplyState: r.reviewReplyState } : {}),
          ...(r.policyViolation ? { policyViolation: r.policyViolation } : {}),
        })),
        ...(state.omitTotals ? {} : { averageRating: 4.5, totalReviewCount: visible.length }),
        ...(more ? { nextPageToken: String(offset + state.pageSize) } : {}),
      });
    }
    return json(404, {});
  };
  const fetch = fakeFetch(respond);
  return { state, fetch };
}
