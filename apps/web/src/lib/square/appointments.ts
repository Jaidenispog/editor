import 'server-only';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  ATTENDANCE_TO_CONFIRM,
  AppError,
  BUSINESS_LOCALE,
  BUSINESS_TIMEZONE,
  SQUARE_AVAILABILITY_MAX_DAYS,
  SQUARE_DASHBOARD_URL,
  SQUARE_IN_SQUARE_INSTRUCTIONS,
  addDaysToDate,
  attendanceLabel,
  deriveAttendance,
  deriveCompletion,
  effectiveLocationId,
  isMelbourneDate,
  mapBookingStatus,
  melbourneDateOf,
  melbourneDayRange,
  newId,
  parseSquareConfig,
  reviewRequestBadgeLabel,
  sentBeforeBookingChanged,
  type Attendance,
  type OwnerAttendance,
  type PaymentMatch,
  type SquareConnectionConfig,
} from '@studio/core';
import { schema, type Database } from '@studio/db';
import type { SessionUser } from '../auth.js';
import { writeAudit } from '../audit.js';
import { getDb } from '../db.js';
import { createTrackedJob } from '../jobs.js';
import { attendanceMarkAllowed, type AvailabilitySearchDto, type BookingDetailDto, type BookingDto, type ClientDetailDto, type ClientDto } from '../shared/square-dto.js';
import { loadSquareConnection, requireSquareConnected } from './status.js';

type BookingRow = typeof schema.bookings.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;

/** Largest page of bookings or clients returned at once. */
export const SQUARE_PAGE_SIZE = 200;
/** Availability results older than this are shown greyed with "Check again". */
export const AVAILABILITY_FRESH_MS = 5 * 60_000;

const timeFormat = new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const dayFormat = new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short' });
const markFormat = new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, day: 'numeric', month: 'short' });

/** "10:30 am" in Melbourne time. */
export function timeLabel(at: Date): string {
  return timeFormat.format(at).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}

/** "Today · Sat 14 Nov", "Tomorrow · Sun 15 Nov", "Yesterday · …" or "Mon 16 Nov", in Melbourne time. */
export function dayLabel(at: Date, now: Date = new Date()): string {
  const day = melbourneDateOf(at);
  const today = melbourneDateOf(now);
  const base = dayFormat.format(at).replace(',', '');
  if (day === today) return `Today · ${base}`;
  if (day === addDaysToDate(today, 1)) return `Tomorrow · ${base}`;
  if (day === addDaysToDate(today, -1)) return `Yesterday · ${base}`;
  return base;
}

/**
 * The environment whose copied data is shown (the connection's own, even after the server switched) and the studio's
 * Square location (the owner's choice, or the only active one; null while the owner still has to choose).
 */
async function dataEnvironment(db: Database): Promise<{ environment: 'sandbox' | 'production'; config: SquareConnectionConfig; locationId: string | null } | null> {
  const conn = await loadSquareConnection(db);
  if (!conn || conn.status === 'disconnected' || conn.status === 'not_configured') return null;
  const config = parseSquareConfig(conn.config);
  return { environment: config.environment, config, locationId: effectiveLocationId(config) };
}

/** Bookings shown: the connection's environment at the studio's location only (nothing while none is chosen). */
function shownBookings(data: { environment: 'sandbox' | 'production'; locationId: string | null }) {
  const t = schema.bookings;
  return and(eq(t.squareEnvironment, data.environment), data.locationId ? eq(t.locationId, data.locationId) : sql`false`);
}

/** True when a stored booking belongs to what is shown. */
function isShown(row: BookingRow, data: { environment: 'sandbox' | 'production'; locationId: string | null } | null): boolean {
  return Boolean(data && row.squareEnvironment === data.environment && data.locationId && row.locationId === data.locationId);
}

function clientName(c: Pick<CustomerRow, 'givenName' | 'familyName'> | null | undefined): string {
  const name = c ? `${c.givenName} ${c.familyName}`.trim() : '';
  return name || 'Client not in Square’s list';
}

