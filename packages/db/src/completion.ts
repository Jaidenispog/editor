import { and, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { GENUINE_COMPLETION_ENVIRONMENT, GENUINE_COMPLETION_SOURCES } from '@studio/core';
import * as schema from './schema.js';

/**
 * The SQL twin of `isGenuinelyCompleted` (packages/core/src/completion.ts) for queries over `bookings`: a live-Square
 * booking that Square still shows as ACCEPTED, with a genuine completion source and time. Every query that picks
 * "real visits" (automations, campaign audiences, the inferred-consent rule) uses this, so sandbox test bookings can
 * never start a real email.
 */
export function genuinelyCompletedBookingWhere(): SQL {
  const b = schema.bookings;
  return and(
    eq(b.squareEnvironment, GENUINE_COMPLETION_ENVIRONMENT),
    eq(b.status, 'ACCEPTED'),
    inArray(b.completionSource, [...GENUINE_COMPLETION_SOURCES]),
    isNotNull(b.completedAt),
  ) as SQL;
}
