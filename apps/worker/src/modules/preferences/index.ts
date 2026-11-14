import { handlePreferencesRecompute } from '../../handlers/preferences.js';
import { handleReferenceAnalyse } from '../../handlers/reference.js';
import { defineHandler, type WorkerModule } from '../types.js';
import { cleanupRenderLogos } from './brand.js';

/**
 * Worker registrations of the saved preferences, reference video and brand module (WP2). Handlers are wrapped so this
 * file can be loaded before the handler modules finish loading.
 */
export const preferencesModule: WorkerModule = {
  name: 'preferences',
  handlers: [
    defineHandler('preferences.recompute', (ctx, run, payload) => handlePreferencesRecompute(ctx, run, payload)),
    defineHandler('reference.analyse', (ctx, run, payload) => handleReferenceAnalyse(ctx, run, payload)),
  ],
  // Nightly at 3:17 am Melbourne time, so recency decay applies even on days without feedback.
  crons: [{ type: 'preferences.recompute', cron: '17 3 * * *', payload: { reason: 'schedule' }, key: 'nightly' }],
  cleanupTasks: [{ name: 'render logos', run: (ctx) => cleanupRenderLogos(ctx) }],
  refIdFor: (type, payload) => {
    if (type === 'preferences.recompute') return 'preferences';
    if (type === 'reference.analyse') return typeof payload['assetId'] === 'string' ? payload['assetId'] : null;
    return undefined;
  },
};
