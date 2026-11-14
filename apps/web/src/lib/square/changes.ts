import 'server-only';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  SQUARE_SELF_TEST_MIN_LEAD_MS,
  SQUARE_SLOT_FRESH_MS,
  bookingActions,
  bookingChangeIdempotencyKey,
  classifyVariation,
  effectiveLocationId,
  newId,
  parseSquareCapabilities,
  parseSquareConfig,
  selfTestAllowed,
  selfTestChangeId,
  tier1Status,
  writeGateReason,
  type BookingChangeKind,
  type BookingChangeRequest,
  type SquareConnectionConfig,
  type SquareTier1Status,
} from '@studio/core';
import { schema, type Database } from '@studio/db';
import type { SessionUser } from '../auth.js';
import { writeAudit } from '../audit.js';
import { getDb } from '../db.js';
import { createTrackedJob } from '../jobs.js';
import type { BookingChangeDto } from '../shared/square-dto.js';
import { toChangeDto } from './change-dto.js';
import { loadSquareConnection, requireSquareConnected } from './status.js';

/**
 * Booking changes from Studio Assistant (Square Tier 1, WP6b; design §4.5–4.6, §8). The web app only records what
 * the owner approved, after checking it against Studio Assistant's copy of Square (the checklist, the booking's
 * version, a fresh availability search); the worker's `square.booking_change` re-checks everything with Square just
 * before the one write. Nothing here calls Square.
 */

/** Options for tests only: `tier1Available` overrides `SQUARE_TIER1_AVAILABLE` (production never passes it). */
export interface ChangeOptions {
  tier1Available?: boolean | undefined;
  now?: Date | undefined;
}

type ConnectionRow = NonNullable<Awaited<ReturnType<typeof loadSquareConnection>>>;

/** The Tier 1 checklist for the stored connection. */
export function tier1For(conn: ConnectionRow, environment: 'sandbox' | 'production', opts: ChangeOptions = {}): SquareTier1Status {
  return tier1Status({ capabilities: parseSquareCapabilities(conn.capabilities), config: parseSquareConfig(conn.config), scopes: conn.scopes, environment, merchantId: conn.externalAccountId, available: opts.tier1Available });
}

/** Team member names from the snapshot. */
export function teamNames(config: SquareConnectionConfig): Map<string, string> {
  return new Map((config.snapshot?.teamMembers ?? []).map((t) => [t.id, t.displayName]));
}

/** A fresh slot from an availability search: same search, at most 5 minutes old, same start and barber. */
async function slotFromSearch(db: Database, input: { searchId: string; startAt: string; teamMemberId: string; environment: string; serviceVariationId?: string; bookingId?: string }, now: Date) {
  const search = await db.query.squareAvailabilitySearches.findFirst({ where: eq(schema.squareAvailabilitySearches.id, input.searchId) });
  if (!search || search.environment !== input.environment || search.status !== 'done' || !search.fetchedAt) throw new AppError('VALIDATION', 'Find free times again, then choose one.');
  if (now.getTime() - search.fetchedAt.getTime() > SQUARE_SLOT_FRESH_MS) throw new AppError('VALIDATION', 'Those free times are more than 5 minutes old. Check again, then choose a time.');
  if (input.serviceVariationId && search.params.serviceVariationId !== input.serviceVariationId) throw new AppError('VALIDATION', 'That time was found for a different service. Find free times again.');
  if (input.bookingId !== undefined && search.params.bookingId !== input.bookingId) throw new AppError('VALIDATION', 'That time was found for a different booking. Find free times again.');
  const slot = search.slots.find((s) => Date.parse(s.startAt) === Date.parse(input.startAt) && s.teamMemberId === input.teamMemberId);
  if (!slot) throw new AppError('VALIDATION', 'That time is not in the free times Square returned. Choose one of them.');
  return slot;
}

