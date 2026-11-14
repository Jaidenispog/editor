import { eq } from 'drizzle-orm';
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
 */
export async function handleEmailCampaignExpand(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'email.campaign.expand'>, deps: EmailDeps = defaultEmailDeps(ctx)): Promise<void> {
  const now = deps.now();
  const campaign = await ctx.db.query.emailCampaigns.findFirst({ where: eq(schema.emailCampaigns.id, payload.campaignId) });
  if (!campaign) throw new NonRetryableError('NOT_FOUND', 'The campaign no longer exists.');
  if (campaign.status !== 'approved' && campaign.status !== 'sending') {
    await run.progress(1, `Nothing to do (${campaign.status})`);
    return;
  }
  const settings = await loadAppSettings(ctx.db);
  const rows = (await computeAudience(ctx.db, settings, campaign.audience, now)).filter((r) => r.included && r.email);
  const { times } = spreadByDailyCap(rows.length, settings.email.dailyCommercialCap, now, settings.email.sendWindow);
  let inserted = 0;
  for (const [i, r] of rows.entries()) {
    run.checkCancelled();
    const customer = await ctx.db.query.customers.findFirst({ where: eq(schema.customers.id, r.customerId) });
    if (!customer?.email) continue;
    const preview = composeMessage(settings, {
      messageClass: 'campaign',
      subject: campaign.subject,
      bodyMarkdown: campaign.bodyMarkdown,
      subjectOf: { customer, booking: null, reviewRequest: null },
      reviewLinkUrl: null,
      unsubscribeUrl: '[unsubscribe link]',
    });
    const res = await ctx.db
      .insert(schema.emailMessages)
      .values({
        id: newId(),
        templateId: campaign.templateId,
        customerId: customer.id,
        toEmail: customer.email,
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
    inserted += res.length;
  }
  await ctx.db.update(schema.emailCampaigns).set({ status: 'sending', recipientCount: rows.length, updatedAt: now }).where(eq(schema.emailCampaigns.id, campaign.id));
  await writeWorkerAudit(ctx.db, { userId: null, action: 'email.campaign.expanded', entityType: 'email_campaign', entityId: campaign.id, data: { recipients: rows.length, inserted } }, ctx.logger);
  await run.progress(1, `${inserted} email${inserted === 1 ? '' : 's'} queued for ${rows.length} recipient${rows.length === 1 ? '' : 's'}`);
}