/** Turns stored rows into list entries (Square's status verbatim, attendance labelled). */
async function toBookingDtos(db: Database, rows: BookingRow[], config: SquareConnectionConfig | null, now: Date): Promise<BookingDto[]> {
  const customerIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => Boolean(x)))];
  const markerIds = [...new Set(rows.map((r) => r.ownerAttendanceBy).filter((x): x is string => Boolean(x)))];
  const customers = customerIds.length ? await db.select().from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [];
  const markers = markerIds.length ? await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, markerIds)) : [];
  const byCustomer = new Map(customers.map((c) => [c.id, c]));
  const byMarker = new Map(markers.map((m) => [m.id, m.displayName]));
  // The latest review request of each past booking (the Appointments badge).
  const pastIds = rows.filter((r) => r.startAt.getTime() <= now.getTime()).map((r) => r.id);
  const requests = pastIds.length
    ? await db
        .select({ bookingId: schema.reviewRequests.bookingId, status: schema.reviewRequests.status, skipReason: schema.reviewRequests.skipReason })
        .from(schema.reviewRequests)
        .where(inArray(schema.reviewRequests.bookingId, pastIds))
        .orderBy(asc(schema.reviewRequests.createdAt))
    : [];
  const byBookingRequest = new Map(requests.map((q) => [q.bookingId, q]));
  const team = new Map((config?.snapshot?.teamMembers ?? []).map((t) => [t.id, t.displayName]));
  return rows.map((r) => {
    const endAt = r.endAt ?? new Date(r.startAt.getTime() + r.durationMinutes * 60_000);
    const status = mapBookingStatus(r.status);
    const attendance = r.attendance as Attendance;
    const evidence = r.attendanceEvidence as { confidence?: string };
    const mark = attendanceMarkAllowed(r.status, r.startAt, now);
    return {
      id: r.id,
      startAt: r.startAt.toISOString(),
      endAt: endAt.toISOString(),
      dayKey: melbourneDateOf(r.startAt),
      dayLabel: dayLabel(r.startAt, now),
      timeRangeLabel: `${timeLabel(r.startAt)} – ${timeLabel(endAt)}`,
      clientName: clientName(r.customerId ? byCustomer.get(r.customerId) : null),
      customerId: r.customerId,
      serviceName: r.serviceName || 'Service not in Square’s list',
      teamMemberName: (r.teamMemberId && team.get(r.teamMemberId)) || 'A team member',
      status: r.status,
      statusLabel: status.label,
      statusExplanation: status.explanation,
      attendance,
      attendanceLabel: attendanceLabel(attendance, {
        status: r.status,
        markedBy: r.ownerAttendanceBy ? (byMarker.get(r.ownerAttendanceBy) ?? null) : null,
        markedAt: r.ownerAttendanceAt ? markFormat.format(r.ownerAttendanceAt) : null,
        confidence: typeof evidence.confidence === 'string' ? evidence.confidence : null,
      }),
      attendanceIsEstimate: ['awaiting_payment', 'payment_matched', 'possible_match', 'no_payment_matched'].includes(attendance),
      missingFromSquare: r.missingFromSquareAt !== null,
      attendanceMark: { allowed: mark.allowed, reason: mark.reason, current: (r.ownerAttendance ?? null) as 'attended' | 'not_attended' | null },
      reviewRequest: (() => {
        const q = byBookingRequest.get(r.id);
        if (!q) return null;
        const bookingChanged = sentBeforeBookingChanged(q.status, r);
        return { status: bookingChanged ? 'booking_changed' : q.status, label: reviewRequestBadgeLabel(q.status, q.skipReason, { bookingChanged }) };
      })(),
    };
  });
}

/** The three booking lists of the Appointments page (design §4.2). */
export type BookingView = 'upcoming' | 'confirm' | 'past';

/**
 * Bookings for a view, from the local copy only (Square is never called in a web request):
 * - upcoming: from the start of today (Melbourne) for `days` days (default 31);
 * - confirm: ACCEPTED bookings that ended in the last 14 days and still need the owner's word;
 * - past: the last 90 days.
 */
