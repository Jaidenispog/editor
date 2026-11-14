import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the Square appointments module (WP6 Tier 0 reads; WP6b booking changes and the self-test). */
export const SQUARE_JOB_TYPES = {
  /** Reads Square (token status, snapshot, bookings, customers) into the local mirror. Never writes to Square. */
  SQUARE_SYNC: 'square.sync',
  /** Re-reads one booking, customer or payment after a verified webhook (the payload is only a hint). */
  SQUARE_REFRESH: 'square.refresh',
  /** Matches Square payments to finished bookings and updates attendance and genuine completion. */
  SQUARE_ATTENDANCE: 'square.attendance',
  /** Runs one free-times search for the availability finder. Read-only. */
  SQUARE_AVAILABILITY: 'square.availability',
  /** Daily check that refreshes the Square access token well before it expires. */
  SQUARE_TOKEN_REFRESH: 'square.token_refresh',
  /** Asks Square to revoke the app's access after the owner disconnects. */
  SQUARE_REVOKE: 'square.revoke',
  /** The only writer to Square (WP6b): one owner-approved create, reschedule or cancel, re-checked just before sending. */
  SQUARE_BOOKING_CHANGE: 'square.booking_change',
  /** The owner-approved self-test (WP6b): book, move and cancel one test booking through the booking-change routine. */
  SQUARE_SELF_TEST: 'square.self_test',
} as const;

export const SquareSyncPayloadSchema = z.object({ reason: z.enum(['connect', 'schedule', 'manual', 'reconcile']) });
export const SquareRefreshPayloadSchema = z.object({ entity: z.enum(['booking', 'customer', 'payment']), squareId: z.string().min(1).max(192) });
export const SquareAttendancePayloadSchema = z.object({
  squareCustomerId: z.string().max(192).optional(),
  fromIso: z.string().datetime({ offset: true }).optional(),
  toIso: z.string().datetime({ offset: true }).optional(),
});
export const SquareAvailabilityPayloadSchema = z.object({ searchId: z.string().min(1) });
export const SquareTokenRefreshPayloadSchema = z.object({});
export const SquareRevokePayloadSchema = z.object({ merchantId: z.string().min(1).max(192), environment: z.enum(['sandbox', 'production']) });
export const SquareBookingChangePayloadSchema = z.object({ changeId: z.string().min(1).max(64) });
export const SquareSelfTestPayloadSchema = z.object({ selfTestId: z.string().min(1).max(64) });

/** Payload schemas of the Square appointments module's job types, keyed by job type. */
export const SQUARE_JOB_PAYLOAD_SCHEMAS = {
  [SQUARE_JOB_TYPES.SQUARE_SYNC]: SquareSyncPayloadSchema,
  [SQUARE_JOB_TYPES.SQUARE_REFRESH]: SquareRefreshPayloadSchema,
  [SQUARE_JOB_TYPES.SQUARE_ATTENDANCE]: SquareAttendancePayloadSchema,
  [SQUARE_JOB_TYPES.SQUARE_AVAILABILITY]: SquareAvailabilityPayloadSchema,
  [SQUARE_JOB_TYPES.SQUARE_TOKEN_REFRESH]: SquareTokenRefreshPayloadSchema,
  [SQUARE_JOB_TYPES.SQUARE_REVOKE]: SquareRevokePayloadSchema,
  [SQUARE_JOB_TYPES.SQUARE_BOOKING_CHANGE]: SquareBookingChangePayloadSchema,
  [SQUARE_JOB_TYPES.SQUARE_SELF_TEST]: SquareSelfTestPayloadSchema,
} as const satisfies JobPayloadSchemaMap;
