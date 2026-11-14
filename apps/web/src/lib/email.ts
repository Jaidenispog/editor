import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  AppError,
  DEFAULT_EMAIL_TEMPLATES,
  LIFT_COMPLAINT_CONFIRMATION,
  MESSAGE_CLASS_LABELS,
  REVIEW_SKIP_LABELS,
  classifyAudience,
  consentLabel,
  consentWordingFor,
  dedupeKeys,
  evaluateSendPolicy,
  foldConsent,
  BUSINESS_LOCALE,
  BUSINESS_TIMEZONE,
  isCommercial,
  lintEmail,
  maskEmail,
  newId,
  normaliseEmail,
  renderEmail,
  spreadByDailyCap,
  type AppSettings,
  type AutomationName,
  type CampaignAudienceFilter,
  type ConsentState,
  type MessageClass,
  type SuppressionFact,
} from '@studio/core';
import { genuinelyCompletedBookingWhere, schema } from '@studio/db';
import type { z } from 'zod';
import type {
  AudiencePreviewDto,
  AutomationDto,
  CampaignDto,
  ClientDto,
  ConsentDetailDto,
  EmailMessageDetailDto,
  EmailMessageDto,
  EmailStatusDto,
  EmailTemplateDto,
  GateReasonDto,
  PermissionWord,
} from '@/components/email/types';
import type {
  ApproveCampaignSchema,
  CreateCampaignSchema,
  CreateCustomerSchema,
  CreateEmailMessageSchema,
  CreateTemplateSchema,
  RecordConsentSchema,
  UpdateAutomationSchema,
  UpdateCampaignSchema,
  UpdateCustomerSchema,
  UpdateEmailSettingsSchema,
  UpdateTemplateSchema,
} from '@studio/core';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { postmarkCard } from './integrations/email.js';
import { createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';
import { getSettings, updateSettingsLocked } from './settings.js';

/**
 * Server side of the email module (email design §4, §7). Routes never call Postmark: they write rows and queue jobs;
 * the worker's `email.send` runs the send gate again immediately before every provider call.
 */

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MessageRow = typeof schema.emailMessages.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const shortDate = new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short' });

/** "Skin fade, Fri 14 Nov" (Melbourne date). */
export function appointmentWords(serviceName: string, at: Date): string {
  return `${serviceName || 'Appointment'}, ${shortDate.format(at)}`;
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** SHA-256 of an unsubscribe or review-link token (the only form stored). */
export function hashLinkToken(token: string): string {
  return sha256(token);
}

/** A client's display name. */
export function customerName(c: Pick<CustomerRow, 'givenName' | 'familyName'> | null | undefined): string {
  if (!c) return 'Client';
  return [c.givenName, c.familyName].filter((s) => s && s.trim()).join(' ') || 'Client';
}

// ---------------------------------------------------------------------------------------------------------
// Postmark webhook authentication and event ids (design §8.1.5)
// ---------------------------------------------------------------------------------------------------------

/** Checks `Authorization: Basic …` against the configured webhook credentials in constant time. */
export function checkPostmarkBasicAuth(header: string | null, env: { POSTMARK_WEBHOOK_USERNAME?: string | undefined; POSTMARK_WEBHOOK_PASSWORD?: string | undefined }): 'ok' | 'bad' | 'not_configured' {
  if (!env.POSTMARK_WEBHOOK_USERNAME || !env.POSTMARK_WEBHOOK_PASSWORD) return 'not_configured';
  const expected = createHash('sha256').update(`${env.POSTMARK_WEBHOOK_USERNAME}:${env.POSTMARK_WEBHOOK_PASSWORD}`).digest();
  let given = '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (m?.[1]) {
    try {
      given = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      given = '';
    }
  }
  const got = createHash('sha256').update(given).digest();
  return timingSafeEqual(expected, got) && given.length > 0 ? 'ok' : 'bad';
}

/**
 * The deterministic event id a Postmark delivery is stored under (no raw addresses). The numeric `ID` of bounces and
 * complaints is read from the raw text, because it can exceed JavaScript's safe integer range.
 */
export function postmarkExternalEventId(rawBody: string, record: Record<string, unknown>): { id: string; type: string } {
  const type = typeof record['RecordType'] === 'string' ? (record['RecordType'] as string) : 'Unknown';
  const rawId = /"ID"\s*:\s*"?(\d+)"?/.exec(rawBody)?.[1] ?? String(record['ID'] ?? '');
  const recipient = (k: string) => sha256(String(record[k] ?? '').trim().toLowerCase()).slice(0, 16);
  switch (type) {
    case 'Bounce':
      return { id: `bounce:${rawId}`, type };
    case 'SpamComplaint':
      return { id: `complaint:${rawId}`, type };
    case 'Delivery':
      return { id: `delivery:${String(record['MessageID'] ?? '')}:${recipient('Recipient')}`, type };
    case 'SubscriptionChange':
      return { id: `subscription:${String(record['MessageID'] ?? 'none')}:${recipient('Recipient')}:${String(record['ChangedAt'] ?? '')}:${String(record['SuppressSending'] ?? '')}`, type };
    default:
      return { id: `other:${sha256(rawBody)}`, type };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------------------------------------

async function postmarkRow() {
  return getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'postmark') });
}

/** The email provider's status for the pages and `/api/email/status` (from settings and the last read-only check). */
export async function getEmailStatus(): Promise<EmailStatusDto> {
  const env = getEnv();
  const conn = await postmarkRow();
  const card = postmarkCard(env, conn ? { provider: conn.provider, status: conn.status, displayName: conn.displayName, capabilities: conn.capabilities, config: conn.config, lastError: conn.lastError, lastSyncAt: conn.lastSyncAt } : undefined);
  const caps = conn?.capabilities ?? {};
  const state: EmailStatusDto['state'] = card.state === 'not_configured' ? 'not_configured' : card.state === 'not_connected' ? 'not_checked' : card.state === 'awaiting_approval' ? 'awaiting_approval' : card.state === 'needs_reauth' ? 'needs_reauth' : card.state === 'error' ? 'error' : 'connected';
  const pill =
    state === 'not_configured'
      ? { status: 'not_configured', label: 'Not set up' }
      : state === 'not_checked'
        ? { status: 'not_connected', label: 'Not checked yet' }
        : state === 'awaiting_approval'
          ? { status: 'pending_approval', label: 'Waiting for approval' }
          : state === 'connected'
            ? card.liveMode === 'sandbox'
              ? { status: 'connected', label: 'Test server' }
              : { status: 'connected', label: 'Live' }
            : { status: 'error', label: 'Problem' };
  return {
    state,
    liveMode: card.liveMode === 'sandbox' ? 'sandbox' : card.liveMode === 'live' ? 'live' : null,
    approved: typeof caps['approved'] === 'boolean' ? (caps['approved'] as boolean) : null,
    webhooks: typeof caps['webhooksConfigured'] === 'boolean' ? (caps['webhooksConfigured'] as boolean) : null,
    lastCheckedAt: iso(conn?.lastSyncAt),
    message: card.message,
    missingEnv: card.missingEnv,
    pill,
  };
}

/** Queues the read-only Postmark check (owner). Never sends. */
export async function requestProviderCheck(user: SessionUser): Promise<{ jobId: string }> {
  const env = getEnv();
  if (env.EMAIL_PROVIDER !== 'postmark' || !env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Email sending is not set up on the server yet, so there is nothing to check.');
  }
  const job = await createTrackedJob({ type: 'email.provider.check', payload: { reason: 'manual' }, singletonKey: 'email-check' });
  await writeAudit({ userId: user.id, action: 'email.provider.check_requested', entityType: 'integration', entityId: 'postmark' });
  return { jobId: job.id };
}

// ---------------------------------------------------------------------------------------------------------
// Consent, suppressions and the gate preview
// ---------------------------------------------------------------------------------------------------------

async function activeSuppressions(db: Db | Tx, emailLower: string) {
  return db.select().from(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.emailLower, emailLower), isNull(schema.emailSuppressions.liftedAt)));
}

async function completedVisits(db: Db | Tx, emailLower: string): Promise<Date[]> {
  const rows = await db
    .select({ at: schema.bookings.completedAt })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .where(and(sql`lower(${schema.customers.email}) = ${emailLower}`, genuinelyCompletedBookingWhere()));
  return rows.map((r) => r.at).filter((d): d is Date => d instanceof Date);
}

