import { and, eq, gte, inArray, isNotNull, isNull, like, notExists, sql } from 'drizzle-orm';
import {
  DEFAULT_AUTOMATION_TEMPLATE_IDS,
  bookingBlock,
  dedupeKeys,
  isGenuinelyCompleted,
  newId,
  nextSendSlot,
  reviewEligibility,
  type AppSettings,
  type AutomationSettings,
  type JobPayload,
  type MessageClass,
} from '@studio/core';
import { genuinelyCompletedBookingWhere, schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { composeMessage } from '../lib/email/compose.js';
import { consentStateFor, ensureBuiltInTemplates, lastReviewRequestSentAt, loadAppSettings, marketingBlockFrom } from '../lib/email/facts.js';
import { recordWithdrawal } from '../lib/email/ledger.js';
import { defaultEmailDeps, type EmailDeps } from '../lib/email/provider.js';

type Booking = typeof schema.bookings.$inferSelect;
type Customer = typeof schema.customers.$inferSelect;
type AutomationName = 'follow_up' | 'review_request';

const DAY_MS = 86_400_000;
/** Most bookings considered per automation per run (the next run continues with the ones still unprocessed). */
export const SWEEP_BATCH = 200;

/**
 * Live-Square bookings genuinely completed since `since` that this automation has not handled yet (design §6: "with
 * no row for the dedupe key"), oldest first, with their client. Handled bookings are excluded in SQL, so a busy week
 * with more than {@link SWEEP_BATCH} completions never holds newer bookings back. Follow-ups only consider clients
 * with a usable address (the others never get a row, so they would otherwise be read again on every run).
 */
async function completedBookingsSince(ctx: WorkerContext, since: Date, name: AutomationName): Promise<Array<{ booking: Booking; customer: Customer | null }>> {
  const b = schema.bookings;
  const handled =
    name === 'review_request'
      ? sql`not exists (select 1 from ${schema.reviewRequests} where ${schema.reviewRequests.dedupeKey} = 'review:' || ${b.id})`
      : sql`not exists (select 1 from ${schema.emailMessages} where ${schema.emailMessages.dedupeKey} = 'follow_up:' || ${b.id})`;
  const rows = await ctx.db
    .select({ booking: b, customer: schema.customers })
    .from(b)
    .leftJoin(schema.customers, eq(b.customerId, schema.customers.id))
    .where(
      and(
        genuinelyCompletedBookingWhere(),
        gte(b.completedAt, since),
        handled,
        name === 'follow_up' ? and(isNotNull(schema.customers.email), isNull(schema.customers.deletedAt)) : undefined,
      ),
    )
    .orderBy(b.completedAt, b.id)
    .limit(SWEEP_BATCH);
  return rows.filter((r) => isGenuinelyCompleted(r.booking));
}

/** The template an automation uses (the owner's choice, else the built-in neutral one). */
async function templateFor(ctx: WorkerContext, name: AutomationName, automation: AutomationSettings) {
  const id = automation.templateId ?? DEFAULT_AUTOMATION_TEMPLATE_IDS[name];
  const t = await ctx.db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, id) });
  if (t && t.enabled) return t;
  return ctx.db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, DEFAULT_AUTOMATION_TEMPLATE_IDS[name]) });
}

/**
 * Creates the request (or a skipped request) and the message for one completed booking, at most once: the inserts use
 * `ON CONFLICT (dedupe_key) DO NOTHING` inside one transaction, so two sweeps running at once create one request.
 */
