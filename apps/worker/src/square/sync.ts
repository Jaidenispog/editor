import { and, eq, gte, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import {
  BUSINESS_TIMEZONE,
  NonRetryableError,
  bookingWindows,
  effectiveLocationId,
  hasSquareReadScopes,
  hasSquareWriteScopes,
  parseSquareCapabilities,
  syncRange,
  type SquareSnapshot,
} from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { markSquareNeedsReauth, mergeSquareConfig, type SquareSession } from './client.js';
import { settleUnknownChanges } from './change.js';
import { applyAttendance, storedMatch, upsertBooking, upsertCustomer, type UpsertOutcome } from './map.js';

/** Why a sync runs. */
export type SquareSyncReason = 'connect' | 'schedule' | 'manual' | 'reconcile';

/** The snapshot (business, locations, team, services) is re-read at least this often. */
export const SQUARE_SNAPSHOT_MAX_AGE_MS = 6 * 3600_000;

/** Counts from one sync, for the job message and tests. */
export interface SquareSyncSummary {
  snapshot: boolean;
  /** Bookings were not copied because the owner still has to choose which Square location is the studio's. */
  needsLocation: boolean;
  bookings: Record<UpsertOutcome, number>;
  missing: number;
  customers: Record<UpsertOutcome, number>;
}

const emptyCounts = (): Record<UpsertOutcome, number> => ({ inserted: 0, updated: 0, unchanged: 0, stale: 0, ignored: 0 });

/**
 * `square.sync` (design §6): token status and permissions, the business snapshot, bookings in ≤ 31-day windows,
 * the nightly reconcile of bookings Square no longer returns, customers (full on connect, incremental otherwise,
 * plus any booking customer not yet copied), then queues the attendance pass. Only reads Square; never writes there.
 * Upserts are idempotent, so a retried or repeated sync changes nothing that has not changed in Square.
 */
export async function runSquareSync(ctx: WorkerContext, run: TrackedRun, s: SquareSession, reason: SquareSyncReason, now: Date = new Date()): Promise<SquareSyncSummary> {
  const t = schema.integrationConnections;
  const summary: SquareSyncSummary = { snapshot: false, needsLocation: false, bookings: emptyCounts(), missing: 0, customers: emptyCounts() };
  const capabilities = parseSquareCapabilities(s.conn.capabilities);
  const capPatch: Record<string, unknown> = {};

  // 1. Token status: permissions and expiry (connect, manual and reconcile only).
  if (reason !== 'schedule') {
    await run.progress(0.05, 'Checking the Square connection…');
    const status = await s.api.retrieveTokenStatus();
    const readOk = hasSquareReadScopes(status.scopes);
    capPatch['readScopesOk'] = readOk;
    capPatch['writeScopesOk'] = hasSquareWriteScopes(status.scopes);
    await ctx.db
      .update(t)
      .set({ scopes: status.scopes, ...(status.expiresAt ? { tokenExpiresAt: new Date(status.expiresAt) } : {}), updatedAt: now })
      .where(eq(t.provider, 'square'));
    if (status.merchantId && status.merchantId !== s.merchantId) {
      await markSquareNeedsReauth(ctx, 'This Square sign-in belongs to a different Square account. Reconnect Square.');
      throw new NonRetryableError('CONFLICT', 'This Square sign-in belongs to a different Square account. Reconnect Square.');
    }
    if (!readOk) {
      await markSquareNeedsReauth(ctx, 'Square didn’t grant all the read permissions Studio Assistant needs.', { readScopesOk: false });
      throw new NonRetryableError('FORBIDDEN', 'Square didn’t grant all the read permissions Studio Assistant needs.');
    }
  }

  // 2. Snapshot: business name, locations, booking profile, team members and services.
  let snapshot: SquareSnapshot | null = s.config.snapshot;
  const snapshotAge = snapshot ? now.getTime() - Date.parse(snapshot.fetchedAt) : Infinity;
  if (reason !== 'schedule' || !snapshot || snapshotAge > SQUARE_SNAPSHOT_MAX_AGE_MS) {
    run.checkCancelled();
    await run.progress(0.15, 'Reading your Square business, team and services…');
    const [merchantName, locations, businessProfile, locationProfiles, services] = await Promise.all([
      s.api.getMerchantName(s.merchantId),
      s.api.listLocations(),
      s.api.getBusinessProfile(),
      s.api.listLocationProfiles(),
      s.api.listServices(),
    ]);
    const locationId = effectiveLocationId({ ...s.config, snapshot: { fetchedAt: '', merchantName, locations: locations.map((l) => ({ ...l, bookingSiteUrl: null })), businessProfile: null, teamMembers: [], services: [] } });
    const teamMembers = await s.api.listTeamMemberProfiles(locationId);
    snapshot = {
      fetchedAt: now.toISOString(),
      merchantName,
      locations: locations.map((l) => ({ ...l, bookingSiteUrl: locationProfiles.find((p) => p.locationId === l.id)?.bookingSiteUrl ?? null })),
      businessProfile,
      teamMembers,
      services,
    };
    await mergeSquareConfig(ctx, { snapshot });
    summary.snapshot = true;
    const location = locations.find((l) => l.id === locationId);
    capPatch['sellerLevelWrites'] = businessProfile?.supportSellerLevelWrites ?? null;
    capPatch['locationTimezone'] = location?.timezone && location.timezone !== BUSINESS_TIMEZONE ? location.timezone : '';
    if (businessProfile && !businessProfile.supportSellerLevelWrites && capabilities.writesEnabled && capabilities.writesSuspendedReason === '') {
      capPatch['writesSuspendedReason'] = 'plan';
      await writeWorkerAudit(ctx.db, { userId: null, action: 'integration.square.writes_suspended', entityType: 'integration_connection', entityId: s.conn.id, data: { reason: 'plan' } }, ctx.logger);
    }
    if (merchantName) await ctx.db.update(t).set({ displayName: merchantName }).where(eq(t.provider, 'square'));
  }
  const locationId = effectiveLocationId({ ...s.config, snapshot });

  // 3. Bookings, in windows of at most 31 days, for the studio's location only. With several active locations and
  // none chosen yet, no booking is copied: another location's bookings would otherwise stay in the lists for good.
  run.checkCancelled();
  const range = syncRange(reason, now);
  const seen = new Set<string>();
  const customerIds = new Set<string>();
  summary.needsLocation = locationId === null;
  if (locationId) await run.progress(0.35, 'Fetching your bookings from Square…');
  for (const w of locationId ? bookingWindows(range.start, range.end) : []) {
    run.checkCancelled();
    const list = await s.api.listBookings({ locationId, startAtMin: w.start.toISOString(), startAtMax: w.end.toISOString() });
    for (const b of list) {
      seen.add(b.id);
      if (b.customerId) customerIds.add(b.customerId);
      summary.bookings[await upsertBooking(ctx.db, b, s, snapshot, now)]++;
    }
  }

  // 4. Reconcile: bookings we hold in the range that Square did not return are re-read one by one.
  if (locationId && (reason === 'reconcile' || reason === 'connect')) {
    const b = schema.bookings;
    const held = await ctx.db
      .select({ id: b.id, squareBookingId: b.squareBookingId })
      .from(b)
      .where(
        and(
          eq(b.squareEnvironment, s.environment),
          eq(b.locationId, locationId),
          gte(b.startAt, range.start),
          lt(b.startAt, range.end),
          isNull(b.missingFromSquareAt),
          seen.size ? notInArray(b.squareBookingId, [...seen]) : undefined,
        ),
      );
    for (const h of held) {
      run.checkCancelled();
      const fresh = await s.api.getBooking(h.squareBookingId);
      if (fresh) {
        if (fresh.customerId) customerIds.add(fresh.customerId);
        summary.bookings[await upsertBooking(ctx.db, fresh, s, snapshot, now)]++;
      } else {
        await markBookingMissing(ctx, h.id, now);
        summary.missing++;
      }
    }
  }

  // 4b. Booking changes whose outcome is not known yet (Tier 1): settled from what Square now shows.
  if (locationId) await settleUnknownChanges(ctx, s, now);

  // 5. Customers: everything on connect, otherwise changes since the last watermark (minus a day of overlap).
  run.checkCancelled();
  await run.progress(0.7, 'Fetching your clients from Square…');
  const since = s.config.customersSyncedAt;
  const customers = reason === 'connect' || !since ? await s.api.listCustomers() : await s.api.searchCustomersUpdatedSince(new Date(Date.parse(since) - 24 * 3600_000).toISOString());
  for (const c of customers) summary.customers[await upsertCustomer(ctx.db, c, s, now)]++;
  const known = customerIds.size
    ? new Set(
        (await ctx.db.select({ id: schema.customers.squareCustomerId }).from(schema.customers).where(inArray(schema.customers.squareCustomerId, [...customerIds]))).map((r) => r.id),
      )
    : new Set<string | null>();
  const missingCustomers = [...customerIds].filter((id) => !known.has(id));
  if (missingCustomers.length) for (const c of await s.api.bulkRetrieveCustomers(missingCustomers)) summary.customers[await upsertCustomer(ctx.db, c, s, now)]++;
  await mergeSquareConfig(ctx, { customersSyncedAt: now.toISOString() });

  // 6. Done: record the sync, clear any old error, and queue the attendance pass.
  await ctx.db
    .update(t)
    .set({
      status: 'connected',
      lastError: null,
      lastSyncAt: now,
      ...(Object.keys(capPatch).length ? { capabilities: sql`${t.capabilities} || ${JSON.stringify(capPatch)}::jsonb` } : {}),
      updatedAt: now,
    })
    .where(and(eq(t.provider, 'square'), inArray(t.status, ['connected', 'error'])));
  await enqueueTracked(ctx, 'square.attendance', {}, { singletonKey: 'square-attendance:all' });
  return summary;
}

/** Marks a booking Square answered NOT_FOUND for, which also clears its completion. */
export async function markBookingMissing(ctx: Pick<WorkerContext, 'db'>, bookingId: string, now: Date = new Date()): Promise<void> {
  const row = await ctx.db.query.bookings.findFirst({ where: eq(schema.bookings.id, bookingId) });
  if (!row || row.missingFromSquareAt) return;
  await ctx.db.update(schema.bookings).set({ missingFromSquareAt: now, updatedAt: now }).where(eq(schema.bookings.id, bookingId));
  await applyAttendance(ctx.db, { ...row, missingFromSquareAt: now }, storedMatch(row.attendanceEvidence), now);
}
