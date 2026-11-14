import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { loadConnection } from '../lib/connections.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import type { StoredWebhookEvent } from '../modules/types.js';

/** Stored on a delivery for a Square account other than the connected one. */
export const MERCHANT_MISMATCH = 'merchant_mismatch';

/** Which object a Square event type asks us to re-read. */
export function refreshTargetFor(eventType: string): 'booking' | 'payment' | 'customer' | null {
  if (eventType === 'booking.created' || eventType === 'booking.updated') return 'booking';
  if (eventType === 'payment.created' || eventType === 'payment.updated') return 'payment';
  if (eventType === 'customer.created' || eventType === 'customer.updated' || eventType === 'customer.deleted') return 'customer';
  return null;
}

/**
 * Square's branch of `webhook.process` (design §7.3). The signature was verified before the event was stored; the
 * payload is still only a hint: a delivery for another merchant is ignored, and a known event type queues a
 * `square.refresh` that re-reads the object from Square. The payload's own object is never used.
 */
export async function handleSquareWebhook(ctx: WorkerContext, run: TrackedRun, event: StoredWebhookEvent): Promise<void> {
  const payload = event.payload as { merchant_id?: unknown; type?: unknown; data?: { id?: unknown } };
  const conn = await loadConnection(ctx.db, 'square');
  const merchantId = typeof payload.merchant_id === 'string' ? payload.merchant_id : null;
  if (!conn?.externalAccountId || merchantId !== conn.externalAccountId) {
    // Marked processed here, with the reason, so the dispatcher's own update (which only touches unprocessed rows) keeps it.
    await ctx.db
      .update(schema.webhookEvents)
      .set({ processedAt: new Date(), error: MERCHANT_MISMATCH })
      .where(and(eq(schema.webhookEvents.id, event.id), isNull(schema.webhookEvents.processedAt)));
    await run.progress(1, 'Ignored: the event is for a different Square account.');
    return;
  }
  const target = refreshTargetFor(String(payload.type ?? event.eventType));
  const id = typeof payload.data?.id === 'string' ? payload.data.id.slice(0, 192) : null;
  if (!target || !id) {
    await run.progress(1, 'Ignored: Studio Assistant does not use this kind of Square event.');
    return;
  }
  await enqueueTracked(ctx, 'square.refresh', { entity: target, squareId: id }, { singletonKey: `square-refresh:${target}:${id}` });
  await run.progress(1, `Queued a fresh read of the ${target} from Square.`);
}
