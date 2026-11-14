import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { AppError, evaluateSendPolicy, isCommercial, lintEmail, senderDomain, streamFor, type JobPayload, type MessageClass, type SendDecision } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { recordConnectionCheck } from '../lib/connections.js';
import { hashEmail, redactEmails } from '../lib/http.js';
import { enqueueTracked } from '../lib/jobs.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { composeMessage, fromHeader, loadMessageSubject, replyToFor } from '../lib/email/compose.js';
import { consentStateFor, identityFrom, lastReviewRequestSentAt, loadAppSettings, providerReadiness, sendCounters } from '../lib/email/facts.js';
import { addSuppression, updateLinkedReviewRequest } from '../lib/email/ledger.js';
import { defaultEmailDeps, postmarkSettings, type EmailDeps } from '../lib/email/provider.js';
import { hashLinkToken, newLinkToken, reviewRedirectUrl, unsubscribeUrl } from '../lib/email/tokens.js';

type MessageRow = typeof schema.emailMessages.$inferSelect;

/** Shown when a send may or may not have reached Postmark and its search could not find it. */
export const CHECK_BEFORE_RETRY_MESSAGE = "We couldn't confirm whether this email went out. Check the client's inbox or Postmark Activity before sending again.";

/**
 * Shown when Postmark refuses a marketing email (406) to an address the app itself put on Postmark's Broadcast
 * suppression list when the client unsubscribed, and the client has since given permission again. The app never
 * removes addresses from Postmark's list (design §8.1.4), so the owner does it in Postmark.
 */
export const PROVIDER_STILL_SUPPRESSED_MESSAGE =
  "Not sent: Postmark still blocks marketing emails to this address because the app added it to Postmark's unsubscribe list when the client unsubscribed. The client has since given permission again, so remove the address from your Broadcast stream's suppression list in Postmark, then write the email again.";

/** A transient provider failure: the queue retries the job. */
export class TransientSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSendError';
  }
}

/** Review-request skip reason for a gate reason (null when the reason has no review meaning). */
function skipReasonFor(code: string): string | null {
  switch (code) {
    case 'no_consent':
      return 'no_consent';
    case 'unsubscribed':
      return 'unsubscribed';
    case 'suppressed_all':
      return 'suppressed';
    case 'review_opt_out':
      return 'opted_out';
    case 'review_link_missing':
    case 'review_link_invalid':
      return 'no_review_link';
    case 'booking_cancelled':
      return 'booking_cancelled';
    case 'booking_no_show':
      return 'booking_no_show';
    case 'booking_not_completed':
      return 'not_completed';
    case 'recently_asked':
      return 'recently_asked';
    case 'invalid_address':
      return 'no_email';
    default:
      return null;
  }
}

/** Updates a message only while it is in one of `from`; returns whether it changed. */
async function setMessage(ctx: WorkerContext, id: string, from: readonly MessageRow['status'][], set: Partial<typeof schema.emailMessages.$inferInsert>): Promise<boolean> {
  const rows = await ctx.db
    .update(schema.emailMessages)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(schema.emailMessages.id, id), inArray(schema.emailMessages.status, [...from])))
    .returning({ id: schema.emailMessages.id });
  return rows.length > 0;
}

/** Campaign statuses whose messages may be sent. */
const SENDABLE_CAMPAIGN_STATUSES: readonly string[] = ['approved', 'sending'];

/**
 * Stops a campaign message whose campaign the owner paused or cancelled (or that paused itself on complaints or
 * bounces): paused → back to `approved` (it goes out after a resume); cancelled or gone → `cancelled`. Returns the
 * progress message, or null when the message may be sent. Nothing is ever sent to the provider here.
 */
async function campaignBlock(ctx: WorkerContext, msg: MessageRow): Promise<string | null> {
  if (!msg.campaignId) return null;
  const camp = await ctx.db.query.emailCampaigns.findFirst({ columns: { status: true }, where: eq(schema.emailCampaigns.id, msg.campaignId) });
  if (camp && SENDABLE_CAMPAIGN_STATUSES.includes(camp.status)) return null;
  if (!camp || camp.status === 'cancelled') {
    await setMessage(ctx, msg.id, ['approved', 'queued'], { status: 'cancelled', statusMessage: 'Campaign cancelled.' });
    return 'Not sent: the campaign was cancelled';
  }
  await setMessage(ctx, msg.id, ['approved', 'queued'], { status: 'approved', statusMessage: camp.status === 'paused' ? 'Campaign paused.' : 'The campaign is not approved.' });
  return `Not sent: the campaign is ${camp.status}`;
}

