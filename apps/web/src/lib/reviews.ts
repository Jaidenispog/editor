import 'server-only';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  DEFAULT_AUTOMATION_TEMPLATE_IDS,
  REVIEW_SKIP_LABELS,
  addDaysToDate,
  dedupeKeys,
  melbourneDateOf,
  melbourneDayRange,
  melbourneLocalToUtc,
  newId,
  reviewEligibility,
  validateReviewLink,
  type ReviewSkipReason,
} from '@studio/core';
import { schema } from '@studio/db';
import type { PlacesStateDto, ReviewRequestDto } from '@/components/email/types';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { approveMessage, appointmentWords, consentFor, customerName, ensureDefaultTemplates, hashLinkToken, renderForDisplay } from './email.js';
import { getEnv } from './env.js';
import { createTrackedJob } from './jobs.js';
import { getSettings, updateSettingsLocked } from './settings.js';

/**
 * Review requests and the Google rating (email design §4.3, §4.7, §4.8). Requests are tracked separately from reviews:
 * nothing here ever matches a request to a review. The app never builds a Google review URL; it only stores the link
 * the owner pastes (or Google's own `writeAReviewUri`, on the owner's explicit choice).
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** The attribution shown next to Places numbers (exact wording to confirm against Google's policy before go-live). */
export const PLACES_ATTRIBUTION = 'Rating from Google Maps';
/** The owner may refresh the rating at most this often. */
export const PLACES_REFRESH_MINUTES = 10;

// ---------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------

/** Review requests with their status, newest first, and this month's counts (Melbourne calendar month). */
export async function listReviewRequests(status?: string): Promise<{ items: ReviewRequestDto[]; counts: { sentThisMonth: number; openedThisMonth: number } }> {
  const db = getDb();
  const r = schema.reviewRequests;
  const rows = await db
    .select({ req: r, customer: schema.customers, booking: schema.bookings, message: schema.emailMessages })
    .from(r)
    .leftJoin(schema.customers, eq(r.customerId, schema.customers.id))
    .leftJoin(schema.bookings, eq(r.bookingId, schema.bookings.id))
    .leftJoin(schema.emailMessages, eq(r.emailMessageId, schema.emailMessages.id))
    .where(status ? inArray(r.status, status.split(',') as Array<typeof r.$inferSelect.status>) : undefined)
    .orderBy(desc(r.createdAt))
    .limit(300);
  const today = melbourneDateOf(new Date());
  const monthStart = melbourneDayRange(`${today.slice(0, 8)}01`).start;
  const [sent, opened] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(r).where(and(eq(r.status, 'sent'), gte(r.sentAt, monthStart))),
    db.select({ n: sql<number>`count(*)::int` }).from(r).where(gte(r.firstClickedAt, monthStart)),
  ]);
  const items = rows.map(({ req, customer, booking, message }) => ({
    id: req.id,
    customerName: customerName(customer),
    appointment: booking ? appointmentWords(booking.serviceName, booking.startAt) : req.attestedVisitDate ? `Visit on ${req.attestedVisitDate} (you confirmed it)` : 'Appointment',
    status: req.status,
    skipReason: req.skipReason,
    skipLabel: req.skipReason ? (REVIEW_SKIP_LABELS[req.skipReason as ReviewSkipReason] ?? req.skipReason) : null,
    origin: req.origin,
    sentAt: iso(req.sentAt),
    firstClickedAt: iso(req.firstClickedAt),
    clickCount: req.clickCount,
    emailMessageId: req.emailMessageId,
    messageStatus: message?.status ?? null,
    isSandbox: message?.isSandbox ?? false,
    createdAt: req.createdAt.toISOString(),
  }));
  return { items, counts: { sentThisMonth: sent[0]?.n ?? 0, openedThisMonth: opened[0]?.n ?? 0 } };
}

/**
 * "Send a request" without Square (memo §7 Tier 0): the owner confirms the visit went ahead (the explicit completed
 * flag). The same eligibility and template as the automation; a draft to approve, or a skipped request with its reason.
 */