/** Folds the ledger and the suppression list for one address. */
export async function consentFor(email: string, settings: AppSettings, db: Db | Tx = getDb()): Promise<{ consent: ConsentState; suppressions: SuppressionFact[] }> {
  const emailLower = normaliseEmail(email);
  const events = await db.select({ id: schema.consentEvents.id, kind: schema.consentEvents.kind, method: schema.consentEvents.method, occurredAt: schema.consentEvents.occurredAt }).from(schema.consentEvents).where(eq(schema.consentEvents.emailLower, emailLower));
  const suppressions = await activeSuppressions(db, emailLower);
  const visits = settings.email.allowInferredConsent ? await completedVisits(db, emailLower) : [];
  return { consent: foldConsent(events, suppressions, { allowInferred: settings.email.allowInferredConsent, completedVisits: visits, now: new Date() }), suppressions };
}

/** The current consent wording with the business name filled in, and its hash (the device and verbal forms send it back). */
export function currentWording(settings: AppSettings): { wording: string; wordingHash: string } {
  const wording = consentWordingFor(settings.email.consentWording, settings.brand.businessName);
  return { wording, wordingHash: sha256(wording) };
}

/**
 * What would stop this message right now (the gate's blocking reasons; defer reasons such as the daily limit are
 * not blockers). Used to show blockers early and to refuse an approval the gate would refuse anyway.
 */
export async function messageBlockers(msg: MessageRow, settings: AppSettings, ownerEmail: string | null): Promise<GateReasonDto[]> {
  const db = getDb();
  const env = getEnv();
  const conn = await postmarkRow();
  const caps = conn?.capabilities ?? {};
  const configured = env.EMAIL_PROVIDER === 'postmark' && Boolean(env.POSTMARK_SERVER_TOKEN && env.EMAIL_FROM);
  const customer = msg.customerId ? await db.query.customers.findFirst({ where: eq(schema.customers.id, msg.customerId) }) : null;
  const booking = msg.bookingId ? await db.query.bookings.findFirst({ where: eq(schema.bookings.id, msg.bookingId) }) : null;
  const { consent, suppressions } = await consentFor(msg.toEmail, settings);
  const messageClass = msg.messageClass as MessageClass;
  let recentlyAsked = false;
  if (messageClass === 'review_request' && msg.customerId) {
    const since = new Date(Date.now() - settings.reviews.minDaysBetweenRequests * 86_400_000);
    const rr = await db.query.reviewRequests.findFirst({ where: and(eq(schema.reviewRequests.customerId, msg.customerId), eq(schema.reviewRequests.status, 'sent'), sql`${schema.reviewRequests.sentAt} > ${since}`) });
    recentlyAsked = Boolean(rr);
  }
  const decision = evaluateSendPolicy({
    messageClass,
    origin: msg.origin,
    toEmail: msg.toEmail,
    ownerEmail,
    customer: customer ? { deleted: Boolean(customer.deletedAt), reviewOptOut: customer.reviewRequestsOptOut, squareEmailUnsubscribed: customer.squareEmailUnsubscribed } : null,
    consent,
    suppressions,
    identity: { businessName: settings.brand.businessName, addressLine: settings.business.addressLine, suburb: settings.business.suburb, state: settings.business.state, postcode: settings.business.postcode, phone: settings.business.phone, email: settings.business.email },
    provider: { ready: configured && conn?.status === 'connected' && caps['sendingBlocked'] !== true, webhooksConfigured: typeof caps['webhooksConfigured'] === 'boolean' ? (caps['webhooksConfigured'] as boolean) : null, webhooksAttested: settings.email.webhooksAttested, sandbox: caps['deliveryType'] === 'sandbox' },
    booking: booking ? { status: booking.status, completionSource: booking.completionSource, completedAt: booking.completedAt, squareEnvironment: booking.squareEnvironment } : null,
    reviewLink: messageClass === 'review_request' ? settings.business.googleReviewLink : null,
    recentlyAsked,
    minDaysBetweenRequests: settings.reviews.minDaysBetweenRequests,
    lint: lintEmail({ messageClass, subject: msg.subject, bodyMarkdown: msg.bodyMarkdown }),
    automationEnabled: null,
    approvedByPerson: true,
    counters: { automationSentToday: 0, automationCap: null, commercialSentToday: 0, commercialCap: Number.MAX_SAFE_INTEGER, customerAutomatedToday: 0 },
    window: settings.email.sendWindow,
    now: new Date(),
  });
  return decision.decision === 'block' ? decision.reasons.map((r) => ({ code: r.code, message: r.message })) : [];
}

// ---------------------------------------------------------------------------------------------------------
// Unsubscribes and consent (design §4.6)
// ---------------------------------------------------------------------------------------------------------

/**
 * Records an unsubscribe from marketing (app page, one-click, or the owner/staff recording one said in person, by
 * phone or by reply): a `marketing` suppression and a `withdrawn` ledger event, pending commercial messages to the
 * address become `suppressed`, and Postmark's list is updated by a job. Idempotent: an address already unsubscribed
 * gets nothing new.
 */
export async function recordUnsubscribe(input: {
  email: string;
  customerId: string | null;
  method: 'unsubscribe_page' | 'one_click' | 'in_person' | 'phone' | 'reply_email' | 'owner_other';
  recordedBy: string | null;
  note?: string | undefined;
  emailMessageId?: string | null;
  userAgent?: string | null;
}): Promise<{ changed: boolean }> {
  const emailLower = normaliseEmail(input.email);
  const source = input.method === 'unsubscribe_page' ? 'unsubscribe_page' : input.method === 'one_click' ? 'one_click' : 'owner';
  const result = await getDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.emailSuppressions)
      .values({ id: newId(), emailLower, scope: 'marketing', reason: 'unsubscribe', source, emailMessageId: input.emailMessageId ?? null })
      .onConflictDoNothing()
      .returning({ id: schema.emailSuppressions.id });
    const suppressionId = inserted[0]?.id ?? null;
    if (!suppressionId) return { suppressionId: null };
    const now = new Date();
    await tx.insert(schema.consentEvents).values({
      id: newId(),
      customerId: input.customerId,
      emailLower,
      kind: 'withdrawn',
      method: input.method,
      evidence: { ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 200) } : {}), ...(input.emailMessageId ? { emailMessageId: input.emailMessageId } : {}), ...(input.note ? { note: input.note } : {}) },
      recordedBy: input.recordedBy,
      occurredAt: now,
    });
    await tx.update(schema.customers).set({ marketingConsent: false, marketingConsentSource: input.method, marketingConsentAt: now, unsubscribedAt: now, updatedAt: now }).where(sql`lower(${schema.customers.email}) = ${emailLower}`);
    const flipped = await tx
      .update(schema.emailMessages)
      .set({ status: 'suppressed', statusMessage: 'This client unsubscribed from marketing emails.', updatedAt: now })
      .where(and(sql`lower(${schema.emailMessages.toEmail}) = ${emailLower}`, inArray(schema.emailMessages.status, ['draft', 'approved', 'queued']), isNull(schema.emailMessages.submittedAt), ne(schema.emailMessages.messageClass, 'transactional_factual'), ne(schema.emailMessages.origin, 'preview')))
      .returning({ id: schema.emailMessages.id });
    if (flipped.length) {
      await tx
        .update(schema.reviewRequests)
        .set({ status: 'skipped', skipReason: 'unsubscribed', updatedAt: now })
        .where(and(inArray(schema.reviewRequests.emailMessageId, flipped.map((f) => f.id)), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
    }
    return { suppressionId };
  });
  if (!result.suppressionId) return { changed: false };
  await writeAudit({ userId: input.recordedBy, action: 'consent.withdrawn', entityType: 'customer', entityId: input.customerId, data: { method: input.method } });
  try {
    await createTrackedJob({ type: 'email.suppression.push', payload: { suppressionId: result.suppressionId }, singletonKey: `suppress-push:${result.suppressionId}` });
  } catch (err) {
    // The app's own list already blocks the address; Postmark's copy is a second guard and is retried by the owner.
    getLogger().warn({ err }, 'could not queue the Postmark suppression push');
  }
  return { changed: true };
}

/** The message an unsubscribe token belongs to, or null (tokens are looked up by their SHA-256 only). */
export async function messageForUnsubscribeToken(token: string): Promise<MessageRow | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await getDb().query.emailMessages.findFirst({ where: eq(schema.emailMessages.unsubscribeTokenHash, hashLinkToken(token)) });
  return row ?? null;
}

