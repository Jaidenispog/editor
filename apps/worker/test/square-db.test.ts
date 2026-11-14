/**
 * Square Tier 0 on a real database with a local fake of Square's API (test/fakes/square-server.ts), through the
 * real `square@46.0.0` SDK pointed at the fake by SQUARE_API_BASE_URL (honoured only when NODE_ENV=test). Covers
 * design §11.2 cases 1–6, 14 and 15 plus the plan's WP6 checks: 31-day windows, the six statuses mirrored verbatim,
 * stale versions ignored, reconcile, payment matching and refunds, DST availability ranges, the environment purge,
 * token refresh and revocation, and that nothing is ever written to Square and no message is sent. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { NonRetryableError, isGenuinelyCompleted, newId, type JobType } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { purgeSquareData } from '@studio/db/square-purge';
import type { WorkerContext } from '../src/context.js';
import { encryptCredential } from '../src/lib/credentials.js';
import { handleWebhookProcess } from '../src/handlers/webhook-process.js';
import { handleSquareSync } from '../src/handlers/square-sync.js';
import { handleSquareRefresh } from '../src/handlers/square-refresh.js';
import { handleSquareAttendance } from '../src/handlers/square-attendance.js';
import { handleSquareAvailability } from '../src/handlers/square-availability.js';
import { handleSquareRevoke, handleSquareTokenRefresh } from '../src/handlers/square-token.js';
import { squareModule } from '../src/modules/square/index.js';
import { openSquare } from '../src/square/client.js';
import { runSquareSync } from '../src/square/sync.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeRun } from './helpers/fakes.js';
import { fakeBooking, fakeCustomer, fakePayment, startFakeSquareServer, type FakeSquareServer } from './fakes/square-server.js';

const skip = !testDatabaseUrl();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

interface Queued {
  type: JobType;
  payload: Record<string, unknown>;
  options: { singletonKey?: string };
}

describe.skipIf(skip)('Square Tier 0 with a fake Square API', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let fake: FakeSquareServer;
  let ctx: WorkerContext;
  const queue: Queued[] = [];
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  const conn = async () => (await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'square') }))!;
  const booking = async (squareId: string) => handle.db.query.bookings.findFirst({ where: eq(schema.bookings.squareBookingId, squareId) });

  /** Stores the connection as the web callback leaves it. */
  async function connect(environment: 'sandbox' | 'production' = 'sandbox', expiresAt = new Date(now + 20 * DAY)) {
    await handle.db.delete(schema.integrationConnections).where(eq(schema.integrationConnections.provider, 'square'));
    await handle.db.insert(schema.integrationConnections).values({
      id: newId(),
      provider: 'square',
      status: 'connected',
      externalAccountId: fake.scenario.merchantId,
      accessTokenEncrypted: encryptCredential(ctx.env, fake.scenario.accessToken),
      refreshTokenEncrypted: encryptCredential(ctx.env, fake.scenario.refreshToken),
      tokenExpiresAt: expiresAt,
      config: { environment },
    });
  }

  async function runQueued(types: JobType[]): Promise<string[]> {
    const ran: string[] = [];
    for (let i = 0; i < 20; i++) {
      const idx = queue.findIndex((j) => types.includes(j.type));
      if (idx < 0) break;
      const [job] = queue.splice(idx, 1);
      if (!job) break;
      ran.push(job.type);
      const p = job.payload as never;
      if (job.type === 'square.refresh') await handleSquareRefresh(ctx, fakeRun(), p);
      else if (job.type === 'square.attendance') await handleSquareAttendance(ctx, fakeRun(), p);
      else if (job.type === 'square.sync') await handleSquareSync(ctx, fakeRun(), p);
    }
    return ran;
  }

  beforeAll(async () => {
    fake = await startFakeSquareServer();
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: t.url,
      APP_SECRET: 'test-secret-0123456789-0123456789-0123456789',
      SQUARE_APPLICATION_ID: 'fake-square-app',
      SQUARE_APPLICATION_SECRET: 'fake-square-secret',
      SQUARE_ENVIRONMENT: 'sandbox',
      SQUARE_API_BASE_URL: fake.url,
    });
    ctx = {
      env,
      db: handle.db,
      store: null as never,
      queue: {
        enqueue: async (type: JobType, payload: Record<string, unknown>, options: Queued['options'] = {}) => {
          queue.push({ type, payload, options });
          return newId();
        },
      } as unknown as WorkerContext['queue'],
      ai: null as never,
      logger: pino({ level: 'silent' }),
      workerId: 'test-worker',
      fontsDir: '',
      tmpRoot: '',
    };
  });

  afterAll(async () => {
    await fake?.close();
    await drop?.();
  });

  beforeEach(() => {
    queue.length = 0;
  });

  it('skips without calling Square when nothing is connected', async () => {
    const run = fakeRun();
    await handleSquareSync(ctx, run, { reason: 'schedule' });
    expect(run.messages.at(-1)).toBe('Square is not connected.');
    expect(fake.calls).toHaveLength(0);
  });

  it('connect sync: snapshot, three ≤ 31-day windows, customers and the six statuses verbatim; a second run changes nothing', async () => {
    fake.scenario.customers = [fakeCustomer({ id: 'CUST_JORDAN', given: 'Jordan', family: 'Lee', email: 'jordan@example.com', unsubscribed: true }), fakeCustomer({ id: 'CUST_RILEY', given: 'Riley', family: 'Tran' })];
    const statuses = ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'NO_SHOW'];
    fake.scenario.bookings = statuses.map((status, i) => fakeBooking({ id: `BK_${status}`, status, startAt: iso((i + 1) * DAY), customerId: 'CUST_JORDAN' }));
    fake.scenario.bookings.push(fakeBooking({ id: 'BK_FAR', startAt: iso(50 * DAY), customerId: 'CUST_GHOST' }));
    await connect();
    await handleSquareSync(ctx, fakeRun(), { reason: 'connect' });

    const windows = fake.callsTo('bookings_list');
    expect(windows).toHaveLength(3);
    for (const w of windows) expect(Date.parse(w.query['start_at_max'] ?? '') - Date.parse(w.query['start_at_min'] ?? '')).toBeLessThanOrEqual(31 * DAY);
    expect(windows[0]?.query['location_id']).toBe('LOC_1');

    const c = await conn();
    expect(c.status).toBe('connected');
    expect(c.lastSyncAt).not.toBeNull();
    expect(c.displayName).toBe('Ivanhoe Test Barbers');
    expect(c.capabilities).toMatchObject({ readScopesOk: true, writeScopesOk: false, sellerLevelWrites: false });
    const config = c.config as { snapshot: { services: Array<{ variationId: string; noShowFeeSeen: unknown; durationMinutes: number }>; teamMembers: unknown[]; locations: Array<{ bookingSiteUrl: string }> } };
    expect(config.snapshot.services.map((s) => s.variationId)).toEqual(['VAR_FADE', 'VAR_BEARD']);
    expect(config.snapshot.services[0]?.durationMinutes).toBe(45);
    expect(config.snapshot.services[1]?.noShowFeeSeen).toEqual({ amount: '1000', currency: 'AUD' });
    expect(config.snapshot.locations[0]?.bookingSiteUrl).toBe('https://book.example.test/ivanhoe');

    for (const status of statuses) expect((await booking(`BK_${status}`))?.status).toBe(status);
    const accepted = (await booking('BK_ACCEPTED'))!;
    expect(accepted).toMatchObject({ squareEnvironment: 'sandbox', squareCustomerId: 'CUST_JORDAN', teamMemberId: 'TM_SAM', serviceName: 'Skin fade', durationMinutes: 45, attendance: 'upcoming', completionSource: 'none' });
    expect(accepted.endAt?.getTime()).toBe(accepted.startAt.getTime() + 45 * 60_000);
    expect(accepted.customerId).not.toBeNull();
    expect((await booking('BK_NO_SHOW'))?.attendance).toBe('no_show');
    expect((await booking('BK_PENDING'))?.attendance).toBe('pending');

    const jordan = await handle.db.query.customers.findFirst({ where: eq(schema.customers.squareCustomerId, 'CUST_JORDAN') });
    expect(jordan).toMatchObject({ givenName: 'Jordan', squareEmailUnsubscribed: true, squareEnvironment: 'sandbox', marketingConsent: null });
    // A booking's customer missing from the list is fetched in bulk (here Square does not know it either).
    expect(fake.callsTo('customers_bulk')).toHaveLength(1);
    expect(queue.map((q) => q.type)).toContain('square.attendance');

    const before = await handle.db.select().from(schema.bookings);
    const s = await openSquare(ctx, fakeRun());
    if ('skip' in s) throw new Error(s.skip);
    const second = await runSquareSync(ctx, fakeRun(), s, 'connect');
    expect(second.bookings.inserted + second.bookings.updated).toBe(0);
    expect(second.customers.inserted + second.customers.updated).toBe(0);
    const after = await handle.db.select().from(schema.bookings);
    const strip = (rows: typeof before) => rows.map(({ syncedAt: _s, ...r }) => r).sort((a, b) => a.id.localeCompare(b.id));
    expect(strip(after)).toEqual(strip(before));
  });

  it('ignores an older copy of a booking (version ordering)', async () => {
    const newer = fakeBooking({ id: 'BK_ACCEPTED', startAt: iso(2 * DAY), customerId: 'CUST_JORDAN', version: 3, updatedAt: iso(-HOUR) });
    fake.scenario.bookings = fake.scenario.bookings.map((b) => (b['id'] === 'BK_ACCEPTED' ? newer : b));
    await handleSquareRefresh(ctx, fakeRun(), { entity: 'booking', squareId: 'BK_ACCEPTED' });
    expect((await booking('BK_ACCEPTED'))?.squareVersion).toBe(3);
    fake.scenario.bookings = fake.scenario.bookings.map((b) => (b['id'] === 'BK_ACCEPTED' ? { ...newer, version: 2, status: 'CANCELLED_BY_SELLER' } : b));
    const run = fakeRun();
    await handleSquareRefresh(ctx, run, { entity: 'booking', squareId: 'BK_ACCEPTED' });
    expect(run.messages.at(-1)).toMatch(/older copy/);
    expect(await booking('BK_ACCEPTED')).toMatchObject({ squareVersion: 3, status: 'ACCEPTED' });
    fake.scenario.bookings = fake.scenario.bookings.map((b) => (b['id'] === 'BK_ACCEPTED' ? newer : b));
  });

  it('webhook processing: re-reads from Square, ignores the payload object and other merchants', async () => {
    fake.scenario.bookings.push(fakeBooking({ id: 'BK_WEBHOOK', startAt: iso(3 * DAY), customerId: 'CUST_RILEY', status: 'ACCEPTED' }));
    const store = async (merchant: string) => {
      const id = newId();
      await handle.db.insert(schema.webhookEvents).values({
        id,
        provider: 'square',
        externalEventId: `evt-${id}`,
        eventType: 'booking.created',
        // The payload's own object says CANCELLED; Square's GET says ACCEPTED and wins.
        payload: { merchant_id: merchant, type: 'booking.created', event_id: `evt-${id}`, data: { type: 'booking', id: 'BK_WEBHOOK', object: { booking: { id: 'BK_WEBHOOK', status: 'CANCELLED_BY_SELLER' } } } },
        signatureValid: true,
      });
      return id;
    };
    const other = await store('SOMEONE_ELSE');
    await handleWebhookProcess(ctx, fakeRun(), { webhookEventId: other });
    const ignored = await handle.db.query.webhookEvents.findFirst({ where: eq(schema.webhookEvents.id, other) });
    expect(ignored).toMatchObject({ error: 'merchant_mismatch' });
    expect(ignored?.processedAt).not.toBeNull();
    expect(queue).toHaveLength(0);

    const mine = await store(fake.scenario.merchantId);
    await handleWebhookProcess(ctx, fakeRun(), { webhookEventId: mine });
    expect(queue.map((q) => [q.type, q.payload])).toEqual([['square.refresh', { entity: 'booking', squareId: 'BK_WEBHOOK' }]]);
    expect(queue[0]?.options.singletonKey).toBe('square-refresh:booking:BK_WEBHOOK');
    await runQueued(['square.refresh']);
    expect(await booking('BK_WEBHOOK')).toMatchObject({ status: 'ACCEPTED' });
    // Processing the same delivery again does nothing.
    await handleWebhookProcess(ctx, fakeRun(), { webhookEventId: mine });
    expect(queue).toHaveLength(0);
  });

  it('a missed booking.created still appears from the 10-minute sync', async () => {
    fake.scenario.bookings.push(fakeBooking({ id: 'BK_MISSED', startAt: iso(5 * DAY) }));
    await handleSquareSync(ctx, fakeRun(), { reason: 'schedule' });
    expect(await booking('BK_MISSED')).toBeDefined();
    const last = fake.callsTo('bookings_list').at(-1)!;
    expect(Date.parse(last.query['start_at_max'] ?? '') - Date.parse(last.query['start_at_min'] ?? '')).toBeLessThanOrEqual(31 * DAY);
  });

  it('reconcile marks a booking Square no longer has', async () => {
    fake.scenario.bookings = fake.scenario.bookings.filter((b) => b['id'] !== 'BK_MISSED');
    await handleSquareSync(ctx, fakeRun(), { reason: 'reconcile' });
    expect((await booking('BK_MISSED'))?.missingFromSquareAt).not.toBeNull();
    expect(fake.callsTo('booking_get').some((c) => c.path.endsWith('/BK_MISSED'))).toBe(true);
  });

  it('attendance: a payment webhook matches and completes the booking; a refund clears it back to none', async () => {
    const start = now - 3 * HOUR;
    fake.scenario.bookings.push(fakeBooking({ id: 'BK_PAST', startAt: new Date(start).toISOString(), customerId: 'CUST_RILEY', durationMinutes: 45 }));
    await handleSquareRefresh(ctx, fakeRun(), { entity: 'booking', squareId: 'BK_PAST' });
    queue.length = 0;
    await handleSquareAttendance(ctx, fakeRun(), {});
    expect((await booking('BK_PAST'))?.attendance).toBe('awaiting_payment');
    expect(isGenuinelyCompleted({ status: 'ACCEPTED', completionSource: (await booking('BK_PAST'))!.completionSource, completedAt: (await booking('BK_PAST'))!.completedAt })).toBe(false);

    fake.scenario.payments.push(fakePayment({ id: 'PAY_1', createdAt: new Date(start + 50 * 60_000).toISOString(), customerId: 'CUST_RILEY', product: 'APPOINTMENTS', orderId: 'ORD_1' }));
    fake.scenario.orders.push({ id: 'ORD_1', location_id: 'LOC_1', line_items: [{ quantity: '1', catalog_object_id: 'VAR_FADE' }] });
    await handleSquareRefresh(ctx, fakeRun(), { entity: 'payment', squareId: 'PAY_1' });
    expect(queue.map((q) => q.type)).toEqual(['square.attendance']);
    await runQueued(['square.attendance']);
    const paid = (await booking('BK_PAST'))!;
    expect(paid).toMatchObject({ attendance: 'payment_matched', completionSource: 'payment' });
    expect(paid.completedAt).not.toBeNull();
    expect(paid.attendanceEvidence).toMatchObject({ paymentId: 'PAY_1', confidence: 'high', signals: ['customer', 'appointments_payment', 'service'] });
    expect(isGenuinelyCompleted({ status: paid.status, completionSource: paid.completionSource, completedAt: paid.completedAt })).toBe(true);

    fake.scenario.payments = fake.scenario.payments.map((p) => (p['id'] === 'PAY_1' ? fakePayment({ id: 'PAY_1', createdAt: String(p['created_at']), customerId: 'CUST_RILEY', product: 'APPOINTMENTS', orderId: 'ORD_1', refunded: 5500 }) : p));
    await handleSquareRefresh(ctx, fakeRun(), { entity: 'payment', squareId: 'PAY_1' });
    await runQueued(['square.attendance']);
    const refunded = (await booking('BK_PAST'))!;
    expect(refunded).toMatchObject({ attendance: 'awaiting_payment', completionSource: 'none', completedAt: null });
  });

  it('availability: a 23-hour DST day is widened to 24 hours and slots outside the day are dropped', async () => {
    fake.scenario.availabilities = [
      { start_at: '2026-10-03T23:00:00Z', location_id: 'LOC_1', appointment_segments: [{ duration_minutes: 45, service_variation_id: 'VAR_FADE', team_member_id: 'TM_SAM', service_variation_version: 1700000000001 }] },
      // 11:30 am on 5 October in Melbourne: inside Square's widened range but outside the requested day.
      { start_at: '2026-10-04T23:30:00Z', location_id: 'LOC_1', appointment_segments: [{ duration_minutes: 45, service_variation_id: 'VAR_FADE', team_member_id: 'TM_SAM', service_variation_version: 1700000000001 }] },
    ];
    const id = newId();
    await handle.db.insert(schema.squareAvailabilitySearches).values({ id, environment: 'sandbox', params: { serviceVariationId: 'VAR_FADE', teamMemberId: 'TM_SAM', fromDate: '2026-10-04', days: 1, bookingId: null } });
    await handleSquareAvailability(ctx, fakeRun(), { searchId: id });
    const row = (await handle.db.query.squareAvailabilitySearches.findFirst({ where: eq(schema.squareAvailabilitySearches.id, id) }))!;
    expect(row.status).toBe('done');
    expect(row.slots).toEqual([{ startAt: '2026-10-03T23:00:00.000Z', teamMemberId: 'TM_SAM', durationMinutes: 45, serviceVariationId: 'VAR_FADE', serviceVariationVersion: '1700000000001' }]);
    const call = fake.callsTo('availability').at(-1)!;
    const range = ((call.body?.['query'] as Record<string, unknown>)['filter'] as Record<string, unknown>)['start_at_range'] as { start_at: string; end_at: string };
    expect(Date.parse(range.end_at) - Date.parse(range.start_at)).toBe(24 * HOUR);
    expect(((call.body?.['query'] as Record<string, unknown>)['filter'] as Record<string, unknown>)['segment_filters']).toEqual([{ service_variation_id: 'VAR_FADE', team_member_id_filter: { any: ['TM_SAM'] } }]);
  });

  it('a deleted Square customer is scrubbed, never deleted', async () => {
    fake.scenario.customers = fake.scenario.customers.filter((c) => c['id'] !== 'CUST_RILEY');
    const before = await handle.db.query.customers.findFirst({ where: eq(schema.customers.squareCustomerId, 'CUST_RILEY') });
    await handleSquareRefresh(ctx, fakeRun(), { entity: 'customer', squareId: 'CUST_RILEY' });
    const after = await handle.db.query.customers.findFirst({ where: eq(schema.customers.id, before!.id) });
    expect(after).toMatchObject({ squareCustomerId: null, givenName: '', familyName: '', email: null, phone: null });
    expect(after?.deletedAt).not.toBeNull();
  });

  it('refreshes a token close to expiry; a revoked token asks the owner to reconnect and later jobs do nothing', async () => {
    const tokenCalls = fake.callsTo('token').length;
    await connect('sandbox', new Date(now + DAY));
    await handleSquareTokenRefresh(ctx, fakeRun(), {});
    expect(fake.callsTo('token').length).toBe(tokenCalls + 1);
    expect(fake.callsTo('token').at(-1)?.body).toMatchObject({ grant_type: 'refresh_token', client_id: 'fake-square-app' });
    expect((await conn()).tokenExpiresAt!.getTime()).toBeGreaterThan(now + 25 * DAY);
    // The new token works for reads.
    await handleSquareSync(ctx, fakeRun(), { reason: 'manual' });
    expect((await conn()).status).toBe('connected');

    fake.scenario.revoked = true;
    await expect(handleSquareSync(ctx, fakeRun(), { reason: 'manual' })).rejects.toBeInstanceOf(NonRetryableError);
    expect((await conn()).status).toBe('needs_reauth');
    const audits = await handle.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'integration.square.needs_reauth'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const before = fake.calls.length;
    const run = fakeRun();
    await handleSquareSync(ctx, run, { reason: 'schedule' });
    expect(run.messages.at(-1)).toBe('Square is not connected.');
    expect(fake.calls.length).toBe(before);
    fake.scenario.revoked = false;
  });

  it('revokes access after a disconnect with the application secret only', async () => {
    await handleSquareRevoke(ctx, fakeRun(), { merchantId: fake.scenario.merchantId, environment: 'sandbox' });
    const call = fake.callsTo('revoke').at(-1)!;
    expect(call.authorization).toBe('Client fake-square-secret');
    expect(call.body).toEqual({ client_id: 'fake-square-app', merchant_id: fake.scenario.merchantId });
    expect((await handle.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'integration.square.revoked'))).length).toBe(1);
    fake.scenario.revoked = false;
  });

  it('environment switch: purges the sandbox rows and scrubs customers that email rows still reference', async () => {
    const jordan = (await handle.db.query.customers.findFirst({ where: eq(schema.customers.squareCustomerId, 'CUST_JORDAN') }))!;
    await handle.db.insert(schema.emailMessages).values({ id: newId(), customerId: jordan.id, toEmail: 'jordan@example.com', subject: 'Thanks', bodyHtml: '<p>x</p>', bodyText: 'x', purpose: 'follow_up', dedupeKey: 'follow_up:test', status: 'draft' });
    await handle.db.insert(schema.squareAvailabilitySearches).values({ id: newId(), environment: 'sandbox', params: { serviceVariationId: 'VAR_FADE', teamMemberId: null, fromDate: '2026-11-20', days: 1, bookingId: null } });
    const r = await purgeSquareData(handle.db, { environment: 'sandbox', reason: 'environment_changed' });
    expect(r.bookings).toBeGreaterThan(0);
    expect(await handle.db.select().from(schema.bookings).where(eq(schema.bookings.squareEnvironment, 'sandbox'))).toHaveLength(0);
    expect(await handle.db.select().from(schema.squareAvailabilitySearches)).toHaveLength(0);
    const scrubbed = await handle.db.query.customers.findFirst({ where: eq(schema.customers.id, jordan.id) });
    expect(scrubbed).toMatchObject({ squareCustomerId: null, givenName: '', email: null });
    expect(scrubbed?.deletedAt).not.toBeNull();
    expect(await handle.db.select().from(schema.emailMessages).where(eq(schema.emailMessages.customerId, jordan.id))).toHaveLength(1);
    expect((await handle.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'integration.square.data_purged')))[0]?.data).toMatchObject({ environment: 'sandbox' });
  });

  it('a connection made in the other environment is never read', async () => {
    await connect('production');
    const run = fakeRun();
    const before = fake.calls.length;
    await handleSquareSync(ctx, run, { reason: 'schedule' });
    expect(run.messages.at(-1)).toMatch(/Reconnect Square/);
    expect(fake.calls.length).toBe(before);
  });

  it('cleanup removes availability searches older than a day', async () => {
    const id = newId();
    await handle.db.insert(schema.squareAvailabilitySearches).values({ id, environment: 'sandbox', params: { serviceVariationId: 'VAR_FADE', teamMemberId: null, fromDate: '2026-11-20', days: 1, bookingId: null }, createdAt: new Date(now - 2 * DAY) });
    const summary = await squareModule.cleanupTasks?.[0]?.run(ctx, fakeRun());
    expect(summary).toMatch(/1 old Square availability search removed/);
  });

  it('never writes to Square and never sends a message', async () => {
    expect(fake.callsTo('write')).toHaveLength(0);
    expect(fake.calls.every((c) => c.method === 'GET' || ['token', 'token_status', 'revoke', 'catalog_search', 'availability', 'customers_search', 'customers_bulk', 'orders_batch'].includes(c.endpoint))).toBe(true);
    const sent = await handle.db.select().from(schema.emailMessages);
    expect(sent.every((m) => m.status === 'draft')).toBe(true);
  });
});