/** A held message (provider not ready, webhooks missing) is looked at again after this long, not every minute. */
export const HOLD_RECHECK_MS = 30 * 60_000;

/** Applies a blocking or deferring gate decision to the message (and its review request). */
async function applyDecision(ctx: WorkerContext, msg: MessageRow, decision: SendDecision, now: Date): Promise<string> {
  const text = decision.reasons.map((r) => r.message).join(' ');
  if (decision.decision === 'defer' && decision.deferUntil) {
    await setMessage(ctx, msg.id, ['approved', 'queued'], { status: 'approved', scheduledFor: decision.deferUntil, statusMessage: text });
    await updateLinkedReviewRequest(ctx.db, msg.id, { scheduledFor: decision.deferUntil }, ['scheduled']);
    return `Deferred: ${decision.reasons.map((r) => r.code).join(', ')}`;
  }
  const outcome = decision.outcome ?? 'failed';
  if (outcome === 'hold') {
    // Pushed forward, so dispatch does not hand it on (and create a job) every minute until the problem is fixed.
    const recheck = new Date(Math.max(now.getTime(), msg.scheduledFor?.getTime() ?? 0) + HOLD_RECHECK_MS);
    await setMessage(ctx, msg.id, ['approved', 'queued'], { status: 'approved', scheduledFor: recheck, statusMessage: text });
    await updateLinkedReviewRequest(ctx.db, msg.id, { scheduledFor: recheck }, ['scheduled']);
    return `On hold: ${decision.reasons.map((r) => r.code).join(', ')}`;
  }
  await setMessage(ctx, msg.id, ['approved', 'queued'], { status: outcome, statusMessage: text });
  const skip = decision.reasons.map((r) => skipReasonFor(r.code)).find((s): s is string => Boolean(s));
  const isBookingChange = decision.reasons.some((r) => r.code.startsWith('booking_') || r.code === 'automation_off');
  const requestStatus = isBookingChange ? 'cancelled' : skip ? 'skipped' : outcome === 'cancelled' ? 'cancelled' : 'failed';
  await updateLinkedReviewRequest(ctx.db, msg.id, { status: requestStatus, skipReason: skip ?? null });
  return `Not sent: ${decision.reasons.map((r) => r.code).join(', ')}`;
}

/**
 * `email.send` (design §6.2): the duplicate-safe send of one approved message.
 * 1. Only `approved`/`queued` messages are sent; a message left `sending` without a provider id is recovered first.
 * 2. Unknown-outcome recovery: `findSent` adopts an accepted message, otherwise the owner checks before a retry.
 * 3. The send gate (`evaluateSendPolicy`) runs on fresh facts immediately before the call.
 * 4. The conditional claim sets `submitted_at` (the non-repeatable call marker) before calling Postmark.
 * 5. The result is mapped; transient failures reset the claim and retry, unknown outcomes keep it.
 */
