import { handlePublishDispatch } from '../../handlers/publish-dispatch.js';
import { handlePublishPoll } from '../../handlers/publish-poll.js';
import { handlePublishPrepare, preparePostsWaitingFor } from '../../handlers/publish-prepare.js';
import { handlePublishTarget } from '../../handlers/publish-target.js';
import { handleSocialCheck } from '../../handlers/social-check.js';
import { defineHandler, type WorkerModule } from '../types.js';

/**
 * Worker registrations of the publishing module (WP4; WP10 adds the Zernio webhook handler and branches). Handlers are
 * wrapped so this file can be loaded before the handler modules finish loading.
 */
export const publishingModule: WorkerModule = {
  name: 'publishing',
  handlers: [
    defineHandler('publish.prepare', (ctx, run, payload) => handlePublishPrepare(ctx, run, payload), 1),
    // One upload at a time (design: concurrency 1).
    defineHandler('publish.target', (ctx, run, payload) => handlePublishTarget(ctx, run, payload), 1),
    defineHandler('publish.poll', (ctx, run, payload) => handlePublishPoll(ctx, run, payload), 2),
    defineHandler('publish.dispatch', (ctx, run, payload) => handlePublishDispatch(ctx, run, payload), 1),
    defineHandler('social.check', (ctx, run, payload) => handleSocialCheck(ctx, run, payload), 1),
  ],
  crons: [
    // Every minute: due scheduled posts and manual "your turn" reminders.
    { type: 'publish.dispatch', cron: '* * * * *', payload: {}, key: 'every-minute' },
    // Daily read-only token, account and quota check at 4:23 am Melbourne time. Never posts.
    { type: 'social.check', cron: '23 4 * * *', payload: { connectionId: null, reason: 'daily' }, key: 'daily' },
  ],
  // Posts waiting for an export (or its music-free version) are prepared again as soon as the file is stored.
  exportReadyHooks: [
    async (ctx, event) => {
      await preparePostsWaitingFor(ctx, event.editVersionId, event.variant);
    },
  ],
  refIdFor: (type, payload) => {
    const pick = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
    switch (type) {
      case 'publish.prepare':
        return pick('postId');
      case 'publish.target':
      case 'publish.poll':
        return pick('targetId');
      case 'publish.dispatch':
        return null;
      case 'social.check':
        return pick('connectionId');
      default:
        return undefined;
    }
  },
};
