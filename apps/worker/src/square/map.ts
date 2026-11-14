import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  bookingEndAt,
  deriveAttendance,
  deriveCompletion,
  effectiveLocationId,
  newId,
  parseSquareConfig,
  type OwnerAttendance,
  type PaymentMatch,
  type SquareConnectionConfig,
  type SquareEnvironmentName,
  type SquareSnapshot,
} from '@studio/core';
import { schema, type Database } from '@studio/db';
import type { DbTransaction } from '../lib/connections.js';
import type { SquareBookingData, SquareCustomerData } from './api.js';

/** A `bookings` row. */
export type BookingRow = typeof schema.bookings.$inferSelect;

/** What an upsert did (`ignored`: a booking at a Square location other than the studio's, never copied). */
export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'stale' | 'ignored';

/** The connection a job opened: copied rows are written only while it is still the live connection. */
export interface MirrorOwner {
  environment: SquareEnvironmentName;
  merchantId: string;
}

/**
 * The owner disconnected Square (or reconnected another account or environment) while a job was copying data. The
 * job stops without writing: anything it wrote now could bring back client details the owner asked to remove.
 */
export class SquareConnectionChangedError extends Error {
  constructor() {
    super('Square was disconnected or changed while this was running, so nothing more was copied.');
    this.name = 'SquareConnectionChangedError';
  }
}

/**
 * Runs one mirror write in a transaction that first takes `SELECT … FOR SHARE` on the `square` connection row and
 * goes ahead only while it is still connected (or in a transient error state) for the same seller and environment.
 * `disconnectSquare` and `storeSquareConnection` take the same row `FOR UPDATE` before purging, so a purge and a
 * write can never interleave: a write either lands before the purge (and is purged) or sees the change and stops.
 */
export async function withMirrorGuard<T>(db: Database, owner: MirrorOwner, fn: (tx: DbTransaction, config: SquareConnectionConfig) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const t = schema.integrationConnections;
    const row = (await tx.select({ status: t.status, externalAccountId: t.externalAccountId, config: t.config }).from(t).where(eq(t.provider, 'square')).limit(1).for('share'))[0];
    const config = parseSquareConfig(row?.config);
    const live = row && (row.status === 'connected' || row.status === 'error') && row.externalAccountId === owner.merchantId && config.environment === owner.environment;
    if (!live) throw new SquareConnectionChangedError();
    return fn(tx, config);
  });
}

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
  b: { status: string; endAt: Date; ownerAttendance: OwnerAttendance | null; missingFromSquareAt: Date | null; completedAt: Date | null; environment: string },
  match: PaymentMatch | null,
  now: Date,
): Pick<BookingRow, 'attendance' | 'attendanceEvidence' | 'completionSource' | 'completedAt'> {
  const attendance = deriveAttendance({ status: b.status, endAt: b.endAt, ownerAttendance: b.ownerAttendance, missingFromSquareAt: b.missingFromSquareAt, match }, now);
  // Sandbox (test) bookings are labelled but never completed: test data must never start a real email (completion.ts).
  const completion = deriveCompletion({ status: b.status, endAt: b.endAt, missingFromSquareAt: b.missingFromSquareAt, ownerAttendance: b.ownerAttendance, attendance, completedAt: b.completedAt, environment: b.environment }, now);
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
 * Written only while `owner` is still the live connection ({@link withMirrorGuard}), and only for the studio's own
 * Square location (the owner's choice, or the only active one): bookings of other locations, or any booking while
 * the owner still has to choose, are `ignored`.
 */
export async function upsertBooking(db: Database, b: SquareBookingData, owner: MirrorOwner, snapshot: SquareSnapshot | null, now: Date = new Date()): Promise<UpsertOutcome> {
  return withMirrorGuard(db, owner, (tx, config) => {
    const locationId = effectiveLocationId(config);
    if (!locationId || b.locationId !== locationId) return Promise.resolve('ignored' as const);
    return upsertBookingIn(tx, b, owner.environment, snapshot, now);
  });
}

async function upsertBookingIn(db: DbTransaction, b: SquareBookingData, environment: SquareEnvironmentName, snapshot: SquareSnapshot | null, now: Date): Promise<UpsertOutcome> {
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
  const derived = derivedColumns({ status: b.status, endAt, ownerAttendance, missingFromSquareAt: null, completedAt: existing?.completedAt ?? null, environment }, storedMatch(existing?.attendanceEvidence), now);
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
 * newer one. Bookings already mirrored for this customer are linked to the row. Written only while `owner` is still
 * the live connection ({@link withMirrorGuard}).
 */
export async function upsertCustomer(db: Database, c: SquareCustomerData, owner: MirrorOwner, now: Date = new Date()): Promise<UpsertOutcome> {
  return withMirrorGuard(db, owner, (tx) => upsertCustomerIn(tx, c, owner.environment, now));
}

async function upsertCustomerIn(db: DbTransaction, c: SquareCustomerData, environment: SquareEnvironmentName, now: Date): Promise<UpsertOutcome> {
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
  const next = derivedColumns({ status: row.status, endAt, ownerAttendance: (row.ownerAttendance ?? null) as OwnerAttendance | null, missingFromSquareAt: row.missingFromSquareAt, completedAt: row.completedAt, environment: row.squareEnvironment }, match, now);
  const prevMatch = storedMatch(row.attendanceEvidence);
  const sameEvidence = (prevMatch?.paymentId ?? null) === (match?.paymentId ?? null) && (prevMatch?.kind ?? null) === (match?.kind ?? null);
  if (row.attendance === next.attendance && row.completionSource === next.completionSource && (row.completedAt?.getTime() ?? null) === (next.completedAt?.getTime() ?? null) && sameEvidence) return false;
  await db
    .update(schema.bookings)
    .set({ ...next, ...(sameEvidence ? { attendanceEvidence: row.attendanceEvidence } : {}), updatedAt: now })
    .where(eq(schema.bookings.id, row.id));
  return true;
}