/** Refuses a second change to the same booking while one is still being made. */
async function refuseIfBusy(db: Database, bookingId: string): Promise<void> {
  const t = schema.squareBookingChanges;
  const busy = await db.select({ id: t.id }).from(t).where(and(eq(t.bookingId, bookingId), inArray(t.status, ['queued', 'checking', 'submitted']))).limit(1);
  if (busy.length) throw new AppError('CONFLICT', 'A change to this booking is already being made. Wait for it to finish.');
}

/** The body of `POST /api/appointments/changes`. `customerId` is Studio Assistant's id of a client copied from Square. */
export type BookingChangeInput =
  | { kind: 'create'; customerId: string; serviceVariationId: string; teamMemberId: string; startAt: string; availabilitySearchId: string; sellerNote?: string | undefined }
  | { kind: 'reschedule'; bookingId: string; startAt: string; teamMemberId: string; availabilitySearchId: string; expectedVersion: number }
  | { kind: 'cancel'; bookingId: string; expectedVersion: number };

/**
 * Records one owner-approved change and queues `square.booking_change` (design §8). Refused (422 with the plain
 * reason) unless the Tier 1 checklist is ready, the slot is in a search at most 5 minutes old with the same barber,
 * the service is bookable from here, and the booking is ACCEPTED, in the future and at the version the owner saw.
 */
