import { and, eq, inArray } from 'drizzle-orm';
import { NonRetryableError, dedupeKeys, newId, spreadByDailyCap, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { computeAudience } from '../lib/email/audience.js';
import { composeMessage } from '../lib/email/compose.js';
import { loadAppSettings } from '../lib/email/facts.js';
import { defaultEmailDeps, type EmailDeps } from '../lib/email/provider.js';

/**
 * `email.campaign.expand` (design §6): recomputes the audience of an approved campaign and inserts one approved
 * message per recipient (`campaign:{campaignId}:{customerId}`, `ON CONFLICT DO NOTHING`), spread over Melbourne days
 * by the daily commercial limit. Running it again adds nothing new. The campaign becomes `sending`.
 *
 * Every insert runs in a transaction that first locks the campaign row and checks it is still `approved`/`sending`;
 * the owner's pause and cancel (`changeCampaign`) take the same lock. So once the owner withdraws approval, no
 * further message is inserted, and the final status change never overwrites `paused` or `cancelled`.
 */
export async function handleEmailCampaignExpand(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'email.campaign.expand'>, deps: EmailDeps = defaultEmailDeps(ctx)): Promise<void> {
  const now = deps.now();
  const campaign = await ctx.db.query.emailCampaigns.findFirst({
    where: eq(schema.emailCampaigns.id, payload.campaignId),
  });
  if (!campaign) throw new NonRetryableError('NOT_FOUND', 'The campaign no longer exists.');
  if (campaign.status !== 'approved' && campaign.status !== 'sending') {
    await run.progress(1, `Nothing to do (${campaign.status})`);
    return;
  }
  const settings = await loadAppSettings(ctx.db);
  const rows = (await computeAudience(ctx.db, settings, campaign.audience, now)).filter((r) => r.included && r.email);
  const { times } = spreadByDailyCap(rows.length, settings.email.dailyCommercialCap, now, settings.email.sendWindow);
  let inserted = 0;
  let stoppedAs: string | null = null;
  const c = schema.emailCampaigns;
  for (const [i, r] of rows.entries()) {
    run.checkCancelled();
    const customer = await ctx.db.query.customers.findFirst({
      where: eq(schema.customers.id, r.customerId),
    });
    const toEmail = customer?.email;
    if (!customer || !toEmail) continue;
    const preview = composeMessage(settings, {
      messageClass: 'campaign',
      subject: campaign.subject,
      bodyMarkdown: campaign.bodyMarkdown,
      subjectOf: { customer, booking: null, reviewRequest: null },
      reviewLinkUrl: null,
      unsubscribeUrl: '[unsubscribe link]',
    });
    const res = await ctx.db.transaction(async (tx) => {
      const [current] = await tx.select({ status: c.status }).from(c).where(eq(c.id, campaign.id)).for('update');
      if (!current || (current.status !== 'approved' && current.status !== 'sending')) {
        stoppedAs = current?.status ?? 'deleted';
        return null;
      }
      return tx
        .insert(schema.emailMessages)
        .values({
          id: newId(),
          templateId: campaign.templateId,
          customerId: customer.id,
          toEmail,
          subject: campaign.subject,
          bodyMarkdown: campaign.bodyMarkdown,
          bodyHtml: preview.storedHtml,
          bodyText: preview.storedText,
          purpose: 'campaign',
          messageClass: 'campaign',
          origin: 'campaign',
          campaignId: campaign.id,
          dedupeKey: dedupeKeys.campaign(campaign.id, customer.id),
          status: 'approved',
          approvedBy: campaign.approvedBy,
          approvedAt: campaign.approvedAt ?? now,
          scheduledFor: times[i] ?? now,
        })
        .onConflictDoNothing()
        .returning({ id: schema.emailMessages.id });
    });
    if (res === null) break;
    inserted += res.length;
  }
  if (stoppedAs) {
    await writeWorkerAudit(
      ctx.db,
      {
        userId: null,
        action: 'email.campaign.expand_stopped',
        entityType: 'email_campaign',
        entityId: campaign.id,
        data: { status: stoppedAs, inserted },
      },
      ctx.logger,
    );
    await run.progress(
      1,
      `Stopped: the campaign was ${stoppedAs === 'paused' ? 'paused' : stoppedAs === 'cancelled' ? 'cancelled' : 'changed'} while emails were being prepared (${inserted} prepared)`,
    );
    return;
  }
  // Only while still approved or sending: a pause or cancel that landed after the last insert is kept.
  await ctx.db
    .update(c)
    .set({ status: 'sending', recipientCount: rows.length, updatedAt: now })
    .where(and(eq(c.id, campaign.id), inArray(c.status, ['approved', 'sending'])));
  await writeWorkerAudit(
    ctx.db,
    {
      userId: null,
      action: 'email.campaign.expanded',
      entityType: 'email_campaign',
      entityId: campaign.id,
      data: { recipients: rows.length, inserted },
    },
    ctx.logger,
  );
  await run.progress(1, `${inserted} email${inserted === 1 ? '' : 's'} queued for ${rows.length} recipient${rows.length === 1 ? '' : 's'}`);
}
