import { and, eq, inArray, sql } from 'drizzle-orm';
import { autoPauseReason, normaliseEmail } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { hashEmail } from '../lib/http.js';
import { enqueueTracked } from '../lib/jobs.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import type { Db } from '../lib/email/facts.js';
import { addSuppression, recordWithdrawal, suppressPendingMessages } from '../lib/email/ledger.js';
import { parsePostmarkWebhook } from '../lib/email/postmark.js';
import type { NormalisedEmailEvent } from '../lib/email/provider.js';
import type { StoredWebhookEvent } from '../modules/types.js';

type CampaignCounter = 'deliveredCount' | 'bounceCount' | 'complaintCount';

/** Moves a message from one of `from` to `to` (by Postmark's MessageID); returns the message when it changed. */
async function transition(tx: Db, providerMessageId: string | null, from: Array<'sent' | 'delivered'>, set: Partial<typeof schema.emailMessages.$inferInsert>) {
  if (!providerMessageId) return null;
  const rows = await tx
    .update(schema.emailMessages)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(schema.emailMessages.providerMessageId, providerMessageId), inArray(schema.emailMessages.status, from)))
    .returning();
  return rows[0] ?? null;
}

/** Adds one to a campaign counter and pauses the campaign when complaints or bounces cross the memo's limits. */
async function bumpCampaign(tx: Db, campaignId: string | null, counter: CampaignCounter): Promise<string | null> {
  if (!campaignId) return null;
  const col = schema.emailCampaigns[counter];
  const rows = await tx
    .update(schema.emailCampaigns)
    .set({ [counter]: sql`${col} + 1`, updatedAt: new Date() })
    .where(eq(schema.emailCampaigns.id, campaignId))
    .returning();
  const c = rows[0];
  if (!c || counter === 'deliveredCount' || c.status !== 'sending') return null;
  const reason = autoPauseReason(c);
  if (!reason) return null;
  const paused = await tx
    .update(schema.emailCampaigns)
    .set({ status: 'paused', pausedReason: reason, updatedAt: new Date() })
    .where(and(eq(schema.emailCampaigns.id, c.id), eq(schema.emailCampaigns.status, 'sending')))
    .returning({ id: schema.emailCampaigns.id });
  if (!paused.length) return null;
  await writeWorkerAudit(tx, { userId: null, action: 'email.campaign.auto_paused', entityType: 'email_campaign', entityId: c.id, data: { reason, sent: c.sentCount, bounces: c.bounceCount, complaints: c.complaintCount } });
  return reason;
}

/** The client a stored ledger event should name (the message's client, else any client with the address). */
async function customerIdFor(tx: Db, email: string, messageCustomerId: string | null): Promise<string | null> {
  if (messageCustomerId) return messageCustomerId;
  const c = await tx.query.customers.findFirst({ columns: { id: true }, where: sql`lower(${schema.customers.email}) = ${normaliseEmail(email)}` });
  return c?.id ?? null;
}

/** A withdrawal recorded once per webhook delivery (re-processing the same delivery adds nothing). */
async function withdrawOnce(tx: Db, email: string, customerId: string | null, webhookEventId: string, emailMessageId: string | null, at: Date): Promise<void> {
  const existing = await tx.query.consentEvents.findFirst({ columns: { id: true }, where: and(eq(schema.consentEvents.emailLower, normaliseEmail(email)), sql`${schema.consentEvents.evidence} ->> 'webhookEventId' = ${webhookEventId}`) });
  if (existing) return;
  await recordWithdrawal(tx, { email, customerId, method: 'postmark_unsubscribe', occurredAt: at, evidence: { webhookEventId, ...(emailMessageId ? { emailMessageId } : {}) } });
}