export async function listBookings(input: { view: BookingView; from?: string | undefined; days?: number | undefined; cursor?: string | undefined }, db: Database = getDb(), now: Date = new Date()) {
  const data = await dataEnvironment(db);
  if (!data) return { bookings: [] as BookingDto[], nextCursor: null as string | null, environment: null, syncedAt: null };
  const t = schema.bookings;
  const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
  const env = shownBookings(data);
  let where;
  let order;
  if (input.view === 'upcoming') {
    const from = input.from && isMelbourneDate(input.from) ? input.from : melbourneDateOf(now);
    const days = Math.min(62, Math.max(1, input.days ?? 31));
    const start = melbourneDayRange(from).start;
    const end = melbourneDayRange(addDaysToDate(from, days - 1)).end;
    where = and(env, gte(t.startAt, start), lt(t.startAt, end));
    order = [asc(t.startAt)];
  } else if (input.view === 'confirm') {
    where = and(env, eq(t.status, 'ACCEPTED'), isNull(t.ownerAttendance), inArray(t.attendance, [...ATTENDANCE_TO_CONFIRM]), gte(t.endAt, new Date(now.getTime() - 14 * 24 * 3600_000)), lte(t.endAt, now));
    order = [desc(t.startAt)];
  } else {
    where = and(env, gte(t.startAt, new Date(now.getTime() - 90 * 24 * 3600_000)), lt(t.startAt, now));
    order = [desc(t.startAt)];
  }
  const rows = await db
    .select()
    .from(t)
    .where(where)
    .orderBy(...order)
    .limit(SQUARE_PAGE_SIZE + 1)
    .offset(offset);
  const conn = await loadSquareConnection(db);
  return {
    bookings: await toBookingDtos(db, rows.slice(0, SQUARE_PAGE_SIZE), data.config, now),
    nextCursor: rows.length > SQUARE_PAGE_SIZE ? String(offset + SQUARE_PAGE_SIZE) : null,
    environment: data.environment,
    syncedAt: conn?.lastSyncAt?.toISOString() ?? null,
  };
}

/** Where a booking was made, from Square's `source`. */
function createdIn(raw: Record<string, unknown>): string {
  switch (raw['source']) {
    case 'FIRST_PARTY_MERCHANT':
      return 'Square (by the studio)';
    case 'FIRST_PARTY_BUYER':
      return 'Square online booking';
    case 'THIRD_PARTY_BUYER':
      return 'Another booking app';
    case 'API':
      return 'An app connected to Square';
    default:
      return 'Square';
  }
}

/** A booking with its detail; notes and contact details only for the owner. */
export async function getBookingDetail(id: string, user: SessionUser, db: Database = getDb(), now: Date = new Date()): Promise<BookingDetailDto> {
  const data = await dataEnvironment(db);
  const row = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, id) });
  if (!row || !data || !isShown(row, data)) throw new AppError('NOT_FOUND', 'That booking is not in Studio Assistant’s copy of your Square bookings.');
  const [dto] = await toBookingDtos(db, [row], data.config, now);
  if (!dto) throw new AppError('NOT_FOUND', 'That booking could not be read.');
  const owner = user.role === 'owner';
  const raw = row.raw;
  const customer = row.customerId ? await db.query.customers.findFirst({ where: eq(schema.customers.id, row.customerId) }) : undefined;
  const ev = row.attendanceEvidence as { paymentId?: unknown; confidence?: unknown; signals?: unknown };
  const instruction = row.status === 'PENDING' ? SQUARE_IN_SQUARE_INSTRUCTIONS.accept : row.status === 'ACCEPTED' && row.startAt < now ? SQUARE_IN_SQUARE_INSTRUCTIONS.noShow : SQUARE_IN_SQUARE_INSTRUCTIONS.booking;
  return {
    ...dto,
    customerNote: owner && typeof raw['customerNote'] === 'string' ? raw['customerNote'] : null,
    sellerNote: owner && typeof raw['sellerNote'] === 'string' ? raw['sellerNote'] : null,
    createdIn: createdIn(raw),
    evidence: typeof ev.paymentId === 'string' ? { paymentId: ev.paymentId, confidence: typeof ev.confidence === 'string' ? ev.confidence : 'low', signals: Array.isArray(ev.signals) ? ev.signals.filter((s): s is string => typeof s === 'string') : [] } : null,
    deepLink: { url: SQUARE_DASHBOARD_URL[data.environment], instruction: data.environment === 'sandbox' ? SQUARE_IN_SQUARE_INSTRUCTIONS.sandbox : instruction },
    clientEmail: owner ? (customer?.email ?? null) : null,
    clientPhone: owner ? (customer?.phone ?? null) : null,
  };
}

