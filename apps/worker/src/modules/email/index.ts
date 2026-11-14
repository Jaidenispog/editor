import { and, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { schema } from '@studio/db';
import { handleEmailCampaignExpand } from '../../handlers/email-campaign.js';
import { handleEmailProviderCheck } from '../../handlers/email-check.js';
import { handleEmailDispatch } from '../../handlers/email-dispatch.js';
import { handleEmailSend } from '../../handlers/email-send.js';
import { handleEmailSuppressionPush } from '../../handlers/email-suppression.js';
import { handleEmailSweep } from '../../handlers/email-sweep.js';
import { handlePostmarkWebhook } from '../../handlers/email-webhook.js';
import { handleReviewsPlacesSync } from '../../handlers/reviews-places.js';
import { defineHandler, type WorkerModule } from '../types.js';

/** Processed Postmark deliveries keep their row and effects, but the payload is blanked after this many days. */
export const POSTMARK_PAYLOAD_RETENTION_DAYS = 90;

/**
 * Worker registrations of the email and review requests module (WP7). Handlers are wrapped so this file can be
 * loaded before the handler modules finish loading.
 */
export const emailModule: WorkerModule = {
  name: 'email',
  handlers: [
    // One send at a time (design §8.1.1: no published per-second limit; volume is bounded by the daily caps).
    defineHandler('email.send', (ctx, run, payload) => handleEmailSend(ctx, run, payload), 1),
    defineHandler('email.dispatch', (ctx, run, payload) => handleEmailDispatch(ctx, run, payload), 1),
    defineHandler('email.automation.sweep', (ctx, run, payload) => handleEmailSweep(ctx, run, payload), 1),
    defineHandler('email.campaign.expand', (ctx, run, payload) => handleEmailCampaignExpand(ctx, run, payload), 1),
    defineHandler('email.provider.check', (ctx, run, payload) => handleEmailProviderCheck(ctx, run, payload), 1),
    defineHandler('email.suppression.push', (ctx, run, payload) => handleEmailSuppressionPush(ctx, run, payload), 1),
    defineHandler('reviews.places.sync', (ctx, run, payload) => handleReviewsPlacesSync(ctx, run, payload), 1),
  ],
  crons: [
    // Every minute: due approved emails are handed to email.send.
    { type: 'email.dispatch', cron: '* * * * *', payload: {}, key: 'every-minute' },
    // Every 10 minutes: follow-ups and review requests for genuinely completed appointments.
    { type: 'email.automation.sweep', cron: '*/10 * * * *', payload: {}, key: 'every-10-minutes' },
    // Daily read-only Postmark check at 4:37 am Melbourne time. Never sends.
    { type: 'email.provider.check', cron: '37 4 * * *', payload: { reason: 'daily' }, key: 'daily' },
    // Daily Google rating refresh at 5:41 am Melbourne time (read-only; one call).
    { type: 'reviews.places.sync', cron: '41 5 * * *', payload: { reason: 'daily' }, key: 'daily' },
  ],
  webhookHandlers: {
    postmark: (ctx, run, event) => handlePostmarkWebhook(ctx, run, event),
  },
  cleanupTasks: [
    {
      name: 'postmark-webhook-payloads',
      run: async (ctx) => {
        const cutoff = new Date(Date.now() - POSTMARK_PAYLOAD_RETENTION_DAYS * 86_400_000);
        const t = schema.webhookEvents;
        const rows = await ctx.db
          .update(t)
          .set({ payload: {} })
          .where(and(eq(t.provider, 'postmark'), isNotNull(t.processedAt), lt(t.receivedAt, cutoff), ne(sql`${t.payload}::text`, '{}')))
          .returning({ id: t.id });
        return rows.length ? `Blanked ${rows.length} old Postmark webhook payload${rows.length === 1 ? '' : 's'}` : undefined;
      },
    },
  ],
  refIdFor: (type, payload) => {
    const pick = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
    switch (type) {
      case 'email.send':
        return pick('emailMessageId');
      case 'email.campaign.expand':
        return pick('campaignId');
      case 'email.suppression.push':
        return pick('suppressionId');
      case 'email.dispatch':
      case 'email.automation.sweep':
      case 'email.provider.check':
      case 'reviews.places.sync':
        return null;
      default:
        return undefined;
    }
  },
};
