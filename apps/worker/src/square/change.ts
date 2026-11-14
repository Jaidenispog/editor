import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  CancelledError,
  NonRetryableError,
  SQUARE_UNKNOWN_GIVE_UP_MS,
  availabilityRange,
  bookingChangeStatusWords,
  classifyVariation,
  confirmedSentence,
  effectiveLocationId,
  melbourneDateOf,
  melbourneDayRange,
  nearestSlots,
  parseSquareCapabilities,
  parseSquareConfig,
  tier1Status,
  writeGateReason,
  type BookingChangeFreshSlot,
  type BookingChangeRequest,
  type BookingChangeStatus,
  type SquareEnvironmentName,
  type SquareServiceSnapshot,
} from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { loadConnection, type ConnectionRow } from '../lib/connections.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { SquareApiError, isMalformedBooking, type SquareApi, type SquareBookingData, type SquareSlotData, type SquareWriteSegment } from './api.js';
import { markSquareNeedsReauth, openSquare, type SquareSession } from './client.js';
import { SquareConnectionChangedError, upsertBooking } from './map.js';

/**
 * `square.booking_change` (design §6.3): the only code that writes to Square. One owner-approved change row goes
 * claim → gate → plan → service → booking → availability re-check → `submitted_at` → send → result:
 *
 * - Nothing is sent unless, at that moment, Square still allows seller-level writes, the service is still confirmed
 *   free of no-show fees at Square's current version, the booking still has the version the owner saw, and Square
 *   still offers the exact time with the same barber.
 * - `submitted_at` is set by a conditional update, inside a transaction that holds the `square` connection row
 *   `FOR SHARE` and checks it is still the account and environment the owner approved, immediately before the call;
 *   the call itself is made under the same lock after the same check, so a disconnect in between sends nothing.
 * - A retry after a time-out re-sends the same body with the same idempotency key, so Square applies it once.
 *   After the last attempt the change is `unknown` until a sync finds it (`settleUnknownChanges`).
 * - Square's refusals are stored verbatim; a refusal for the plan or permissions pauses booking changes, and an
 *   unexplained refusal for a service marks it "Book in Square" until the owner confirms it again.
 */

/** A `square_booking_changes` row. */
export type BookingChangeRow = typeof schema.squareBookingChanges.$inferSelect;

/** Options for {@link runBookingChange}. */
export interface BookingChangeOptions {
  /** Tests only: overrides `SQUARE_TIER1_AVAILABLE` (production code never passes it). */
  tier1Available?: boolean | undefined;
  /** Clock (tests). */
  now?: (() => Date) | undefined;
}

/** A submitted change still without an answer after this long is treated as `unknown` by the next sync. */
export const SUBMITTED_STALE_MS = 10 * 60_000;
/** A Square booking created up to this long before `submitted_at` still counts as ours (clock differences). */
const CREATED_SLACK_MS = 5 * 60_000;

const DISCONNECTED_MESSAGE = 'Square was disconnected or switched to another account since you approved this. Nothing was sent.';
const UNKNOWN_MESSAGE = 'Square may or may not have made this change. Check Square before trying again; Studio Assistant checks again at the next sync.';
const NOT_FOUND_LATER = 'Not found in Square — it was probably not made.';

const table = schema.squareBookingChanges;

/** The segment a change sends, fixed at approval (copied from the slot Square returned). */
function segmentOf(req: BookingChangeRequest): SquareWriteSegment {
  return { teamMemberId: req.teamMemberId ?? '', serviceVariationId: req.serviceVariationId ?? '', serviceVariationVersion: req.serviceVariationVersion ?? null, durationMinutes: req.durationMinutes ?? 0 };
}

/** True when the stored connection is still the live one the change was approved for. */
function connectionMatches(conn: Pick<ConnectionRow, 'status' | 'externalAccountId' | 'config'> | null | undefined, row: Pick<BookingChangeRow, 'merchantId' | 'environment'>, serverEnvironment: SquareEnvironmentName): boolean {
  if (!conn || (conn.status !== 'connected' && conn.status !== 'error')) return false;
  const environment = parseSquareConfig(conn.config).environment;
  return conn.externalAccountId === row.merchantId && environment === row.environment && environment === serverEnvironment;
}

async function loadChange(ctx: Pick<WorkerContext, 'db'>, id: string): Promise<BookingChangeRow | null> {
  return (await ctx.db.select().from(table).where(eq(table.id, id)).limit(1))[0] ?? null;
}