/** Applies one normalised event. Returns new suppression ids (to push to Postmark after the transaction). */
async function applyEvent(tx: Db, ev: NormalisedEmailEvent, webhookEventId: string): Promise<string[]> {
  const out: string[] = [];
  const occurredAt = Number.isFinite(Date.parse(ev.occurredAt)) ? new Date(ev.occurredAt) : new Date();
  const asHardBounce = async () => {
    const msg = await transition(tx, ev.providerMessageId, ['sent', 'delivered'], { status: 'bounced', statusMessage: 'The address bounced. Nothing more will be sent to it.' });
    if (msg) await bumpCampaign(tx, msg.campaignId, 'bounceCount');
    if (ev.email) {
      const id = await addSuppression(tx, { email: ev.email, scope: 'all', reason: 'hard_bounce', source: 'postmark_webhook', stream: ev.stream, emailMessageId: msg?.id ?? null, webhookEventId });
      if (id) out.push(id);
      await suppressPendingMessages(tx, ev.email, 'all', 'This address bounced. Nothing can be sent to it.');
    }
  };
  const asComplaint = async () => {
    const msg = await transition(tx, ev.providerMessageId, ['sent', 'delivered'], { status: 'complained', statusMessage: 'The client marked this email as spam.' });
    if (msg) await bumpCampaign(tx, msg.campaignId, 'complaintCount');
    if (ev.email) {
      const id = await addSuppression(tx, { email: ev.email, scope: 'all', reason: 'spam_complaint', source: 'postmark_webhook', stream: ev.stream, emailMessageId: msg?.id ?? null, webhookEventId });
      if (id) out.push(id);
      await withdrawOnce(tx, ev.email, await customerIdFor(tx, ev.email, msg?.customerId ?? null), webhookEventId, msg?.id ?? null, occurredAt);
      await suppressPendingMessages(tx, ev.email, 'all', 'This address reported spam. Nothing can be sent to it.');
    }
  };
  switch (ev.type) {
    case 'delivered': {
      const msg = await transition(tx, ev.providerMessageId, ['sent'], { status: 'delivered', deliveredAt: occurredAt });
      if (msg) await bumpCampaign(tx, msg.campaignId, 'deliveredCount');
      break;
    }
    case 'bounced':
      if (ev.hard) await asHardBounce();
      else if (ev.providerMessageId) {
        await tx
          .update(schema.emailMessages)
          .set({ statusMessage: `Temporary delivery problem (${ev.suppressionReason ?? 'soft bounce'})`, updatedAt: new Date() })
          .where(and(eq(schema.emailMessages.providerMessageId, ev.providerMessageId), inArray(schema.emailMessages.status, ['sent', 'delivered'])));
      }
      break;
    case 'complained':
      await asComplaint();
      break;
    case 'subscription_change': {
      if (!ev.email) break;
      if (ev.suppressSending === true) {
        if (ev.suppressionReason === 'HardBounce') await asHardBounce();
        else if (ev.suppressionReason === 'SpamComplaint') await asComplaint();
        else {
          const msg = ev.providerMessageId ? await tx.query.emailMessages.findFirst({ where: eq(schema.emailMessages.providerMessageId, ev.providerMessageId) }) : null;
          const id = await addSuppression(tx, { email: ev.email, scope: 'marketing', reason: 'unsubscribe', source: 'postmark_webhook', stream: ev.stream, emailMessageId: msg?.id ?? null, webhookEventId });
          if (id) out.push(id);
          await withdrawOnce(tx, ev.email, await customerIdFor(tx, ev.email, msg?.customerId ?? null), webhookEventId, msg?.id ?? null, occurredAt);
          await suppressPendingMessages(tx, ev.email, 'marketing', 'This client unsubscribed from marketing emails.');
        }
      } else if (ev.suppressSending === false) {
        // Recorded only: a webhook can never lift the app's own suppression.
        await writeWorkerAudit(tx, { userId: null, action: 'email.postmark_reactivated', entityType: 'email_address', entityId: hashEmail(ev.email), data: { webhookEventId } });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * The `postmark` handler for `webhook.process` (design §8.1.5). Only authenticated deliveries are stored, and even
 * those may only restrict sending or update delivery display: nothing here grants consent, lifts a suppression or
 * causes a send. Every write is conditional or `ON CONFLICT DO NOTHING`, so processing a delivery again is a no-op.
 */
export async function handlePostmarkWebhook(ctx: WorkerContext, run: TrackedRun, event: StoredWebhookEvent): Promise<void> {
  const events = parsePostmarkWebhook(event.payload);
  const pushed = await ctx.db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const ev of events) ids.push(...(await applyEvent(tx, ev, event.id)));
    return ids;
  });
  for (const suppressionId of pushed) {
    await enqueueTracked(ctx, 'email.suppression.push', { suppressionId }, { singletonKey: `suppress-push:${suppressionId}` });
  }
  await run.progress(1, `Applied ${events.filter((e) => e.type !== 'ignored').length} Postmark event${events.length === 1 ? '' : 's'}`);
}
