import { and, eq, isNull } from 'drizzle-orm';
import type { JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { defaultEmailDeps, type EmailDeps } from '../lib/email/provider.js';

/**
 * `email.suppression.push`: adds a suppressed address to Postmark's own list on the Broadcast stream (marketing) or
 * both streams (all), so Postmark refuses it too. Only ever restricts sending; the app never removes an address from
 * Postmark's list. Skipped when already pushed, lifted, or when Postmark is not set up (the app's own list still
 * blocks every send).
 */
export async function handleEmailSuppressionPush(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'email.suppression.push'>, deps: EmailDeps = defaultEmailDeps(ctx)): Promise<void> {
  const s = await ctx.db.query.emailSuppressions.findFirst({ where: eq(schema.emailSuppressions.id, payload.suppressionId) });
  if (!s || s.pushedToProviderAt || s.liftedAt) {
    await run.progress(1, 'Nothing to push');
    return;
  }
  if (!deps.provider) {
    await run.progress(1, 'Email sending is not set up; the app’s own list still blocks this address');
    return;
  }
  const streams: Array<'transactional' | 'broadcast'> = s.scope === 'all' ? ['broadcast', 'transactional'] : ['broadcast'];
  for (const stream of streams) {
    run.checkCancelled();
    await deps.provider.suppress(s.emailLower, stream, run.signal);
  }
  await ctx.db
    .update(schema.emailSuppressions)
    .set({ pushedToProviderAt: deps.now() })
    .where(and(eq(schema.emailSuppressions.id, s.id), isNull(schema.emailSuppressions.pushedToProviderAt)));
  await run.progress(1, 'Added to Postmark’s suppression list');
}