/**
 * The owner's or a barber's attendance mark (design §4.7, also the email module's "Mark as completed" / "Didn't
 * happen"). Refused while Square's own status forbids it or before the start. Re-derives attendance and genuine
 * completion at once and audits the change (never names or notes).
 */
export async function markAttendance(id: string, value: OwnerAttendance | null, user: SessionUser, db: Database = getDb(), now: Date = new Date()): Promise<BookingDto> {
  const data = await dataEnvironment(db);
  const row = await db.query.bookings.findFirst({ where: eq(schema.bookings.id, id) });
  if (!row || !data || !isShown(row, data)) throw new AppError('NOT_FOUND', 'That booking is not in Studio Assistant’s copy of your Square bookings.');
  const allowed = attendanceMarkAllowed(row.status, row.startAt, now);
  if (!allowed.allowed) throw new AppError('CONFLICT', allowed.reason ?? 'This booking cannot be marked.');
  const endAt = row.endAt ?? new Date(row.startAt.getTime() + row.durationMinutes * 60_000);
  const ev = row.attendanceEvidence as Partial<PaymentMatch>;
  const match = (ev.kind === 'strong' || ev.kind === 'weak') && typeof ev.paymentId === 'string' ? (ev as PaymentMatch) : null;
  // Marked while the appointment is still running: completion follows once it has ended (the worker's attendance pass).
  const attendance = deriveAttendance({ status: row.status, endAt, ownerAttendance: value, missingFromSquareAt: row.missingFromSquareAt, match }, now);
  // Sandbox (test) bookings keep the label but never count as completed, so a test mark cannot start a real email.
  const completion = deriveCompletion({ status: row.status, endAt, missingFromSquareAt: row.missingFromSquareAt, ownerAttendance: value, attendance, completedAt: row.completedAt, environment: row.squareEnvironment }, now);
  const previous = row.ownerAttendance ?? null;
  const [updated] = await db
    .update(schema.bookings)
    .set({
      ownerAttendance: value,
      ownerAttendanceBy: value ? user.id : null,
      ownerAttendanceAt: value ? now : null,
      attendance,
      completionSource: completion.source,
      completedAt: completion.completedAt,
      updatedAt: now,
    })
    .where(eq(schema.bookings.id, row.id))
    .returning();
  await writeAudit({ userId: user.id, action: 'booking.attendance_marked', entityType: 'booking', entityId: row.id, data: { value, previous } });
  const [dto] = await toBookingDtos(db, [updated ?? row], data.config, now);
  if (!dto) throw new AppError('INTERNAL', 'The booking could not be read back.');
  return dto;
}

function toClientDto(c: CustomerRow, owner: boolean): ClientDto {
  return { id: c.id, name: clientName(c), email: owner ? c.email : null, phone: owner ? c.phone : null };
}

/** Clients copied from Square, searched by name (and, for the owner, email or phone). */
export async function listClients(input: { q?: string | undefined; cursor?: string | undefined }, user: SessionUser, db: Database = getDb()): Promise<{ clients: ClientDto[]; nextCursor: string | null }> {
  const data = await dataEnvironment(db);
  if (!data) return { clients: [], nextCursor: null };
  const c = schema.customers;
  const owner = user.role === 'owner';
  const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
  const q = (input.q ?? '').trim().slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const search = q
    ? or(ilike(c.givenName, like), ilike(c.familyName, like), ilike(sql`${c.givenName} || ' ' || ${c.familyName}`, like), ...(owner ? [ilike(c.email, like), ilike(c.phone, like)] : []))
    : undefined;
  const rows = await db
    .select()
    .from(c)
    .where(and(eq(c.squareEnvironment, data.environment), isNull(c.deletedAt), search))
    .orderBy(asc(c.givenName), asc(c.familyName))
    .limit(SQUARE_PAGE_SIZE + 1)
    .offset(offset);
  return { clients: rows.slice(0, SQUARE_PAGE_SIZE).map((r) => toClientDto(r, owner)), nextCursor: rows.length > SQUARE_PAGE_SIZE ? String(offset + SQUARE_PAGE_SIZE) : null };
}