/** What the public unsubscribe page shows for a token (masked address only). */
export async function unsubscribePageFacts(token: string): Promise<{ valid: boolean; maskedEmail: string | null; businessName: string; phone: string; accentColour: string; alreadyUnsubscribed: boolean }> {
  const settings = await getSettings();
  const msg = await messageForUnsubscribeToken(token);
  const base = { businessName: settings.brand.businessName, phone: settings.business.phone, accentColour: settings.brand.accentColour };
  if (!msg) return { ...base, valid: false, maskedEmail: null, alreadyUnsubscribed: false };
  const active = await activeSuppressions(getDb(), normaliseEmail(msg.toEmail));
  return { ...base, valid: true, maskedEmail: maskEmail(msg.toEmail), alreadyUnsubscribed: active.some((s) => s.scope === 'marketing' && s.reason === 'unsubscribe') };
}

/** Unsubscribes the address a token belongs to (the public page's POST and RFC 8058 one-click). */
export async function unsubscribeByToken(token: string, method: 'unsubscribe_page' | 'one_click', userAgent: string | null): Promise<'done' | 'invalid'> {
  const msg = await messageForUnsubscribeToken(token);
  if (!msg) return 'invalid';
  await recordUnsubscribe({ email: msg.toEmail, customerId: msg.customerId, method, recordedBy: null, emailMessageId: msg.id, userAgent });
  return 'done';
}

/** Records express consent from the device or verbal form (staff or owner). Lifts an active unsubscribe only. */
export async function recordConsent(user: SessionUser, customerId: string, input: z.infer<typeof RecordConsentSchema>, userAgent: string | null): Promise<{ state: { status: string; label: string } }> {
  const settings = await getSettings();
  const customer = await getDb().query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
  if (!customer || customer.deletedAt) throw new AppError('NOT_FOUND', 'That client no longer exists.');
  if (!customer.email) throw new AppError('VALIDATION', 'Add an email address for this client first.');
  const { wording, wordingHash } = currentWording(settings);
  if (input.wordingHash !== wordingHash) throw new AppError('CONFLICT', 'The permission wording changed. Reload the page and show the client the current wording.');
  const emailLower = normaliseEmail(customer.email);
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx.insert(schema.consentEvents).values({
      id: newId(),
      customerId,
      emailLower,
      kind: 'granted',
      basis: 'express',
      method: input.method,
      wording,
      wordingHash,
      evidence: { ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}), ...(input.note ? { note: input.note } : {}) },
      recordedBy: user.id,
      occurredAt: now,
    });
    // New express consent reverses an unsubscribe (never a bounce or a complaint).
    await tx
      .update(schema.emailSuppressions)
      .set({ liftedAt: now, liftedBy: user.id, liftNote: 'New express permission recorded' })
      .where(and(eq(schema.emailSuppressions.emailLower, emailLower), eq(schema.emailSuppressions.reason, 'unsubscribe'), isNull(schema.emailSuppressions.liftedAt)));
    await tx.update(schema.customers).set({ marketingConsent: true, marketingConsentSource: input.method, marketingConsentAt: now, unsubscribedAt: null, updatedAt: now }).where(eq(schema.customers.id, customerId));
  });
  await writeAudit({ userId: user.id, action: 'consent.granted', entityType: 'customer', entityId: customerId, data: { method: input.method } });
  const { consent } = await consentFor(customer.email, settings);
  return { state: { status: consent.status, label: consentLabel(consent) } };
}

/** The consent page for one client: state, ledger, suppressions and the current wording. */
export async function consentDetail(customerId: string): Promise<ConsentDetailDto> {
  const settings = await getSettings();
  const customer = await getDb().query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
  if (!customer) throw new AppError('NOT_FOUND', 'That client no longer exists.');
  const { wording, wordingHash } = currentWording(settings);
  if (!customer.email) return { state: { status: 'none', label: 'No email address' }, events: [], suppressions: [], wording, wordingHash, postmarkReactivated: false };
  const emailLower = normaliseEmail(customer.email);
  const { consent } = await consentFor(customer.email, settings);
  const events = await getDb().select().from(schema.consentEvents).where(eq(schema.consentEvents.emailLower, emailLower)).orderBy(desc(schema.consentEvents.occurredAt));
  const suppressions = await getDb().select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.emailLower, emailLower)).orderBy(desc(schema.emailSuppressions.createdAt));
  const reactivated = await getDb().query.auditLog.findFirst({ where: and(eq(schema.auditLog.action, 'email.postmark_reactivated'), eq(schema.auditLog.entityId, `email:${sha256(emailLower).slice(0, 12)}`)) });
  return {
    state: { status: consent.status, label: consentLabel(consent) },
    events: events.map((e) => ({ id: e.id, kind: e.kind, method: e.method, wording: e.wording, occurredAt: e.occurredAt.toISOString(), recordedBy: e.recordedBy })),
    suppressions: suppressions.map((s) => ({ id: s.id, scope: s.scope, reason: s.reason, source: s.source, createdAt: s.createdAt.toISOString(), liftedAt: iso(s.liftedAt) })),
    wording,
    wordingHash,
    postmarkReactivated: Boolean(reactivated) && suppressions.some((s) => !s.liftedAt),
  };
}

/** Lifts a suppression (owner only) under the design's rules (§4.6). Unsubscribes are reversed only by new consent. */
export async function liftSuppression(user: SessionUser, id: string, input: { note: string; confirm: string }): Promise<{ suppression: { id: string; liftedAt: string } }> {
  const db = getDb();
  const s = await db.query.emailSuppressions.findFirst({ where: eq(schema.emailSuppressions.id, id) });
  if (!s) throw new AppError('NOT_FOUND', 'That block no longer exists.');
  if (s.liftedAt) throw new AppError('CONFLICT', 'This block was already lifted.');
  if (s.reason === 'unsubscribe') throw new AppError('CONFLICT', 'An unsubscribe can only be reversed by recording new permission from the client.');
  if (s.reason === 'spam_complaint') {
    const granted = await db.query.consentEvents.findFirst({ where: and(eq(schema.consentEvents.emailLower, s.emailLower), eq(schema.consentEvents.kind, 'granted'), sql`${schema.consentEvents.occurredAt} > ${s.createdAt}`) });
    if (!granted) throw new AppError('CONFLICT', 'Record new express permission from the client (after the complaint) before lifting this.');
    if (input.confirm.trim().toLowerCase() !== LIFT_COMPLAINT_CONFIRMATION) throw new AppError('VALIDATION', `Type "${LIFT_COMPLAINT_CONFIRMATION}" to confirm.`);
  } else if (input.confirm.trim().toLowerCase() !== 'the address was corrected') {
    throw new AppError('VALIDATION', 'Type "the address was corrected" to confirm.');
  }
  const now = new Date();
  await db.update(schema.emailSuppressions).set({ liftedAt: now, liftedBy: user.id, liftNote: input.note.slice(0, 500) }).where(and(eq(schema.emailSuppressions.id, id), isNull(schema.emailSuppressions.liftedAt)));
  await writeAudit({ userId: user.id, action: 'suppression.lifted', entityType: 'email_suppression', entityId: id, data: { reason: s.reason } });
  return { suppression: { id, liftedAt: now.toISOString() } };
}

// ---------------------------------------------------------------------------------------------------------
// Clients (design §7.3)
// ---------------------------------------------------------------------------------------------------------

function permissionOf(consent: ConsentState, suppressions: readonly SuppressionFact[], squareOptOut: boolean | null): PermissionWord {
  if (suppressions.some((s) => s.scope === 'all')) return 'suppressed';
  if (consent.status === 'withdrawn' || squareOptOut === true || suppressions.some((s) => s.scope === 'marketing')) return 'unsubscribed';
  if (consent.status === 'express') return 'express';
  if (consent.status === 'inferred') return 'inferred';
  return 'none';
}

const PERMISSION_LABELS: Record<PermissionWord, string> = { express: 'Permission recorded', inferred: 'Inferred permission', none: 'No permission', unsubscribed: 'Unsubscribed', suppressed: 'Bounced or spam' };