export async function handleEmailSend(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'email.send'>, deps: EmailDeps = defaultEmailDeps(ctx)): Promise<void> {
  const now = deps.now();
  const msg = await ctx.db.query.emailMessages.findFirst({ where: eq(schema.emailMessages.id, payload.emailMessageId) });
  if (!msg) {
    await run.progress(1, 'The email no longer exists');
    return;
  }
  const provider = deps.provider;

  // 2. Unknown-outcome recovery: a previous attempt claimed the message and may have reached Postmark.
  if (msg.submittedAt && !msg.providerMessageId) {
    if (msg.status !== 'sending' && msg.status !== 'queued' && msg.status !== 'approved') {
      await run.progress(1, 'Already settled');
      return;
    }
    if (!provider) {
      await setMessage(ctx, msg.id, ['sending', 'queued', 'approved'], { status: 'failed', ownerAction: 'check_before_retry', statusMessage: CHECK_BEFORE_RETRY_MESSAGE });
      await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'failed' });
      return;
    }
    const found = await provider.findSent(msg.id, msg.toEmail, run.signal);
    if (found) {
      await markSent(ctx, msg, found, now, 'Sent (confirmed with Postmark after a lost answer)');
      await run.progress(1, 'Confirmed as sent');
    } else {
      await setMessage(ctx, msg.id, ['sending', 'queued', 'approved'], { status: 'failed', ownerAction: 'check_before_retry', statusMessage: CHECK_BEFORE_RETRY_MESSAGE });
      await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'failed' });
      await writeWorkerAudit(ctx.db, { userId: null, action: 'email.message.check_before_retry', entityType: 'email_message', entityId: msg.id }, ctx.logger);
      await run.progress(1, 'Could not confirm; waiting for the owner');
    }
    return;
  }
  // 1. Only approved or queued messages are sent.
  if (msg.status !== 'approved' && msg.status !== 'queued') {
    await run.progress(1, `Nothing to send (${msg.status})`);
    return;
  }
  // 1b. A campaign message goes out only while its campaign is still sending (checked again under lock at the claim).
  const campaignHold = await campaignBlock(ctx, msg);
  if (campaignHold) {
    await run.progress(1, campaignHold);
    return;
  }

  // 3. The gate, on fresh facts.
  const settings = await loadAppSettings(ctx.db);
  const subjectOf = await loadMessageSubject(ctx.db, msg);
  const messageClass = msg.messageClass as MessageClass;
  const readiness = await providerReadiness(ctx.db, ctx.env, settings);
  const ready = { ...readiness, ready: readiness.ready && provider !== null };
  const { consent, suppressions } = await consentStateFor(ctx.db, msg.toEmail, settings, now);
  const automationName = msg.purpose === 'review_request' ? 'review_request' : 'follow_up';
  const automation = automationName === 'review_request' ? settings.reviews.automation : settings.email.followUp;
  const counters = await sendCounters(ctx.db, { purpose: msg.purpose, customerId: msg.customerId, now });
  const owner = msg.origin === 'preview' ? await ctx.db.query.users.findFirst({ where: eq(schema.users.role, 'owner') }) : null;
  const recentlyAsked =
    messageClass === 'review_request' && msg.customerId
      ? Boolean(await lastReviewRequestSentAt(ctx.db, msg.customerId, subjectOf.reviewRequest?.id ?? null).then((d) => d && d.getTime() > now.getTime() - settings.reviews.minDaysBetweenRequests * 86_400_000))
      : false;
  const decision = evaluateSendPolicy({
    messageClass,
    origin: msg.origin,
    toEmail: msg.toEmail,
    ownerEmail: owner?.email ?? null,
    customer: subjectOf.customer ? { deleted: Boolean(subjectOf.customer.deletedAt), reviewOptOut: subjectOf.customer.reviewRequestsOptOut, squareEmailUnsubscribed: subjectOf.customer.squareEmailUnsubscribed } : null,
    consent,
    suppressions,
    identity: identityFrom(settings),
    provider: ready,
    booking: subjectOf.booking ? { status: subjectOf.booking.status, completionSource: subjectOf.booking.completionSource, completedAt: subjectOf.booking.completedAt, squareEnvironment: subjectOf.booking.squareEnvironment } : null,
    reviewLink: messageClass === 'review_request' ? settings.business.googleReviewLink : null,
    recentlyAsked,
    minDaysBetweenRequests: settings.reviews.minDaysBetweenRequests,
    lint: lintEmail({ messageClass, subject: msg.subject, bodyMarkdown: msg.bodyMarkdown }),
    automationEnabled: msg.origin === 'automation' ? automation.enabled : null,
    approvedByPerson: Boolean(msg.approvedBy),
    counters: { ...counters, automationCap: msg.origin === 'automation' ? automation.dailyCap : null, commercialCap: settings.email.dailyCommercialCap },
    window: settings.email.sendWindow,
    now,
  });
  if (decision.decision !== 'send' || !provider) {
    const summary = await applyDecision(ctx, msg, decision, now);
    await run.progress(1, summary);
    return;
  }
  const pm = postmarkSettings(ctx.env);
  if (!pm) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Email sending is not set up on the server.');

  // 4. Claim (the non-repeatable call marker), with the rendered copy and the hashed personal tokens. A cancel that
  // arrived during the gate stops here, before anything is claimed.
  run.checkCancelled();
  const commercial = isCommercial(messageClass);
  const unsubToken = commercial ? newLinkToken() : null;
  const clickToken = messageClass === 'review_request' ? newLinkToken() : null;
  const rendered = composeMessage(settings, {
    messageClass,
    subject: msg.subject,
    bodyMarkdown: msg.bodyMarkdown,
    subjectOf,
    reviewLinkUrl: clickToken ? reviewRedirectUrl(ctx.env.APP_URL, clickToken) : null,
    unsubscribeUrl: unsubToken ? unsubscribeUrl(ctx.env.APP_URL, unsubToken) : null,
  });
  const stream = streamFor(messageClass);
  const claimed = await ctx.db.transaction(async (tx) => {
    // The owner's pause or cancel (and the automatic pause) lock the campaign row FOR UPDATE: holding it FOR SHARE
    // here means a message is either claimed before the pause commits or not claimed at all.
    if (msg.campaignId) {
      const [camp] = await tx.select({ status: schema.emailCampaigns.status }).from(schema.emailCampaigns).where(eq(schema.emailCampaigns.id, msg.campaignId)).for('share');
      if (!camp || !SENDABLE_CAMPAIGN_STATUSES.includes(camp.status)) return false;
    }
    // "Send again" after an unknown outcome claims the message a second time with new tokens. The first attempt may
    // have reached the client, so its link tokens are kept (moved to email_link_tokens) and keep working.
    const [current] = await tx
      .select({ status: schema.emailMessages.status, submittedAt: schema.emailMessages.submittedAt, unsubscribeTokenHash: schema.emailMessages.unsubscribeTokenHash })
      .from(schema.emailMessages)
      .where(eq(schema.emailMessages.id, msg.id))
      .for('update');
    if (!current || (current.status !== 'approved' && current.status !== 'queued') || current.submittedAt) return false;
    if (current.unsubscribeTokenHash) {
      await tx.insert(schema.emailLinkTokens).values({ tokenHash: current.unsubscribeTokenHash, kind: 'unsubscribe', emailMessageId: msg.id }).onConflictDoNothing();
    }
    if (clickToken) {
      const earlier = await tx
        .select({ id: schema.reviewRequests.id, clickTokenHash: schema.reviewRequests.clickTokenHash })
        .from(schema.reviewRequests)
        .where(and(eq(schema.reviewRequests.emailMessageId, msg.id), isNotNull(schema.reviewRequests.clickTokenHash)));
      for (const r of earlier) {
        await tx.insert(schema.emailLinkTokens).values({ tokenHash: r.clickTokenHash!, kind: 'review_click', emailMessageId: msg.id, reviewRequestId: r.id }).onConflictDoNothing();
      }
    }
    const rows = await tx
      .update(schema.emailMessages)
      .set({
        status: 'sending',
        submittedAt: now,
        stream,
        consentBasis: decision.consentBasis as unknown as Record<string, unknown>,
        unsubscribeTokenHash: unsubToken ? hashLinkToken(unsubToken) : null,
        subject: rendered.subject,
        bodyHtml: rendered.storedHtml,
        bodyText: rendered.storedText,
        isSandbox: decision.sandbox,
        statusMessage: '',
        updatedAt: now,
      })
      .where(and(eq(schema.emailMessages.id, msg.id), inArray(schema.emailMessages.status, ['approved', 'queued']), isNull(schema.emailMessages.submittedAt)))
      .returning({ id: schema.emailMessages.id });
    if (!rows.length) return false;
    if (clickToken) {
      await tx.update(schema.reviewRequests).set({ clickTokenHash: hashLinkToken(clickToken), updatedAt: now }).where(eq(schema.reviewRequests.emailMessageId, msg.id));
    }
    return true;
  });
  if (!claimed) {
    const hold = await campaignBlock(ctx, msg);
    await run.progress(1, hold ?? 'Another attempt is sending this email');
    return;
  }

  // 5. Last point where a cancel applies, then the one external call. Postmark has certainly not been called yet,
  // so a cancel here releases the claim instead of leaving an "unknown outcome" for the owner to check.
  try {
    run.checkCancelled();
  } catch (err) {
    await setMessage(ctx, msg.id, ['sending'], { status: 'approved', submittedAt: null, statusMessage: '' });
    throw err;
  }
  const result = await provider.send(
    {
      emailMessageId: msg.id,
      to: msg.toEmail,
      from: fromHeader(pm.from, settings),
      replyTo: replyToFor(settings),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      stream,
      tag: msg.purpose,
      metadata: { emailMessageId: msg.id, purpose: msg.purpose, ...(msg.campaignId ? { campaignId: msg.campaignId } : {}) },
    },
    run.signal,
  );

  // 6. The result.
  if (result.ok) {
    await markSent(ctx, msg, result.providerMessageId, now, decision.sandbox ? 'Test — not delivered' : '');
    // Postmark accepted a live send to an address outside the sender's domain: the account is approved, so an
    // earlier "pending approval" (412) answer no longer applies (until approval, only own-domain sends work).
    if (!decision.sandbox) await recordApprovalSeen(ctx, msg.toEmail, pm.from);
    await run.progress(1, decision.sandbox ? 'Sent to the Postmark test server (not delivered)' : 'Sent');
    return;
  }
  const verbatim = redactEmails(`${result.message} (Postmark ${result.code})`).slice(0, 500);
  switch (result.kind) {
    case 'transient': {
      // Nothing was accepted: release the claim so the retry (or the next dispatch) sends it.
      await setMessage(ctx, msg.id, ['sending'], { status: run.willRetry ? 'queued' : 'approved', submittedAt: null, statusMessage: 'Postmark was busy; trying again shortly.' });
      throw new TransientSendError(`Postmark was busy (${result.code})`);
    }
    case 'unknown_outcome':
      // Keep `submitted_at`: the retry looks the message up before doing anything else.
      throw new TransientSendError('Postmark did not confirm the send; checking before trying again');
    case 'inactive_recipient': {
      if (stream === 'broadcast' && (await refusedBecauseOfOwnUnsubscribePush(ctx, msg.toEmail))) {
        // The 406 is the app's own unsubscribe push, not a bounce or a report: say so, and add no block of our own
        // (it would keep blocking after the owner removes the address from Postmark's list).
        await setMessage(ctx, msg.id, ['sending'], { status: 'suppressed', error: verbatim, statusMessage: PROVIDER_STILL_SUPPRESSED_MESSAGE });
        await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'skipped', skipReason: 'suppressed' });
        await writeWorkerAudit(ctx.db, { userId: null, action: 'email.provider_still_suppressed', entityType: 'email_address', entityId: hashEmail(msg.toEmail), data: { emailMessageId: msg.id } }, ctx.logger);
        break;
      }
      const scope = stream === 'broadcast' ? 'marketing' : 'all';
      await setMessage(ctx, msg.id, ['sending'], { status: 'suppressed', error: verbatim, statusMessage: 'Postmark has stopped sending to this address (it bounced or was reported before).' });
      const suppressionId = await addSuppression(ctx.db, { email: msg.toEmail, scope, reason: 'provider_inactive', source: 'send_error', stream, emailMessageId: msg.id });
      await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'skipped', skipReason: 'suppressed' });
      if (suppressionId) ctx.logger.info({ suppressionId }, 'address suppressed after an inactive-recipient answer');
      break;
    }
    case 'invalid_recipient':
      await setMessage(ctx, msg.id, ['sending'], { status: 'failed', error: verbatim, statusMessage: 'This address was rejected as invalid.' });
      await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'failed' });
      break;
    case 'pending_approval':
      await setMessage(ctx, msg.id, ['sending'], { status: 'failed', error: verbatim, statusMessage: "Postmark is still reviewing your account. Until it's approved you can only email addresses at your own domain." });
      await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'failed' });
      await recordConnectionCheck(ctx.db, 'postmark', { status: 'connected', capabilities: { approved: false } });
      break;
    case 'sender_not_verified':
    case 'auth': {
      const message = result.kind === 'auth' ? 'Postmark rejected the server token. Replace POSTMARK_SERVER_TOKEN on the server.' : 'Postmark has not confirmed the sender address or domain yet. Finish the domain set-up in Postmark, then check the connection again.';
      await setMessage(ctx, msg.id, ['sending'], { status: 'failed', error: verbatim, statusMessage: message });
      await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'failed' });
      // Dispatch stops sending until the next successful check.
      await recordConnectionCheck(ctx.db, 'postmark', { status: result.kind === 'auth' ? 'needs_reauth' : 'error', lastError: message, capabilities: { sendingBlocked: true } });
      break;
    }
    default:
      await setMessage(ctx, msg.id, ['sending'], { status: 'failed', error: verbatim, statusMessage: `Postmark refused this email: ${verbatim}` });
      await updateLinkedReviewRequest(ctx.db, msg.id, { status: 'failed' });
  }
  await run.progress(1, `Not sent: ${result.kind}`);
}

