import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { BookingChangeFreshSlot, BookingChangeKind, BookingChangeRequest, BookingChangeStatus } from '@studio/core';
import { bookings, users } from '../schema.js';

/**
 * Booking changes from Studio Assistant (Square Tier 1, WP6b; design `square-appointments.md` §5.3, §6.3). One row per
 * owner-approved create, reschedule or cancel. `square.booking_change` is the only code that writes to Square: it
 * claims the row, re-checks the plan, service, booking and time, sets `submitted_at` just before the one write (the
 * non-repeatable marker), and stores Square's answer verbatim. `../schema.ts` re-exports this file.
 *
 * `merchant_id` and `environment` bind the approval to the Square account the owner saw: the worker refuses to send
 * when the live connection is another account or environment. Removed with the rest of Square's data on a purge.
 */
export const squareBookingChanges = pgTable(
  'square_booking_changes',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<BookingChangeKind>().notNull(),
    environment: text('environment').$type<'sandbox' | 'production'>().notNull(),
    /** The Square seller the owner approved this for (the connection's merchant id at approval). */
    merchantId: text('merchant_id').notNull(),
    bookingId: text('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    /** Known for a reschedule or cancel; filled in after a create. */
    squareBookingId: text('square_booking_id'),
    request: jsonb('request').$type<BookingChangeRequest>().notNull(),
    /** Sent to Square; stable across retries. */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').$type<BookingChangeStatus>().notNull().default('queued'),
    statusMessage: text('status_message').notNull().default(''),
    httpStatus: integer('http_status'),
    /** Square's `errors[0].code`, verbatim. */
    errorCode: text('error_code'),
    /** Square's answer verbatim (the booking on success, the error body on a refusal). Never holds a token. */
    squareResponse: jsonb('square_response').$type<Record<string, unknown>>(),
    /** Free times the re-check found when the requested one was taken. */
    freshSlots: jsonb('fresh_slots').$type<BookingChangeFreshSlot[]>(),
    selfTestId: text('self_test_id'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Set by a conditional update immediately before the write call. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('square_booking_changes_idem_idx').on(t.idempotencyKey),
    index('square_booking_changes_booking_idx').on(t.bookingId, t.createdAt),
    index('square_booking_changes_status_idx').on(t.status, t.createdAt),
    index('square_booking_changes_selftest_idx').on(t.selfTestId),
  ],
);