export async function requestBookingChange(input: BookingChangeInput, user: SessionUser, db: Database = getDb(), opts: ChangeOptions = {}): Promise<{ change: BookingChangeDto; jobId: string }> {
  const now = opts.now ?? new Date();
  const conn = await requireSquareConnected(db);
  const config = parseSquareConfig(conn.config);
  const tier1 = tier1For(conn, config.environment, opts);
  const gate = writeGateReason({ tier1, selfTest: false });
  if (gate) throw new AppError('UNSUPPORTED', gate);
  const locationId = effectiveLocationId(config);
  if (!locationId || !conn.externalAccountId) throw new AppError('UNSUPPORTED', 'Choose your studio’s Square location in Settings → Integrations first.');
  const labelOf = (variationId: string | null) => {
    const s = config.snapshot?.services.find((x) => x.variationId === variationId);
    return s ? classifyVariation(s, config.snapshot?.businessProfile ?? null, config.serviceConfirmations, config.serviceWriteRejections) : null;
  };

  let request: BookingChangeRequest;
  let booking: typeof schema.bookings.$inferSelect | null = null;
  if (input.kind === 'create') {
    const customer = await db.query.customers.findFirst({ where: and(eq(schema.customers.id, input.customerId), isNull(schema.customers.deletedAt)) });
    if (!customer?.squareCustomerId || customer.squareEnvironment !== config.environment) throw new AppError('VALIDATION', 'Choose a client copied from Square. New clients are added in Square first.');
    const label = labelOf(input.serviceVariationId);
    if (!label) throw new AppError('VALIDATION', 'That service is not in your Square catalogue.');
    if (label.label !== 'bookable') throw new AppError('UNSUPPORTED', label.reason);
    const slot = await slotFromSearch(db, { searchId: input.availabilitySearchId, startAt: input.startAt, teamMemberId: input.teamMemberId, environment: config.environment, serviceVariationId: input.serviceVariationId }, now);
    if (Date.parse(slot.startAt) <= now.getTime()) throw new AppError('VALIDATION', 'That time has passed. Choose a later one.');
    request = {
      locationId,
      squareCustomerId: customer.squareCustomerId,
      serviceVariationId: slot.serviceVariationId,
      serviceVariationVersion: slot.serviceVariationVersion,
      teamMemberId: slot.teamMemberId,
      durationMinutes: slot.durationMinutes,
      startAt: new Date(slot.startAt).toISOString(),
      availabilitySearchId: input.availabilitySearchId,
      ...(input.sellerNote?.trim() ? { sellerNote: input.sellerNote.trim() } : {}),
    };
  } else {
    booking = (await db.query.bookings.findFirst({ where: eq(schema.bookings.id, input.bookingId) })) ?? null;
    if (!booking || booking.squareEnvironment !== config.environment || booking.locationId !== locationId) throw new AppError('NOT_FOUND', 'That booking is not in Studio Assistant’s copy of your Square bookings.');
    const actions = bookingActions({ tier1Ready: tier1.ready, owner: user.role === 'owner', status: booking.status, startAt: booking.startAt, missingFromSquare: booking.missingFromSquareAt !== null, serviceLabel: labelOf(booking.serviceVariationId)?.label ?? null, now });
    const allowed = input.kind === 'reschedule' ? actions.move : actions.cancel;
    if (!allowed.allowed) throw new AppError('UNSUPPORTED', allowed.reason ?? 'This booking cannot be changed from Studio Assistant.');
    if (booking.squareVersion !== input.expectedVersion) throw new AppError('CONFLICT', 'This booking changed in Square since you opened it. Close it and open it again.');
    await refuseIfBusy(db, booking.id);
    if (input.kind === 'reschedule') {
      const slot = await slotFromSearch(db, { searchId: input.availabilitySearchId, startAt: input.startAt, teamMemberId: input.teamMemberId, environment: config.environment, bookingId: booking.id }, now);
      if (Date.parse(slot.startAt) <= now.getTime()) throw new AppError('VALIDATION', 'That time has passed. Choose a later one.');
      request = {
        locationId,
        serviceVariationId: slot.serviceVariationId,
        serviceVariationVersion: slot.serviceVariationVersion,
        teamMemberId: slot.teamMemberId,
        durationMinutes: slot.durationMinutes,
        startAt: new Date(slot.startAt).toISOString(),
        expectedVersion: input.expectedVersion,
        availabilitySearchId: input.availabilitySearchId,
      };
    } else {
      request = { locationId, expectedVersion: input.expectedVersion, durationMinutes: booking.durationMinutes || undefined, startAt: booking.startAt.toISOString() };
    }
  }

  const id = newId();
  const [row] = await db
    .insert(schema.squareBookingChanges)
    .values({
      id,
      kind: input.kind,
      environment: config.environment,
      merchantId: conn.externalAccountId,
      bookingId: booking?.id ?? null,
      squareBookingId: booking?.squareBookingId ?? null,
      request,
      idempotencyKey: bookingChangeIdempotencyKey(id),
      requestedBy: user.id,
    })
    .returning();
  if (!row) throw new AppError('INTERNAL', 'The change could not be recorded.');
  await writeAudit({ userId: user.id, action: 'booking.change_requested', entityType: 'square_booking_change', entityId: id, data: { kind: input.kind, environment: config.environment, startAt: request.startAt ?? null } });
  const job = await createTrackedJob({ type: 'square.booking_change', payload: { changeId: id }, projectId: null, refId: id, singletonKey: `square-change:${id}` });
  return { change: toChangeDto(row, teamNames(config), now), jobId: job.id };
}

/**
 * A change and its progress. A change whose job was cancelled or failed before the worker picked it up (so the
 * worker never saw it) is closed here as withdrawn, so it never shows "waiting" for ever.
 */
export async function getBookingChange(id: string, db: Database = getDb(), now: Date = new Date()): Promise<BookingChangeDto> {
  const t = schema.squareBookingChanges;
  let row = (await db.select().from(t).where(eq(t.id, id)).limit(1))[0];
  if (!row) throw new AppError('NOT_FOUND', 'That change no longer exists.');
  if (row.status === 'queued') {
    const j = schema.jobs;
    const job = (await db.select({ status: j.status }).from(j).where(and(eq(j.type, 'square.booking_change'), eq(j.refId, id))).orderBy(desc(j.createdAt)).limit(1))[0];
    if (job && (job.status === 'cancelled' || job.status === 'failed')) {
      row = (await db.update(t).set({ status: 'cancelled', statusMessage: 'Stopped before anything was sent to Square.', finishedAt: now, updatedAt: now }).where(and(eq(t.id, id), eq(t.status, 'queued'))).returning())[0] ?? row;
    }
  }
  const conn = await loadSquareConnection(db);
  return toChangeDto(row, teamNames(parseSquareConfig(conn?.config)), now);
}