export async function createManualReviewRequest(user: SessionUser, input: { customerId: string; visitDate: string }) {
  const settings = await getSettings();
  const db = getDb();
  const today = melbourneDateOf(new Date());
  if (input.visitDate > today || input.visitDate < addDaysToDate(today, -7)) throw new AppError('VALIDATION', 'Choose today or a day in the last week.');
  const customer = await db.query.customers.findFirst({ where: eq(schema.customers.id, input.customerId) });
  if (!customer || customer.deletedAt) throw new AppError('NOT_FOUND', 'That client no longer exists.');
  await ensureDefaultTemplates();
  const automationTemplate = settings.reviews.automation.templateId;
  const template =
    (automationTemplate ? await db.query.emailTemplates.findFirst({ where: and(eq(schema.emailTemplates.id, automationTemplate), eq(schema.emailTemplates.enabled, true)) }) : null) ??
    (await db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, DEFAULT_AUTOMATION_TEMPLATE_IDS.review_request) }));
  if (!template) throw new AppError('INTERNAL', 'The review request template is missing.');
  let marketingBlock: 'no_consent' | 'unsubscribed' | 'suppressed' | null = null;
  if (customer.email) {
    const { consent, suppressions } = await consentFor(customer.email, settings);
    marketingBlock = suppressions.some((s) => s.scope === 'all') ? 'suppressed' : suppressions.some((s) => s.scope === 'marketing') || consent.status === 'withdrawn' || customer.squareEmailUnsubscribed === true ? 'unsubscribed' : consent.status === 'express' || consent.status === 'inferred' ? null : 'no_consent';
  }
  const lastSent = await db.select({ at: sql<Date | null>`max(${schema.reviewRequests.sentAt})` }).from(schema.reviewRequests).where(and(eq(schema.reviewRequests.customerId, customer.id), eq(schema.reviewRequests.status, 'sent')));
  const eligibility = reviewEligibility({
    evidence: { kind: 'attestation', visitDate: input.visitDate, attestedBy: user.id },
    automation: null,
    customer: { deleted: Boolean(customer.deletedAt), email: customer.email, reviewRequestsOptOut: customer.reviewRequestsOptOut },
    lastRequestSentAt: lastSent[0]?.at ? new Date(lastSent[0].at) : null,
    minDaysBetweenRequests: settings.reviews.minDaysBetweenRequests,
    reviewLink: settings.business.googleReviewLink,
    marketingBlock,
    now: new Date(),
  });
  const dedupeKey = dedupeKeys.reviewManual(customer.id, input.visitDate);
  const requestId = newId();
  const visit = melbourneLocalToUtc(input.visitDate, '12:00');
  const result = await db.transaction(async (tx) => {
    const base = { id: requestId, customerId: customer.id, channel: 'email' as const, origin: 'manual' as const, completionEvidence: 'owner_attested', attestedBy: user.id, attestedVisitDate: input.visitDate, dedupeKey };
    if (!eligibility.eligible) {
      const ins = await tx.insert(schema.reviewRequests).values({ ...base, status: 'skipped', skipReason: eligibility.skipReason }).onConflictDoNothing().returning({ id: schema.reviewRequests.id });
      return ins.length ? { created: true, skipped: eligibility.skipReason as string } : { created: false, skipped: null };
    }
    const ins = await tx.insert(schema.reviewRequests).values({ ...base, status: 'pending_approval' }).onConflictDoNothing().returning({ id: schema.reviewRequests.id });
    if (!ins.length) return { created: false, skipped: null };
    const messageId = newId();
    const preview = renderForDisplay(settings, { messageClass: 'review_request', subject: template.subject, bodyMarkdown: template.bodyMarkdown, customer, booking: null, visitDate: visit.ok ? visit.instant : null });
    await tx.insert(schema.emailMessages).values({
      id: messageId,
      templateId: template.id,
      customerId: customer.id,
      toEmail: customer.email ?? '',
      subject: template.subject,
      bodyMarkdown: template.bodyMarkdown,
      bodyHtml: preview.storedHtml,
      bodyText: preview.storedText,
      purpose: 'review_request',
      messageClass: 'review_request',
      origin: 'manual',
      dedupeKey,
      status: 'draft',
    });
    await tx.update(schema.reviewRequests).set({ emailMessageId: messageId }).where(eq(schema.reviewRequests.id, requestId));
    return { created: true, skipped: null };
  });
  if (!result.created) throw new AppError('CONFLICT', `${customerName(customer)} already has a request for that visit.`);
  await writeAudit({ userId: user.id, action: 'review_request.manual_create', entityType: 'review_request', entityId: requestId, data: { skipped: result.skipped } });
  const request = await db.query.reviewRequests.findFirst({ where: eq(schema.reviewRequests.id, requestId) });
  return { request: { id: requestId, status: request?.status ?? 'pending_approval', skipReason: request?.skipReason ?? null, emailMessageId: request?.emailMessageId ?? null } };
}

