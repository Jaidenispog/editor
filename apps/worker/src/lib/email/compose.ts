import { eq } from 'drizzle-orm';
import { melbourneLocalToUtc, renderEmail, senderAddress, type AppSettings, type MessageClass, type RenderedEmail } from '@studio/core';
import { schema } from '@studio/db';
import type { Db } from './facts.js';
import { identityFrom } from './facts.js';

/** What a message is about: its client and, when tied to one, the appointment (or the attested visit date). */
export interface MessageSubject {
  customer: typeof schema.customers.$inferSelect | null;
  booking: typeof schema.bookings.$inferSelect | null;
  reviewRequest: typeof schema.reviewRequests.$inferSelect | null;
}

/** Loads the client, booking and review request a message is about. */
export async function loadMessageSubject(db: Db, message: Pick<typeof schema.emailMessages.$inferSelect, 'id' | 'customerId' | 'bookingId'>): Promise<MessageSubject> {
  const [customer, booking, reviewRequest] = await Promise.all([
    message.customerId ? db.query.customers.findFirst({ where: eq(schema.customers.id, message.customerId) }) : Promise.resolve(undefined),
    message.bookingId ? db.query.bookings.findFirst({ where: eq(schema.bookings.id, message.bookingId) }) : Promise.resolve(undefined),
    db.query.reviewRequests.findFirst({ where: eq(schema.reviewRequests.emailMessageId, message.id) }),
  ]);
  return { customer: customer ?? null, booking: booking ?? null, reviewRequest: reviewRequest ?? null };
}

/** The visit date shown in `{{visit_date}}`: the booking's start, or the attested visit date at midday. */
export function visitDateOf(subject: MessageSubject): Date | null {
  if (subject.booking) return subject.booking.startAt;
  const d = subject.reviewRequest?.attestedVisitDate;
  if (d) {
    const r = melbourneLocalToUtc(d, '12:00');
    return r.ok ? r.instant : null;
  }
  return null;
}

/** Renders a message for one client with the given personal links (real tokens to send, or null for a stored preview). */
export function composeMessage(
  settings: AppSettings,
  input: { messageClass: MessageClass; subject: string; bodyMarkdown: string; subjectOf: MessageSubject; reviewLinkUrl: string | null; unsubscribeUrl: string | null },
): RenderedEmail {
  const { customer, booking } = input.subjectOf;
  return renderEmail({
    messageClass: input.messageClass,
    subject: input.subject,
    bodyMarkdown: input.bodyMarkdown,
    vars: {
      firstName: customer?.givenName ?? null,
      businessName: settings.brand.businessName,
      visitDate: visitDateOf(input.subjectOf),
      serviceName: booking?.serviceName ?? null,
      senderName: settings.email.senderName || settings.brand.businessName,
      bookingLink: settings.business.bookingLink || null,
    },
    identity: identityFrom(settings),
    reviewLinkUrl: input.reviewLinkUrl,
    unsubscribeUrl: input.unsubscribeUrl,
    accentColour: settings.brand.accentColour,
  });
}

/** The `From` header: `EMAIL_FROM` as given when it has a display name, otherwise the sender name with that address. */
export function fromHeader(emailFrom: string, settings: AppSettings): string {
  if (emailFrom.includes('<')) return emailFrom;
  const name = (settings.email.senderName || settings.brand.businessName).replace(/["\\\r\n]/g, '');
  return `"${name}" <${senderAddress(emailFrom)}>`;
}

/** Reply-To: the email setting, else Settings → Business email, else none. */
export function replyToFor(settings: AppSettings): string | null {
  return settings.email.replyTo.trim() || settings.business.email.trim() || null;
}
