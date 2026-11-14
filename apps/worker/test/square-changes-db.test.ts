/**
 * Square Tier 1 booking changes (WP6b) on a real database with the local fake of Square's API
 * (test/fakes/square-server.ts) through the real `square@46.0.0` SDK. Covers the plan's WP6b acceptance tests and
 * design §11.2 cases 7–13 and 16: the gate (plan flag, permissions, fee-bearing and unconfirmed services, Tier 1 off),
 * the create happy path, a slot taken at the re-check, a booking changed in Square, a time-out retried with the same
 * idempotency key (one booking), the last attempt left `unknown` and settled by the next sync, a 4xx stored verbatim
 * (the service becomes "Book in Square"), a plan refusal pausing changes, the double-booking warning, a crash after
 * `submitted_at`, and the self-test (resume after a crash; a failed move still cancels). Tier 1 is switched on only
 * through the test-only `tier1Available` option; production code keeps `SQUARE_TIER1_AVAILABLE` false. Skipped
 * unless TEST_DATABASE_URL is set. No real Square endpoint is contacted and no message is sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import {
  SQUARE_READ_SCOPES,
  SQUARE_WRITE_SCOPES,
  bookingChangeIdempotencyKey,
  classifyVariation,
  newId,
  parseSquareConfig,
  selfTestChangeId,
  type BookingChangeKind,
  type BookingChangeRequest,
  type JobType,
} from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import type { WorkerContext } from '../src/context.js';
import { encryptCredential } from '../src/lib/credentials.js';
import { handleSquareSync } from '../src/handlers/square-sync.js';
import { handleSquareBookingChange } from '../src/handlers/square-booking-change.js';
import { handleSquareSelfTest } from '../src/handlers/square-self-test.js';
import { squareModule } from '../src/modules/square/index.js';
import { openSquare } from '../src/square/client.js';
import { runBookingChange, settleUnknownChanges } from '../src/square/change.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeRun } from './helpers/fakes.js';
import { fakeBooking, fakeCustomer, fakeSlot, startFakeSquareServer, type FakeSquareServer } from './fakes/square-server.js';

const skip = !testDatabaseUrl();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ON = { tier1Available: true };

interface Queued {
  type: JobType;
  payload: Record<string, unknown>;
}

describe.skipIf(skip)('Square booking changes (Tier 1) with a fake Square API', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let fake: FakeSquareServer;
  let ctx: WorkerContext;
  const queue: Queued[] = [];
  // A Melbourne-morning instant three days ahead, on a whole quarter hour.
  const base = new Date(Math.ceil((Date.now() + 3 * DAY) / (15 * 60_000)) * 15 * 60_000);
  const at = (offsetMs: number) => new Date(base.getTime() + offsetMs).toISOString();

  const conn = async () => (await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'square') }))!;
  const change = async (id: string) => (await handle.db.query.squareBookingChanges.findFirst({ where: eq(schema.squareBookingChanges.id, id) }))!;
  const writes = () => fake.callsTo('write');

  /** A connected sandbox account with booking changes switched on and the fade confirmed free of no-show fees. */
  async function setUp(caps: Record<string, unknown> = {}) {
    await handle.db.delete(schema.squareBookingChanges);
    await handle.db.delete(schema.integrationConnections).where(eq(schema.integrationConnections.provider, 'square'));
    await handle.db.insert(schema.integrationConnections).values({
      id: newId(),
      provider: 'square',
      status: 'connected',
      externalAccountId: fake.scenario.merchantId,
      accessTokenEncrypted: encryptCredential(ctx.env, fake.scenario.accessToken),
      refreshTokenEncrypted: encryptCredential(ctx.env, fake.scenario.refreshToken),
      tokenExpiresAt: new Date(Date.now() + 20 * DAY),
      config: { environment: 'sandbox' },
    });
    await handleSquareSync(ctx, fakeRun(), { reason: 'connect' });
    const c = await conn();
    const config = parseSquareConfig(c.config);
    const fade = config.snapshot?.services.find((s) => s.variationId === 'VAR_FADE');
    const beard = config.snapshot?.services.find((s) => s.variationId === 'VAR_BEARD');
    await handle.db
      .update(schema.integrationConnections)
      .set({
        config: {
          ...config,
          serviceConfirmations: {
            VAR_FADE: { version: fade?.version ?? '', confirmedBy: 'owner', confirmedAt: new Date().toISOString() },
            VAR_BEARD: { version: beard?.version ?? '', confirmedBy: 'owner', confirmedAt: new Date().toISOString() },
          },
        },
        capabilities: { ...c.capabilities, writesEnabled: true, writesSuspendedReason: '', selfTestStatus: 'passed', selfTestEnvironment: 'sandbox', selfTestMerchantId: fake.scenario.merchantId, ...caps },
      })
      .where(eq(schema.integrationConnections.provider, 'square'));
    fake.calls.length = 0;
    queue.length = 0;
  }

  async function makeChange(kind: BookingChangeKind, request: Partial<BookingChangeRequest>, extra: { squareBookingId?: string; selfTestId?: string; id?: string } = {}) {
    const id = extra.id ?? newId();
    await handle.db.insert(schema.squareBookingChanges).values({
      id,
      kind,
      environment: 'sandbox',
      merchantId: fake.scenario.merchantId,
      squareBookingId: extra.squareBookingId ?? null,
      request: { locationId: 'LOC_1', ...request },
      idempotencyKey: bookingChangeIdempotencyKey(id),
      selfTestId: extra.selfTestId ?? null,
    });
    return id;
  }

  const createRequest = (startAt: string, teamMemberId = 'TM_SAM', serviceVariationId = 'VAR_FADE'): Partial<BookingChangeRequest> => ({
    squareCustomerId: 'CUST_JORDAN',
    serviceVariationId,
    serviceVariationVersion: serviceVariationId === 'VAR_FADE' ? '1700000000001' : '1700000000002',
    teamMemberId,
    durationMinutes: 45,
    startAt,
    sellerNote: 'Test note',
  });

  beforeAll(async () => {
    fake = await startFakeSquareServer();
    fake.scenario.scopes = [...SQUARE_READ_SCOPES, ...SQUARE_WRITE_SCOPES];
    fake.scenario.businessProfile = { ...fake.scenario.businessProfile, support_seller_level_writes: true };
    fake.scenario.customers = [fakeCustomer({ id: 'CUST_JORDAN', given: 'Jordan', family: 'Lee' })];
    fake.scenario.acceptWrites = true;
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
        enqueue: async (type: JobType, payload: Record<string, unknown>) => {
          queue.push({ type, payload });
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

  beforeEach(async () => {
    fake.scenario.bookings = [];
    fake.scenario.availabilities = [];
    fake.scenario.idempotency = {};
    fake.scenario.failOnce = {};
    fake.scenario.dropWriteResponses = 0;
    fake.scenario.dropWriteKinds = [];
    fake.scenario.failNextWrite = null;
    fake.scenario.businessProfile = { ...fake.scenario.businessProfile, support_seller_level_writes: true };
    await setUp();
  });

  it('registers the two Tier 1 job types with their reference ids', () => {
    const types = (squareModule.handlers ?? []).map((h) => h.type);
    expect(types).toEqual(expect.arrayContaining(['square.booking_change', 'square.self_test']));
    expect(squareModule.refIdFor?.('square.booking_change', { changeId: 'c1' })).toBe('c1');
    expect(squareModule.refIdFor?.('square.self_test', { selfTestId: 's1' })).toBe('s1');
    // No schedule ever writes to Square.
    expect(squareModule.crons?.map((c) => c.type)).not.toContain('square.booking_change');
  });

  it('stays off while Tier 1 is not available in this version (the default), sending nothing', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    const id = await makeChange('create', createRequest(at(0)));
    await handleSquareBookingChange(ctx, fakeRun(), { changeId: id });
    expect(await change(id)).toMatchObject({ status: 'not_allowed', submittedAt: null });
    expect((await change(id)).statusMessage).toMatch(/aren’t available yet/);
    expect(fake.calls).toHaveLength(0);
  });

  it('gate: refuses without a write when the plan flag, the permissions, a fee-bearing or an unconfirmed service do not allow it', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) }), fakeSlot({ startAt: at(0), serviceVariationId: 'VAR_BEARD' })];
    // Plan flag false in the stored checklist.
    await setUp({ sellerLevelWrites: false });
    let id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    expect((await change(id)).status).toBe('not_allowed');
    expect((await change(id)).statusMessage).toMatch(/plan/);

    // Missing write permissions.
    await setUp();
    await handle.db.update(schema.integrationConnections).set({ scopes: [...SQUARE_READ_SCOPES] }).where(eq(schema.integrationConnections.provider, 'square'));
    id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    expect((await change(id)).statusMessage).toMatch(/permission/);

    // A fee-bearing service (Square sent a no_show_fee), even though the owner ticked it.
    await setUp();
    id = await makeChange('create', createRequest(at(0), 'TM_SAM', 'VAR_BEARD'));
    await runBookingChange(ctx, fakeRun(), id, ON);
    expect(await change(id)).toMatchObject({ status: 'not_allowed', submittedAt: null });
    expect((await change(id)).statusMessage).toMatch(/no-show fee/);

    // An unconfirmed service.
    await setUp();
    const c = await conn();
    await handle.db
      .update(schema.integrationConnections)
      .set({ config: { ...parseSquareConfig(c.config), serviceConfirmations: {} } })
      .where(eq(schema.integrationConnections.provider, 'square'));
    id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    expect((await change(id)).status).toBe('not_allowed');

    // Plan flag true when stored but false at write time: refused and booking changes are paused.
    await setUp();
    fake.scenario.businessProfile = { ...fake.scenario.businessProfile, support_seller_level_writes: false };
    id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    expect((await change(id)).statusMessage).toMatch(/plan no longer allows/);
    expect((await conn()).capabilities).toMatchObject({ writesSuspendedReason: 'plan', sellerLevelWrites: false });
    expect(writes()).toHaveLength(0);
  });

  it('create: re-checks the time, sends once with the stored idempotency key, mirrors the booking and audits', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) }), fakeSlot({ startAt: at(HOUR) })];
    const id = await makeChange('create', createRequest(at(0)));
    await handleSquareBookingChange(ctx, fakeRun(), { changeId: id }, ON);
    const row = await change(id);
    expect(row).toMatchObject({ status: 'confirmed', httpStatus: 200 });
    expect(row.submittedAt).not.toBeNull();
    expect(row.statusMessage).toBe('Booked in Square.');
    expect(fake.callsTo('availability')).toHaveLength(1);
    expect(fake.callsTo('catalog_object')).toHaveLength(1);
    expect(fake.callsTo('business_profile')).toHaveLength(1);
    const sent = writes();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ idempotency_key: `sabc_${id}`, booking: { location_id: 'LOC_1', customer_id: 'CUST_JORDAN', seller_note: 'Test note', start_at: at(0) } });
    expect((sent[0]?.body?.['booking'] as { appointment_segments: unknown[] }).appointment_segments).toEqual([{ team_member_id: 'TM_SAM', service_variation_id: 'VAR_FADE', duration_minutes: 45, service_variation_version: 1700000000001 }]);
    const mirrored = await handle.db.query.bookings.findFirst({ where: eq(schema.bookings.squareBookingId, row.squareBookingId ?? '') });
    expect(mirrored).toMatchObject({ status: 'ACCEPTED', teamMemberId: 'TM_SAM', squareEnvironment: 'sandbox' });
    expect(row.bookingId).toBe(mirrored?.id);
    const audits = await handle.db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audits.map((a) => a.action).sort()).toEqual(['booking.change_confirmed', 'booking.change_submitted']);
    expect(JSON.stringify(audits.map((a) => a.data))).not.toMatch(/Jordan|Test note/);
    // Running it again changes nothing and sends nothing.
    await handleSquareBookingChange(ctx, fakeRun(), { changeId: id }, ON);
    expect(writes()).toHaveLength(1);
  });

  it('a slot taken between the search and the change: slot_unavailable with alternatives, nothing sent', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(HOUR) }), fakeSlot({ startAt: at(2 * HOUR) }), fakeSlot({ startAt: at(0), teamMemberId: 'TM_ALEX' })];
    const id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    const row = await change(id);
    expect(row).toMatchObject({ status: 'slot_unavailable', submittedAt: null });
    expect(row.freshSlots?.map((s) => s.startAt)).toEqual([at(0), at(HOUR), at(2 * HOUR)]);
    expect(writes()).toHaveLength(0);
  });

  it('a booking changed in Square (version differs): changed_in_square, nothing sent', async () => {
    fake.scenario.bookings = [fakeBooking({ id: 'BK_MOVE', startAt: at(0), customerId: 'CUST_JORDAN', version: 4 })];
    fake.scenario.availabilities = [fakeSlot({ startAt: at(HOUR) })];
    const id = await makeChange('reschedule', { ...createRequest(at(HOUR)), squareCustomerId: undefined, expectedVersion: 3 }, { squareBookingId: 'BK_MOVE' });
    await runBookingChange(ctx, fakeRun(), id, ON);
    const row = await change(id);
    expect(row).toMatchObject({ status: 'changed_in_square', submittedAt: null });
    expect(row.squareResponse).toMatchObject({ id: 'BK_MOVE', version: 4 });
    expect(writes()).toHaveLength(0);
    // The local copy now shows Square's latest.
    expect((await handle.db.query.bookings.findFirst({ where: eq(schema.bookings.squareBookingId, 'BK_MOVE') }))?.squareVersion).toBe(4);
  });

  it('a booking Square sends with a local start time at the re-check: failed, nothing sent, never treated as gone', async () => {
    // Square still has it but its copy can't be read (G4 review round 3), so its version can't be checked.
    fake.scenario.bookings = [{ ...fakeBooking({ id: 'BK_MOVE', startAt: at(0), customerId: 'CUST_JORDAN', version: 2 }), start_at: at(0).replace(/(\.\d+)?Z$/, '') }];
    fake.scenario.availabilities = [fakeSlot({ startAt: at(HOUR) })];
    const id = await makeChange('reschedule', { ...createRequest(at(HOUR)), squareCustomerId: undefined, expectedVersion: 2 }, { squareBookingId: 'BK_MOVE' });
    await runBookingChange(ctx, fakeRun(), id, ON);
    const row = await change(id);
    expect(row).toMatchObject({ status: 'failed', submittedAt: null });
    expect(row.statusMessage).toMatch(/couldn’t be read.*Nothing was sent\.$/);
    expect(writes()).toHaveLength(0);
  });

  it('reschedule and cancel at the version the owner saw', async () => {
    fake.scenario.bookings = [fakeBooking({ id: 'BK_MOVE', startAt: at(0), customerId: 'CUST_JORDAN', version: 2 })];
    fake.scenario.availabilities = [fakeSlot({ startAt: at(HOUR) })];
    const move = await makeChange('reschedule', { ...createRequest(at(HOUR)), squareCustomerId: undefined, sellerNote: undefined, expectedVersion: 2 }, { squareBookingId: 'BK_MOVE' });
    await runBookingChange(ctx, fakeRun(), move, ON);
    expect(await change(move)).toMatchObject({ status: 'confirmed', statusMessage: 'Moved in Square.' });
    expect(writes()[0]?.body).toMatchObject({ idempotency_key: `sabc_${move}`, booking: { version: 2, start_at: at(HOUR) } });
    const cancel = await makeChange('cancel', { expectedVersion: 3 }, { squareBookingId: 'BK_MOVE' });
    await runBookingChange(ctx, fakeRun(), cancel, ON);
    expect(await change(cancel)).toMatchObject({ status: 'confirmed', statusMessage: 'Cancelled in Square.' });
    expect(writes()[1]?.body).toMatchObject({ idempotency_key: `sabc_${cancel}`, booking_version: 3 });
    expect((await handle.db.query.bookings.findFirst({ where: eq(schema.bookings.squareBookingId, 'BK_MOVE') }))?.status).toBe('CANCELLED_BY_SELLER');
  });

  it('a time-out after Square made the booking: the retry re-sends the same key and Square holds one booking', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    fake.scenario.dropWriteResponses = 1;
    const id = await makeChange('create', createRequest(at(0)));
    await expect(handleSquareBookingChange(ctx, fakeRun({ willRetry: true }), { changeId: id }, ON)).rejects.toThrow();
    expect(await change(id)).toMatchObject({ status: 'submitted' });
    expect((await change(id)).submittedAt).not.toBeNull();
    // The retry skips the checks (the change was already sent) and re-sends the identical request.
    fake.calls.length = 0;
    await handleSquareBookingChange(ctx, fakeRun({ willRetry: true }), { changeId: id }, ON);
    expect(await change(id)).toMatchObject({ status: 'confirmed' });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body?.['idempotency_key']).toBe(`sabc_${id}`);
    expect(fake.callsTo('availability')).toHaveLength(0);
    expect(fake.scenario.bookings.filter((b) => b['source'] === 'API')).toHaveLength(1);
  });

  it('a crash after submitted_at: the next attempt re-sends with the same key and confirms the one booking', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    const id = await makeChange('create', createRequest(at(0)));
    // Square already made it under this key (the worker died after sending, before saving the answer).
    fake.scenario.dropWriteResponses = 1;
    await expect(runBookingChange(ctx, fakeRun({ willRetry: true }), id, ON)).rejects.toThrow();
    await handleSquareBookingChange(ctx, fakeRun({ willRetry: false }), { changeId: id }, ON);
    expect(await change(id)).toMatchObject({ status: 'confirmed' });
    expect(new Set(writes().map((w) => w.body?.['idempotency_key']))).toEqual(new Set([`sabc_${id}`]));
    expect(fake.scenario.bookings.filter((b) => b['source'] === 'API')).toHaveLength(1);
  });

  it('time-outs on every attempt: unknown, then the next sync finds the booking and confirms it', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    fake.scenario.dropWriteResponses = 5;
    const id = await makeChange('create', createRequest(at(0)));
    await expect(handleSquareBookingChange(ctx, fakeRun({ willRetry: true }), { changeId: id }, ON)).rejects.toThrow();
    await handleSquareBookingChange(ctx, fakeRun({ willRetry: false }), { changeId: id }, ON);
    const unknown = await change(id);
    expect(unknown.status).toBe('unknown');
    expect(unknown.statusMessage).toMatch(/may or may not/);
    expect(queue.map((q) => q.type)).toContain('square.sync');
    expect((await handle.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, 'booking.change_unknown')))).length).toBe(1);
    await handleSquareSync(ctx, fakeRun(), { reason: 'manual' });
    const settled = await change(id);
    expect(settled.status).toBe('confirmed');
    expect(settled.statusMessage).toMatch(/Square shows it/);
    expect(settled.bookingId).not.toBeNull();
  });

  it('an unknown change Square does not show after 24 hours is reported as probably not made', async () => {
    const id = await makeChange('create', createRequest(at(0)));
    const old = new Date(Date.now() - 25 * HOUR);
    await handle.db.update(schema.squareBookingChanges).set({ status: 'unknown', submittedAt: old, createdAt: old }).where(eq(schema.squareBookingChanges.id, id));
    const s = await openSquare(ctx, fakeRun());
    if ('skip' in s) throw new Error(s.skip);
    expect(await settleUnknownChanges(ctx, s)).toBe(0);
    expect(await change(id)).toMatchObject({ status: 'unknown', statusMessage: 'Not found in Square — it was probably not made.' });
  });

  it('a 4xx is stored verbatim and the service becomes "Book in Square"; a plan refusal pauses changes', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    fake.scenario.failOnce = { write: { status: 400, code: 'INVALID_VALUE', detail: 'A no-show fee applies to this service.' } };
    const id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    const row = await change(id);
    expect(row).toMatchObject({ status: 'rejected', httpStatus: 400, errorCode: 'INVALID_VALUE' });
    expect(row.squareResponse).toEqual({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'INVALID_VALUE', detail: 'A no-show fee applies to this service.' }] });
    expect(row.statusMessage).toContain('“A no-show fee applies to this service.”');
    const config = parseSquareConfig((await conn()).config);
    expect(config.serviceWriteRejections['VAR_FADE']).toMatchObject({ changeId: id, code: 'INVALID_VALUE' });
    const fade = config.snapshot?.services.find((s) => s.variationId === 'VAR_FADE');
    expect(fade && classifyVariation(fade, config.snapshot?.businessProfile ?? null, config.serviceConfirmations, config.serviceWriteRejections).label).toBe('book_in_square');
    expect((await handle.db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id))).map((a) => a.action)).toContain('booking.change_rejected');

    await setUp();
    fake.scenario.failOnce = { write: { status: 403, code: 'MERCHANT_SUBSCRIPTION_NOT_FOUND', category: 'MERCHANT_SUBSCRIPTION_ERROR', detail: 'No subscription' } };
    const plan = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), plan, ON);
    expect(await change(plan)).toMatchObject({ status: 'not_allowed', httpStatus: 403, errorCode: 'MERCHANT_SUBSCRIPTION_NOT_FOUND' });
    expect((await conn()).capabilities).toMatchObject({ writesSuspendedReason: 'plan' });
    // Paused: the next change is refused before anything is sent.
    fake.calls.length = 0;
    const next = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), next, ON);
    expect((await change(next)).status).toBe('not_allowed');
    expect(writes()).toHaveLength(0);
  });

  it('warns when Square accepted a booking that overlaps another one for the same barber', async () => {
    fake.scenario.bookings = [fakeBooking({ id: 'BK_OTHER', startAt: at(15 * 60_000), customerId: null, teamMemberId: 'TM_SAM' })];
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    const id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    const row = await change(id);
    expect(row.status).toBe('confirmed');
    expect(row.statusMessage).toMatch(/overlaps another booking for Sam\. Check Square\./);
  });

  it('refuses to send after the owner reconnected another Square account, and after a disconnect', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    const id = await makeChange('create', createRequest(at(0)));
    await handle.db.update(schema.squareBookingChanges).set({ merchantId: 'SOMEONE_ELSE' }).where(eq(schema.squareBookingChanges.id, id));
    await runBookingChange(ctx, fakeRun(), id, ON);
    expect((await change(id)).statusMessage).toMatch(/disconnected or switched/);
    const other = await makeChange('create', createRequest(at(0)));
    await handle.db.update(schema.integrationConnections).set({ status: 'disconnected' }).where(eq(schema.integrationConnections.provider, 'square'));
    await runBookingChange(ctx, fakeRun(), other, ON);
    expect((await change(other)).status).toBe('not_allowed');
    expect(writes()).toHaveLength(0);
  });

  /** Creates the three step rows the web app creates when the owner approves a self-test. */
  async function makeSelfTest(startAt: string) {
    const selfTestId = newId();
    await makeChange('create', { ...createRequest(startAt), sellerNote: 'Studio Assistant self-test' }, { selfTestId, id: selfTestChangeId(selfTestId, 'create') });
    await makeChange('reschedule', {}, { selfTestId, id: selfTestChangeId(selfTestId, 'reschedule') });
    await makeChange('cancel', {}, { selfTestId, id: selfTestChangeId(selfTestId, 'cancel') });
    await handle.db.update(schema.integrationConnections).set({ capabilities: { ...(await conn()).capabilities, selfTestStatus: 'running', writesEnabled: false } }).where(eq(schema.integrationConnections.provider, 'square'));
    return selfTestId;
  }

  it('self-test: books, moves by one free slot and cancels; resumes after a crash without booking twice', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) }), fakeSlot({ startAt: at(HOUR) })];
    // The switch is off and the test has not passed yet: a self-test only needs checklist lines 1–3.
    await setUp({ selfTestStatus: 'none', writesEnabled: false });
    const selfTestId = await makeSelfTest(at(0));
    // The worker dies while moving (Square applied the move; the answer was lost), then the queue retries the test.
    fake.scenario.dropWriteResponses = 1;
    fake.scenario.dropWriteKinds = ['update'];
    await expect(handleSquareSelfTest(ctx, fakeRun({ willRetry: true }), { selfTestId }, ON)).rejects.toThrow();
    expect((await change(selfTestChangeId(selfTestId, 'create'))).status).toBe('confirmed');
    expect((await change(selfTestChangeId(selfTestId, 'reschedule'))).status).toBe('submitted');
    const run = fakeRun({ willRetry: true });
    await handleSquareSelfTest(ctx, run, { selfTestId }, ON);
    for (const kind of ['create', 'reschedule', 'cancel'] as const) expect((await change(selfTestChangeId(selfTestId, kind))).status).toBe('confirmed');
    const moved = await change(selfTestChangeId(selfTestId, 'reschedule'));
    expect(moved.request.startAt).toBe(at(HOUR));
    // One create, the move sent twice with the same key, one cancel.
    const kinds = writes().map((w) => `${w.method} ${w.path.endsWith('/cancel') ? 'cancel' : w.method === 'POST' ? 'create' : 'update'} ${String(w.body?.['idempotency_key'])}`);
    expect(kinds.filter((k) => k.includes(' create '))).toHaveLength(1);
    expect(new Set(kinds.filter((k) => k.includes(' update ')))).toEqual(new Set([`PUT update sabc_${selfTestChangeId(selfTestId, 'reschedule')}`]));
    expect(kinds.filter((k) => k.includes(' cancel '))).toHaveLength(1);
    expect(fake.scenario.bookings.filter((b) => b['source'] === 'API').map((b) => b['status'])).toEqual(['CANCELLED_BY_SELLER']);
    expect((await conn()).capabilities).toMatchObject({ selfTestStatus: 'passed', selfTestId, selfTestEnvironment: 'sandbox', selfTestMerchantId: fake.scenario.merchantId, selfTestFailure: '' });
    expect(run.messages.at(-1)).toMatch(/Self-test passed/);
    expect((await handle.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'integration.square.self_test_passed'))).length).toBeGreaterThan(0);
  });

  it('self-test: a failed move still cancels; a failed cancel reports the test booking left in Square', async () => {
    // No other free time that day: the move cannot run, the cancel still does.
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    await setUp({ selfTestStatus: 'none', writesEnabled: false });
    let selfTestId = await makeSelfTest(at(0));
    await handleSquareSelfTest(ctx, fakeRun(), { selfTestId }, ON);
    expect((await change(selfTestChangeId(selfTestId, 'reschedule'))).status).toBe('slot_unavailable');
    expect((await change(selfTestChangeId(selfTestId, 'cancel'))).status).toBe('confirmed');
    let caps = (await conn()).capabilities;
    expect(caps).toMatchObject({ selfTestStatus: 'failed' });
    expect(String(caps['selfTestFailure'])).toMatch(/^Moving failed: Not run: Square had no other free time/);
    expect(String(caps['selfTestFailure'])).not.toMatch(/may still be in Square/);

    // The cancel is refused: the owner is told a test booking may still be in Square, with its time.
    fake.scenario.availabilities = [fakeSlot({ startAt: at(DAY) }), fakeSlot({ startAt: at(DAY + HOUR) })];
    await setUp({ selfTestStatus: 'none', writesEnabled: false });
    selfTestId = await makeSelfTest(at(DAY));
    fake.scenario.failNextWrite = { kind: 'cancel', error: { status: 400, code: 'BAD_REQUEST', detail: 'Cannot cancel' } };
    await handleSquareSelfTest(ctx, fakeRun(), { selfTestId }, ON);
    expect((await change(selfTestChangeId(selfTestId, 'reschedule'))).status).toBe('confirmed');
    expect((await change(selfTestChangeId(selfTestId, 'cancel'))).status).toBe('rejected');
    caps = (await conn()).capabilities;
    expect(caps['selfTestStatus']).toBe('failed');
    expect(String(caps['selfTestFailure'])).toMatch(/^Cancelling failed: .*A test booking may still be in Square for .* (AEDT|AEST)\. Cancel it in Square\.$/);
  });

  // ---- Review fixes (G5 round 1) -------------------------------------------------------------------------------

  it('self-test: a 400 on the move for the only confirmed service still sends the clean-up cancel (R1)', async () => {
    // VAR_BEARD carries a no-show fee in the fake, so VAR_FADE is the only bookable service.
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) }), fakeSlot({ startAt: at(HOUR) })];
    await setUp({ selfTestStatus: 'none', writesEnabled: false });
    const selfTestId = await makeSelfTest(at(0));
    fake.scenario.failNextWrite = { kind: 'update', error: { status: 400, code: 'INVALID_VALUE', detail: 'Not allowed for this service' } };
    await handleSquareSelfTest(ctx, fakeRun(), { selfTestId }, ON);
    expect((await change(selfTestChangeId(selfTestId, 'reschedule'))).status).toBe('rejected');
    // The move's refusal marked the only confirmed service "Book in Square", yet the cancel is still sent.
    expect(parseSquareConfig((await conn()).config).serviceWriteRejections['VAR_FADE']).toBeDefined();
    expect(await change(selfTestChangeId(selfTestId, 'cancel'))).toMatchObject({ status: 'confirmed' });
    expect(writes().filter((w) => w.path.endsWith('/cancel'))).toHaveLength(1);
    expect(fake.scenario.bookings.filter((b) => b['source'] === 'API').map((b) => b['status'])).toEqual(['CANCELLED_BY_SELLER']);
    const caps = (await conn()).capabilities;
    expect(caps['selfTestStatus']).toBe('failed');
    expect(String(caps['selfTestFailure'])).toMatch(/^Moving failed: Square refused the change\./);
    expect(String(caps['selfTestFailure'])).not.toMatch(/may still be in Square/);
  });

  it('self-test: stopped by the owner, it is closed and recorded instead of staying "running" (R2)', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) }), fakeSlot({ startAt: at(HOUR) })];
    await setUp({ selfTestStatus: 'none', writesEnabled: false });
    const selfTestId = await makeSelfTest(at(0));
    const run = fakeRun({ willRetry: true });
    run.abort();
    await expect(handleSquareSelfTest(ctx, run, { selfTestId }, ON)).rejects.toThrow();
    for (const kind of ['create', 'reschedule', 'cancel'] as const) {
      expect(await change(selfTestChangeId(selfTestId, kind))).toMatchObject({ status: 'cancelled', submittedAt: null });
    }
    const caps = (await conn()).capabilities;
    expect(caps).toMatchObject({ selfTestStatus: 'failed', selfTestId });
    expect(String(caps['selfTestFailure'])).toMatch(/^Booking failed: Stopped before anything was sent to Square\.$/);
    expect(writes()).toHaveLength(0);
  });

  it('self-test: stopped after the booking was made, it reports the booking left in Square (R2)', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) }), fakeSlot({ startAt: at(HOUR) })];
    await setUp({ selfTestStatus: 'none', writesEnabled: false });
    const selfTestId = await makeSelfTest(at(0));
    // The booking is made, then the owner stops the test while it moves it.
    const run = fakeRun({ willRetry: false });
    const progress = run.progress;
    run.progress = async (fraction, message) => {
      if (message === 'Moving…') run.abort();
      return progress(fraction, message);
    };
    await expect(handleSquareSelfTest(ctx, run, { selfTestId }, ON)).rejects.toThrow();
    expect((await change(selfTestChangeId(selfTestId, 'create'))).status).toBe('confirmed');
    expect((await change(selfTestChangeId(selfTestId, 'reschedule'))).status).toBe('cancelled');
    expect((await change(selfTestChangeId(selfTestId, 'cancel'))).status).toBe('cancelled');
    const caps = (await conn()).capabilities;
    expect(caps['selfTestStatus']).toBe('failed');
    expect(String(caps['selfTestFailure'])).toMatch(/^Moving failed: .*A test booking may still be in Square for .* (AEDT|AEST)\. Cancel it in Square\.$/);
  });

  it('settling an unknown cancel: a client cancel online is not reported as ours (R6)', async () => {
    fake.scenario.bookings = [fakeBooking({ id: 'BK_GONE', startAt: at(0), customerId: 'CUST_JORDAN', version: 3, status: 'CANCELLED_BY_CUSTOMER' })];
    const id = await makeChange('cancel', { expectedVersion: 2 }, { squareBookingId: 'BK_GONE' });
    await handle.db.update(schema.squareBookingChanges).set({ status: 'unknown', submittedAt: new Date() }).where(eq(schema.squareBookingChanges.id, id));
    const s = await openSquare(ctx, fakeRun());
    if ('skip' in s) throw new Error(s.skip);
    expect(await settleUnknownChanges(ctx, s)).toBe(0);
    expect(await change(id)).toMatchObject({ status: 'changed_in_square', statusMessage: 'The client cancelled this in Square.' });
    // A seller cancel at a later version is ours.
    fake.scenario.bookings = [fakeBooking({ id: 'BK_SELLER', startAt: at(0), customerId: 'CUST_JORDAN', version: 3, status: 'CANCELLED_BY_SELLER' })];
    const ours = await makeChange('cancel', { expectedVersion: 2 }, { squareBookingId: 'BK_SELLER' });
    await handle.db.update(schema.squareBookingChanges).set({ status: 'unknown', submittedAt: new Date() }).where(eq(schema.squareBookingChanges.id, ours));
    expect(await settleUnknownChanges(ctx, s)).toBe(1);
    expect(await change(ours)).toMatchObject({ status: 'confirmed', statusMessage: 'Cancelled in Square. (Square shows it, so it was made.)' });
  });

  it('a disconnect after submitted_at but before the call sends nothing (R7)', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    const id = await makeChange('create', createRequest(at(0)));
    const run = fakeRun();
    const progress = run.progress;
    run.progress = async (fraction, message) => {
      if (message === 'Sending to Square…') await handle.db.update(schema.integrationConnections).set({ status: 'disconnected' }).where(eq(schema.integrationConnections.provider, 'square'));
      return progress(fraction, message);
    };
    await runBookingChange(ctx, run, id, ON);
    expect(await change(id)).toMatchObject({ status: 'not_allowed' });
    expect((await change(id)).statusMessage).toMatch(/disconnected or switched.*Nothing was sent/);
    expect(writes()).toHaveLength(0);
    expect((await handle.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, 'booking.change_submitted')))).length).toBe(0);
  });

  it('a 404 on a create is rejected without marking the service "Book in Square" (R8)', async () => {
    fake.scenario.availabilities = [fakeSlot({ startAt: at(0) })];
    fake.scenario.failNextWrite = { kind: 'create', error: { status: 404, code: 'NOT_FOUND', detail: 'Customer not found' } };
    const id = await makeChange('create', createRequest(at(0)));
    await runBookingChange(ctx, fakeRun(), id, ON);
    const row = await change(id);
    expect(row).toMatchObject({ status: 'rejected', httpStatus: 404 });
    expect(row.statusMessage).not.toMatch(/Book in Square/);
    expect(parseSquareConfig((await conn()).config).serviceWriteRejections).toEqual({});
  });
});
