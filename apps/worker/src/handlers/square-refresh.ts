import { eq } from 'drizzle-orm';
import type { JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import { scrubSquareCustomer } from '@studio/db/square-purge';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { failSquareJob, openSquare } from '../square/client.js';
import { upsertBooking, upsertCustomer } from '../square/map.js';
import { markBookingMissing } from '../square/sync.js';

/** Payments are matched to bookings that end within this long before the payment… */
const PAYMENT_LOOKBACK_MS = 3 * 3600_000;
/** …or start up to 30 minutes after it (allowing for the longest service). */
const PAYMENT_LOOKAHEAD_MS = 30 * 60_000 + 4 * 3600_000;

/**
 * `square.refresh`: re-reads one booking, customer or payment from Square after a verified webhook. The webhook's
 * own copy is never trusted; Square's answer is. A booking Square no longer has is marked missing; a deleted
 * customer is scrubbed; a payment queues the attendance pass for its customer.
 */
export async function handleSquareRefresh(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.refresh'>): Promise<void> {
  const s = await openSquare(ctx, run);
  if ('skip' in s) {
    await run.progress(1, s.skip);
    return;
  }
  try {
    if (payload.entity === 'booking') {
      const b = await s.api.getBooking(payload.squareId);
      if (!b) {
        const row = await ctx.db.query.bookings.findFirst({ where: eq(schema.bookings.squareBookingId, payload.squareId), columns: { id: true } });
        if (row) await markBookingMissing(ctx, row.id);
        await run.progress(1, 'Square no longer has this booking.');
        return;
      }
      if (b.customerId) {
        const known = await ctx.db.query.customers.findFirst({ where: eq(schema.customers.squareCustomerId, b.customerId), columns: { id: true } });
        if (!known) {
          const c = await s.api.getCustomer(b.customerId);
          if (c) await upsertCustomer(ctx.db, c, s.environment);
        }
      }
      const outcome = await upsertBooking(ctx.db, b, s.environment, s.config.snapshot);
      if (b.customerId && Date.parse(b.startAt) < Date.now()) {
        await enqueueTracked(ctx, 'square.attendance', { squareCustomerId: b.customerId }, { singletonKey: `square-attendance:${b.customerId}` });
      }
      await run.progress(1, outcome === 'stale' ? 'Already up to date (Square sent an older copy).' : 'Booking updated from Square.');
      return;
    }
    if (payload.entity === 'customer') {
      const c = await s.api.getCustomer(payload.squareId);
      if (!c) {
        await scrubSquareCustomer(ctx.db, payload.squareId);
        await run.progress(1, 'Square deleted this client, so their details were removed here too.');
        return;
      }
      await upsertCustomer(ctx.db, c, s.environment);
      await run.progress(1, 'Client updated from Square.');
      return;
    }
    const p = await s.api.getPayment(payload.squareId);
    if (!p || !p.customerId) {
      await run.progress(1, 'Nothing to match: the payment has no client.');
      return;
    }
    const at = p.createdAt.getTime();
    await enqueueTracked(
      ctx,
      'square.attendance',
      { squareCustomerId: p.customerId, fromIso: new Date(at - PAYMENT_LOOKBACK_MS).toISOString(), toIso: new Date(at + PAYMENT_LOOKAHEAD_MS).toISOString() },
      { singletonKey: `square-attendance:${p.customerId}` },
    );
    await run.progress(1, 'Payment noted; checking it against bookings.');
  } catch (err) {
    await failSquareJob(ctx, run, err, 'Square refresh failed');
  }
}
