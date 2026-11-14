import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { SQUARE_MATCH_AFTER_END_MS, SQUARE_MATCH_BEFORE_START_MS, SQUARE_PAYMENT_GIVE_UP_MS, effectiveLocationId, matchPayments, type MatchBooking } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import type { SquareSession } from './client.js';
import { applyAttendance, storedMatch, type BookingRow } from './map.js';

/** Result of one attendance pass. */
export interface AttendanceSummary {
  candidates: number;
  changed: number;
  payments: number;
}

/**
 * Matches Square payments to finished ACCEPTED bookings and stores attendance and genuine completion (design §4.7).
 * Candidates are bookings ending in [from, to] (default: the last 7 days) without an owner mark, plus bookings
 * already marked paid in that range, so a refund clears their completion. Bookings with an owner mark are left to
 * the owner. Read-only towards Square.
 */
export async function runAttendance(
  ctx: WorkerContext,
  run: Pick<TrackedRun, 'checkCancelled'>,
  s: SquareSession,
  input: { squareCustomerId?: string | undefined; from?: Date | undefined; to?: Date | undefined },
  now: Date = new Date(),
): Promise<AttendanceSummary> {
  const t = schema.bookings;
  const from = input.from ?? new Date(now.getTime() - SQUARE_PAYMENT_GIVE_UP_MS);
  const to = input.to ?? now;
  // Only the studio's Square location (none while the owner still has to choose one).
  const locationId = effectiveLocationId(s.config);
  if (!locationId) return { candidates: 0, changed: 0, payments: 0 };
  const rows = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.squareEnvironment, s.environment),
        eq(t.locationId, locationId),
        eq(t.status, 'ACCEPTED'),
        isNull(t.ownerAttendance),
        gte(t.endAt, from),
        lte(t.endAt, to),
        input.squareCustomerId ? eq(t.squareCustomerId, input.squareCustomerId) : undefined,
      ),
    );
  let changed = await settleWithoutPayments(ctx, s, locationId, now);
  if (!rows.length) return { candidates: 0, changed, payments: 0 };

  // One payments read per location, over the union of the candidates' matching windows.
  const byLocation = new Map<string, BookingRow[]>();
  for (const r of rows) byLocation.set(r.locationId, [...(byLocation.get(r.locationId) ?? []), r]);
  let paymentCount = 0;
  for (const [locationId, list] of byLocation) {
    run.checkCancelled();
    if (!locationId) continue;
    const begin = new Date(Math.min(...list.map((b) => b.startAt.getTime())) - SQUARE_MATCH_BEFORE_START_MS);
    const end = new Date(Math.max(...list.map((b) => (b.endAt ?? b.startAt).getTime())) + SQUARE_MATCH_AFTER_END_MS);
    const payments = await s.api.listPayments({ locationId, beginTime: begin.toISOString(), endTime: end.toISOString() });
    paymentCount += payments.length;
    const bookings: MatchBooking[] = list.map((b) => ({
      id: b.id,
      locationId: b.locationId,
      squareCustomerId: b.squareCustomerId,
      teamMemberId: b.teamMemberId,
      serviceVariationId: b.serviceVariationId,
      startAt: b.startAt,
      endAt: b.endAt ?? b.startAt,
    }));
    // Order lines only for completed payments that fall in some candidate's window and carry an order.
    const inWindow = payments.filter(
      (p) => p.orderId && p.status === 'COMPLETED' && bookings.some((b) => p.createdAt.getTime() >= b.startAt.getTime() - SQUARE_MATCH_BEFORE_START_MS && p.createdAt.getTime() <= b.endAt.getTime() + SQUARE_MATCH_AFTER_END_MS),
    );
    const orderIds = [...new Set(inWindow.map((p) => p.orderId as string))];
    const orderLines = orderIds.length ? await s.api.batchGetOrderLines(locationId, orderIds) : {};
    const matches = matchPayments(bookings, payments, orderLines);
    for (const row of list) if (await applyAttendance(ctx.db, row, matches.get(row.id) ?? null, now)) changed++;
  }
  return { candidates: rows.length, changed, payments: paymentCount };
}

/**
 * Moves bookings on as time passes without calling Square: an ACCEPTED booking that has just ended becomes "waiting
 * for a payment", one that ended over 7 days ago without a match becomes "no payment found", and one the owner marked
 * attended before it ended is completed. The stored evidence is kept.
 */
async function settleWithoutPayments(ctx: WorkerContext, s: SquareSession, locationId: string, now: Date): Promise<number> {
  const t = schema.bookings;
  const giveUp = new Date(now.getTime() - SQUARE_PAYMENT_GIVE_UP_MS);
  const rows = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.squareEnvironment, s.environment),
        eq(t.locationId, locationId),
        or(
          and(isNull(t.ownerAttendance), or(and(eq(t.attendance, 'upcoming'), lte(t.endAt, now)), and(eq(t.attendance, 'awaiting_payment'), lte(t.endAt, giveUp)))),
          // Marked "attended" while the appointment was still running: completed once it has ended (live Square only;
          // sandbox bookings never complete).
          s.environment === 'production' ? and(eq(t.ownerAttendance, 'attended'), eq(t.status, 'ACCEPTED'), eq(t.completionSource, 'none'), lte(t.endAt, now)) : undefined,
        ),
      ),
    );
  let changed = 0;
  for (const row of rows) if (await applyAttendance(ctx.db, row, storedMatch(row.attendanceEvidence), now)) changed++;
  return changed;
}
