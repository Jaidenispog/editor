import { and, eq, isNull, sql } from 'drizzle-orm';
import { bookingEndAt, deriveAttendance, deriveCompletion, newId, type OwnerAttendance, type PaymentMatch, type SquareEnvironmentName, type SquareSnapshot } from '@studio/core';
import { schema, type Database } from '@studio/db';
import type { SquareBookingData, SquareCustomerData } from './api.js';

/** A `bookings` row. */
export type BookingRow = typeof schema.bookings.$inferSelect;

/** What an upsert did. */
export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'stale';

/** The payment evidence stored on a booking, read back for re-derivation (null when none is stored). */
export function storedMatch(evidence: Record<string, unknown> | null | undefined): PaymentMatch | null {
  const e = evidence ?? {};
  if ((e['kind'] !== 'strong' && e['kind'] !== 'weak') || typeof e['paymentId'] !== 'string') return null;
  return {
    kind: e['kind'],
    paymentId: e['paymentId'],
    score: typeof e['score'] === 'number' ? e['score'] : 0,
    signals: Array.isArray(e['signals']) ? (e['signals'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    confidence: e['confidence'] === 'high' || e['confidence'] === 'medium' ? e['confidence'] : 'low',
  };
}

/** The display name of a service variation from the snapshot ("Skin fade", or "Skin fade · Long"). */
export function serviceNameFor(snapshot: SquareSnapshot | null, variationId: string | null): string {
  if (!snapshot || !variationId) return '';
  const s = snapshot.services.find((x) => x.variationId === variationId);
  if (!s) return '';
  return s.variationName && s.variationName !== 'Regular' && s.variationName !== s.itemName ? `${s.itemName} · ${s.variationName}` : s.itemName;
}

/** Attendance, evidence and completion columns for a booking after a change in Square, a payment match or an owner mark. */
export function derivedColumns(
  b: { status: string; endAt: Date; ownerAttendance: OwnerAttendance | null; missingFromSquareAt: Date | null; completedAt: Date | null },
  match: PaymentMatch | null,
  now: Date,
): Pick<BookingRow, 'attendance' | 'attendanceEvidence' | 'completionSource' | 'completedAt'> {
  const attendance = deriveAttendance({ status: b.status, endAt: b.endAt, ownerAttendance: b.ownerAttendance, missingFromSquareAt: b.missingFromSquareAt, match }, now);
  const completion = deriveCompletion({ status: b.status, endAt: b.endAt, missingFromSquareAt: b.missingFromSquareAt, ownerAttendance: b.ownerAttendance, attendance, completedAt: b.completedAt }, now);
  return {
    attendance,
    attendanceEvidence: match ? { kind: match.kind, paymentId: match.paymentId, score: match.score, signals: match.signals, confidence: match.confidence, matchedAt: now.toISOString() } : {},
    completionSource: completion.source,
    completedAt: completion.completedAt,
  };
}

/**
 * Upserts one booking by its Square id (design §6.2). A stored version newer than Square's answer is kept (stale
 * reads never overwrite); the same version and update time leaves the row untouched apart from `synced_at`. The
 * owner's attendance mark and the stored payment evidence are kept, and attendance/completion are re-derived.
 */
export async function upsertBooking(db: Database, b: SquareBookingData, environment: SquareEnvironmentName, snapshot: SquareSnapshot | null, now: Date = new Date()): Promise<UpsertOutcome> {
  const t = schema.bookings;
  const existing = await db.query.bookings.findFirst({ where: eq(t.squareBookingId, b.id) });
  if (existing && existing.squareVersion > b.version) return 'stale';
  const updatedAt = b.updatedAt ? new Date(b.updatedAt) : null;
  if (existing && existing.squareVersion === b.version && existing.squareUpdatedAt?.getTime() === updatedAt?.getTime() && existing.missingFromSquareAt === null && existing.squareEnvironment === environment) {
    await db.update(t).set({ syncedAt: now }).where(eq(t.id, existing.id));
    return 'unchanged';
  }
  const startAt = new Date(b.startAt);
  const endAt = bookingEndAt(startAt, b.segments);
  const first = b.segments[0];
  const customer = b.customerId ? await db.query.customers.findFirst({ where: eq(schema.customers.squareCustomerId, b.customerId), columns: { id: true } }) : undefined;
  const ownerAttendance = (existing?.ownerAttendance ?? null) as OwnerAttendance | null;
  const derived = derivedColumns({ status: b.status, endAt, ownerAttendance, missingFromSquareAt: null, completedAt: existing?.completedAt ?? null }, storedMatch(existing?.attendanceEvidence), now);
  const values = {
    squareVersion: b.version,
    customerId: customer?.id ?? null,
    squareCustomerId: b.customerId,
    locationId: b.locationId,
    teamMemberId: first?.teamMemberId ?? null,
    serviceVariationId: first?.serviceVariationId ?? null,
    serviceName: serviceNameFor(snapshot, first?.serviceVariationId ?? null) || existing?.serviceName || '',
    startAt,
    endAt,
    durationMinutes: b.segments.reduce((sum, s) => sum + s.durationMinutes, 0),
    status: b.status,
    raw: b.raw,
    syncedAt: now,
    squareEnvironment: environment,
    squareUpdatedAt: updatedAt,
    missingFromSquareAt: null,
    ...derived,
    updatedAt: now,
  };
  const rows = await db
    .insert(t)
    .values({ id: newId(), squareBookingId: b.id, ...values })
    .onConflictDoUpdate({ target: t.squareBookingId, set: values, setWhere: sql`${t.squareVersion} <= ${b.version}` })
    .returning({ id: t.id });
  if (!rows.length) return 'stale';
  return existing ? 'updated' : 'inserted';
}

/**
 * Upserts one customer by its Square id. Only the Square-owned fields are written: consent, review opt-out,
 * unsubscribe and notes belong to other modules and are never touched. An older Square version never overwrites a
 * newer one. Bookings already mirrored for this customer are linked to the row.
 */
export async function upsertCustomer(db: Database, c: SquareCustomerData, environment: SquareEnvironmentName, now: Date = new Date()): Promise<UpsertOutcome> {
  const t = schema.customers;
  const existing = await db.query.customers.findFirst({ where: eq(t.squareCustomerId, c.id) });
  if (existing && existing.squareVersion !== null && c.version !== null && existing.squareVersion > c.version) return 'stale';
  const values = {
    givenName: c.givenName,
    familyName: c.familyName,
    email: c.email,
    phone: c.phone,
    squareVersion: c.version,
    squareEmailUnsubscribed: c.emailUnsubscribed,
    squareSyncedAt: now,
    squareEnvironment: environment,
    deletedAt: null,
  };
  if (
    existing &&
    existing.givenName === values.givenName &&
    existing.familyName === values.familyName &&
    existing.email === values.email &&
    existing.phone === values.phone &&
    existing.squareVersion === values.squareVersion &&
    existing.squareEmailUnsubscribed === values.squareEmailUnsubscribed &&
    existing.squareEnvironment === environment &&
    existing.deletedAt === null
  ) {
    await db.update(t).set({ squareSyncedAt: now }).where(eq(t.id, existing.id));
    return 'unchanged';
  }
  const rows = await db
    .insert(t)
    .values({ id: newId(), squareCustomerId: c.id, ...values })
    .onConflictDoUpdate({ target: t.squareCustomerId, set: { ...values, updatedAt: now } })
    .returning({ id: t.id });
  const id = rows[0]?.id;
  if (id) await db.update(schema.bookings).set({ customerId: id }).where(and(eq(schema.bookings.squareCustomerId, c.id), isNull(schema.bookings.customerId)));
  return existing ? 'updated' : 'inserted';
}

/**
 * Re-derives attendance and completion for one stored booking with the given payment evidence (null clears it).
 * Writes only when something changed, so running it again is harmless.
 */
export async function applyAttendance(db: Database, row: BookingRow, match: PaymentMatch | null, now: Date = new Date()): Promise<boolean> {
  const endAt = row.endAt ?? new Date(row.startAt.getTime() + row.durationMinutes * 60_000);
  const next = derivedColumns({ status: row.status, endAt, ownerAttendance: (row.ownerAttendance ?? null) as OwnerAttendance | null, missingFromSquareAt: row.missingFromSquareAt, completedAt: row.completedAt }, match, now);
  const prevMatch = storedMatch(row.attendanceEvidence);
  const sameEvidence = (prevMatch?.paymentId ?? null) === (match?.paymentId ?? null) && (prevMatch?.kind ?? null) === (match?.kind ?? null);
  if (row.attendance === next.attendance && row.completionSource === next.completionSource && (row.completedAt?.getTime() ?? null) === (next.completedAt?.getTime() ?? null) && sameEvidence) return false;
  await db
    .update(schema.bookings)
    .set({ ...next, ...(sameEvidence ? { attendanceEvidence: row.attendanceEvidence } : {}), updatedAt: now })
    .where(eq(schema.bookings.id, row.id));
  return true;
}