/** Withdraws a change that has not started (`queued` → `cancelled`); once checking has begun it completes. */
export async function withdrawBookingChange(id: string, user: SessionUser, db: Database = getDb(), now: Date = new Date()): Promise<BookingChangeDto> {
  const t = schema.squareBookingChanges;
  const updated = (await db.update(t).set({ status: 'cancelled', statusMessage: 'Withdrawn before anything was sent to Square.', finishedAt: now, updatedAt: now }).where(and(eq(t.id, id), eq(t.status, 'queued'))).returning())[0];
  if (!updated) {
    const exists = (await db.select({ id: t.id }).from(t).where(eq(t.id, id)).limit(1))[0];
    if (!exists) throw new AppError('NOT_FOUND', 'That change no longer exists.');
    throw new AppError('CONFLICT', 'Studio Assistant has already started this change, so it will finish.');
  }
  await writeAudit({ userId: user.id, action: 'booking.change_cancelled', entityType: 'square_booking_change', entityId: id, data: { kind: updated.kind } });
  const conn = await loadSquareConnection(db);
  return toChangeDto(updated, teamNames(parseSquareConfig(conn?.config)), now);
}

/** Changes made to one booking from Studio Assistant, newest first. */
export async function changesForBooking(db: Database, bookingId: string, config: SquareConnectionConfig, now: Date = new Date()): Promise<BookingChangeDto[]> {
  const t = schema.squareBookingChanges;
  const rows = await db.select().from(t).where(eq(t.bookingId, bookingId)).orderBy(desc(t.createdAt)).limit(20);
  const names = teamNames(config);
  return rows.map((r) => toChangeDto(r, names, now));
}

/** The body of `POST /api/integrations/square/self-test`. */
export interface SelfTestInput {
  customerId: string;
  serviceVariationId: string;
  teamMemberId: string;
  startAt: string;
  availabilitySearchId: string;
  acknowledgeLive: boolean;
}

/**
 * Starts the owner-approved self-test (design §4.5.1): never automatic. Needs checklist lines 1–3, no test already
 * running, a fresh slot at least 48 hours ahead, and on live Square the owner's tick that these are real bookings.
 * The three step rows are created now with fixed ids, so the test resumes after a crash.
 */