async function prepareForBooking(
  ctx: WorkerContext,
  settings: AppSettings,
  name: AutomationName,
  automation: AutomationSettings,
  item: { booking: Booking; customer: Customer | null },
  now: Date,
): Promise<'created' | 'skipped' | 'exists' | 'none'> {
  const { booking, customer } = item;
  const completedAt = booking.completedAt;
  if (!completedAt) return 'none';
  const template = await templateFor(ctx, name, automation);
  if (!template) return 'none';
  const dedupeKey = name === 'review_request' ? dedupeKeys.reviewForBooking(booking.id) : dedupeKeys.followUp(booking.id);
  const approveEach = automation.mode === 'approve_each';
  const scheduledFor = nextSendSlot(new Date(completedAt.getTime() + automation.delayHours * 3600_000), settings.email.sendWindow);

  if (name === 'review_request') {
    let marketingBlock: 'no_consent' | 'unsubscribed' | 'suppressed' | null = null;
    if (customer?.email) {
      const facts = await consentStateFor(ctx.db, customer.email, settings, now);
      marketingBlock = marketingBlockFrom(facts.consent, facts.suppressions, customer.squareEmailUnsubscribed);
    }
    const eligibility = reviewEligibility({
      evidence: { kind: 'booking', booking: { status: booking.status, completionSource: booking.completionSource, completedAt, squareEnvironment: booking.squareEnvironment } },
      automation: { enabledAt: automation.enabledAt ? new Date(automation.enabledAt) : null, maxAgeDays: settings.reviews.maxAgeDays },
      customer: customer ? { deleted: Boolean(customer.deletedAt), email: customer.email, reviewRequestsOptOut: customer.reviewRequestsOptOut } : null,
      lastRequestSentAt: customer ? await lastReviewRequestSentAt(ctx.db, customer.id, null) : null,
      minDaysBetweenRequests: settings.reviews.minDaysBetweenRequests,
      reviewLink: settings.business.googleReviewLink,
      marketingBlock,
      now,
    });
    return ctx.db.transaction(async (tx) => {
      const requestId = newId();
      if (!eligibility.eligible) {
        const inserted = await tx
          .insert(schema.reviewRequests)
          .values({ id: requestId, bookingId: booking.id, customerId: customer?.id ?? null, channel: 'email', status: 'skipped', skipReason: eligibility.skipReason, origin: 'automation', completionEvidence: booking.completionSource, dedupeKey })
          .onConflictDoNothing()
          .returning({ id: schema.reviewRequests.id });
        return inserted.length ? 'skipped' : 'exists';
      }
      const inserted = await tx
        .insert(schema.reviewRequests)
        .values({ id: requestId, bookingId: booking.id, customerId: customer?.id ?? null, channel: 'email', status: approveEach ? 'pending_approval' : 'scheduled', origin: 'automation', completionEvidence: booking.completionSource, dedupeKey, scheduledFor })
        .onConflictDoNothing()
        .returning({ id: schema.reviewRequests.id });
      if (!inserted.length || !customer?.email) return 'exists';
      const messageId = await insertMessage(tx, settings, { template, customer, booking, dedupeKey, approveEach, scheduledFor, purpose: 'review_request' });
      if (!messageId) return 'exists';
      await tx.update(schema.reviewRequests).set({ emailMessageId: messageId }).where(eq(schema.reviewRequests.id, requestId));
      return 'created';
    });
  }

  // Follow-up: only clients with an address; the gate checks consent at send time for a marketing template.
  if (!customer || customer.deletedAt || !customer.email) return 'none';
  if (automation.enabledAt && completedAt.getTime() < new Date(automation.enabledAt).getTime()) return 'none';
  return ctx.db.transaction(async (tx) => {
    const messageId = await insertMessage(tx, settings, { template, customer, booking, dedupeKey, approveEach, scheduledFor, purpose: 'follow_up' });
    return messageId ? 'created' : 'exists';
  });
}

/** Inserts one automation message (draft to approve, or approved by the automation setting). */
async function insertMessage(
  tx: Parameters<Parameters<WorkerContext['db']['transaction']>[0]>[0],
  settings: AppSettings,
  input: { template: typeof schema.emailTemplates.$inferSelect; customer: Customer; booking: Booking; dedupeKey: string; approveEach: boolean; scheduledFor: Date; purpose: 'review_request' | 'follow_up' },
): Promise<string | null> {
  const id = newId();
  const messageClass = input.template.messageClass as MessageClass;
  // The stored preview copy (markers instead of personal links); the real links are made at send time.
  const preview = composeMessage(settings, {
    messageClass,
    subject: input.template.subject,
    bodyMarkdown: input.template.bodyMarkdown,
    subjectOf: { customer: input.customer, booking: input.booking, reviewRequest: null },
    reviewLinkUrl: messageClass === 'review_request' ? '[review link]' : null,
    unsubscribeUrl: messageClass === 'transactional_factual' ? null : '[unsubscribe link]',
  });
  const rows = await tx
    .insert(schema.emailMessages)
    .values({
      id,
      templateId: input.template.id,
      customerId: input.customer.id,
      bookingId: input.booking.id,
      toEmail: input.customer.email ?? '',
      subject: input.template.subject,
      bodyMarkdown: input.template.bodyMarkdown,
      bodyHtml: preview.storedHtml,
      bodyText: preview.storedText,
      purpose: input.purpose,
      messageClass,
      origin: 'automation',
      dedupeKey: input.dedupeKey,
      status: input.approveEach ? 'draft' : 'approved',
      approvedAt: input.approveEach ? null : new Date(),
      scheduledFor: input.scheduledFor,
    })
    .onConflictDoNothing()
    .returning({ id: schema.emailMessages.id });
  return rows[0]?.id ?? null;
}