/** The client list with each client's permission (staff and owner). */
export async function listClients(query: { q?: string | undefined; permission?: string | undefined }): Promise<{ items: ClientDto[] }> {
  const settings = await getSettings();
  const db = getDb();
  const q = query.q?.trim();
  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(isNull(schema.customers.deletedAt), q ? or(ilike(schema.customers.givenName, `%${q}%`), ilike(schema.customers.familyName, `%${q}%`), ilike(schema.customers.email, `%${q}%`)) : undefined))
    .orderBy(asc(schema.customers.givenName), asc(schema.customers.familyName))
    .limit(300);
  const items: ClientDto[] = [];
  for (const c of rows) {
    let permission: PermissionWord = 'none';
    if (c.email) {
      const { consent, suppressions } = await consentFor(c.email, settings);
      permission = permissionOf(consent, suppressions, c.squareEmailUnsubscribed);
    }
    const last = await db.select({ at: sql<Date | null>`max(${schema.emailMessages.sentAt})` }).from(schema.emailMessages).where(eq(schema.emailMessages.customerId, c.id));
    const lastAt = last[0]?.at ? new Date(last[0].at) : null;
    items.push({ id: c.id, name: customerName(c), email: c.email, phone: c.phone, fromSquare: Boolean(c.squareCustomerId), permission, permissionLabel: PERMISSION_LABELS[permission], reviewOptOut: c.reviewRequestsOptOut, lastEmailedAt: iso(lastAt) });
  }
  return { items: query.permission ? items.filter((i) => i.permission === query.permission) : items };
}

/** Adds a manual client (no Square). 409 when the address matches an existing client. */
export async function createClient(user: SessionUser, input: z.infer<typeof CreateCustomerSchema>): Promise<{ customer: ClientDto }> {
  const db = getDb();
  const emailLower = normaliseEmail(input.email);
  const dup = await db.query.customers.findFirst({ where: and(sql`lower(${schema.customers.email}) = ${emailLower}`, isNull(schema.customers.deletedAt)) });
  if (dup) throw new AppError('CONFLICT', `${customerName(dup)} already uses this email address.`);
  const id = newId();
  await db.insert(schema.customers).values({ id, givenName: input.givenName, familyName: input.familyName ?? '', email: input.email.trim(), phone: input.phone?.trim() || null });
  await writeAudit({ userId: user.id, action: 'customer.create', entityType: 'customer', entityId: id });
  return { customer: { id, name: customerName({ givenName: input.givenName, familyName: input.familyName ?? '' }), email: input.email.trim(), phone: input.phone?.trim() || null, fromSquare: false, permission: 'none', permissionLabel: PERMISSION_LABELS.none, reviewOptOut: false, lastEmailedAt: null } };
}

/** Edits a manual client (Square clients are edited in Square). */
export async function updateClient(user: SessionUser, id: string, input: z.infer<typeof UpdateCustomerSchema>): Promise<{ customer: { id: string } }> {
  const db = getDb();
  const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, id) });
  if (!c || c.deletedAt) throw new AppError('NOT_FOUND', 'That client no longer exists.');
  if (c.squareCustomerId && (input.givenName !== undefined || input.familyName !== undefined || input.email !== undefined || input.phone !== undefined)) {
    throw new AppError('CONFLICT', 'This client comes from Square. Change their details in Square; only notes can be edited here.');
  }
  await db
    .update(schema.customers)
    .set({
      ...(input.givenName !== undefined ? { givenName: input.givenName } : {}),
      ...(input.familyName !== undefined ? { familyName: input.familyName } : {}),
      ...(input.email !== undefined ? { email: input.email.trim() } : {}),
      ...(input.phone !== undefined ? { phone: input.phone.trim() || null } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.customers.id, id));
  await writeAudit({ userId: user.id, action: 'customer.update', entityType: 'customer', entityId: id, data: { fields: Object.keys(input) } });
  return { customer: { id } };
}

/** Review opt-out: staff may set it (a fail-safe); only the owner may clear it. */
export async function setReviewOptOut(user: SessionUser, id: string, value: boolean): Promise<{ customer: { id: string; reviewOptOut: boolean } }> {
  if (!value && user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the studio owner can turn review requests back on for a client.');
  const db = getDb();
  const rows = await db.update(schema.customers).set({ reviewRequestsOptOut: value, updatedAt: new Date() }).where(eq(schema.customers.id, id)).returning({ id: schema.customers.id });
  if (!rows.length) throw new AppError('NOT_FOUND', 'That client no longer exists.');
  if (value) {
    const pending = await db
      .select({ id: schema.reviewRequests.id, messageId: schema.reviewRequests.emailMessageId })
      .from(schema.reviewRequests)
      .where(and(eq(schema.reviewRequests.customerId, id), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
    for (const p of pending) {
      await db.update(schema.reviewRequests).set({ status: 'skipped', skipReason: 'opted_out', updatedAt: new Date() }).where(eq(schema.reviewRequests.id, p.id));
      if (p.messageId) await db.update(schema.emailMessages).set({ status: 'cancelled', statusMessage: 'This client asked not to get review requests.', updatedAt: new Date() }).where(and(eq(schema.emailMessages.id, p.messageId), inArray(schema.emailMessages.status, ['draft', 'approved', 'queued']), isNull(schema.emailMessages.submittedAt)));
    }
  }
  await writeAudit({ userId: user.id, action: 'customer.review_opt_out', entityType: 'customer', entityId: id, data: { value } });
  return { customer: { id, reviewOptOut: value } };
}

// ---------------------------------------------------------------------------------------------------------
// Templates (design §4.5)
// ---------------------------------------------------------------------------------------------------------

/** Seeds the built-in neutral templates once (fixed ids; the owner's edits are never overwritten). */
export async function ensureDefaultTemplates(): Promise<void> {
  await getDb()
    .insert(schema.emailTemplates)
    .values(DEFAULT_EMAIL_TEMPLATES.map((t) => ({ id: t.id, name: t.name, purpose: t.purpose, messageClass: t.messageClass, isCommercial: t.messageClass !== 'transactional_factual', subject: t.subject, bodyMarkdown: t.bodyMarkdown, builtIn: true })))
    .onConflictDoNothing();
}

function toTemplateDto(t: typeof schema.emailTemplates.$inferSelect): EmailTemplateDto {
  return { id: t.id, name: t.name, purpose: t.purpose, messageClass: t.messageClass, subject: t.subject, bodyMarkdown: t.bodyMarkdown, builtIn: t.builtIn, enabled: t.enabled, updatedAt: t.updatedAt.toISOString() };
}

export async function listTemplates(): Promise<{ items: EmailTemplateDto[] }> {
  await ensureDefaultTemplates();
  const rows = await getDb().select().from(schema.emailTemplates).orderBy(desc(schema.emailTemplates.builtIn), asc(schema.emailTemplates.name));
  return { items: rows.map(toTemplateDto) };
}

/** Lint errors as a 400 (templates and drafts with errors are not saved as ready). */
function assertNoLintErrors(lint: ReturnType<typeof lintEmail>): void {
  if (lint.errors.length) throw new AppError('VALIDATION', lint.errors.map((e) => e.message).join(' '), { details: lint.errors.map((e) => ({ path: e.code, message: e.message })) });
}

export async function createTemplate(user: SessionUser, input: z.infer<typeof CreateTemplateSchema>) {
  const lint = lintEmail(input);
  assertNoLintErrors(lint);
  const id = newId();
  await getDb().insert(schema.emailTemplates).values({ id, name: input.name, purpose: input.purpose, messageClass: input.messageClass, isCommercial: isCommercial(input.messageClass), subject: input.subject, bodyMarkdown: input.bodyMarkdown });
  await writeAudit({ userId: user.id, action: 'email.template.create', entityType: 'email_template', entityId: id });
  const t = await getDb().query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, id) });
  return { template: toTemplateDto(t!), lint };
}

export async function updateTemplate(user: SessionUser, id: string, input: z.infer<typeof UpdateTemplateSchema>) {
  const db = getDb();
  const t = await db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, id) });
  if (!t) throw new AppError('NOT_FOUND', 'That template no longer exists.');
  const next = { messageClass: input.messageClass ?? t.messageClass, subject: input.subject ?? t.subject, bodyMarkdown: input.bodyMarkdown ?? t.bodyMarkdown };
  const lint = lintEmail(next);
  if (input.subject !== undefined || input.bodyMarkdown !== undefined || input.messageClass !== undefined) assertNoLintErrors(lint);
  await db
    .update(schema.emailTemplates)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.messageClass !== undefined ? { messageClass: input.messageClass, isCommercial: isCommercial(input.messageClass) } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.bodyMarkdown !== undefined ? { bodyMarkdown: input.bodyMarkdown } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.emailTemplates.id, id));
  await writeAudit({ userId: user.id, action: input.enabled === false ? 'email.template.archive' : 'email.template.update', entityType: 'email_template', entityId: id });
  const updated = await db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, id) });
  return { template: toTemplateDto(updated!), lint };
}