/**
 * True when the address has no active block in the app, but an unsubscribe the app pushed to Postmark was later
 * reversed by new express permission: Postmark's Broadcast list (which the app never edits back) still has it.
 */
async function refusedBecauseOfOwnUnsubscribePush(ctx: WorkerContext, toEmail: string): Promise<boolean> {
  const s = schema.emailSuppressions;
  const emailLower = toEmail.trim().toLowerCase();
  const active = await ctx.db.select({ id: s.id }).from(s).where(and(eq(s.emailLower, emailLower), isNull(s.liftedAt))).limit(1);
  if (active.length) return false;
  const pushedThenLifted = await ctx.db
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.emailLower, emailLower), eq(s.reason, 'unsubscribe'), isNotNull(s.pushedToProviderAt), isNotNull(s.liftedAt)))
    .limit(1);
  return pushedThenLifted.length > 0;
}

/** Clears a stored "pending approval" once a live send outside the sender's own domain was accepted (design §3.1). */
export async function recordApprovalSeen(ctx: WorkerContext, toEmail: string, from: string): Promise<void> {
  const own = senderDomain(from);
  const at = toEmail.lastIndexOf('@');
  const recipientDomain = at > 0 ? toEmail.slice(at + 1).toLowerCase() : null;
  if (!own || !recipientDomain || recipientDomain === own) return;
  const t = schema.integrationConnections;
  await ctx.db
    .update(t)
    .set({ capabilities: sql`${t.capabilities} || '{"approved": true}'::jsonb`, updatedAt: new Date() })
    .where(and(eq(t.provider, 'postmark'), sql`(${t.capabilities} ->> 'approved') is distinct from 'true'`));
}

