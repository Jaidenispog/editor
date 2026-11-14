import { and, eq, isNull } from 'drizzle-orm';
import { errorMessage } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { redactEmails } from '../lib/http.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { webhookHandlerFor, type WebhookHandler, type WorkerModule } from '../modules/index.js';

/** Stored on an event no module handles. */
export function unknownProviderError(provider: string): string {
  return `No module handles webhooks from "${provider}", so this delivery was ignored.`;
}

/**
 * `webhook.process`: hands one stored webhook delivery to the handler its provider's module registered, then marks
 * it processed. A provider nobody handles is marked processed with an error (nothing to retry). A handler failure is
 * recorded on the event and rethrown so the queue retries; a delivery already processed is skipped, so running
 * this again is harmless.
 */
export async function handleWebhookProcess(
  ctx: WorkerContext,
  run: TrackedRun,
  payload: { webhookEventId: string },
  lookup: (provider: string) => WebhookHandler | null = (p) => webhookHandlerFor(p),
): Promise<void> {
  const t = schema.webhookEvents;
  const event = await ctx.db.query.webhookEvents.findFirst({ where: eq(t.id, payload.webhookEventId) });
  if (!event) {
    await run.progress(1, 'The webhook delivery no longer exists');
    return;
  }
  if (event.processedAt) {
    await run.progress(1, 'Already processed');
    return;
  }
  const handler = lookup(event.provider);
  if (!handler) {
    await ctx.db
      .update(t)
      .set({ processedAt: new Date(), error: unknownProviderError(event.provider) })
      .where(and(eq(t.id, event.id), isNull(t.processedAt)));
    ctx.logger.warn({ provider: event.provider, webhookEventId: event.id }, 'webhook from a provider no module handles');
    await run.progress(1, 'Ignored: no module handles this provider');
    return;
  }
  try {
    await handler(ctx, run, event);
  } catch (err) {
    run.checkCancelled();
    await ctx.db
      .update(t)
      .set({ error: redactEmails(errorMessage(err)).slice(0, 500) })
      .where(eq(t.id, event.id));
    throw err;
  }
  await ctx.db
    .update(t)
    .set({ processedAt: new Date(), error: null })
    .where(and(eq(t.id, event.id), isNull(t.processedAt)));
  await run.progress(1, 'Webhook processed');
}

/** Lookup over an explicit module list (tests). */
export function webhookLookupFor(modules: readonly WorkerModule[]): (provider: string) => WebhookHandler | null {
  return (provider) => webhookHandlerFor(provider, modules);
}
