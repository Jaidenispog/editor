import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_SETTINGS,
  foldConsent,
  melbourneDateOf,
  melbourneDayRange,
  normaliseEmail,
  parseStoredSettings,
  type AppSettings,
  type BusinessIdentity,
  type ConsentState,
  type ProviderReadiness,
  type SuppressionFact,
} from '@studio/core';
import { genuinelyCompletedBookingWhere, schema, type Database } from '@studio/db';
import type { Env } from '@studio/config';
import type { DbTransaction } from '../connections.js';
import { postmarkSettings } from './provider.js';

/** A database or an open transaction. */
export type Db = Database | DbTransaction;

/** Statuses of messages that count as sent for daily caps. */
export const SENT_STATUSES = ['sent', 'delivered', 'bounced', 'complained'] as const;

/** The stored app settings (defaults when the row does not exist or does not parse). */
export async function loadAppSettings(db: Db): Promise<AppSettings> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.id, 'default') });
  return (row ? parseStoredSettings(row.data) : null) ?? DEFAULT_SETTINGS;
}

/** Who every email is from (Settings → Brand and Business). */
export function identityFrom(settings: AppSettings): BusinessIdentity {
  const b = settings.business;
  return { businessName: settings.brand.businessName, addressLine: b.addressLine, suburb: b.suburb, state: b.state, postcode: b.postcode, phone: b.phone, email: b.email };
}

/** Provider readiness from the server settings and the latest read-only check stored on the `postmark` row. */
export async function providerReadiness(db: Db, env: Env, settings: AppSettings): Promise<ProviderReadiness & { configured: boolean }> {
  const configured = postmarkSettings(env) !== null;
  const conn = await db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'postmark') });
  const caps = conn?.capabilities ?? {};
  const webhooks = caps['webhooksConfigured'];
  return {
    configured,
    ready: configured && conn?.status === 'connected' && caps['sendingBlocked'] !== true,
    webhooksConfigured: typeof webhooks === 'boolean' ? webhooks : null,
    webhooksAttested: settings.email.webhooksAttested,
    sandbox: caps['deliveryType'] === 'sandbox',
  };
}

/** Ensures the built-in templates exist (fixed ids; never overwrites the owner's edits). */
export async function ensureBuiltInTemplates(db: Db): Promise<void> {
  await db
    .insert(schema.emailTemplates)
    .values(
      DEFAULT_EMAIL_TEMPLATES.map((t) => ({ id: t.id, name: t.name, purpose: t.purpose, messageClass: t.messageClass, isCommercial: t.messageClass !== 'transactional_factual', subject: t.subject, bodyMarkdown: t.bodyMarkdown, builtIn: true })),
    )
    .onConflictDoNothing();
}

/** Active (not lifted) suppressions for an address. */
export async function activeSuppressions(db: Db, emailLower: string): Promise<SuppressionFact[]> {
  const rows = await db
    .select({ scope: schema.emailSuppressions.scope, reason: schema.emailSuppressions.reason, createdAt: schema.emailSuppressions.createdAt, liftedAt: schema.emailSuppressions.liftedAt })
    .from(schema.emailSuppressions)
    .where(and(eq(schema.emailSuppressions.emailLower, emailLower), isNull(schema.emailSuppressions.liftedAt)));
  return rows;
}

/** Completion times of genuinely completed bookings of every client using this address (for the inferred rule). */
export async function completedVisitsFor(db: Db, emailLower: string): Promise<Date[]> {
  const rows = await db
    .select({ completedAt: schema.bookings.completedAt })
    .from(schema.bookings)
    .innerJoin(schema.customers, eq(schema.bookings.customerId, schema.customers.id))
    .where(and(sql`lower(${schema.customers.email}) = ${emailLower}`, genuinelyCompletedBookingWhere()));
  return rows.map((r) => r.completedAt).filter((d): d is Date => d instanceof Date);
}

/** The consent state of one address, from the ledger and the suppression list. */
export async function consentStateFor(db: Db, email: string, settings: AppSettings, now: Date): Promise<{ consent: ConsentState; suppressions: SuppressionFact[] }> {
  const emailLower = normaliseEmail(email);
  const [events, suppressions] = await Promise.all([
    db
      .select({ id: schema.consentEvents.id, kind: schema.consentEvents.kind, method: schema.consentEvents.method, occurredAt: schema.consentEvents.occurredAt })
      .from(schema.consentEvents)
      .where(eq(schema.consentEvents.emailLower, emailLower)),
    activeSuppressions(db, emailLower),
  ]);
  const visits = settings.email.allowInferredConsent ? await completedVisitsFor(db, emailLower) : [];
  return { consent: foldConsent(events, suppressions, { allowInferred: settings.email.allowInferredConsent, completedVisits: visits, now }), suppressions };
}

/** The gate's answer about consent and suppression for review eligibility (step 7). */
export function marketingBlockFrom(consent: ConsentState, suppressions: readonly SuppressionFact[], squareEmailUnsubscribed: boolean | null): 'no_consent' | 'unsubscribed' | 'suppressed' | null {
  if (suppressions.some((s) => s.scope === 'all')) return 'suppressed';
  if (suppressions.some((s) => s.scope === 'marketing') || consent.status === 'withdrawn' || squareEmailUnsubscribed === true) return 'unsubscribed';
  if (consent.status !== 'express' && consent.status !== 'inferred') return 'no_consent';
  return null;
}

/** Sending counters for the daily caps, on the Melbourne calendar day of `now`. */
export async function sendCounters(db: Db, input: { purpose: string; customerId: string | null; now: Date }): Promise<{ automationSentToday: number; commercialSentToday: number; customerAutomatedToday: number }> {
  const { start, end } = melbourneDayRange(melbourneDateOf(input.now));
  const m = schema.emailMessages;
  const today = and(gte(m.sentAt, start), lt(m.sentAt, end), inArray(m.status, [...SENT_STATUSES]));
  const count = async (where: ReturnType<typeof and>) => {
    const r = await db.select({ n: sql<number>`count(*)::int` }).from(m).where(where);
    return r[0]?.n ?? 0;
  };
  const [automationSentToday, commercialSentToday, customerAutomatedToday] = await Promise.all([
    count(and(today, eq(m.origin, 'automation'), eq(m.purpose, input.purpose))),
    count(and(today, ne(m.messageClass, 'transactional_factual'), ne(m.origin, 'preview'))),
    input.customerId ? count(and(today, eq(m.origin, 'automation'), eq(m.customerId, input.customerId))) : Promise.resolve(0),
  ]);
  return { automationSentToday, commercialSentToday, customerAutomatedToday };
}

/** When a review request was last actually sent to this client (excluding one request id). */
export async function lastReviewRequestSentAt(db: Db, customerId: string, excludeRequestId: string | null): Promise<Date | null> {
  const r = schema.reviewRequests;
  const rows = await db
    .select({ at: sql<Date | null>`max(${r.sentAt})` })
    .from(r)
    .where(and(eq(r.customerId, customerId), eq(r.status, 'sent'), excludeRequestId ? ne(r.id, excludeRequestId) : undefined));
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}