/** Records an accepted send: the message, its review request, its campaign counter and the audit entry. */
async function markSent(ctx: WorkerContext, msg: MessageRow, providerMessageId: string, now: Date, statusMessage: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.emailMessages)
      .set({ status: 'sent', providerMessageId, sentAt: now, ownerAction: null, statusMessage, updatedAt: now })
      .where(and(eq(schema.emailMessages.id, msg.id), inArray(schema.emailMessages.status, ['sending', 'queued', 'approved'])))
      .returning({ id: schema.emailMessages.id });
    if (!rows.length) return;
    await tx
      .update(schema.reviewRequests)
      .set({ status: 'sent', sentAt: now, updatedAt: now })
      .where(and(eq(schema.reviewRequests.emailMessageId, msg.id), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled', 'failed'])));
    if (msg.campaignId) {
      await tx
        .update(schema.emailCampaigns)
        .set({ sentCount: sql`${schema.emailCampaigns.sentCount} + 1`, updatedAt: now })
        .where(eq(schema.emailCampaigns.id, msg.campaignId));
    }
    await writeWorkerAudit(tx, { userId: null, action: 'email.message.sent', entityType: 'email_message', entityId: msg.id, data: { purpose: msg.purpose, origin: msg.origin, campaignId: msg.campaignId } });
  });
}

/** Hands one message to `email.send` (dispatch and the API use the same singleton key). */
export async function enqueueEmailSend(ctx: WorkerContext, emailMessageId: string): Promise<string> {
  return enqueueTracked(ctx, 'email.send', { emailMessageId }, { singletonKey: `email-send:${emailMessageId}` });
}