// ---------------------------------------------------------------------------------------------------------
// Messages (design §4.2, §7.1)
// ---------------------------------------------------------------------------------------------------------

/** Renders a draft for display (personal links as markers) for one client. */
export function renderForDisplay(settings: AppSettings, input: { messageClass: MessageClass; subject: string; bodyMarkdown: string; customer: Pick<CustomerRow, 'givenName'> | null; booking: { startAt: Date; serviceName: string } | null; visitDate?: Date | null }) {
  return renderEmail({
    messageClass: input.messageClass,
    subject: input.subject,
    bodyMarkdown: input.bodyMarkdown,
    vars: {
      firstName: input.customer?.givenName ?? null,
      businessName: settings.brand.businessName,
      visitDate: input.booking?.startAt ?? input.visitDate ?? null,
      serviceName: input.booking?.serviceName ?? null,
      senderName: settings.email.senderName || settings.brand.businessName,
      bookingLink: settings.business.bookingLink || null,
    },
    identity: { businessName: settings.brand.businessName, addressLine: settings.business.addressLine, suburb: settings.business.suburb, state: settings.business.state, postcode: settings.business.postcode, phone: settings.business.phone, email: settings.business.email },
    reviewLinkUrl: input.messageClass === 'review_request' ? '[review link]' : null,
    unsubscribeUrl: isCommercial(input.messageClass) ? '[unsubscribe link]' : null,
    accentColour: settings.brand.accentColour,
  });
}

async function toMessageDtos(rows: MessageRow[]): Promise<EmailMessageDto[]> {
  const db = getDb();
  const customerIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => Boolean(x)))];
  const bookingIds = [...new Set(rows.map((r) => r.bookingId).filter((x): x is string => Boolean(x)))];
  const customers = customerIds.length ? await db.select().from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [];
  const bookings = bookingIds.length ? await db.select().from(schema.bookings).where(inArray(schema.bookings.id, bookingIds)) : [];
  const byCustomer = new Map(customers.map((c) => [c.id, c]));
  const byBooking = new Map(bookings.map((b) => [b.id, b]));
  return rows.map((r) => {
    const b = r.bookingId ? byBooking.get(r.bookingId) : undefined;
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: r.origin === 'preview' ? 'You (preview)' : customerName(r.customerId ? byCustomer.get(r.customerId) : null),
      toEmail: r.toEmail,
      subject: r.subject,
      purpose: r.purpose,
      messageClass: r.messageClass,
      origin: r.origin,
      status: r.status,
      statusMessage: r.statusMessage,
      ownerAction: r.ownerAction,
      isSandbox: r.isSandbox,
      scheduledFor: iso(r.scheduledFor),
      sentAt: iso(r.sentAt),
      deliveredAt: iso(r.deliveredAt),
      createdAt: r.createdAt.toISOString(),
      campaignId: r.campaignId,
      bookingId: r.bookingId,
      appointment: b ? appointmentWords(b.serviceName, b.startAt) : null,
    };
  });
}

