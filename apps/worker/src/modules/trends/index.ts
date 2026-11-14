import { cleanupTrends, handleTrendsRefresh } from '../../handlers/trends.js';
import { defineHandler, type WorkerModule } from '../types.js';

/**
 * Worker registrations of the trends module (WP3; WP5 adds the Instagram hashtag source to the handler's source
 * list). Handlers are wrapped so this file can be loaded before the handler module finishes loading.
 */
export const trendsModule: WorkerModule = {
  name: 'trends',
  handlers: [defineHandler('trends.refresh', (ctx, run, payload) => handleTrendsRefresh(ctx, run, payload), 2)],
  // Daily at 5:41 am Melbourne time (every enabled watch; manual refreshes are limited by the web app).
  crons: [{ type: 'trends.refresh', cron: '41 5 * * *', payload: { watchId: null }, key: 'daily' }],
  cleanupTasks: [{ name: 'trends', run: (ctx) => cleanupTrends(ctx) }],
  refIdFor: (type, payload) => (type === 'trends.refresh' ? (typeof payload['watchId'] === 'string' ? payload['watchId'] : null) : undefined),
};
