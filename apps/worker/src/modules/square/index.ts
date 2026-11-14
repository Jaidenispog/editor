import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { schema } from '@studio/db';
import { handleSquareAttendance } from '../../handlers/square-attendance.js';
import { handleSquareAvailability } from '../../handlers/square-availability.js';
import { handleSquareRefresh } from '../../handlers/square-refresh.js';
import { handleSquareSync } from '../../handlers/square-sync.js';
import { handleSquareRevoke, handleSquareTokenRefresh } from '../../handlers/square-token.js';
import { handleSquareWebhook } from '../../square/webhook.js';
import { defineHandler, type WorkerModule } from '../types.js';

/** Availability searches are kept for a day (design §5.3). */
export const AVAILABILITY_SEARCH_TTL_MS = 24 * 3600_000;
/**
 * Processed Square webhook deliveries are kept this long (Square retries a delivery for up to three days, and the
 * stored event id is what makes a retry a duplicate), then deleted. They only hold the minimal envelope.
 */
export const SQUARE_WEBHOOK_RETENTION_DAYS = 7;

/**
 * Worker registrations of the Square appointments module (WP6 Tier 0: reads, webhooks, attendance; WP6b adds booking
 * changes and the self-test). Nothing here writes to Square or sends a message. Handlers are wrapped so this file can
 * be loaded before the handler modules finish loading.
 */
export const squareModule: WorkerModule = {
  name: 'square',
  handlers: [
    defineHandler('square.sync', (ctx, run, payload) => handleSquareSync(ctx, run, payload), 1),
    defineHandler('square.refresh', (ctx, run, payload) => handleSquareRefresh(ctx, run, payload), 1),
    defineHandler('square.attendance', (ctx, run, payload) => handleSquareAttendance(ctx, run, payload), 1),
    defineHandler('square.availability', (ctx, run, payload) => handleSquareAvailability(ctx, run, payload), 1),
    defineHandler('square.token_refresh', (ctx, run, payload) => handleSquareTokenRefresh(ctx, run, payload), 1),
    defineHandler('square.revoke', (ctx, run, payload) => handleSquareRevoke(ctx, run, payload), 1),
  ],
  crons: [
    // Every 10 minutes: bookings for the next 31 days (plus the last two hours) and changed clients.
    { type: 'square.sync', cron: '*/10 * * * *', payload: { reason: 'schedule' }, key: 'every-10-minutes' },
    // Nightly at 2:47 am Melbourne time: the wide reconcile (last 31 days to 62 days ahead) and a fresh snapshot.
    { type: 'square.sync', cron: '47 2 * * *', payload: { reason: 'reconcile' }, key: 'nightly-reconcile' },
    // Every 30 minutes: match Square payments to bookings that have finished.
    { type: 'square.attendance', cron: '*/30 * * * *', payload: {}, key: 'every-30-minutes' },
    // Daily at 3:13 am: renew the access token well before it expires.
    { type: 'square.token_refresh', cron: '13 3 * * *', payload: {}, key: 'daily' },
  ],
  webhookHandlers: { square: (ctx, run, event) => handleSquareWebhook(ctx, run, event) },
  cleanupTasks: [
    {
      name: 'square availability searches',
      run: async (ctx) => {
        const removed = await ctx.db
          .delete(schema.squareAvailabilitySearches)
          .where(lt(schema.squareAvailabilitySearches.createdAt, new Date(Date.now() - AVAILABILITY_SEARCH_TTL_MS)))
          .returning({ id: schema.squareAvailabilitySearches.id });
        return removed.length ? `${removed.length} old Square availability search${removed.length === 1 ? '' : 'es'} removed` : undefined;
      },
    },
    {
      name: 'square webhook deliveries',
      run: async (ctx) => {
        const t = schema.webhookEvents;
        const cutoff = new Date(Date.now() - SQUARE_WEBHOOK_RETENTION_DAYS * 86_400_000);
        const removed = await ctx.db
          .delete(t)
          .where(and(eq(t.provider, 'square'), isNotNull(t.processedAt), lt(t.receivedAt, cutoff)))
          .returning({ id: t.id });
        return removed.length ? `${removed.length} old Square webhook deliver${removed.length === 1 ? 'y' : 'ies'} removed` : undefined;
      },
    },
  ],
  refIdFor: (type, payload) => {
    switch (type) {
      case 'square.availability':
        return typeof payload['searchId'] === 'string' ? payload['searchId'] : null;
      case 'square.refresh':
        return typeof payload['squareId'] === 'string' ? payload['squareId'] : null;
      case 'square.sync':
      case 'square.attendance':
      case 'square.token_refresh':
      case 'square.revoke':
        return null;
      default:
        return undefined;
    }
  },
};