/** One client and their bookings (newest first). */
export async function getClient(id: string, user: SessionUser, db: Database = getDb(), now: Date = new Date()): Promise<ClientDetailDto> {
  const data = await dataEnvironment(db);
  const row = await db.query.customers.findFirst({ where: and(eq(schema.customers.id, id), isNull(schema.customers.deletedAt)) });
  if (!row || !data || row.squareEnvironment !== data.environment) throw new AppError('NOT_FOUND', 'That client is not in Studio Assistant’s copy of your Square clients.');
  const bookings = await db.select().from(schema.bookings).where(and(eq(schema.bookings.customerId, row.id), shownBookings(data))).orderBy(desc(schema.bookings.startAt)).limit(100);
  return { ...toClientDto(row, user.role === 'owner'), bookings: await toBookingDtos(db, bookings, data.config, now) };
}

/** Starts a read-only free-times search (design §4.4); the worker fills it. */
export async function createAvailabilitySearch(
  input: { serviceVariationId: string; teamMemberId?: string | null | undefined; fromDate: string; days: number },
  user: SessionUser,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<{ searchId: string; jobId: string }> {
  const conn = await requireSquareConnected(db);
  const config = parseSquareConfig(conn.config);
  const service = config.snapshot?.services.find((s) => s.variationId === input.serviceVariationId);
  if (!service) throw new AppError('VALIDATION', 'That service is not in your Square catalogue. Press Refresh if you added it recently.');
  if (input.teamMemberId && !service.teamMemberIds.includes(input.teamMemberId)) throw new AppError('VALIDATION', 'That barber doesn’t offer this service in Square.');
  if (!isMelbourneDate(input.fromDate)) throw new AppError('VALIDATION', 'Choose a start date.');
  if (input.fromDate < melbourneDateOf(now)) throw new AppError('VALIDATION', 'Choose today or a later day.');
  const days = Math.min(SQUARE_AVAILABILITY_MAX_DAYS, Math.max(1, Math.floor(input.days)));
  const id = newId();
  await db.insert(schema.squareAvailabilitySearches).values({
    id,
    environment: config.environment,
    params: { serviceVariationId: service.variationId, teamMemberId: input.teamMemberId ?? null, fromDate: input.fromDate, days, bookingId: null },
    requestedBy: user.id,
  });
  const job = await createTrackedJob({ type: 'square.availability', payload: { searchId: id }, projectId: null, refId: id, singletonKey: `square-availability:${id}` });
  return { searchId: id, jobId: job.id };
}

/** An availability search with Melbourne labels. */
export async function getAvailabilitySearch(id: string, db: Database = getDb(), now: Date = new Date()): Promise<AvailabilitySearchDto> {
  const row = await db.query.squareAvailabilitySearches.findFirst({ where: eq(schema.squareAvailabilitySearches.id, id) });
  if (!row) throw new AppError('NOT_FOUND', 'That search has expired. Search again.');
  const conn = await loadSquareConnection(db);
  const team = new Map((parseSquareConfig(conn?.config).snapshot?.teamMembers ?? []).map((t) => [t.id, t.displayName]));
  return {
    id: row.id,
    status: row.status,
    slots: row.slots.map((s) => {
      const start = new Date(s.startAt);
      const end = new Date(start.getTime() + s.durationMinutes * 60_000);
      return { startAt: s.startAt, dayKey: melbourneDateOf(start), dayLabel: dayLabel(start, now), startLabel: timeLabel(start), endLabel: timeLabel(end), teamMemberId: s.teamMemberId, teamMemberName: team.get(s.teamMemberId) ?? 'A team member', durationMinutes: s.durationMinutes };
    }),
    fetchedAt: row.fetchedAt?.toISOString() ?? null,
    fetchedLabel: row.fetchedAt ? timeLabel(row.fetchedAt) : null,
    stale: row.fetchedAt ? now.getTime() - row.fetchedAt.getTime() > AVAILABILITY_FRESH_MS : false,
    error: row.error,
  };
}