async function loadRequest(id: string) {
  const r = await getDb().query.reviewRequests.findFirst({ where: eq(schema.reviewRequests.id, id) });
  if (!r) throw new AppError('NOT_FOUND', 'That review request no longer exists.');
  return r;
}

/** Approves a waiting request (its email goes through the same approval and gate as any email). */
export async function approveReviewRequest(user: SessionUser, id: string, scheduledFor: string | null | undefined) {
  const r = await loadRequest(id);
  if (r.status !== 'pending_approval' || !r.emailMessageId) throw new AppError('CONFLICT', 'This request is not waiting for approval.');
  const { message, blockers } = await approveMessage(user, r.emailMessageId, scheduledFor);
  await writeAudit({ userId: user.id, action: 'review_request.approve', entityType: 'review_request', entityId: id });
  return { request: { id, status: (await loadRequest(id)).status }, message, blockers };
}

/** Approves several waiting requests; the blocked ones come back with their reasons. */
export async function approveReviewBatch(user: SessionUser, ids: string[]) {
  const approved: string[] = [];
  const blocked: Array<{ id: string; reasons: Array<{ code: string; message: string }> }> = [];
  for (const id of ids) {
    try {
      await approveReviewRequest(user, id, null);
      approved.push(id);
    } catch (err) {
      const reasons = err instanceof AppError && Array.isArray(err.details) ? (err.details as Array<{ path: string; message: string }>).map((d) => ({ code: d.path, message: d.message })) : [{ code: 'error', message: err instanceof Error ? err.message : 'Not approved' }];
      blocked.push({ id, reasons });
    }
  }
  return { approved, blocked };
}

/** Skips a request with a reason from the fixed list (never "client unhappy"); its email is cancelled. */
export async function skipReviewRequest(user: SessionUser, id: string, input: { reason: 'asked_in_person' | 'wrong_client_details' | 'other'; note?: string | undefined }) {
  const r = await loadRequest(id);
  if (!['pending_approval', 'scheduled'].includes(r.status)) throw new AppError('CONFLICT', 'Only a waiting or scheduled request can be skipped.');
  await settleRequest(id, r.emailMessageId, 'skipped', input.reason);
  await writeAudit({ userId: user.id, action: 'review_request.skip', entityType: 'review_request', entityId: id, data: { reason: input.reason, ...(input.note ? { note: input.note.slice(0, 200) } : {}) } });
  return { request: { id, status: 'skipped', skipReason: input.reason } };
}

/** Cancels a request that has not been sent. */
export async function cancelReviewRequest(user: SessionUser, id: string) {
  const r = await loadRequest(id);
  if (!['pending_approval', 'scheduled'].includes(r.status)) throw new AppError('CONFLICT', 'Only a waiting or scheduled request can be cancelled.');
  await settleRequest(id, r.emailMessageId, 'cancelled', null);
  await writeAudit({ userId: user.id, action: 'review_request.cancel', entityType: 'review_request', entityId: id });
  return { request: { id, status: 'cancelled' } };
}

