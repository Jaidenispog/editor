import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from '../schema.js';

/** Parameters of one free-times search (`square_availability_searches.params`). */
export interface SquareAvailabilityParams {
  serviceVariationId: string;
  teamMemberId: string | null;
  /** First Melbourne day, `YYYY-MM-DD`. */
  fromDate: string;
  days: number;
  /** For a reschedule search (Tier 1): the booking being moved. */
  bookingId: string | null;
}

/** One free slot Square returned (an exact instant; never converted from local time). */
export interface SquareAvailabilitySlot {
  startAt: string;
  teamMemberId: string;
  durationMinutes: number;
  serviceVariationId: string;
  serviceVariationVersion: string | null;
}

/**
 * Tables of the Square appointments module (WP6; WP6b adds `square_booking_changes` in its own file).
 * `../schema.ts` re-exports this file, so the app, the worker and drizzle-kit all see the tables.
 */

/**
 * On-demand availability searches (design §4.4): the web app creates a row, `square.availability` fills `slots`.
 * Read-only; rows older than 24 hours are removed by `maintenance.cleanup`.
 */
export const squareAvailabilitySearches = pgTable(
  'square_availability_searches',
  {
    id: text('id').primaryKey(),
    environment: text('environment').notNull(),
    params: jsonb('params').$type<SquareAvailabilityParams>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull().default('queued'),
    slots: jsonb('slots').$type<SquareAvailabilitySlot[]>().notNull().default([]),
    error: text('error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('square_availability_searches_created_idx').on(t.createdAt)],
);