/** Lists messages for the Emails page (owner). */
export async function listMessages(query: { status?: string | undefined; origin?: string | undefined; purpose?: string | undefined; customerId?: string | undefined; campaignId?: string | undefined; view?: string | undefined; limit?: number }): Promise<{ items: EmailMessageDto[]; nextCursor: null }> {
  const m = schema.emailMessages;
  const statuses = query.status ? query.status.split(',').filter(Boolean) : null;
  const rows = await getDb()
    .select()
    .from(m)
    .where(
      and(
        statuses ? inArray(m.status, statuses as MessageRow['status'][]) : undefined,
        query.origin ? eq(m.origin, query.origin as MessageRow['origin']) : undefined,
        query.purpose ? eq(m.purpose, query.purpose) : undefined,
        query.customerId ? eq(m.customerId, query.customerId) : undefined,
        query.campaignId ? eq(m.campaignId, query.campaignId) : undefined,
        query.view === 'to_approve' ? and(eq(m.status, 'draft'), ne(m.origin, 'preview'), or(eq(m.origin, 'automation'), isNotNull(m.bookingId), eq(m.purpose, 'review_request'))) : undefined,
        query.view === 'sent' ? inArray(m.status, ['sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'cancelled']) : undefined,
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(query.limit ?? 200);
  return { items: await toMessageDtos(rows), nextCursor: null };
}

async function loadMessage(id: string): Promise<MessageRow> {
  const row = await getDb().query.emailMessages.findFirst({ where: eq(schema.emailMessages.id, id) });
  if (!row) throw new AppError('NOT_FOUND', 'That email no longer exists.');
  return row;
}

async function ownerEmailOf(): Promise<string | null> {
  const owner = await getDb().query.users.findFirst({ where: eq(schema.users.role, 'owner') });
  return owner?.email ?? null;
}

/** One message with its rendered copy, timeline, consent basis and current blockers (owner). */
export async function messageDetail(id: string): Promise<EmailMessageDetailDto> {
  const settings = await getSettings();
  const msg = await loadMessage(id);
  const [dto] = await toMessageDtos([msg]);
  const db = getDb();
  let renderedHtml = msg.bodyHtml;
  if (msg.status === 'draft' || !renderedHtml) {
    const customer = msg.customerId ? await db.query.customers.findFirst({ where: eq(schema.customers.id, msg.customerId) }) : null;
    const booking = msg.bookingId ? await db.query.bookings.findFirst({ where: eq(schema.bookings.id, msg.bookingId) }) : null;
    renderedHtml = renderForDisplay(settings, { messageClass: msg.messageClass, subject: msg.subject, bodyMarkdown: msg.bodyMarkdown, customer: customer ?? null, booking: booking ?? null }).storedHtml;
  }
  const timeline: Array<{ at: string; label: string }> = [{ at: msg.createdAt.toISOString(), label: 'Created' }];
  if (msg.approvedAt) timeline.push({ at: msg.approvedAt.toISOString(), label: msg.approvedBy ? 'Approved' : 'Approved by the automation setting' });
  if (msg.submittedAt) timeline.push({ at: msg.submittedAt.toISOString(), label: 'Handed to Postmark' });
  if (msg.sentAt) timeline.push({ at: msg.sentAt.toISOString(), label: msg.isSandbox ? 'Test — not delivered' : 'Sent' });
  if (msg.deliveredAt) timeline.push({ at: msg.deliveredAt.toISOString(), label: 'Delivered' });
  const pending = ['draft', 'approved', 'queued'].includes(msg.status);
  return {
    message: { ...dto!, bodyMarkdown: msg.bodyMarkdown },
    renderedHtml,
    timeline,
    consentBasis: msg.consentBasis ?? null,
    blockers: pending ? await messageBlockers(msg, settings, await ownerEmailOf()) : [],
    lint: lintEmail({ messageClass: msg.messageClass, subject: msg.subject, bodyMarkdown: msg.bodyMarkdown }),
  };
}

/** Creates a one-off draft to a client (information only or marketing). */
export async function createDraft(user: SessionUser, input: z.infer<typeof CreateEmailMessageSchema>): Promise<{ message: EmailMessageDto }> {
  const settings = await getSettings();
  const db = getDb();
  const customer = await db.query.customers.findFirst({ where: eq(schema.customers.id, input.customerId) });
  if (!customer || customer.deletedAt) throw new AppError('NOT_FOUND', 'That client no longer exists.');
  if (!customer.email) throw new AppError('VALIDATION', 'This client has no email address.');
  const id = newId();
  const preview = renderForDisplay(settings, { messageClass: input.messageClass, subject: input.subject, bodyMarkdown: input.bodyMarkdown, customer, booking: null });
  await db.insert(schema.emailMessages).values({
    id,
    templateId: input.templateId ?? null,
    customerId: customer.id,
    toEmail: customer.email,
    subject: input.subject,
    bodyMarkdown: input.bodyMarkdown,
    bodyHtml: preview.storedHtml,
    bodyText: preview.storedText,
    purpose: input.messageClass === 'campaign' ? 'custom' : 'custom',
    messageClass: input.messageClass,
    origin: 'manual',
    dedupeKey: dedupeKeys.manual(id),
    status: 'draft',
  });
  await writeAudit({ userId: user.id, action: 'email.message.create', entityType: 'email_message', entityId: id, data: { messageClass: input.messageClass } });
  const [dto] = await toMessageDtos([await loadMessage(id)]);
  return { message: dto! };
}

/** Edits a draft (only while it is a draft). */
export async function updateDraft(user: SessionUser, id: string, input: { subject?: string | undefined; bodyMarkdown?: string | undefined }) {
  const settings = await getSettings();
  const msg = await loadMessage(id);
  if (msg.status !== 'draft') throw new AppError('CONFLICT', 'Only drafts can be edited.');
  const subject = input.subject ?? msg.subject;
  const bodyMarkdown = input.bodyMarkdown ?? msg.bodyMarkdown;
  const db = getDb();
  const customer = msg.customerId ? await db.query.customers.findFirst({ where: eq(schema.customers.id, msg.customerId) }) : null;
  const booking = msg.bookingId ? await db.query.bookings.findFirst({ where: eq(schema.bookings.id, msg.bookingId) }) : null;
  const preview = renderForDisplay(settings, { messageClass: msg.messageClass, subject, bodyMarkdown, customer: customer ?? null, booking: booking ?? null });
  const rows = await db
    .update(schema.emailMessages)
    .set({ subject, bodyMarkdown, bodyHtml: preview.storedHtml, bodyText: preview.storedText, updatedAt: new Date() })
    .where(and(eq(schema.emailMessages.id, id), eq(schema.emailMessages.status, 'draft')))
    .returning();
  if (!rows.length) throw new AppError('CONFLICT', 'Only drafts can be edited.');
  await writeAudit({ userId: user.id, action: 'email.message.edit', entityType: 'email_message', entityId: id });
  const [dto] = await toMessageDtos(rows);
  return { message: dto!, lint: lintEmail({ messageClass: msg.messageClass, subject, bodyMarkdown }) };
}

/**
 * Approves a draft (owner). Refused with 422 and the reasons when the send gate would block it now. A due message is
 * handed to the worker straight away; a later one waits for the per-minute dispatch.
 */
export async function approveMessage(user: SessionUser, id: string, scheduledFor: string | null | undefined): Promise<{ message: EmailMessageDto; blockers: GateReasonDto[] }> {
  const settings = await getSettings();
  const msg = await loadMessage(id);
  if (msg.status !== 'draft') throw new AppError('CONFLICT', msg.status === 'approved' || msg.status === 'queued' ? 'This email is already approved.' : 'Only drafts can be approved.');
  const when = scheduledFor ? new Date(scheduledFor) : null;
  if (when && when.getTime() < Date.now() - 60_000) throw new AppError('VALIDATION', 'Choose a time in the future (Melbourne time).');
  const blockers = await messageBlockers(msg, settings, user.email);
  if (blockers.length) throw new AppError('UNSUPPORTED', blockers.map((b) => b.message).join(' '), { details: blockers.map((b) => ({ path: b.code, message: b.message })) });
  const now = new Date();
  const rows = await getDb()
    .update(schema.emailMessages)
    .set({ status: 'approved', approvedBy: user.id, approvedAt: now, scheduledFor: when, statusMessage: '', updatedAt: now })
    .where(and(eq(schema.emailMessages.id, id), eq(schema.emailMessages.status, 'draft')))
    .returning();
  if (!rows.length) throw new AppError('CONFLICT', 'This email changed in the meantime. Reload and try again.');
  await getDb()
    .update(schema.reviewRequests)
    .set({ status: 'scheduled', scheduledFor: when ?? msg.scheduledFor, updatedAt: now })
    .where(and(eq(schema.reviewRequests.emailMessageId, id), eq(schema.reviewRequests.status, 'pending_approval')));
  await writeAudit({ userId: user.id, action: 'email.message.approve', entityType: 'email_message', entityId: id, data: { scheduled: Boolean(when) } });
  if (!when || when.getTime() <= now.getTime()) {
    try {
      await createTrackedJob({ type: 'email.send', payload: { emailMessageId: id }, singletonKey: `email-send:${id}` });
    } catch (err) {
      // The per-minute dispatch hands it on anyway.
      getLogger().warn({ err, emailMessageId: id }, 'could not queue email.send; dispatch will pick it up');
    }
  }
  const [dto] = await toMessageDtos(rows);
  return { message: dto!, blockers: [] };
}

/** Approves several drafts; returns the ones the gate blocked with their reasons. */
export async function approveBatch(user: SessionUser, ids: string[]): Promise<{ approved: string[]; blocked: Array<{ id: string; reasons: GateReasonDto[] }> }> {
  const approved: string[] = [];
  const blocked: Array<{ id: string; reasons: GateReasonDto[] }> = [];
  for (const id of ids) {
    try {
      await approveMessage(user, id, null);
      approved.push(id);
    } catch (err) {
      const reasons = err instanceof AppError && Array.isArray(err.details) ? (err.details as Array<{ path: string; message: string }>).map((d) => ({ code: d.path, message: d.message })) : [{ code: 'error', message: err instanceof Error ? err.message : 'Not approved' }];
      blocked.push({ id, reasons });
    }
  }
  return { approved, blocked };
}

/** Cancels a message that has not gone out; 409 once it is sending or sent. */
export async function cancelMessage(user: SessionUser, id: string): Promise<{ message: EmailMessageDto }> {
  const msg = await loadMessage(id);
  const rows = await getDb()
    .update(schema.emailMessages)
    .set({ status: 'cancelled', statusMessage: 'Cancelled by you.', updatedAt: new Date() })
    .where(and(eq(schema.emailMessages.id, id), inArray(schema.emailMessages.status, ['draft', 'approved', 'queued']), isNull(schema.emailMessages.submittedAt)))
    .returning();
  if (!rows.length) throw new AppError('CONFLICT', msg.status === 'cancelled' ? 'This email was already cancelled.' : 'This email is already on its way, so it cannot be cancelled.');
  await getDb().update(schema.reviewRequests).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(schema.reviewRequests.emailMessageId, id), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
  await writeAudit({ userId: user.id, action: 'email.message.cancel', entityType: 'email_message', entityId: id });
  const [dto] = await toMessageDtos(rows);
  return { message: dto! };
}

/** "Send again" after an unknown outcome the owner has checked (clears the claim and re-approves). */
export async function sendAgain(user: SessionUser, id: string): Promise<{ message: EmailMessageDto }> {
  const rows = await getDb()
    .update(schema.emailMessages)
    .set({ status: 'approved', submittedAt: null, ownerAction: null, approvedBy: user.id, approvedAt: new Date(), statusMessage: '', updatedAt: new Date() })
    .where(and(eq(schema.emailMessages.id, id), eq(schema.emailMessages.ownerAction, 'check_before_retry'), isNull(schema.emailMessages.providerMessageId)))
    .returning();
  if (!rows.length) throw new AppError('CONFLICT', 'This email does not need a check before sending again.');
  await getDb().update(schema.reviewRequests).set({ status: 'scheduled', updatedAt: new Date() }).where(and(eq(schema.reviewRequests.emailMessageId, id), eq(schema.reviewRequests.status, 'failed')));
  await writeAudit({ userId: user.id, action: 'email.message.override_retry', entityType: 'email_message', entityId: id });
  await createTrackedJob({ type: 'email.send', payload: { emailMessageId: id }, singletonKey: `email-send:${id}` });
  const [dto] = await toMessageDtos(rows);
  return { message: dto! };
}

/** Sends this exact draft to the owner's own address only, marked "[Preview]" (origin `preview`, audited). */
export async function previewToMe(user: SessionUser, id: string): Promise<{ previewMessageId: string }> {
  const msg = await loadMessage(id);
  const status = await getEmailStatus();
  if (status.state !== 'connected' && status.state !== 'awaiting_approval') throw new AppError('INTEGRATION_NOT_CONFIGURED', "Email sending isn't set up yet, so a preview can't be emailed. The preview on screen is exactly what the client gets.");
  const previewId = newId();
  const now = new Date();
  await getDb().insert(schema.emailMessages).values({
    id: previewId,
    templateId: msg.templateId,
    customerId: msg.customerId,
    bookingId: msg.bookingId,
    toEmail: user.email,
    subject: `[Preview] ${msg.subject}`.slice(0, 200),
    bodyMarkdown: msg.bodyMarkdown,
    bodyHtml: msg.bodyHtml,
    bodyText: msg.bodyText,
    purpose: 'preview',
    messageClass: msg.messageClass,
    origin: 'preview',
    dedupeKey: dedupeKeys.preview(previewId),
    status: 'approved',
    approvedBy: user.id,
    approvedAt: now,
  });
  await writeAudit({ userId: user.id, action: 'email.message.preview', entityType: 'email_message', entityId: id, data: { previewMessageId: previewId } });
  await createTrackedJob({ type: 'email.send', payload: { emailMessageId: previewId }, singletonKey: `email-send:${previewId}` });
  return { previewMessageId: previewId };
}

/** Lints and previews without side effects (with a chosen client, or the labelled sample client). */
export async function lintAndPreview(input: { messageClass: MessageClass; subject: string; bodyMarkdown: string; customerId?: string | null | undefined }) {
  const settings = await getSettings();
  const customer = input.customerId ? await getDb().query.customers.findFirst({ where: eq(schema.customers.id, input.customerId) }) : null;
  const lint = lintEmail(input);
  const r = renderForDisplay(settings, { ...input, customer: customer ?? { givenName: 'Sample client (not a real person)' }, booking: null, visitDate: new Date() });
  return { errors: lint.errors, warnings: lint.warnings, preview: { subject: r.subject, html: r.storedHtml, text: r.storedText } };
}

// ---------------------------------------------------------------------------------------------------------
// Automations and settings (design §4.3, §5.3)
// ---------------------------------------------------------------------------------------------------------

/** Updates an automation; turning one on records `enabledAt`, turning one off cancels what it approved by itself. */
export async function updateAutomation(user: SessionUser, name: AutomationName, input: z.infer<typeof UpdateAutomationSchema>): Promise<{ automation: AutomationDto }> {
  const db = getDb();
  if (input.templateId) {
    const t = await db.query.emailTemplates.findFirst({ where: eq(schema.emailTemplates.id, input.templateId) });
    if (!t || !t.enabled) throw new AppError('VALIDATION', 'Choose a template that still exists.');
    if (name === 'review_request' && t.messageClass !== 'review_request') throw new AppError('VALIDATION', 'Review requests need a review-request template.');
    if (name === 'follow_up' && t.messageClass === 'review_request') throw new AppError('VALIDATION', 'Follow-ups cannot use a review-request template.');
  }
  const saved = await updateSettingsLocked((current) => {
    const prev = name === 'review_request' ? current.reviews.automation : current.email.followUp;
    if (input.enabled && name === 'review_request') {
      if (current.email.squareSends.feedbackOrReviews === true) throw new AppError('UNSUPPORTED', 'Square is already asking your clients for feedback; turn that off in Square first to avoid asking twice.');
      const link = current.business.googleReviewLink;
      if (!link || !/^https:\/\//.test(link)) throw new AppError('UNSUPPORTED', 'Add your Google review link in Reviews → Review link first.');
    }
    const next = { ...input, enabledAt: input.enabled ? (prev.enabled && prev.enabledAt ? prev.enabledAt : new Date().toISOString()) : null };
    return name === 'review_request' ? { ...current, reviews: { ...current.reviews, automation: next } } : { ...current, email: { ...current.email, followUp: next } };
  });
  const automation = name === 'review_request' ? saved.reviews.automation : saved.email.followUp;
  if (!automation.enabled) {
    const cancelled = await db
      .update(schema.emailMessages)
      .set({ status: 'cancelled', statusMessage: 'The automation was switched off before this was sent.', updatedAt: new Date() })
      .where(and(eq(schema.emailMessages.origin, 'automation'), isNull(schema.emailMessages.approvedBy), inArray(schema.emailMessages.status, ['approved', 'queued']), isNull(schema.emailMessages.submittedAt), sql`${schema.emailMessages.dedupeKey} like ${name === 'review_request' ? 'review:%' : 'follow_up:%'}`))
      .returning({ id: schema.emailMessages.id });
    if (cancelled.length) await db.update(schema.reviewRequests).set({ status: 'cancelled', updatedAt: new Date() }).where(and(inArray(schema.reviewRequests.emailMessageId, cancelled.map((c) => c.id)), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
  }
  await writeAudit({ userId: user.id, action: 'email.automation.update', entityType: 'email_automation', entityId: name, data: { enabled: automation.enabled, mode: automation.mode, dailyCap: automation.dailyCap } });
  return { automation };
}

/** Updates the email settings (not the automations). */
export async function updateEmailSettings(user: SessionUser, input: z.infer<typeof UpdateEmailSettingsSchema>) {
  const saved = await updateSettingsLocked((current) => {
    const email = { ...current.email, ...input, squareSends: input.squareSends ?? current.email.squareSends, sendWindow: input.sendWindow ?? current.email.sendWindow };
    return { ...current, email };
  });
  await writeAudit({ userId: user.id, action: 'email.settings.update', entityType: 'settings', entityId: 'email', data: { fields: Object.keys(input) } });
  return { email: saved.email };
}

// ---------------------------------------------------------------------------------------------------------
// Campaigns (design §4.4, §7.2)
// ---------------------------------------------------------------------------------------------------------

function toCampaignDto(c: typeof schema.emailCampaigns.$inferSelect): CampaignDto {
  return { id: c.id, name: c.name, subject: c.subject, bodyMarkdown: c.bodyMarkdown, audience: c.audience, status: c.status, pausedReason: c.pausedReason, recipientCount: c.recipientCount, sentCount: c.sentCount, deliveredCount: c.deliveredCount, bounceCount: c.bounceCount, complaintCount: c.complaintCount, approvedAt: iso(c.approvedAt), createdAt: c.createdAt.toISOString() };
}

async function loadCampaign(id: string) {
  const c = await getDb().query.emailCampaigns.findFirst({ where: eq(schema.emailCampaigns.id, id) });
  if (!c) throw new AppError('NOT_FOUND', 'That campaign no longer exists.');
  return c;
}

export async function listCampaigns(): Promise<{ items: CampaignDto[] }> {
  const rows = await getDb().select().from(schema.emailCampaigns).orderBy(desc(schema.emailCampaigns.createdAt)).limit(100);
  return { items: rows.map(toCampaignDto) };
}

export async function getCampaign(id: string) {
  const c = await loadCampaign(id);
  return { campaign: toCampaignDto(c), lint: lintEmail({ messageClass: 'campaign', subject: c.subject, bodyMarkdown: c.bodyMarkdown }) };
}

export async function createCampaign(user: SessionUser, input: z.infer<typeof CreateCampaignSchema>) {
  const id = newId();
  await getDb().insert(schema.emailCampaigns).values({ id, name: input.name, templateId: input.templateId ?? null, subject: input.subject, bodyMarkdown: input.bodyMarkdown, audience: input.audience as CampaignAudienceFilter, createdBy: user.id });
  await writeAudit({ userId: user.id, action: 'email.campaign.create', entityType: 'email_campaign', entityId: id });
  return getCampaign(id);
}

export async function updateCampaign(user: SessionUser, id: string, input: z.infer<typeof UpdateCampaignSchema>) {
  const c = await loadCampaign(id);
  if (c.status !== 'draft') throw new AppError('CONFLICT', 'Only draft campaigns can be edited.');
  await getDb()
    .update(schema.emailCampaigns)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.bodyMarkdown !== undefined ? { bodyMarkdown: input.bodyMarkdown } : {}),
      ...(input.audience !== undefined ? { audience: input.audience as CampaignAudienceFilter } : {}),
      ...(input.templateId !== undefined ? { templateId: input.templateId ?? null } : {}),
      audienceHash: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.emailCampaigns.id, id));
  return getCampaign(id);
}

/** Classifies every client for a campaign (the same rule as the worker's expansion). */
async function audienceRows(settings: AppSettings, audience: CampaignAudienceFilter) {
  const db = getDb();
  const now = new Date();
  const customers = await db.select().from(schema.customers).orderBy(asc(schema.customers.givenName), asc(schema.customers.id));
  const emails = [...new Set(customers.map((c) => (c.email ? normaliseEmail(c.email) : null)).filter((e): e is string => Boolean(e)))];
  const events = emails.length ? await db.select().from(schema.consentEvents).where(inArray(schema.consentEvents.emailLower, emails)) : [];
  const sups = emails.length ? await db.select().from(schema.emailSuppressions).where(and(inArray(schema.emailSuppressions.emailLower, emails), isNull(schema.emailSuppressions.liftedAt))) : [];
  const visits = await db
    .select({ customerId: schema.bookings.customerId, at: schema.bookings.completedAt })
    .from(schema.bookings)
    .where(genuinelyCompletedBookingWhere());
  return customers.map((c) => {
    const e = c.email ? normaliseEmail(c.email) : null;
    const own = visits.filter((v) => v.customerId === c.id && v.at).map((v) => v.at as Date);
    const s = e ? sups.filter((x) => x.emailLower === e) : [];
    const verdict = classifyAudience(
      {
        customerId: c.id,
        deleted: Boolean(c.deletedAt),
        email: c.email,
        consent: foldConsent(e ? events.filter((x) => x.emailLower === e) : [], s, { allowInferred: settings.email.allowInferredConsent, completedVisits: own, now }),
        activeSuppressions: s,
        squareEmailUnsubscribed: c.squareEmailUnsubscribed,
        lastCompletedVisitAt: own.reduce<Date | null>((a, b) => (a && a > b ? a : b), null),
      },
      audience,
      now,
    );
    return { customerId: c.id, name: customerName(c), email: c.email, included: verdict.included, reason: verdict.included ? null : verdict.reason };
  });
}

function hashAudience(includedIds: string[], c: { subject: string; bodyMarkdown: string; audience: unknown }): string {
  return sha256(`${[...includedIds].sort().join(',')}|${c.subject}|${c.bodyMarkdown}|${JSON.stringify(c.audience)}`);
}

/** The recipient preview: who receives it, who is left out and why, the schedule under the daily limit, and the hash to approve. */
export async function audiencePreview(id: string, search?: string): Promise<AudiencePreviewDto> {
  const settings = await getSettings();
  const c = await loadCampaign(id);
  const rows = await audienceRows(settings, c.audience);
  const included = rows.filter((r) => r.included);
  const byReason: Record<string, number> = {};
  for (const r of rows) if (!r.included && r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const audienceHash = hashAudience(included.map((r) => r.customerId), c);
  await getDb().update(schema.emailCampaigns).set({ audienceHash, recipientCount: included.length, updatedAt: new Date() }).where(eq(schema.emailCampaigns.id, id));
  const s = search?.trim().toLowerCase();
  const visible = s ? rows.filter((r) => r.name.toLowerCase().includes(s) || (r.email ?? '').toLowerCase().includes(s)) : rows;
  return { included: included.length, excluded: rows.length - included.length, byReason, rows: visible.slice(0, 500), audienceHash, schedule: spreadByDailyCap(included.length, settings.email.dailyCommercialCap, new Date(), settings.email.sendWindow).schedule };
}

/** Approves a campaign: 409 when the audience or content changed since the preview the owner saw. */
export async function approveCampaign(user: SessionUser, id: string, input: z.infer<typeof ApproveCampaignSchema>) {
  const settings = await getSettings();
  const c = await loadCampaign(id);
  if (c.status !== 'draft') throw new AppError('CONFLICT', 'This campaign was already approved.');
  const lint = lintEmail({ messageClass: 'campaign', subject: c.subject, bodyMarkdown: c.bodyMarkdown });
  assertNoLintErrors(lint);
  const status = await getEmailStatus();
  if (status.state !== 'connected' && status.state !== 'awaiting_approval') throw new AppError('UNSUPPORTED', "Email sending isn't set up yet.");
  if (status.webhooks !== true && !(status.webhooks === null && settings.email.webhooksAttested)) throw new AppError('UNSUPPORTED', "Postmark isn't telling the app about bounces and unsubscribes yet, so marketing emails are on hold.");
  const rows = await audienceRows(settings, c.audience);
  const hash = hashAudience(rows.filter((r) => r.included).map((r) => r.customerId), c);
  if (hash !== input.audienceHash) throw new AppError('CONFLICT', 'The recipient list changed since your preview. Preview it again before approving.');
  const now = new Date();
  const updated = await getDb()
    .update(schema.emailCampaigns)
    .set({ status: 'approved', approvedBy: user.id, approvedAt: now, audienceHash: hash, updatedAt: now })
    .where(and(eq(schema.emailCampaigns.id, id), eq(schema.emailCampaigns.status, 'draft')))
    .returning();
  if (!updated.length) throw new AppError('CONFLICT', 'This campaign was already approved.');
  await writeAudit({ userId: user.id, action: 'email.campaign.approve', entityType: 'email_campaign', entityId: id, data: { recipients: rows.filter((r) => r.included).length } });
  const job = await createTrackedJob({ type: 'email.campaign.expand', payload: { campaignId: id }, singletonKey: `campaign-expand:${id}` });
  return { campaign: toCampaignDto(updated[0]!), jobId: job.id };
}

/** Pause, resume or cancel a campaign (cancel stops every unsent message). */
/**
 * Pause, resume or cancel a campaign. Each change runs in one transaction holding the campaign row `FOR UPDATE`, the
 * same lock `email.campaign.expand` takes before every insert, so expansion and the owner's change never interleave:
 * after a pause or cancel no further message is prepared. Pausing hands messages already queued (not yet submitted)
 * back to `approved`, so `email.send` never sends them while paused; cancelling cancels everything not yet submitted.
 */
export async function changeCampaign(user: SessionUser, id: string, action: 'pause' | 'resume' | 'cancel') {
  await loadCampaign(id);
  const db = getDb();
  const now = new Date();
  const c = schema.emailCampaigns;
  const m = schema.emailMessages;
  let expandAgain = false;
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(c).where(eq(c.id, id)).for('update');
    if (!current) throw new AppError('NOT_FOUND', 'That campaign no longer exists.');
    if (action === 'pause') {
      if (!['approved', 'sending'].includes(current.status)) throw new AppError('CONFLICT', 'Only a sending campaign can be paused.');
      await tx.update(c).set({ status: 'paused', pausedReason: 'Paused by you.', updatedAt: now }).where(eq(c.id, id));
      await tx
        .update(m)
        .set({ status: 'approved', statusMessage: 'Campaign paused.', updatedAt: now })
        .where(and(eq(m.campaignId, id), eq(m.status, 'queued'), isNull(m.submittedAt)));
    } else if (action === 'resume') {
      if (current.status !== 'paused') throw new AppError('CONFLICT', 'Only a paused campaign can be resumed.');
      const expanded = await tx.query.emailMessages.findFirst({ columns: { id: true }, where: eq(m.campaignId, id) });
      // A pause during expansion stops it part-way: expand again (it never adds a message twice) unless it finished.
      const finished = await tx.query.auditLog.findFirst({ columns: { id: true }, where: and(eq(schema.auditLog.action, 'email.campaign.expanded'), eq(schema.auditLog.entityId, id)) });
      expandAgain = !finished;
      await tx.update(c).set({ status: expanded ? 'sending' : 'approved', pausedReason: '', updatedAt: now }).where(eq(c.id, id));
    } else {
      if (['sent', 'cancelled'].includes(current.status)) throw new AppError('CONFLICT', 'This campaign has already finished.');
      await tx.update(c).set({ status: 'cancelled', updatedAt: now }).where(eq(c.id, id));
      await tx
        .update(m)
        .set({ status: 'cancelled', statusMessage: 'Campaign cancelled.', updatedAt: now })
        .where(and(eq(m.campaignId, id), inArray(m.status, ['draft', 'approved', 'queued']), isNull(m.submittedAt)));
    }
  });
  if (expandAgain) await createTrackedJob({ type: 'email.campaign.expand', payload: { campaignId: id }, singletonKey: `campaign-expand:${id}` });
  await writeAudit({ userId: user.id, action: `email.campaign.${action}`, entityType: 'email_campaign', entityId: id });
  return { campaign: toCampaignDto(await loadCampaign(id)) };
}

// ---------------------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------------------

/** How many emails and review requests wait for the owner's approval (the dashboard line). */
export async function approvalCounts(): Promise<{ emails: number; reviewRequests: number }> {
  const db = getDb();
  const [e, r] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.emailMessages).where(and(eq(schema.emailMessages.status, 'draft'), ne(schema.emailMessages.purpose, 'review_request'), ne(schema.emailMessages.origin, 'preview'), or(eq(schema.emailMessages.origin, 'automation'), isNotNull(schema.emailMessages.bookingId)))),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.reviewRequests).where(eq(schema.reviewRequests.status, 'pending_approval')),
  ]);
  return { emails: e[0]?.n ?? 0, reviewRequests: r[0]?.n ?? 0 };
}

/** Owner-facing words for a message class and a review skip reason (re-exported for the pages). */
export { MESSAGE_CLASS_LABELS, REVIEW_SKIP_LABELS };
