import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { classifyAudience, foldConsent, normaliseEmail, type AppSettings, type AudienceCandidate, type AudienceExclusion, type CampaignAudienceFilter } from '@studio/core';
import { schema } from '@studio/db';
import type { Db } from './facts.js';

/** One client in a campaign audience, included or left out with a reason. */
export interface AudienceRow {
  customerId: string;
  name: string;
  email: string | null;
  included: boolean;
  reason: AudienceExclusion | null;
}

/**
 * Every client classified for a campaign (design §4.4), from the ledger, the suppression list and genuinely
 * completed visits. The same rule (`classifyAudience` in core) is used by the web preview, so the approved audience
 * hash matches what this computes unless something changed in between.
 */
export async function computeAudience(db: Db, settings: AppSettings, audience: CampaignAudienceFilter, now: Date): Promise<AudienceRow[]> {
  const customers = await db.select().from(schema.customers).orderBy(schema.customers.givenName, schema.customers.id);
  const emails = [...new Set(customers.map((c) => (c.email ? normaliseEmail(c.email) : null)).filter((e): e is string => Boolean(e)))];
  const events = emails.length ? await db.select().from(schema.consentEvents).where(inArray(schema.consentEvents.emailLower, emails)) : [];
  const suppressions = emails.length ? await db.select().from(schema.emailSuppressions).where(and(inArray(schema.emailSuppressions.emailLower, emails), isNull(schema.emailSuppressions.liftedAt))) : [];
  const visits = await db
    .select({ customerId: schema.bookings.customerId, completedAt: schema.bookings.completedAt })
    .from(schema.bookings)
    .where(and(eq(schema.bookings.status, 'ACCEPTED'), inArray(schema.bookings.completionSource, ['payment', 'owner_marked']), isNotNull(schema.bookings.completedAt), isNotNull(schema.bookings.customerId)));
  const visitsByCustomer = new Map<string, Date[]>();
  for (const v of visits) {
    if (!v.customerId || !v.completedAt) continue;
    visitsByCustomer.set(v.customerId, [...(visitsByCustomer.get(v.customerId) ?? []), v.completedAt]);
  }
  return customers.map((c) => {
    const emailLower = c.email ? normaliseEmail(c.email) : null;
    const ev = emailLower ? events.filter((e) => e.emailLower === emailLower) : [];
    const sup = emailLower ? suppressions.filter((s) => s.emailLower === emailLower) : [];
    const own = visitsByCustomer.get(c.id) ?? [];
    const candidate: AudienceCandidate = {
      customerId: c.id,
      deleted: Boolean(c.deletedAt),
      email: c.email,
      consent: foldConsent(ev, sup, { allowInferred: settings.email.allowInferredConsent, completedVisits: own, now }),
      activeSuppressions: sup,
      squareEmailUnsubscribed: c.squareEmailUnsubscribed,
      lastCompletedVisitAt: own.reduce<Date | null>((a, b) => (a && a > b ? a : b), null),
    };
    const verdict = classifyAudience(candidate, audience, now);
    return { customerId: c.id, name: [c.givenName, c.familyName].filter(Boolean).join(' ') || 'Client', email: c.email, included: verdict.included, reason: verdict.included ? null : verdict.reason };
  });
}
