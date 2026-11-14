import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { newId, normaliseEmail, type ConsentMethod } from '@studio/core';
import { schema, type ConsentEvidence } from '@studio/db';
import type { Db } from './facts.js';

/**
 * Restrictive writes shared by the webhook handler, the send state machine and the sweep. Each one only ever
 * reduces sending: nothing here grants consent, lifts a suppression or causes a send (design §8.1.5).
 */

export type SuppressionScope = 'all' | 'marketing';
export type SuppressionReason = 'hard_bounce' | 'spam_complaint' | 'unsubscribe' | 'provider_inactive' | 'manual_block';
export type SuppressionSource = 'postmark_webhook' | 'unsubscribe_page' | 'one_click' | 'owner' | 'send_error' | 'square_preference';

/** Adds a suppression once (the active unique index makes a repeat a no-op). Returns the new row id, or null. */
export async function addSuppression(
  db: Db,
  input: { email: string; scope: SuppressionScope; reason: SuppressionReason; source: SuppressionSource; stream?: string | null; emailMessageId?: string | null; webhookEventId?: string | null },
): Promise<string | null> {
  const id = newId();
  const rows = await db
    .insert(schema.emailSuppressions)
    .values({
      id,
      emailLower: normaliseEmail(input.email),
      scope: input.scope,
      reason: input.reason,
      source: input.source,
      stream: input.stream ?? null,
      emailMessageId: input.emailMessageId ?? null,
      webhookEventId: input.webhookEventId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.emailSuppressions.id });
  return rows[0]?.id ?? null;
}

/** Appends a `withdrawn` consent event (append-only ledger) and updates the clients' display cache. */
export async function recordWithdrawal(db: Db, input: { email: string; customerId: string | null; method: ConsentMethod; evidence?: ConsentEvidence; recordedBy?: string | null; occurredAt?: Date }): Promise<void> {
  const emailLower = normaliseEmail(input.email);
  const at = input.occurredAt ?? new Date();
  await db.insert(schema.consentEvents).values({
    id: newId(),
    customerId: input.customerId,
    emailLower,
    kind: 'withdrawn',
    basis: '',
    method: input.method,
    evidence: input.evidence ?? {},
    recordedBy: input.recordedBy ?? null,
    occurredAt: at,
  });
  await db
    .update(schema.customers)
    .set({ marketingConsent: false, marketingConsentSource: input.method, marketingConsentAt: at, unsubscribedAt: at, updatedAt: new Date() })
    .where(sql`lower(${schema.customers.email}) = ${emailLower}`);
}

/**
 * Pending messages to the address that may no longer go out flip to `suppressed` (commercial ones for a marketing
 * suppression; every class for an `all` suppression), with their review requests skipped. Messages already handed to
 * the provider (`submitted_at` set) are left alone.
 */
export async function suppressPendingMessages(db: Db, email: string, scope: SuppressionScope, statusMessage: string): Promise<number> {
  const m = schema.emailMessages;
  const emailLower = normaliseEmail(email);
  const rows = await db
    .update(m)
    .set({ status: 'suppressed', statusMessage, updatedAt: new Date() })
    .where(
      and(
        sql`lower(${m.toEmail}) = ${emailLower}`,
        inArray(m.status, ['draft', 'approved', 'queued']),
        isNull(m.submittedAt),
        ne(m.origin, 'preview'),
        scope === 'marketing' ? ne(m.messageClass, 'transactional_factual') : undefined,
      ),
    )
    .returning({ id: m.id });
  if (rows.length) {
    await db
      .update(schema.reviewRequests)
      .set({ status: 'skipped', skipReason: scope === 'all' ? 'suppressed' : 'unsubscribed', updatedAt: new Date() })
      .where(and(inArray(schema.reviewRequests.emailMessageId, rows.map((r) => r.id)), inArray(schema.reviewRequests.status, ['pending_approval', 'scheduled'])));
  }
  return rows.length;
}

/** Marks a review request linked to a message (no-op when none). */
export async function updateLinkedReviewRequest(db: Db, emailMessageId: string, set: Partial<typeof schema.reviewRequests.$inferInsert>, fromStatuses: readonly string[] = ['pending_approval', 'scheduled']): Promise<void> {
  await db
    .update(schema.reviewRequests)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(schema.reviewRequests.emailMessageId, emailMessageId), inArray(schema.reviewRequests.status, [...fromStatuses] as Array<'pending_approval' | 'scheduled' | 'sent' | 'skipped' | 'failed' | 'cancelled'>)));
}