export async function requestSelfTest(input: SelfTestInput, user: SessionUser, db: Database = getDb(), opts: ChangeOptions = {}): Promise<{ selfTestId: string; jobId: string }> {
  const now = opts.now ?? new Date();
  const conn = await requireSquareConnected(db);
  const config = parseSquareConfig(conn.config);
  const tier1 = tier1For(conn, config.environment, opts);
  if (!selfTestAllowed(tier1)) throw new AppError('UNSUPPORTED', writeGateReason({ tier1, selfTest: true }) ?? 'The self-test can run once the first three checklist lines are ticked.');
  const locationId = effectiveLocationId(config);
  if (!locationId || !conn.externalAccountId) throw new AppError('UNSUPPORTED', 'Choose your studio’s Square location in Settings → Integrations first.');
  const t = schema.squareBookingChanges;
  const running = await db.select({ id: t.id }).from(t).where(and(isNotNull(t.selfTestId), inArray(t.status, ['queued', 'checking', 'submitted']))).limit(1);
  if (running.length) throw new AppError('CONFLICT', 'A self-test is already running.');
  if (config.environment === 'production' && !input.acknowledgeLive) throw new AppError('VALIDATION', 'Tick “I understand these are real bookings in Square” first.');
  const customer = await db.query.customers.findFirst({ where: and(eq(schema.customers.id, input.customerId), isNull(schema.customers.deletedAt)) });
  if (!customer?.squareCustomerId || customer.squareEnvironment !== config.environment) throw new AppError('VALIDATION', 'Choose a client copied from Square (yourself is best).');
  const service = config.snapshot?.services.find((s) => s.variationId === input.serviceVariationId);
  if (!service || classifyVariation(service, config.snapshot?.businessProfile ?? null, config.serviceConfirmations, config.serviceWriteRejections).label !== 'bookable') {
    throw new AppError('VALIDATION', 'Choose a service you have confirmed has no no-show fee.');
  }
  const slot = await slotFromSearch(db, { searchId: input.availabilitySearchId, startAt: input.startAt, teamMemberId: input.teamMemberId, environment: config.environment, serviceVariationId: service.variationId }, now);
  if (Date.parse(slot.startAt) - now.getTime() < SQUARE_SELF_TEST_MIN_LEAD_MS) throw new AppError('VALIDATION', 'Choose a time at least 2 days ahead, so no client is offered the test time at short notice.');

  const selfTestId = newId();
  const common = { environment: config.environment, merchantId: conn.externalAccountId, selfTestId, requestedBy: user.id };
  const step = (kind: BookingChangeKind, request: BookingChangeRequest) => {
    const id = selfTestChangeId(selfTestId, kind);
    return { id, kind, request, idempotencyKey: bookingChangeIdempotencyKey(id), ...common };
  };
  await db.transaction(async (tx) => {
    await tx.insert(t).values([
      step('create', {
        locationId,
        squareCustomerId: customer.squareCustomerId ?? undefined,
        serviceVariationId: slot.serviceVariationId,
        serviceVariationVersion: slot.serviceVariationVersion,
        teamMemberId: slot.teamMemberId,
        durationMinutes: slot.durationMinutes,
        startAt: new Date(slot.startAt).toISOString(),
        availabilitySearchId: input.availabilitySearchId,
        sellerNote: 'Studio Assistant self-test: this booking is moved and cancelled straight away.',
      }),
      // Filled in by the worker just before each step runs (the move's free time, the booking's current version).
      step('reschedule', { locationId }),
      step('cancel', { locationId }),
    ]);
    const c = schema.integrationConnections;
    await tx
      .update(c)
      .set({ capabilities: sql`${c.capabilities} || ${JSON.stringify({ selfTestStatus: 'running', selfTestId, selfTestFailure: '' })}::jsonb`, updatedAt: now })
      .where(eq(c.id, conn.id));
  });
  await writeAudit({ userId: user.id, action: 'integration.square.self_test_requested', entityType: 'integration_connection', entityId: conn.id, data: { selfTestId, environment: config.environment, startAt: slot.startAt } });
  const job = await createTrackedJob({ type: 'square.self_test', payload: { selfTestId }, projectId: null, refId: selfTestId, singletonKey: `square-self-test:${selfTestId}` });
  return { selfTestId, jobId: job.id };
}

/** The owner's answer to "Did the client receive a confirmation from Square for the test booking?" (design §4.5.1). */
export async function answerSelfTestNotification(answer: 'yes' | 'no' | 'unknown', db: Database = getDb()): Promise<void> {
  const conn = await requireSquareConnected(db);
  const caps = parseSquareCapabilities(conn.capabilities);
  if (caps.selfTestStatus !== 'passed' && caps.selfTestStatus !== 'failed') throw new AppError('CONFLICT', 'Run the self-test first.');
  const c = schema.integrationConnections;
  await db
    .update(c)
    .set({ capabilities: sql`${c.capabilities} || ${JSON.stringify({ squareNotifiesApiBookings: answer })}::jsonb`, updatedAt: new Date() })
    .where(eq(c.id, conn.id));
}
