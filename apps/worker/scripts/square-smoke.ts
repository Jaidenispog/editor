/**
 * Square sandbox smoke test, read-only part (design §11.3 steps 1–2; developer-run, never in CI).
 *
 *   pnpm --filter @studio/worker square:smoke
 *
 * Uses the Square connection stored by Settings → Integrations → Connect Square on the database in DATABASE_URL and
 * refuses to run unless SQUARE_ENVIRONMENT=sandbox and that connection is a sandbox one. It reads, through the same
 * client the worker uses: token status and permissions, the business snapshot, a 31-day bookings window, the first
 * page of customers, and an availability search over a 23-hour daylight-saving day (widened to Square's 24-hour
 * minimum). It never writes to Square and sends nothing. Paste the printed summary into
 * docs/research/square-sandbox-results.md. The write checks (no-show set-ups, Tier 1) belong to WP6b.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { loadEnv } from '@studio/config';
import { availabilityRange, effectiveLocationId, errorMessage, hasSquareReadScopes } from '@studio/core';
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
  out['customers'] = { firstPage: (await s.api.listCustomers()).length };
  const service = services.find((v) => v.availableForBooking && !v.archived);
  if (service && locationId) {
    // 4 October 2026 is a 23-hour day in Melbourne; Square needs at least 24 hours per search.
    const range = availabilityRange('2026-10-04', 1);
    const slots = await s.api.searchAvailability({ startAt: range.start.toISOString(), endAt: range.end.toISOString(), locationId, serviceVariationId: service.variationId, teamMemberId: null });
    out['availabilityDstDay'] = { requestedHours: (range.end.getTime() - range.start.getTime()) / 3600_000, slots: slots.length };
  } else {
    out['availabilityDstDay'] = 'skipped: no bookable service or no single location';
  }
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(`Smoke test stopped: ${errorMessage(err)}`);
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  await handle.close();
}