async function settleRequest(id: string, messageId: string | null, status: 'skipped' | 'cancelled', reason: string | null) {
  const db = getDb();
  if (messageId) {
    const rows = await db
      .update(schema.emailMessages)
      .set({ status: 'cancelled', statusMessage: status === 'skipped' ? 'Skipped by you.' : 'Cancelled by you.', updatedAt: new Date() })
      .where(and(eq(schema.emailMessages.id, messageId), inArray(schema.emailMessages.status, ['draft', 'approved', 'queued']), isNull(schema.emailMessages.submittedAt)))
      .returning({ id: schema.emailMessages.id });
    if (!rows.length) {
      const m = await db.query.emailMessages.findFirst({ where: eq(schema.emailMessages.id, messageId) });
      if (m && !['cancelled', 'failed', 'suppressed'].includes(m.status)) throw new AppError('CONFLICT', 'This request is already on its way, so it cannot be stopped.');
    }
  }
  await db.update(schema.reviewRequests).set({ status, skipReason: reason, updatedAt: new Date() }).where(and(eq(schema.reviewRequests.id, id), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
}

// ---------------------------------------------------------------------------------------------------------
// Review link and the tracked redirect
// ---------------------------------------------------------------------------------------------------------

/** Saves the owner's official review link (validated; never constructed by the app). */
export async function saveReviewLink(user: SessionUser, url: string): Promise<{ url: string; valid: boolean; message: string | null }> {
  const v = validateReviewLink(url);
  if (url.trim() && !v.valid) throw new AppError('VALIDATION', v.message ?? 'That link is not valid.');
  const saved = await updateSettingsLocked((current) => ({ ...current, business: { ...current.business, googleReviewLink: url.trim() } }));
  await writeAudit({ userId: user.id, action: 'review_link.update', entityType: 'settings', entityId: 'business.googleReviewLink', data: { cleared: !url.trim() } });
  return { url: saved.business.googleReviewLink, valid: v.valid, message: v.message };
}

/** Copies Google's own `writeAReviewUri` from the latest Places snapshot (explicit owner action, audited). */
export async function useGoogleReviewLink(user: SessionUser): Promise<{ url: string }> {
  const conn = await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_places') });
  const uri = typeof conn?.capabilities['writeAReviewUri'] === 'string' ? (conn.capabilities['writeAReviewUri'] as string) : null;
  if (!uri || conn?.config['confirmed'] !== true) throw new AppError('CONFLICT', "Google hasn't given a review link for your confirmed place yet.");
  const v = validateReviewLink(uri);
  if (!v.valid) throw new AppError('CONFLICT', 'Google returned a link the app does not accept. Paste your link by hand instead.');
  await updateSettingsLocked((current) => ({ ...current, business: { ...current.business, googleReviewLink: uri } }));
  await writeAudit({ userId: user.id, action: 'review_link.use_google', entityType: 'settings', entityId: 'business.googleReviewLink' });
  return { url: uri };
}

/**
 * The `/r/{token}` redirect: counts a link open when the token is known (it may be an email security scanner), then
 * always answers with the same saved review link, whatever the token (nothing branches; memo §7). Null when no valid
 * link is saved.
 */
export async function recordReviewClick(token: string): Promise<{ url: string | null; businessName: string }> {
  const settings = await getSettings();
  if (/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    const now = new Date();
    await getDb()
      .update(schema.reviewRequests)
      .set({ clickCount: sql`${schema.reviewRequests.clickCount} + 1`, firstClickedAt: sql`coalesce(${schema.reviewRequests.firstClickedAt}, ${now})`, updatedAt: now })
      .where(eq(schema.reviewRequests.clickTokenHash, hashLinkToken(token)));
  }
  const link = settings.business.googleReviewLink;
  return { url: validateReviewLink(link).valid ? link : null, businessName: settings.brand.businessName };
}

// ---------------------------------------------------------------------------------------------------------
// Google rating (Places API, Tier 1)
// ---------------------------------------------------------------------------------------------------------

async function placesRow() {
  return getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_places') });
}

/** The rating card's state (only the latest snapshot; never a placeholder number). */
export async function getPlacesState(): Promise<PlacesStateDto> {
  const env = getEnv();
  const conn = await placesRow();
  const caps = conn?.capabilities ?? {};
  const num = (k: string) => (typeof caps[k] === 'number' ? (caps[k] as number) : null);
  const placeId = typeof conn?.config['placeId'] === 'string' ? (conn.config['placeId'] as string) : null;
  const candidate = (conn?.config['candidate'] as PlacesStateDto['candidate'] | undefined) ?? null;
  const base = { placeId, candidate, rating: null, userRatingCount: null, fetchedAt: null, writeAReviewUri: null, message: null, attribution: PLACES_ATTRIBUTION };
  if (!env.GOOGLE_MAPS_API_KEY) return { ...base, state: 'not_configured' };
  if (!conn || !placeId) return { ...base, state: 'no_place' };
  if (conn.status === 'error') return { ...base, state: 'error', message: conn.lastError };
  if (conn.config['confirmed'] !== true) return { ...base, state: candidate ? 'confirm' : 'checking' };
  return {
    ...base,
    state: 'connected',
    rating: num('rating'),
    userRatingCount: num('userRatingCount'),
    fetchedAt: typeof caps['fetchedAt'] === 'string' ? (caps['fetchedAt'] as string) : null,
    writeAReviewUri: typeof caps['writeAReviewUri'] === 'string' ? (caps['writeAReviewUri'] as string) : null,
  };
}

/** Saves a Place ID and queues the first read (name and address to confirm). */
export async function setPlaceId(user: SessionUser, placeId: string) {
  if (!getEnv().GOOGLE_MAPS_API_KEY) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'The server has no Google Maps key (GOOGLE_MAPS_API_KEY).');
  const db = getDb();
  const existing = await placesRow();
  if (existing) {
    await db.update(schema.integrationConnections).set({ status: 'not_configured', config: { placeId, confirmed: false }, capabilities: {}, lastError: null, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, existing.id));
  } else {
    await db.insert(schema.integrationConnections).values({ id: newId(), provider: 'google_places', status: 'not_configured', displayName: '', config: { placeId, confirmed: false } });
  }
  const job = await createTrackedJob({ type: 'reviews.places.sync', payload: { reason: 'connect' }, singletonKey: 'places-sync' });
  await writeAudit({ userId: user.id, action: 'integration.google_places.connect', entityType: 'integration', entityId: 'google_places' });
  return { state: 'checking' as const, jobId: job.id };
}

/** "Yes, that's us" keeps the place; "No" removes it. */
export async function confirmPlace(user: SessionUser, confirm: boolean) {
  const conn = await placesRow();
  if (!conn) throw new AppError('NOT_FOUND', 'No Place ID is saved.');
  if (confirm) {
    await getDb().update(schema.integrationConnections).set({ config: sql`${schema.integrationConnections.config} || '{"confirmed": true}'::jsonb`, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
  } else {
    await getDb().delete(schema.integrationConnections).where(eq(schema.integrationConnections.id, conn.id));
  }
  await writeAudit({ userId: user.id, action: 'integration.google_places.confirm', entityType: 'integration', entityId: 'google_places', data: { confirm } });
  return { state: (await getPlacesState()).state };
}

/** Removes the Place ID and the snapshot. */
export async function disconnectPlaces(user: SessionUser): Promise<void> {
  await getDb().delete(schema.integrationConnections).where(eq(schema.integrationConnections.provider, 'google_places'));
  await writeAudit({ userId: user.id, action: 'integration.google_places.disconnect', entityType: 'integration', entityId: 'google_places' });
}

/** The owner's refresh: at most every 10 minutes (429 otherwise). */
export async function refreshPlaces(user: SessionUser) {
  const conn = await placesRow();
  if (!conn || conn.config['confirmed'] !== true) throw new AppError('CONFLICT', 'Confirm your place first.');
  if (conn.lastSyncAt && conn.lastSyncAt.getTime() > Date.now() - PLACES_REFRESH_MINUTES * 60_000) throw new AppError('RATE_LIMITED', 'The rating was refreshed in the last 10 minutes. Try again shortly.');
  const job = await createTrackedJob({ type: 'reviews.places.sync', payload: { reason: 'manual' }, singletonKey: 'places-sync' });
  await writeAudit({ userId: user.id, action: 'integration.google_places.refresh', entityType: 'integration', entityId: 'google_places' });
  return { jobIds: [job.id] };
}


