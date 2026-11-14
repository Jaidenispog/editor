import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Square booking changes (Tier 1, WP6b) in the web app against a throwaway database (TEST_DATABASE_URL): the routes
 * refuse every change while booking changes are not available (the shipped default), and the changes, self-test and
 * switch logic is exercised with the test-only `tier1Available` option. Covers the change-route refusals (role,
 * checklist, fresh search, slot, service label, booking state and version, one change at a time), the recorded
 * request and job, withdrawing, the self-test refusals and its three step rows, the switch (lines 1–4, clearing a
 * pause), booking detail actions per role, and withdrawing queued changes on disconnect. Nothing calls Square from the
 * web app; the queue and database are real. Skipped when TEST_DATABASE_URL is unset.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

type User = { id: string; email: string; displayName: string; role: 'owner' | 'staff' };
const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: User; expiresAt: Date } }));
vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));
vi.mock('../src/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/env')>();
  const { loadEnv } = await import('@studio/config');
  return { ...actual, getEnv: () => loadEnv({ ...process.env }) };
});

const ORIGIN = 'http://localhost:3000';
const ON = { tier1Available: true };
const HOUR = 3600_000;
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: any }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { origin: ORIGIN } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

suite('Square booking changes in the web app (database-backed)', () => {
  const dbName = `sa_sqchg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;
  const ids = { customer: randomUUID(), sandboxOnly: randomUUID(), future: randomUUID(), pending: randomUUID(), search: randomUUID(), moveSearch: randomUUID() };
  const slotAt = new Date(Math.ceil((Date.now() + 3 * 24 * HOUR) / (15 * 60_000)) * 15 * 60_000).toISOString();
  const soonAt = new Date(Math.ceil((Date.now() + 5 * HOUR) / (15 * 60_000)) * 15 * 60_000).toISOString();

  const db = async () => (await import('../src/lib/db')).getDb();
  const schema = async () => (await import('@studio/db')).schema;
  const signIn = (user: User) => {
    auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + HOUR) };
  };
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    merchantName: 'Ivanhoe Test Barbers',
    locations: [{ id: 'LOC_1', name: 'Ivanhoe', timezone: 'Australia/Melbourne', status: 'ACTIVE', bookingSiteUrl: null }],
    businessProfile: { bookingEnabled: true, bookingPolicy: 'ACCEPT_ALL', allowUserCancel: true, supportSellerLevelWrites: true, cancellationWindowSeconds: null, cancellationFee: null, cancellationPolicy: null, minLeadSeconds: null, maxLeadSeconds: null },
    teamMembers: [{ id: 'TM_SAM', displayName: 'Sam', isBookable: true }],
    services: [
      { itemId: 'I1', itemName: 'Skin fade', variationId: 'VAR_FADE', variationName: 'Regular', version: '7', durationMinutes: 45, price: null, availableForBooking: true, teamMemberIds: ['TM_SAM'], archived: false, noShowFeeSeen: null },
      { itemId: 'I2', itemName: 'Beard trim', variationId: 'VAR_BEARD', variationName: 'Regular', version: '3', durationMinutes: 30, price: null, availableForBooking: true, teamMemberIds: ['TM_SAM'], archived: false, noShowFeeSeen: null },
    ],
  };
  const readyCaps = { readScopesOk: true, writeScopesOk: true, sellerLevelWrites: true, writesEnabled: true, writesSuspendedReason: '', selfTestStatus: 'passed', selfTestEnvironment: 'sandbox', selfTestMerchantId: 'MERCHANT_FAKE_1' };
  const allScopes = ['APPOINTMENTS_READ', 'APPOINTMENTS_ALL_READ', 'APPOINTMENTS_BUSINESS_SETTINGS_READ', 'CUSTOMERS_READ', 'ITEMS_READ', 'MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'ORDERS_READ', 'APPOINTMENTS_WRITE', 'APPOINTMENTS_ALL_WRITE'];

  /** A connected sandbox account with every checklist line ticked (except where `caps` says otherwise). */
  async function connect(caps: Record<string, string | number | boolean | null> = readyCaps, scopes = allScopes) {
    const d = await db();
    const s = await schema();
    await d.delete(s.squareBookingChanges);
    await d.delete(s.integrationConnections);
    await d.insert(s.integrationConnections).values({
      id: randomUUID(),
      provider: 'square',
      status: 'connected',
      externalAccountId: 'MERCHANT_FAKE_1',
      scopes,
      lastSyncAt: new Date(),
      config: { environment: 'sandbox', locationId: 'LOC_1', snapshot, serviceConfirmations: { VAR_FADE: { version: '7', confirmedBy: owner.id, confirmedAt: new Date().toISOString() } } },
      capabilities: caps,
    });
  }
  async function freshSearch(id: string, bookingId: string | null, fetchedAt = new Date(), at = slotAt) {
    const d = await db();
    const s = await schema();
    await d.delete(s.squareAvailabilitySearches).where((await import('drizzle-orm')).eq(s.squareAvailabilitySearches.id, id));
    await d.insert(s.squareAvailabilitySearches).values({
      id,
      environment: 'sandbox',
      params: { serviceVariationId: 'VAR_FADE', teamMemberId: null, fromDate: at.slice(0, 10), days: 3, bookingId },
      status: 'done',
      slots: [{ startAt: at, teamMemberId: 'TM_SAM', durationMinutes: 45, serviceVariationId: 'VAR_FADE', serviceVariationVersion: '7' }],
      fetchedAt,
    });
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    process.env.DATABASE_URL = url.toString();
    process.env.APP_URL = ORIGIN;
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';
    process.env.SQUARE_APPLICATION_ID = 'fake-square-app';
    process.env.SQUARE_APPLICATION_SECRET = 'fake-square-secret';
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    const d = await db();
    const s = await schema();
    const mk = async (role: 'owner' | 'staff', name: string): Promise<User> => {
      const u = { id: randomUUID(), email: `${name.toLowerCase()}@example.com`, displayName: name, role };
      await d.insert(s.users).values({ ...u, passwordHash: 'x' });
      return u;
    };
    owner = await mk('owner', 'Owner');
    staff = await mk('staff', 'Sam');
    await d.insert(s.customers).values([
      { id: ids.customer, squareCustomerId: 'CUST_1', givenName: 'Jordan', familyName: 'Lee', squareEnvironment: 'sandbox' },
      { id: ids.sandboxOnly, squareCustomerId: 'CUST_LIVE', givenName: 'Live', familyName: 'Only', squareEnvironment: 'production' },
    ]);
    const booking = (id: string, squareId: string, status: string) => ({
      id,
      squareBookingId: squareId,
      squareVersion: 2,
      customerId: ids.customer,
      squareCustomerId: 'CUST_1',
      locationId: 'LOC_1',
      teamMemberId: 'TM_SAM',
      serviceName: 'Skin fade',
      serviceVariationId: 'VAR_FADE',
      startAt: new Date(Date.now() + 2 * 24 * HOUR),
      endAt: new Date(Date.now() + 2 * 24 * HOUR + 45 * 60_000),
      durationMinutes: 45,
      status,
      squareEnvironment: 'sandbox',
    });
    await d.insert(s.bookings).values([booking(ids.future, 'BK_FUT', 'ACCEPTED'), booking(ids.pending, 'BK_PEND', 'PENDING')]);
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    for (const k of ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET']) delete process.env[k];
  }, 60_000);

  beforeEach(async () => {
    await connect();
    await freshSearch(ids.search, null);
    await freshSearch(ids.moveSearch, ids.future);
  });

  it('refuses every change, the self-test and the switch while booking changes are not available (the shipped default)', async () => {
    const changes = await import('../src/app/api/appointments/changes/route');
    const selfTest = await import('../src/app/api/integrations/square/self-test/route');
    const card = await import('../src/app/api/integrations/square/route');
    const detail = await import('../src/app/api/appointments/[id]/route');
    signIn(staff);
    expect((await call(changes.POST, 'POST', '/api/appointments/changes', {}, { kind: 'cancel', bookingId: ids.future, expectedVersion: 2 })).status).toBe(403);
    signIn(owner);
    const refused = await call(changes.POST, 'POST', '/api/appointments/changes', {}, { kind: 'create', customerId: ids.customer, serviceVariationId: 'VAR_FADE', teamMemberId: 'TM_SAM', startAt: slotAt, availabilitySearchId: ids.search });
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toMatch(/aren’t available yet/);
    expect((await call(changes.POST, 'POST', '/api/appointments/changes', {}, { kind: 'create', customerId: ids.customer })).status).toBe(400);
    const test = await call(selfTest.POST, 'POST', '/api/integrations/square/self-test', {}, { customerId: ids.customer, serviceVariationId: 'VAR_FADE', teamMemberId: 'TM_SAM', startAt: slotAt, availabilitySearchId: ids.search, acknowledgeLive: false });
    expect(test.status).toBe(422);
    expect((await call(card.PATCH, 'PATCH', '/api/integrations/square', {}, { writesEnabled: true })).status).toBe(409);
    const st = (await call(card.GET, 'GET', '/api/integrations/square')).json;
    expect(st.tier1).toMatchObject({ available: false, ready: false, canEnable: false, canGivePermission: false });
    expect(st.selfTest).toMatchObject({ canRun: false });
    const d = (await call(detail.GET, 'GET', `/api/appointments/${ids.future}`, { id: ids.future })).json;
    expect(d.actions.move).toMatchObject({ allowed: false });
    expect(d.actions.cancel.reason).toMatch(/not switched on/);
    const s = await schema();
    expect(await (await db()).select().from(s.squareBookingChanges)).toHaveLength(0);
  });

  it('records an approved booking with the slot Square returned, queues the one writer and audits (never the key)', async () => {
    const { requestBookingChange } = await import('../src/lib/square/changes');
    const { eq } = await import('drizzle-orm');
    const d = await db();
    const s = await schema();
    const r = await requestBookingChange({ kind: 'create', customerId: ids.customer, serviceVariationId: 'VAR_FADE', teamMemberId: 'TM_SAM', startAt: slotAt, availabilitySearchId: ids.search, sellerNote: '  Bring the clippers  ' }, owner, d, ON);
    expect(r.change).toMatchObject({ kind: 'create', status: 'queued', done: false, canWithdraw: true, statusLabel: 'Waiting to start' });
    expect(JSON.stringify(r.change)).not.toMatch(/sabc_|CUST_1/);
    expect(r.change.startLabel).toMatch(/ (AEDT|AEST)$/);
    const row = (await d.select().from(s.squareBookingChanges).where(eq(s.squareBookingChanges.id, r.change.id)))[0]!;
    expect(row).toMatchObject({ environment: 'sandbox', merchantId: 'MERCHANT_FAKE_1', idempotencyKey: `sabc_${row.id}`, requestedBy: owner.id, submittedAt: null });
    expect(row.request).toEqual({ locationId: 'LOC_1', squareCustomerId: 'CUST_1', serviceVariationId: 'VAR_FADE', serviceVariationVersion: '7', teamMemberId: 'TM_SAM', durationMinutes: 45, startAt: slotAt, availabilitySearchId: ids.search, sellerNote: 'Bring the clippers' });
    const job = (await d.select().from(s.jobs).where(eq(s.jobs.id, r.jobId)))[0]!;
    expect(job).toMatchObject({ type: 'square.booking_change', refId: row.id, payload: { changeId: row.id } });
    const audit = await d.select().from(s.auditLog).where(eq(s.auditLog.action, 'booking.change_requested'));
    expect(audit.at(-1)?.data).toEqual({ kind: 'create', environment: 'sandbox', startAt: slotAt });

    // Poll and withdraw while it is still queued; a second withdraw is refused.
    const get = await import('../src/app/api/appointments/changes/[id]/route');
    const cancel = await import('../src/app/api/appointments/changes/[id]/cancel/route');
    signIn(staff);
    expect((await call(get.GET, 'GET', `/api/appointments/changes/${row.id}`, { id: row.id })).json).toMatchObject({ status: 'queued' });
    expect((await call(cancel.POST, 'POST', `/api/appointments/changes/${row.id}/cancel`, { id: row.id })).status).toBe(403);
    signIn(owner);
    expect((await call(cancel.POST, 'POST', `/api/appointments/changes/${row.id}/cancel`, { id: row.id })).json).toMatchObject({ status: 'cancelled', done: true, canWithdraw: false });
    expect((await call(cancel.POST, 'POST', `/api/appointments/changes/${row.id}/cancel`, { id: row.id })).status).toBe(409);
  });

  it('refuses a change that does not match what Square offered or what the owner saw', async () => {
    const { requestBookingChange } = await import('../src/lib/square/changes');
    const d = await db();
    const create = (over: Record<string, unknown> = {}) => requestBookingChange({ kind: 'create', customerId: ids.customer, serviceVariationId: 'VAR_FADE', teamMemberId: 'TM_SAM', startAt: slotAt, availabilitySearchId: ids.search, ...over } as never, owner, d, ON);
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);
    // A search older than 5 minutes, a time that is not in it, and another service's search.
    await freshSearch(ids.search, null, new Date(Date.now() - 6 * 60_000));
    expect(await code(create())).toMatch(/^VALIDATION: .*5 minutes old/);
    await freshSearch(ids.search, null);
    expect(await code(create({ startAt: new Date(Date.parse(slotAt) + 15 * 60_000).toISOString() }))).toMatch(/^VALIDATION: .*not in the free times/);
    expect(await code(create({ teamMemberId: 'TM_ALEX' }))).toMatch(/^VALIDATION/);
    // The beard trim is not confirmed free of no-show fees; a client from the other environment is refused.
    expect(await code(create({ serviceVariationId: 'VAR_BEARD' }))).toMatch(/^UNSUPPORTED: Confirm in Square/);
    expect(await code(create({ customerId: ids.sandboxOnly }))).toMatch(/^VALIDATION: Choose a client copied from Square/);
    // A time that has passed since the search is refused.
    const past = new Date(Date.now() - HOUR).toISOString();
    await freshSearch(ids.search, null, new Date(), past);
    expect(await code(create({ startAt: past }))).toBe('VALIDATION: That time has passed. Choose a later one.');
    await freshSearch(ids.search, null);

    // Reschedule and cancel: the version the owner saw, Square's status, one change at a time.
    const move = (over: Record<string, unknown> = {}) => requestBookingChange({ kind: 'reschedule', bookingId: ids.future, startAt: slotAt, teamMemberId: 'TM_SAM', availabilitySearchId: ids.moveSearch, expectedVersion: 2, ...over } as never, owner, d, ON);
    expect(await code(move({ expectedVersion: 1 }))).toMatch(/^CONFLICT: This booking changed in Square/);
    expect(await code(move({ availabilitySearchId: ids.search }))).toMatch(/^VALIDATION: That time was found for a different booking/);
    expect(await code(requestBookingChange({ kind: 'cancel', bookingId: ids.pending, expectedVersion: 2 }, owner, d, ON))).toBe('UNSUPPORTED: Accept or decline this request in Square.');
    expect(await code(requestBookingChange({ kind: 'cancel', bookingId: ids.future, expectedVersion: 2 }, staff, d, ON))).toBe('UNSUPPORTED: Only the owner can change bookings.');
    expect(await code(move())).toBe('ok');
    expect(await code(requestBookingChange({ kind: 'cancel', bookingId: ids.future, expectedVersion: 2 }, owner, d, ON))).toMatch(/^CONFLICT: A change to this booking is already being made/);

    // A paused or switched-off checklist refuses with the plain reason.
    await connect({ ...readyCaps, writesSuspendedReason: 'plan' });
    expect(await code(requestBookingChange({ kind: 'cancel', bookingId: ids.future, expectedVersion: 2 }, owner, d, ON))).toMatch(/^UNSUPPORTED: Paused: Square refused because of your Appointments plan/);
    await connect({ ...readyCaps, writesEnabled: false });
    expect(await code(requestBookingChange({ kind: 'cancel', bookingId: ids.future, expectedVersion: 2 }, owner, d, ON))).toMatch(/switched off/);
  });

  it('booking detail offers Move and Cancel to the owner only, and lists the changes made from here', async () => {
    const { getBookingDetail } = await import('../src/lib/square/appointments');
    const { requestBookingChange } = await import('../src/lib/square/changes');
    const d = await db();
    const ownerView = await getBookingDetail(ids.future, owner, d, new Date(), ON);
    expect(ownerView.actions).toEqual({ move: { allowed: true, reason: null }, cancel: { allowed: true, reason: null } });
    expect(ownerView).toMatchObject({ squareVersion: 2, serviceVariationId: 'VAR_FADE', changes: [] });
    expect((await getBookingDetail(ids.future, staff, d, new Date(), ON)).actions.move.reason).toBe('Only the owner can change bookings.');
    expect((await getBookingDetail(ids.pending, owner, d, new Date(), ON)).actions.cancel.allowed).toBe(false);
    await requestBookingChange({ kind: 'cancel', bookingId: ids.future, expectedVersion: 2 }, owner, d, ON);
    const after = await getBookingDetail(ids.future, owner, d, new Date(), ON);
    expect(after.changes.map((c) => [c.kind, c.status])).toEqual([['cancel', 'queued']]);
  });

  it('self-test: refuses too soon, a running test and an unacknowledged live test; creates three fixed step rows', async () => {
    const { requestSelfTest } = await import('../src/lib/square/changes');
    const { getSquareStatus } = await import('../src/lib/square/status');
    const { eq } = await import('drizzle-orm');
    const d = await db();
    const s = await schema();
    await connect({ ...readyCaps, selfTestStatus: 'none', writesEnabled: false });
    const st = await getSquareStatus(owner, d, new Date(), ON);
    expect(st.selfTest).toMatchObject({ status: 'none', canRun: true, runReason: null });
    expect(st.tier1).toMatchObject({ available: true, canEnable: false, canGivePermission: false });
    expect(st.tier1.enableReason).toMatch(/self-test/);
    const input = { customerId: ids.customer, serviceVariationId: 'VAR_FADE', teamMemberId: 'TM_SAM', startAt: slotAt, availabilitySearchId: ids.search, acknowledgeLive: false };
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);
    // Less than 2 days ahead.
    await freshSearch(ids.search, null, new Date(), soonAt);
    expect(await code(requestSelfTest({ ...input, startAt: soonAt }, owner, d, ON))).toMatch(/^VALIDATION: Choose a time at least 2 days ahead/);
    await freshSearch(ids.search, null);
    // Without write permissions the test cannot run (checklist line 2).
    await connect({ ...readyCaps, selfTestStatus: 'none' }, allScopes.slice(0, 8));
    expect(await code(requestSelfTest(input, owner, d, ON))).toMatch(/^UNSUPPORTED: .*permission/);
    await connect({ ...readyCaps, selfTestStatus: 'none', writesEnabled: false });
    const started = await requestSelfTest(input, owner, d, ON);
    const rows = await d.select().from(s.squareBookingChanges).where(eq(s.squareBookingChanges.selfTestId, started.selfTestId));
    expect(rows.map((r) => [r.id, r.kind, r.status, r.idempotencyKey]).sort()).toEqual(
      (['cancel', 'create', 'reschedule'] as const).map((k) => [`${started.selfTestId}-${k}`, k, 'queued', `sabc_${started.selfTestId}-${k}`]),
    );
    expect(rows.find((r) => r.kind === 'create')?.request).toMatchObject({ squareCustomerId: 'CUST_1', startAt: slotAt, teamMemberId: 'TM_SAM' });
    expect((await d.select().from(s.jobs).where(eq(s.jobs.id, started.jobId)))[0]).toMatchObject({ type: 'square.self_test', refId: started.selfTestId });
    const running = await getSquareStatus(owner, d, new Date(), ON);
    expect(running.selfTest).toMatchObject({ status: 'running', canRun: false });
    expect(running.selfTest.steps.map((x) => x.kind)).toEqual(['create', 'reschedule', 'cancel']);
    expect(await code(requestSelfTest(input, owner, d, ON))).toMatch(/^CONFLICT: A self-test is already running/);

    // Live Square: the owner must tick that these are real bookings.
    process.env.SQUARE_ENVIRONMENT = 'production';
    try {
      await d.delete(s.squareBookingChanges);
      await d.update(s.integrationConnections).set({ config: { environment: 'production', locationId: 'LOC_1', snapshot, serviceConfirmations: { VAR_FADE: { version: '7', confirmedBy: owner.id, confirmedAt: 'x' } } } }).where(eq(s.integrationConnections.provider, 'square'));
      await d.update(s.customers).set({ squareEnvironment: 'production' }).where(eq(s.customers.id, ids.customer));
      await d.update(s.squareAvailabilitySearches).set({ environment: 'production' }).where(eq(s.squareAvailabilitySearches.id, ids.search));
      expect(await code(requestSelfTest(input, owner, d, ON))).toMatch(/^VALIDATION: Tick “I understand these are real bookings in Square”/);
    } finally {
      process.env.SQUARE_ENVIRONMENT = 'sandbox';
      await d.update(s.customers).set({ squareEnvironment: 'sandbox' }).where(eq(s.customers.id, ids.customer));
    }
  });

  it('the switch turns on only with lines 1–4 ticked, and turning it on again clears a pause', async () => {
    const { updateSquareSettings, getSquareStatus } = await import('../src/lib/square/status');
    const { eq } = await import('drizzle-orm');
    const d = await db();
    const s = await schema();
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);
    await connect({ ...readyCaps, writesEnabled: false, selfTestStatus: 'failed' });
    expect(await code(updateSquareSettings(owner, { writesEnabled: true }, d, ON))).toMatch(/^CONFLICT: The self-test hasn’t passed/);
    await connect({ ...readyCaps, writesEnabled: false, writesSuspendedReason: 'plan' });
    expect((await getSquareStatus(owner, d, new Date(), ON)).tier1).toMatchObject({ canEnable: true, switchOn: false, summary: 'Paused: Square refused because of your Appointments plan.' });
    expect(await code(updateSquareSettings(owner, { writesEnabled: true }, d, ON))).toBe('ok');
    const caps = (await d.select().from(s.integrationConnections).where(eq(s.integrationConnections.provider, 'square')))[0]!.capabilities;
    expect(caps).toMatchObject({ writesEnabled: true, writesSuspendedReason: '' });
    expect((await getSquareStatus(owner, d, new Date(), ON)).tier1).toMatchObject({ ready: true, switchOn: true });
    expect((await d.select().from(s.auditLog).where(eq(s.auditLog.action, 'integration.square.writes_enabled'))).length).toBe(1);
    expect(await code(updateSquareSettings(owner, { writesEnabled: false }, d, ON))).toBe('ok');
  });

  it('answers the client-notification question only after a self-test, and the dialog sentence follows it', async () => {
    const notify = await import('../src/app/api/integrations/square/self-test/notification/route');
    signIn(owner);
    await connect({ ...readyCaps, selfTestStatus: 'none' });
    expect((await call(notify.POST, 'POST', '/api/integrations/square/self-test/notification', {}, { answer: 'yes' })).status).toBe(409);
    await connect(readyCaps);
    const r = await call(notify.POST, 'POST', '/api/integrations/square/self-test/notification', {}, { answer: 'no' });
    expect(r.status).toBe(200);
    expect(r.json.tier1.notificationSentence).toBe('Square didn’t send a confirmation for the test booking, so let the client know yourself.');
    signIn(staff);
    expect((await call(notify.POST, 'POST', '/api/integrations/square/self-test/notification', {}, { answer: 'yes' })).status).toBe(403);
  });

  it('closes a queued change whose job was cancelled, and withdraws queued changes on disconnect', async () => {
    const { requestBookingChange, getBookingChange } = await import('../src/lib/square/changes');
    const { disconnectSquare } = await import('../src/lib/square/status');
    const { eq } = await import('drizzle-orm');
    const d = await db();
    const s = await schema();
    const first = await requestBookingChange({ kind: 'cancel', bookingId: ids.future, expectedVersion: 2 }, owner, d, ON);
    await d.update(s.jobs).set({ status: 'cancelled' }).where(eq(s.jobs.id, first.jobId));
    expect(await getBookingChange(first.change.id, d)).toMatchObject({ status: 'cancelled', statusMessage: 'Stopped before anything was sent to Square.' });
    const second = await requestBookingChange({ kind: 'cancel', bookingId: ids.future, expectedVersion: 2 }, owner, d, ON);
    await disconnectSquare(owner, false, d);
    expect((await d.select().from(s.squareBookingChanges).where(eq(s.squareBookingChanges.id, second.change.id)))[0]).toMatchObject({ status: 'cancelled', statusMessage: 'Square was disconnected.' });
  });
});
