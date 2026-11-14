import { handleReviewsGbpSync } from '../../handlers/reviews-gbp.js';
import { defineHandler, type WorkerModule } from '../types.js';

/**
 * Worker registrations of the Google Business Profile module (WP9). Reviews: `reviews.gbp.sync` daily at 5:53 am and a
 * full re-read on Mondays at 6:07 am (Google's API can miss reviews from page 2 on). Performance runs on the website
 * module's queues: `search.sync` (source `business_profile`) daily at 7:47 am, which does nothing until Google has
 * approved access, and a Monday 8:13 am re-probe of `website.connection_check` while approval is pending. All times
 * are Melbourne time; every call to Google is read-only.
 */
export const businessProfileModule: WorkerModule = {
  name: 'business_profile',
  handlers: [defineHandler('reviews.gbp.sync', async (ctx, run, payload) => void (await handleReviewsGbpSync(ctx, run, payload)))],
  crons: [
    { type: 'reviews.gbp.sync', cron: '53 5 * * *', payload: { reason: 'daily' }, key: 'gbp_daily' },
    { type: 'reviews.gbp.sync', cron: '7 6 * * 1', payload: { reason: 'weekly_full' }, key: 'gbp_weekly_full' },
    { type: 'search.sync', cron: '47 7 * * *', payload: { source: 'business_profile', reason: 'daily' }, key: 'business_profile_daily' },
    {
      type: 'website.connection_check',
      cron: '13 8 * * 1',
      payload: { provider: 'business_profile_performance', reason: 'daily' },
      key: 'business_profile_performance_weekly',
    },
  ],
  refIdFor: (type) => (type === 'reviews.gbp.sync' ? 'google_business_profile' : undefined),
};
