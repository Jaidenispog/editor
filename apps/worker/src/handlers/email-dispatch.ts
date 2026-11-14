import { and, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { webhooksReadyForCommercial, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { loadAppSettings, providerReadiness } from '../lib/email/facts.js';
import { defaultEmailDeps, type EmailDeps } from '../lib/email/provider.js';
import { enqueueEmailSend } from './email-send.js';

/** A message left `sending` (claimed, no provider id) this long has lost its job; the recovery path takes over. */
export const STALLED_SENDING_MINUTES = 15;
/** Most messages handed on per run (the next minute continues). */
export const DISPATCH_BATCH = 100;

/** True when an `email.send` job for this message is still queued or running. */
async function hasActiveSend(ctx: WorkerContext, emailMessageId: string): Promise<boolean> {
  const row = await ctx.db.query.jobs.findFirst({ columns: { id: true }, where: and(eq(schema.jobs.type, 'email.send'), eq(schema.jobs.refId, emailMessageId), inArray(schema.jobs.status, ['queued', 'running'])) });
  return Boolean(row);
}

/**
 * `email.dispatch` (every minute): hands approved messages that are due to `email.send`, skipping paused or
 * cancelled campaigns and anything waiting for the owner. Approved messages held because the provider was not ready
 * are handed on once it is. Never calls the provider; the gate in `email.send` re-checks everything.
 */
export async function handleEmailDispatch(ctx: WorkerContext, run: TrackedRun, _payload: JobPayload<'email.dispatch'>, deps: EmailDeps = defaultEmailDeps(ctx)): Promise<void> {
  const now = deps.now();
  const settings = await loadAppSettings(ctx.db);
  const readiness = await providerReadiness(ctx.db, ctx.env, settings);
  if (!readiness.ready || !deps.provider) {
    await run.progress(1, 'Email sending is not ready; nothing handed on');
    return;
  }
  const m = schema.emailMessages;
  const c = schema.emailCampaigns;
  const commercialOk = webhooksReadyForCommercial(readiness);
  const pausedCampaigns = ctx.db.select({ id: c.id }).from(c).where(inArray(c.status, ['paused', 'cancelled', 'draft']));
  const due = await ctx.db
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.status, 'approved'),
        isNull(m.submittedAt),
        isNull(m.ownerAction),
        or(isNull(m.scheduledFor), lte(m.scheduledFor, now)),
        or(isNull(m.campaignId), notInArray(m.campaignId, pausedCampaigns)),
        // Commercial email waits (in `approved`, without a job) while the webhooks are missing and not attested; the
        // send gate would only hold it again, and handing it on every minute would pile up jobs.
        commercialOk ? undefined : or(eq(m.messageClass, 'transactional_factual'), eq(m.origin, 'preview')),
      ),
    )
    .orderBy(sql`${m.scheduledFor} asc nulls first`, m.createdAt)
    .limit(DISPATCH_BATCH);
  let handed = 0;
  for (const { id } of due) {
    const moved = await ctx.db
      .update(m)
      .set({ status: 'queued', updatedAt: now })
      .where(and(eq(m.id, id), eq(m.status, 'approved'), isNull(m.submittedAt)))
      .returning({ id: m.id });
    if (!moved.length) continue;
    await enqueueEmailSend(ctx, id);
    handed++;
  }

  // Safety nets: a claimed message whose job was lost goes through the recovery path (it looks Postmark up first);
  // a queued message whose job was lost goes back to approved for the next run.
  const stale = new Date(now.getTime() - STALLED_SENDING_MINUTES * 60_000);
  const stalled = await ctx.db
    .select({ id: m.id, status: m.status })
    .from(m)
    .where(and(inArray(m.status, ['sending', 'queued']), lt(m.updatedAt, stale)))
    .limit(DISPATCH_BATCH);
  let recovered = 0;
  for (const s of stalled) {
    if (await hasActiveSend(ctx, s.id)) continue;
    if (s.status === 'sending') {
      await enqueueEmailSend(ctx, s.id);
      recovered++;
    } else {
      await ctx.db.update(m).set({ status: 'approved', updatedAt: now }).where(and(eq(m.id, s.id), eq(m.status, 'queued'), isNull(m.submittedAt)));
    }
  }
  // A campaign whose messages have all gone out (or settled) is finished.
  await ctx.db
    .update(c)
    .set({ status: 'sent', updatedAt: now })
    .where(
      and(
        eq(c.status, 'sending'),
        sql`not exists (select 1 from ${m} where ${m.campaignId} = ${c.id} and ${m.status} in ('draft', 'approved', 'queued', 'sending'))`,
      ),
    );
  if (handed || recovered) await run.message(`Handed on ${handed} email${handed === 1 ? '' : 's'}${recovered ? `; checking ${recovered} that stalled` : ''}`);
}
