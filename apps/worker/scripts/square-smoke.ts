/**
 * Square sandbox smoke test, read-only part (design §11.3 steps 1–2; developer-run, never in CI).
 *
 *   pnpm --filter @studio/worker square:smoke
 *
 * Uses the Square connection stored by Settings → Integrations → Connect Square on the database in DATABASE_URL and
 * refuses to run unless SQUARE_ENVIRONMENT=sandbox and that connection is a sandbox one. It reads, through the same
 * client the worker uses: token status and permissions, the business snapshot, a 31-day bookings window, every page
 * of customers (the count), and an availability search over tomorrow (one Melbourne day, at least Square's 24-hour
 * minimum). The 23-hour daylight-saving day cannot be checked live once its date has passed, so the summary says so;
 * the widening is covered by the unit and fake-Square tests (`availabilityRange`). It never writes to Square and
 * sends nothing. Paste the printed summary into
 * docs/research/square-sandbox-results.md. The write checks (no-show set-ups, Tier 1) belong to WP6b.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { loadEnv } from '@studio/config';
import { addDaysToDate, availabilityRange, effectiveLocationId, errorMessage, hasSquareReadScopes, melbourneDateOf } from '@studio/core';
import { createDatabase } from '@studio/db';
import { repoRoot, type WorkerContext } from '../src/context.js';
import { openSquare } from '../src/square/client.js';

const envFile = path.join(repoRoot(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = loadEnv();
if (env.SQUARE_ENVIRONMENT !== 'sandbox') {
  console.error('Refusing to run: the smoke test only runs with SQUARE_ENVIRONMENT=sandbox.');
  process.exit(2);
}
const handle = createDatabase(env.DATABASE_URL, { max: 2, applicationName: 'square-smoke' });
const ctx = { env, db: handle.db, logger: pino({ level: 'warn' }) } as unknown as WorkerContext;
const signal = AbortSignal.timeout(120_000);
const out: Record<string, unknown> = { ranAt: new Date().toISOString(), environment: env.SQUARE_ENVIRONMENT };

try {
  const s = await openSquare(ctx, { signal });
  if ('skip' in s) throw new Error(s.skip);
  if (s.environment !== 'sandbox') throw new Error('The stored connection is not a sandbox connection.');
  const status = await s.api.retrieveTokenStatus();
  out['tokenStatus'] = { scopes: status.scopes, readScopesOk: hasSquareReadScopes(status.scopes), expiresAt: status.expiresAt };
  const [merchantName, locations, businessProfile, services] = await Promise.all([s.api.getMerchantName(s.merchantId), s.api.listLocations(), s.api.getBusinessProfile(), s.api.listServices()]);
  out['snapshot'] = {
    merchantName,
    locations: locations.map((l) => ({ id: l.id, timezone: l.timezone, status: l.status })),
    supportSellerLevelWrites: businessProfile?.supportSellerLevelWrites ?? null,
    cancellationFee: businessProfile?.cancellationFee ?? null,
    services: services.map((v) => ({ variationId: v.variationId, name: v.itemName, availableForBooking: v.availableForBooking, noShowFeeSeen: v.noShowFeeSeen })),
  };
  const locationId = effectiveLocationId({ ...s.config, snapshot: { fetchedAt: '', merchantName, locations: locations.map((l) => ({ ...l, bookingSiteUrl: null })), businessProfile, teamMembers: [], services } });
  const start = new Date();
  const bookings = await s.api.listBookings({ locationId, startAtMin: start.toISOString(), startAtMax: new Date(start.getTime() + 31 * 24 * 3600_000).toISOString() });
  out['bookings'] = { count: bookings.length, statuses: [...new Set(bookings.map((b) => b.status))] };
  // listCustomers reads every page (100 a page), as the sync does.
  out['customers'] = { allPages: (await s.api.listCustomers()).length };
  const service = services.find((v) => v.availableForBooking && !v.archived);
  if (service && locationId) {
    // Square searches only future times, so a past date proves nothing: search tomorrow (Melbourne), one day.
    const tomorrow = addDaysToDate(melbourneDateOf(new Date()), 1);
    const range = availabilityRange(tomorrow, 1);
    const slots = await s.api.searchAvailability({ startAt: range.start.toISOString(), endAt: range.end.toISOString(), locationId, serviceVariationId: service.variationId, teamMemberId: null });
    out['availabilityOneDay'] = { date: tomorrow, requestedHours: (range.end.getTime() - range.start.getTime()) / 3600_000, slots: slots.length };
  } else {
    out['availabilityOneDay'] = 'skipped: no bookable service or no single location';
  }
  out['availabilityDstDay'] = 'not verifiable live (the next 23-hour day is months away); covered by unit and fake-Square tests';
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(`Smoke test stopped: ${errorMessage(err)}`);
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  await handle.close();
}