/** Cancels pending requests and messages whose booking no longer genuinely counts as completed (design §4.3 step 6). */
async function cancelStale(ctx: WorkerContext): Promise<number> {
  const m = schema.emailMessages;
  const rows = await ctx.db
    .select({ message: m, booking: schema.bookings })
    .from(m)
    .innerJoin(schema.bookings, eq(m.bookingId, schema.bookings.id))
    .where(and(inArray(m.status, ['draft', 'approved', 'queued']), isNull(m.submittedAt), inArray(m.origin, ['automation', 'manual'])))
    .limit(500);
  let n = 0;
  for (const { message, booking } of rows) {
    const block = bookingBlock(booking);
    if (!block) continue;
    const skipReason = block === 'booking_cancelled' ? 'booking_cancelled' : block === 'booking_no_show' ? 'booking_no_show' : 'not_completed';
    const changed = await ctx.db
      .update(m)
      .set({ status: 'cancelled', statusMessage: 'The appointment is no longer marked as completed.', updatedAt: new Date() })
      .where(and(eq(m.id, message.id), inArray(m.status, ['draft', 'approved', 'queued']), isNull(m.submittedAt)))
      .returning({ id: m.id });
    if (!changed.length) continue;
    await ctx.db
      .update(schema.reviewRequests)
      .set({ status: 'cancelled', skipReason, updatedAt: new Date() })
      .where(and(eq(schema.reviewRequests.emailMessageId, message.id), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
    n++;
  }
  return n;
}

/** Turning an automation off cancels the messages it approved by itself that have not gone out (drafts stay). */
async function cancelSwitchedOff(ctx: WorkerContext, name: AutomationName): Promise<number> {
  const m = schema.emailMessages;
  const rows = await ctx.db
    .update(m)
    .set({ status: 'cancelled', statusMessage: 'The automation was switched off before this was sent.', updatedAt: new Date() })
    .where(and(eq(m.origin, 'automation'), isNull(m.approvedBy), inArray(m.status, ['approved', 'queued']), isNull(m.submittedAt), like(m.dedupeKey, name === 'review_request' ? 'review:%' : 'follow_up:%')))
    .returning({ id: m.id });
  if (rows.length) {
    await ctx.db
      .update(schema.reviewRequests)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(inArray(schema.reviewRequests.emailMessageId, rows.map((r) => r.id)), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
  }
  return rows.length;
}

/**
 * Square's own "email unsubscribed" flag: one `withdrawn` ledger event (method `square_preference`) per client the
 * first time it is seen as true. Never a grant; false or unknown mean nothing.
 */
async function recordSquareOptOuts(ctx: WorkerContext): Promise<number> {
  const cu = schema.customers;
  const ce = schema.consentEvents;
  const rows = await ctx.db
    .select({ id: cu.id, email: cu.email })
    .from(cu)
    .where(
      and(
        eq(cu.squareEmailUnsubscribed, true),
        isNotNull(cu.email),
        notExists(ctx.db.select({ one: sql`1` }).from(ce).where(and(eq(ce.customerId, cu.id), eq(ce.method, 'square_preference')))),
      ),
    )
    .limit(SWEEP_BATCH);
  for (const r of rows) {
    if (!r.email) continue;
    await recordWithdrawal(ctx.db, { email: r.email, customerId: r.id, method: 'square_preference', evidence: { note: "Square shows this client as unsubscribed from email" } });
  }
  return rows.length;
}

/**
 * `email.automation.sweep` (every 10 minutes, design §6): for each enabled automation, completed appointments since
 * `max(enabledAt, now − maxAgeDays)` get a request and message (or a skipped request with its reason) at most once;
 * pending items whose appointment changed are cancelled; Square opt-outs are recorded in the ledger.
 */
export async function handleEmailSweep(ctx: WorkerContext, run: TrackedRun, _payload: JobPayload<'email.automation.sweep'>, deps: EmailDeps = defaultEmailDeps(ctx)): Promise<void> {
  const now = deps.now();
  const settings = await loadAppSettings(ctx.db);
  await ensureBuiltInTemplates(ctx.db);
  const optOuts = await recordSquareOptOuts(ctx);
  const counts = { created: 0, skipped: 0 };
  const automations: Array<[AutomationName, AutomationSettings]> = [
    ['follow_up', settings.email.followUp],
    ['review_request', settings.reviews.automation],
  ];
  let switchedOff = 0;
  for (const [name, automation] of automations) {
    run.checkCancelled();
    if (!automation.enabled || !automation.enabledAt) {
      switchedOff += await cancelSwitchedOff(ctx, name);
      continue;
    }
    // Square already asks for feedback: the review automation stays off (design §4.3).
    if (name === 'review_request' && settings.email.squareSends.feedbackOrReviews === true) continue;
    const enabledAt = new Date(automation.enabledAt);
    const since = new Date(Math.max(enabledAt.getTime(), now.getTime() - settings.reviews.maxAgeDays * DAY_MS));
    for (const item of await completedBookingsSince(ctx, since, name)) {
      const outcome = await prepareForBooking(ctx, settings, name, automation, item, now);
      if (outcome === 'created') counts.created++;
      if (outcome === 'skipped') counts.skipped++;
    }
  }
  const cancelled = await cancelStale(ctx);
  if (counts.created || counts.skipped || cancelled || switchedOff || optOuts) {
    await writeWorkerAudit(ctx.db, { userId: null, action: 'email.automation.sweep', entityType: 'email_automation', data: { ...counts, cancelled, switchedOff, squareOptOuts: optOuts } }, ctx.logger);
  }
  await run.progress(1, `Prepared ${counts.created}, skipped ${counts.skipped}, cancelled ${cancelled + switchedOff}`);
}