/**
 * Moves a change that the worker is still working on (`checking` or `submitted`) to a final status. Conditional, so
 * a row another attempt already finished is left alone; returns the row as it now stands.
 */
async function finish(
  ctx: Pick<WorkerContext, 'db'>,
  row: BookingChangeRow,
  status: BookingChangeStatus,
  message: string,
  patch: Partial<Pick<BookingChangeRow, 'httpStatus' | 'errorCode' | 'squareResponse' | 'freshSlots' | 'squareBookingId' | 'bookingId'>> = {},
  now: Date = new Date(),
): Promise<BookingChangeRow> {
  const updated = await ctx.db
    .update(table)
    .set({ status, statusMessage: message.slice(0, 1000), ...patch, finishedAt: now, updatedAt: now })
    .where(and(eq(table.id, row.id), inArray(table.status, ['checking', 'submitted'])))
    .returning();
  return updated[0] ?? (await loadChange(ctx, row.id)) ?? row;
}

/** Pauses booking changes with a reason (the card shows "Paused: …") and audits it once per change of reason. */
export async function suspendSquareWrites(ctx: WorkerContext, reason: 'plan' | 'scopes' | 'forbidden', extra: Record<string, unknown> = {}): Promise<void> {
  const t = schema.integrationConnections;
  const rows = await ctx.db
    .update(t)
    .set({ capabilities: sql`${t.capabilities} || ${JSON.stringify({ writesSuspendedReason: reason, ...extra })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(t.provider, 'square'), sql`coalesce(${t.capabilities}->>'writesSuspendedReason', '') <> ${reason}`))
    .returning({ id: t.id });
  if (rows.length) await writeWorkerAudit(ctx.db, { userId: null, action: 'integration.square.writes_suspended', entityType: 'integration_connection', entityId: rows[0]?.id ?? null, data: { reason } }, ctx.logger);
}

/** Marks a service "Book in Square" after Square refused a write for it without a clear reason (design §4.3). */
async function recordServiceRejection(ctx: Pick<WorkerContext, 'db'>, variationId: string, changeId: string, code: string, now: Date): Promise<void> {
  const t = schema.integrationConnections;
  const entry = JSON.stringify({ [variationId]: { changeId, code, at: now.toISOString() } });
  await ctx.db
    .update(t)
    .set({ config: sql`jsonb_set(${t.config}, '{serviceWriteRejections}', coalesce(${t.config}->'serviceWriteRejections', '{}'::jsonb) || ${entry}::jsonb)`, updatedAt: now })
    .where(eq(t.provider, 'square'));
}

/** Converts a slot to the alternatives stored on the change. */
function freshFrom(slots: SquareSlotData[], requestedAt: string): BookingChangeFreshSlot[] {
  const flat = slots.flatMap((s) => (s.segments[0] ? [{ startAt: new Date(s.startAt).toISOString(), teamMemberId: s.segments[0].teamMemberId, durationMinutes: s.segments[0].durationMinutes }] : []));
  return nearestSlots(flat, requestedAt);
}

/**
 * What a failed read (before anything was sent) does: retried while attempts remain; then `failed`, with nothing
 * sent. A refused token asks the owner to reconnect; a refusal for permissions or the plan is `not_allowed`.
 */
async function readFailure(ctx: WorkerContext, run: Pick<TrackedRun, 'willRetry'>, row: BookingChangeRow, err: unknown, now: Date): Promise<BookingChangeRow> {
  if (err instanceof CancelledError) throw err;
  if (err instanceof SquareConnectionChangedError) return finish(ctx, row, 'not_allowed', DISCONNECTED_MESSAGE, {}, now);
  if (err instanceof NonRetryableError && err.code === 'UNAUTHORISED') return finish(ctx, row, 'not_allowed', 'Square needs you to reconnect. Nothing was sent.', {}, now);
  if (err instanceof SquareApiError) {
    if (err.kind === 'reauth') {
      await markSquareNeedsReauth(ctx, 'Square needs you to reconnect.');
      return finish(ctx, row, 'not_allowed', 'Square needs you to reconnect. Nothing was sent.', { httpStatus: err.statusCode, errorCode: err.code }, now);
    }
    if (err.kind === 'not_allowed') return finish(ctx, row, 'not_allowed', `${err.message} Nothing was sent.`, { httpStatus: err.statusCode, errorCode: err.code }, now);
    if (err.kind === 'invalid') return finish(ctx, row, 'failed', `${err.message} Nothing was sent.`, { httpStatus: err.statusCode, errorCode: err.code }, now);
  }
  if (run.willRetry && !(err instanceof NonRetryableError)) throw err;
  return finish(ctx, row, 'failed', 'Square didn’t answer while Studio Assistant was checking. Nothing was sent; try again.', {}, now);
}

/**
 * Runs one booking change (design §6.3) and returns the row as it stands afterwards (null when it does not exist).
 * Transient failures are rethrown while the queue will retry (the row keeps its state, so the retry continues where
 * this attempt stopped); after the last attempt the row is final.
 */
export async function runBookingChange(ctx: WorkerContext, run: TrackedRun, changeId: string, opts: BookingChangeOptions = {}): Promise<BookingChangeRow | null> {
  const clock = opts.now ?? (() => new Date());
  // 1. Claim: only a change not yet sent; a change already sent goes straight to the re-send with the same key.
  const claimed = (
    await ctx.db
      .update(table)
      .set({ status: 'checking', updatedAt: clock() })
      .where(and(eq(table.id, changeId), inArray(table.status, ['queued', 'checking']), isNull(table.submittedAt)))
      .returning()
  )[0];
  if (!claimed) {
    const current = await loadChange(ctx, changeId);
    if (current?.status === 'submitted') return resend(ctx, run, current, clock);
    return current;
  }
  let row = claimed;
  const req = row.request;

  // 2. Gate: the live connection is the approved account and environment, and the checklist allows the change.
  const conn = await loadConnection(ctx.db, 'square');
  if (!connectionMatches(conn, row, ctx.env.SQUARE_ENVIRONMENT) || !conn) return finish(ctx, row, 'not_allowed', DISCONNECTED_MESSAGE, {}, clock());
  const config = parseSquareConfig(conn.config);
  const tier1 = tier1Status({ capabilities: parseSquareCapabilities(conn.capabilities), config, scopes: conn.scopes, environment: row.environment, merchantId: conn.externalAccountId, available: opts.tier1Available });
  const gate = writeGateReason({ tier1, selfTest: row.selfTestId !== null, kind: row.kind });
  if (gate) return finish(ctx, row, 'not_allowed', `${gate} Nothing was sent.`, {}, clock());
  if (req.locationId !== effectiveLocationId(config) || ((row.kind === 'create' || row.kind === 'reschedule') && (!req.startAt || !req.teamMemberId || !req.serviceVariationId || !req.durationMinutes))) {
    return finish(ctx, row, 'not_allowed', 'This change no longer matches your Square location or is missing details. Nothing was sent.', {}, clock());
  }
  if ((row.kind === 'reschedule' || row.kind === 'cancel') && (!row.squareBookingId || req.expectedVersion === undefined)) {
    return finish(ctx, row, 'not_allowed', 'This change is missing the booking it is for. Nothing was sent.', {}, clock());
  }
  if (row.kind === 'create' && !req.squareCustomerId) return finish(ctx, row, 'not_allowed', 'This booking has no client. Nothing was sent.', {}, clock());

  let s: SquareSession;
  try {
    const opened = await openSquare(ctx, run);
    if ('skip' in opened) return finish(ctx, row, 'not_allowed', `${opened.skip} Nothing was sent.`, {}, clock());
    s = opened;
  } catch (err) {
    return readFailure(ctx, run, row, err, clock());
  }

  try {
    // 3. Plan: Square must still allow seller-level writes.
    run.checkCancelled();
    await run.progress(0.2, 'Checking your Square plan…');
    const profile = await s.api.getBusinessProfile();
    if (!profile?.supportSellerLevelWrites) {
      await suspendSquareWrites(ctx, 'plan', { sellerLevelWrites: false });
      return finish(ctx, row, 'not_allowed', 'Your Square plan no longer allows apps to change bookings. Nothing was sent.', {}, clock());
    }

    // 4. Service: fresh from the catalogue, still bookable from here at the version the owner confirmed.
    if (row.kind === 'create' || row.kind === 'reschedule') {
      await run.progress(0.35, 'Checking the service in Square…');
      const fresh = await s.api.getServiceVariation(req.serviceVariationId ?? '');
      if (!fresh) return finish(ctx, row, 'not_allowed', 'This service is no longer in Square. Nothing was sent.', {}, clock());
      const known = config.snapshot?.services.find((x) => x.variationId === fresh.variationId);
      const snap: SquareServiceSnapshot = {
        itemId: known?.itemId ?? '',
        itemName: known?.itemName ?? '',
        variationId: fresh.variationId,
        variationName: known?.variationName ?? '',
        version: fresh.version,
        durationMinutes: fresh.durationMinutes,
        price: known?.price ?? null,
        availableForBooking: fresh.availableForBooking,
        teamMemberIds: fresh.teamMemberIds,
        archived: fresh.archived || (known?.archived ?? false),
        noShowFeeSeen: fresh.noShowFeeSeen,
      };
      const label = classifyVariation(snap, profile, config.serviceConfirmations, config.serviceWriteRejections);
      if (label.label !== 'bookable') return finish(ctx, row, 'not_allowed', `${label.reason} Nothing was sent.`, {}, clock());
      if (req.serviceVariationVersion && req.serviceVariationVersion !== fresh.version) {
        return finish(ctx, row, 'not_allowed', 'This service changed in Square after you chose the time. Check it under Services and choose the time again. Nothing was sent.', {}, clock());
      }
      if (!fresh.teamMemberIds.includes(req.teamMemberId ?? '')) return finish(ctx, row, 'not_allowed', 'That barber no longer offers this service in Square. Nothing was sent.', {}, clock());
    }

    // 5. Booking: still the version the owner saw, still accepted and still in the future.
    let current: SquareBookingData | null = null;
    if (row.kind === 'reschedule' || row.kind === 'cancel') {
      await run.progress(0.5, 'Checking the booking in Square…');
      const fresh = await s.api.getBooking(row.squareBookingId ?? '');
      // Square still has a booking it sent in a shape we can't read, but its version can't be checked: never write.
      if (isMalformedBooking(fresh)) return finish(ctx, row, 'failed', 'Square’s copy of this booking couldn’t be read, so it can’t be checked. Change it in Square. Nothing was sent.', {}, clock());
      current = fresh;
      if (!current) return finish(ctx, row, 'changed_in_square', 'Square no longer has this booking. Nothing was sent.', {}, clock());
      await upsertBooking(ctx.db, current, s, s.config.snapshot, clock());
      if (current.version !== req.expectedVersion || current.status !== 'ACCEPTED' || Date.parse(current.startAt) <= clock().getTime()) {
        return finish(ctx, row, 'changed_in_square', 'Someone changed this booking in Square. The latest is shown; try again if you still want to change it. Nothing was sent.', { squareResponse: current.raw }, clock());
      }
    }

    // 6. Availability re-check: Square must still offer the exact time with the same barber.
    if (row.kind === 'create' || row.kind === 'reschedule') {
      await run.progress(0.65, 'Checking the time is still free…');
      const startAt = req.startAt ?? '';
      const range = availabilityRange(melbourneDateOf(new Date(startAt)), 1);
      const slots =
        row.kind === 'create'
          ? await s.api.searchAvailability({ startAt: range.start.toISOString(), endAt: range.end.toISOString(), locationId: req.locationId, serviceVariationId: req.serviceVariationId ?? '', teamMemberId: req.teamMemberId ?? null })
          : await s.api.searchAvailabilityForBooking({ startAt: range.start.toISOString(), endAt: range.end.toISOString(), bookingId: row.squareBookingId ?? '' });
      const target = Date.parse(startAt);
      const free = slots.some((x) => Date.parse(x.startAt) === target && x.segments[0]?.teamMemberId === req.teamMemberId);
      if (!free) return finish(ctx, row, 'slot_unavailable', 'That time was just taken. Nothing was sent; choose another time.', { freshSlots: freshFrom(slots, startAt) }, clock());
    }
  } catch (err) {
    return readFailure(ctx, run, row, err, clock());
  }

  // 7. The non-repeatable marker, under the connection row's lock: refused after a disconnect or a switch.
  run.checkCancelled();
  const marked = await ctx.db.transaction(async (tx) => {
    const t = schema.integrationConnections;
    const live = (await tx.select({ status: t.status, externalAccountId: t.externalAccountId, config: t.config }).from(t).where(eq(t.provider, 'square')).limit(1).for('share'))[0];
    if (!connectionMatches(live, row, ctx.env.SQUARE_ENVIRONMENT)) return 'disconnected' as const;
    return (await tx.update(table).set({ status: 'submitted', submittedAt: clock(), updatedAt: clock() }).where(and(eq(table.id, row.id), eq(table.status, 'checking'), isNull(table.submittedAt))).returning())[0] ?? null;
  });
  if (marked === 'disconnected') return finish(ctx, row, 'not_allowed', DISCONNECTED_MESSAGE, {}, clock());
  if (!marked) return loadChange(ctx, row.id);
  row = marked;
  return send(ctx, run, s, row, clock, true);
}

/** A change Square may already have: re-sent with the same idempotency key, if the connection is still the approved one. */
async function resend(ctx: WorkerContext, run: TrackedRun, row: BookingChangeRow, clock: () => Date): Promise<BookingChangeRow> {
  const conn = await loadConnection(ctx.db, 'square');
  if (!connectionMatches(conn, row, ctx.env.SQUARE_ENVIRONMENT)) return markUnknown(ctx, row, 'Square was disconnected before Studio Assistant could confirm this change. Check Square.', clock(), false);
  let s: SquareSession;
  try {
    const opened = await openSquare(ctx, run);
    if ('skip' in opened) return markUnknown(ctx, row, `${opened.skip} Check Square for this change.`, clock(), false);
    s = opened;
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    if (run.willRetry && !(err instanceof NonRetryableError)) throw err;
    return markUnknown(ctx, row, UNKNOWN_MESSAGE, clock(), true);
  }
  return send(ctx, run, s, row, clock, false);
}

/**
 * 7–8: the one write call and what its answer means. The call is made inside a transaction that holds the `square`
 * connection row `FOR SHARE` and re-checks it is still the approved account and environment, so a disconnect (which
 * takes the row `FOR UPDATE`) either lands before the check, and nothing is sent, or waits for the call to finish
 * (at most the SDK's time limit).
 */
async function send(ctx: WorkerContext, run: TrackedRun, s: SquareSession, row: BookingChangeRow, clock: () => Date, firstSend: boolean): Promise<BookingChangeRow> {
  const req = row.request;
  await run.progress(0.8, 'Sending to Square…');
  const sent = await ctx.db.transaction(async (tx) => {
    const t = schema.integrationConnections;
    const live = (await tx.select({ status: t.status, externalAccountId: t.externalAccountId, config: t.config }).from(t).where(eq(t.provider, 'square')).limit(1).for('share'))[0];
    if (!connectionMatches(live, row, ctx.env.SQUARE_ENVIRONMENT)) return { gone: true as const };
    try {
      return { gone: false as const, booking: await write(s.api, row) };
    } catch (err) {
      return { gone: false as const, err };
    }
  });
  if (sent.gone) {
    // A first send never reached Square; a re-send may follow an earlier send whose answer was lost.
    return firstSend ? finish(ctx, row, 'not_allowed', DISCONNECTED_MESSAGE, {}, clock()) : markUnknown(ctx, row, 'Square was disconnected before Studio Assistant could confirm this change. Check Square.', clock(), false);
  }
  if (firstSend) {
    await writeWorkerAudit(ctx.db, { userId: row.requestedBy, action: 'booking.change_submitted', entityType: 'square_booking_change', entityId: row.id, data: { kind: row.kind, environment: row.environment, startAt: req.startAt ?? null, selfTest: row.selfTestId !== null } }, ctx.logger);
  }
  let booking: SquareBookingData;
  try {
    if ('err' in sent) throw sent.err;
    booking = sent.booking;
  } catch (err) {
    const transient = !(err instanceof SquareApiError) || err.kind === 'transient' || err.kind === 'rate_limited';
    if (transient) {
      // Square may have made it: the queue retries with the same key; after the last attempt it is unknown.
      if (run.willRetry) throw err;
      return markUnknown(ctx, row, UNKNOWN_MESSAGE, clock(), true);
    }
    return refused(ctx, row, err, clock());
  }
  return confirmChange(ctx, s, row, booking, clock(), req);
}

function write(api: SquareApi, row: BookingChangeRow): Promise<SquareBookingData> {
  const req = row.request;
  if (row.kind === 'create') {
    return api.createBooking({ idempotencyKey: row.idempotencyKey, locationId: req.locationId, startAt: req.startAt ?? '', customerId: req.squareCustomerId ?? '', sellerNote: req.sellerNote ?? null, segment: segmentOf(req) });
  }
  if (row.kind === 'reschedule') {
    return api.updateBooking({ bookingId: row.squareBookingId ?? '', idempotencyKey: row.idempotencyKey, version: req.expectedVersion ?? 0, startAt: req.startAt ?? '', segment: segmentOf(req) });
  }
  return api.cancelBooking({ bookingId: row.squareBookingId ?? '', idempotencyKey: row.idempotencyKey, version: req.expectedVersion ?? 0 });
}

/** Square answered with the booking: the change is confirmed, mirrored, and checked for a double booking. */
async function confirmChange(ctx: WorkerContext, s: SquareSession, row: BookingChangeRow, b: SquareBookingData, now: Date, req: BookingChangeRequest): Promise<BookingChangeRow> {
  let bookingId: string | null = null;
  let overlapWith: string | null = null;
  try {
    await upsertBooking(ctx.db, b, s, s.config.snapshot, now);
    bookingId = (await ctx.db.query.bookings.findFirst({ where: eq(schema.bookings.squareBookingId, b.id), columns: { id: true } }))?.id ?? null;
    if (row.kind !== 'cancel') overlapWith = await doubleBookingCheck(ctx, s, b, now);
  } catch (err) {
    // Square made the change; only the local copy could not be refreshed (the next sync does it).
    if (err instanceof CancelledError) throw err;
    ctx.logger.warn({ changeId: row.id, err: err instanceof Error ? err.message : String(err) }, 'booking change confirmed but the local copy was not refreshed');
  }
  const message = overlapWith ? `${confirmedSentence(row.kind)} Square accepted this, but it overlaps another booking for ${overlapWith}. Check Square.` : confirmedSentence(row.kind);
  const done = await finish(ctx, row, 'confirmed', message, { squareBookingId: b.id, bookingId, squareResponse: b.raw, httpStatus: 200, errorCode: null }, now);
  await writeWorkerAudit(ctx.db, { userId: row.requestedBy, action: 'booking.change_confirmed', entityType: 'square_booking_change', entityId: row.id, data: { kind: row.kind, environment: row.environment, startAt: req.startAt ?? b.startAt, overlap: overlapWith !== null } }, ctx.logger);
  return done;
}

/**
 * Seller-level writes may double-book a barber (`APPOINTMENTS_ALL_WRITE`, spec), so after Square confirmed a create
 * or move, that day is read again and the local copy is checked for another accepted booking of the same barber
 * overlapping it. Returns the barber's name when there is one.
 */
async function doubleBookingCheck(ctx: WorkerContext, s: SquareSession, b: SquareBookingData, now: Date): Promise<string | null> {
  const day = melbourneDayRange(melbourneDateOf(new Date(b.startAt)));
  for (const other of (await s.api.listBookings({ locationId: b.locationId || null, startAtMin: day.start.toISOString(), startAtMax: day.end.toISOString() })).bookings) {
    await upsertBooking(ctx.db, other, s, s.config.snapshot, now);
  }
  const teamMemberId = b.segments[0]?.teamMemberId;
  if (!teamMemberId) return null;
  const start = new Date(b.startAt);
  const end = new Date(start.getTime() + b.segments.reduce((sum, x) => sum + x.durationMinutes + x.intermissionMinutes, 0) * 60_000);
  const t = schema.bookings;
  const clash = await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.squareEnvironment, s.environment), eq(t.status, 'ACCEPTED'), eq(t.teamMemberId, teamMemberId), ne(t.squareBookingId, b.id), lt(t.startAt, end), gt(t.endAt, start)))
    .limit(1);
  if (!clash.length) return null;
  return s.config.snapshot?.teamMembers.find((m) => m.id === teamMemberId)?.displayName || 'this barber';
}

/** Square refused the write (4xx): stored verbatim, with the module's reaction (design §6.3 step 8). */
async function refused(ctx: WorkerContext, row: BookingChangeRow, err: unknown, now: Date): Promise<BookingChangeRow> {
  const e = err instanceof SquareApiError ? err : null;
  const detail = e?.errors[0]?.detail;
  const verbatim = { httpStatus: e?.statusCode ?? null, errorCode: e?.code ?? 'UNKNOWN', squareResponse: (e?.body && typeof e.body === 'object' ? e.body : { errors: e?.errors ?? [] }) as Record<string, unknown> };
  const said = detail ? ` Square said: “${detail.slice(0, 400)}”` : '';
  let done: BookingChangeRow;
  if (e?.kind === 'reauth') {
    await markSquareNeedsReauth(ctx, 'Square needs you to reconnect.');
    done = await finish(ctx, row, 'rejected', `Square needs you to reconnect. The change was not made.${said}`, verbatim, now);
  } else if (e?.kind === 'not_allowed') {
    const reason = e.code === 'INSUFFICIENT_SCOPES' ? 'scopes' : e.code === 'MERCHANT_SUBSCRIPTION_NOT_FOUND' || e.errors[0]?.category === 'MERCHANT_SUBSCRIPTION_ERROR' ? 'plan' : 'forbidden';
    await suspendSquareWrites(ctx, reason);
    done = await finish(ctx, row, 'not_allowed', `Square didn’t allow this, so booking changes from Studio Assistant are paused.${said}`, verbatim, now);
  } else if (e?.kind === 'conflict' || (e?.kind === 'not_found' && row.kind !== 'create')) {
    if (row.squareBookingId) await enqueueTracked(ctx, 'square.refresh', { entity: 'booking', squareId: row.squareBookingId }, { singletonKey: `square-refresh:booking:${row.squareBookingId}` });
    done = await finish(ctx, row, 'changed_in_square', `The booking changed in Square, so the change was not made.${said}`, verbatim, now);
  } else {
    // Only an invalid request (400/422) for a booking with a service is taken as Square refusing that service
    // (design §6.3). A 404 on a create (an unknown client or location, say) is not about the service.
    const marksService = e?.kind === 'invalid' && (row.kind === 'create' || row.kind === 'reschedule') && Boolean(row.request.serviceVariationId);
    if (marksService) await recordServiceRejection(ctx, row.request.serviceVariationId ?? '', row.id, e?.code ?? 'UNKNOWN', now);
    done = await finish(ctx, row, 'rejected', `Square refused the change.${said}${marksService ? ' This service is now marked “Book in Square” until you confirm it again.' : ''}`, verbatim, now);
  }
  await writeWorkerAudit(ctx.db, { userId: row.requestedBy, action: 'booking.change_rejected', entityType: 'square_booking_change', entityId: row.id, data: { kind: row.kind, code: e?.code ?? 'UNKNOWN', httpStatus: e?.statusCode ?? null } }, ctx.logger);
  return done;
}

/** After the last attempt: Square's answer never arrived. The next sync settles it. */
async function markUnknown(ctx: WorkerContext, row: BookingChangeRow, message: string, now: Date, queueSync: boolean): Promise<BookingChangeRow> {
  const done = await finish(ctx, row, 'unknown', message, {}, now);
  await writeWorkerAudit(ctx.db, { userId: row.requestedBy, action: 'booking.change_unknown', entityType: 'square_booking_change', entityId: row.id, data: { kind: row.kind, environment: row.environment } }, ctx.logger);
  if (queueSync) await enqueueTracked(ctx, 'square.sync', { reason: 'manual' }, { singletonKey: 'square-sync' });
  return done;
}

/**
 * Settles changes whose outcome is not known (design §6.3 step 8), during a sync of the same account and
 * environment: a reschedule or cancel by the booking's fresh state, a create by a booking with the same client,
 * barber and start made after `submitted_at`. Found → `confirmed`; not found after 24 hours → stays `unknown` with
 * "probably not made". A `submitted` change older than 10 minutes (its worker died on the last attempt) is treated
 * the same way. Read-only towards Square. Returns how many were confirmed.
 */
export async function settleUnknownChanges(ctx: WorkerContext, s: SquareSession, now: Date = new Date()): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(table)
    .where(
      and(
        eq(table.environment, s.environment),
        eq(table.merchantId, s.merchantId),
        or(eq(table.status, 'unknown'), and(eq(table.status, 'submitted'), lt(table.submittedAt, new Date(now.getTime() - SUBMITTED_STALE_MS)))),
        gt(table.createdAt, new Date(now.getTime() - 7 * SQUARE_UNKNOWN_GIVE_UP_MS)),
      ),
    );
  let confirmed = 0;
  for (const row of rows) {
    const req = row.request;
    let found: SquareBookingData | null = null;
    let unreadable = false;
    if (row.kind === 'create') {
      if (!req.startAt) continue;
      const day = melbourneDayRange(melbourneDateOf(new Date(req.startAt)));
      const list = await s.api.listBookings({ locationId: req.locationId, startAtMin: day.start.toISOString(), startAtMax: day.end.toISOString() });
      const after = (row.submittedAt?.getTime() ?? row.createdAt.getTime()) - CREATED_SLACK_MS;
      found =
        list.bookings.find(
          (b) => b.customerId === req.squareCustomerId && b.segments[0]?.teamMemberId === req.teamMemberId && Date.parse(b.startAt) === Date.parse(req.startAt ?? '') && (!b.createdAt || Date.parse(b.createdAt) >= after),
        ) ?? null;
      // A booking that day Square sent in a shape we can't read could be this one: never call it "not made".
      if (!found && list.skippedIds.length > 0) unreadable = true;
    } else if (row.squareBookingId) {
      const fresh = await s.api.getBooking(row.squareBookingId);
      // Square still has the booking but its copy can't be read: leave the change as it is until it can.
      if (isMalformedBooking(fresh)) {
        ctx.logger.warn({ changeId: row.id, reason: fresh.reason }, 'left a booking change unsettled: its booking from Square could not be read');
        continue;
      }
      const b = fresh;
      const moved = b && row.kind === 'reschedule' && Date.parse(b.startAt) === Date.parse(req.startAt ?? '') && b.version > (req.expectedVersion ?? 0);
      // Only a cancel by the seller can be ours; a client who cancelled online meanwhile is not reported as our change.
      const cancelled = b && row.kind === 'cancel' && b.status === 'CANCELLED_BY_SELLER' && b.version > (req.expectedVersion ?? 0);
      if (b && row.kind === 'cancel' && !cancelled && b.status === 'CANCELLED_BY_CUSTOMER' && b.version > (req.expectedVersion ?? 0)) {
        try {
          await upsertBooking(ctx.db, b, s, s.config.snapshot, now);
        } catch (err) {
          if (!(err instanceof SquareConnectionChangedError)) throw err;
        }
        await ctx.db
          .update(table)
          .set({ status: 'changed_in_square', statusMessage: 'The client cancelled this in Square.', squareResponse: b.raw, finishedAt: now, updatedAt: now })
          .where(and(eq(table.id, row.id), inArray(table.status, ['unknown', 'submitted'])));
        continue;
      }
      found = moved || cancelled ? b : null;
    }
    if (found) {
      try {
        await upsertBooking(ctx.db, found, s, s.config.snapshot, now);
      } catch (err) {
        if (!(err instanceof SquareConnectionChangedError)) throw err;
      }
      const bookingId = (await ctx.db.query.bookings.findFirst({ where: eq(schema.bookings.squareBookingId, found.id), columns: { id: true } }))?.id ?? null;
      const updated = await ctx.db
        .update(table)
        .set({ status: 'confirmed', statusMessage: `${confirmedSentence(row.kind)} (Square shows it, so it was made.)`, squareBookingId: found.id, bookingId, squareResponse: found.raw, finishedAt: now, updatedAt: now })
        .where(and(eq(table.id, row.id), inArray(table.status, ['unknown', 'submitted'])))
        .returning({ id: table.id });
      if (updated.length) {
        confirmed++;
        await writeWorkerAudit(ctx.db, { userId: row.requestedBy, action: 'booking.change_confirmed', entityType: 'square_booking_change', entityId: row.id, data: { kind: row.kind, environment: row.environment, settledBySync: true } }, ctx.logger);
      }
      continue;
    }
    const since = row.submittedAt?.getTime() ?? row.createdAt.getTime();
    const message = now.getTime() - since > SQUARE_UNKNOWN_GIVE_UP_MS && !unreadable ? NOT_FOUND_LATER : UNKNOWN_MESSAGE;
    await ctx.db
      .update(table)
      .set({ status: 'unknown', statusMessage: message, finishedAt: row.finishedAt ?? now, updatedAt: now })
      .where(and(eq(table.id, row.id), inArray(table.status, ['unknown', 'submitted']), or(ne(table.statusMessage, message), ne(table.status, 'unknown'))));
  }
  return confirmed;
}

/** The progress line for a finished change. */
export function changeOutcomeMessage(row: BookingChangeRow): string {
  return row.statusMessage || bookingChangeStatusWords(row.status).label;
}
