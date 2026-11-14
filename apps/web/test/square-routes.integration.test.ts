import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { startFakeSquareServer, type FakeSquareServer } from '../../worker/test/fakes/square-server.js';
import { squareSignature } from '../src/lib/square/webhook';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Square routes against a throwaway database (TEST_DATABASE_URL) and a local fake of Square's token endpoint (the
 * worker's test fake): connect with read scopes only, the callback's state check, code exchange and environment
 * purge, the verified webhook (stored once, one job; bad signatures never stored), the bookings lists, attendance
 * marks (refused on Square NO_SHOW and before the start), clients (contact details for the owner only), services
 * and confirmations, availability searches, and disconnect with purge and revoke. The session lookup is replaced;
 * CSRF, validation, the database and the pg-boss queue are real. Nothing is sent to Square. Skipped when
 * TEST_DATABASE_URL is unset.
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
const HOOK_KEY = 'square-hook-key';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }): Promise<{ status: number; json: any; res: Response }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.clone().text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

const signIn = (user: User) => {
  auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + 3600_000) };
};

suite('Square routes (database-backed)', () => {
  const dbName = `sa_sqtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let fake: FakeSquareServer;
  let owner: User;
  let staff: User;
  const now = Date.now();
  const ids = { past: randomUUID(), noShow: randomUUID(), future: randomUUID(), customer: randomUUID() };

  const db = async () => (await import('../src/lib/db')).getDb();
  const schema = async () => (await import('@studio/db')).schema;

  beforeAll(async () => {
    fake = await startFakeSquareServer();
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
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = HOOK_KEY;
    process.env.SQUARE_API_BASE_URL = fake.url;
    const d = await db();
    const s = await schema();
    const mk = async (role: 'owner' | 'staff', name: string): Promise<User> => {
      const u = { id: randomUUID(), email: `${name.toLowerCase()}@example.com`, displayName: name, role };
      await d.insert(s.users).values({ ...u, passwordHash: 'x' });
      return u;
    };
    owner = await mk('owner', 'Owner');
    staff = await mk('staff', 'Sam');
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    await fake?.close();
    for (const k of ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_API_BASE_URL']) delete process.env[k];
  }, 60_000);

  it('shows the honest state before connecting and refuses actions that need Square', async () => {
    const r = await import('../src/app/api/integrations/square/route');
    const sync = await import('../src/app/api/integrations/square/sync/route');
    const list = await import('../src/app/api/appointments/route');
    signIn(staff);
    const st = await call(r.GET, 'GET', '/api/integrations/square');
    expect(st.json).toMatchObject({ state: 'not_connected', liveMode: 'sandbox', dataEnvironment: null, canManage: false, details: null });
    expect((await call(list.GET, 'GET', '/api/appointments?view=upcoming')).json).toEqual({ bookings: [], nextCursor: null, environment: null, syncedAt: null });
    signIn(owner);
    expect((await call(sync.POST, 'POST', '/api/integrations/square/sync')).status).toBe(409);
  });

  it('connects with read permissions only, checks the state, exchanges the code once and queues the first sync', async () => {
    const connect = await import('../src/app/api/integrations/square/connect/route');
    const callback = await import('../src/app/api/integrations/square/callback/route');
    signIn(staff);
    expect((await call(connect.GET, 'GET', '/api/integrations/square/connect')).status).toBe(403);
    signIn(owner);
    expect((await call(connect.GET, 'GET', '/api/integrations/square/connect?access=write')).status).toBe(422);
    const started = await call(connect.GET, 'GET', '/api/integrations/square/connect?access=read');
    expect(started.status).toBe(302);
    const target = new URL(started.res.headers.get('location')!);
    expect(target.origin).toBe(fake.url);
    expect(target.pathname).toBe('/oauth2/authorize');
    expect(target.searchParams.get('scope')).toBe('APPOINTMENTS_READ APPOINTMENTS_ALL_READ APPOINTMENTS_BUSINESS_SETTINGS_READ CUSTOMERS_READ ITEMS_READ MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ');
    expect(target.searchParams.get('session')).toBe('false');
    const cookie = started.res.headers.get('set-cookie')!.split(';')[0]!;
    const state = target.searchParams.get('state')!;

    const forged = await call(callback.GET, 'GET', `/api/integrations/square/callback?code=fake-square-code&state=wrong`, {}, undefined, { origin: ORIGIN, cookie });
    expect(new URL(forged.res.headers.get('location')!).searchParams.get('square_error')).toMatch(/could not be confirmed/);
    expect(fake.callsTo('token')).toHaveLength(0);
    const cancelled = await call(callback.GET, 'GET', `/api/integrations/square/callback?error=access_denied&state=${encodeURIComponent(state)}`, {}, undefined, { origin: ORIGIN, cookie });
    expect(new URL(cancelled.res.headers.get('location')!).searchParams.get('square_error')).toBe('Square connection was cancelled. Nothing was changed.');

    const ok = await call(callback.GET, 'GET', `/api/integrations/square/callback?code=fake-square-code&state=${encodeURIComponent(state)}`, {}, undefined, { origin: ORIGIN, cookie });
    expect(new URL(ok.res.headers.get('location')!).searchParams.get('square')).toBe('checking');
    expect(fake.callsTo('token')).toHaveLength(1);
    expect(fake.callsTo('token')[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'fake-square-code', client_id: 'fake-square-app', redirect_uri: `${ORIGIN}/api/integrations/square/callback` });
    const d = await db();
    const s = await schema();
    const { eq } = await import('drizzle-orm');
    const conn = (await d.select().from(s.integrationConnections).where(eq(s.integrationConnections.provider, 'square')))[0]!;
    expect(conn).toMatchObject({ status: 'connected', externalAccountId: 'MERCHANT_FAKE_1', config: { environment: 'sandbox' } });
    expect(conn.accessTokenEncrypted).not.toContain('fake-square-access');
    const jobs = await d.select().from(s.jobs).where(eq(s.jobs.type, 'square.sync'));
    expect(jobs.map((j) => j.payload)).toEqual([{ reason: 'connect' }]);
    const audit = await d.select().from(s.auditLog).where(eq(s.auditLog.action, 'integration.square.connected'));
    expect(JSON.stringify(audit)).not.toContain('fake-square-access');
  });

  it('receives verified webhooks once and never stores a bad signature', async () => {
    const hook = await import('../src/app/api/webhooks/square/route');
    const d = await db();
    const s = await schema();
    const { eq } = await import('drizzle-orm');
    const body = JSON.stringify({
      merchant_id: 'MERCHANT_FAKE_1',
      type: 'booking.created',
      event_id: 'evt-1',
      created_at: new Date().toISOString(),
      data: { type: 'booking', id: 'BK_1', object: { booking: { id: 'BK_1', customer_note: 'Allergic to lavender', seller_note: 'Call 0400 000 000' } } },
    });
    const sig = squareSignature(HOOK_KEY, `${ORIGIN}/api/webhooks/square`, body);
    const send = (b: string, signature: string) => call(hook.POST, 'POST', '/api/webhooks/square', {}, b, { 'x-square-hmacsha256-signature': signature });
    expect((await send(body, 'nope')).status).toBe(401);
    expect((await send(body, squareSignature(HOOK_KEY, `${ORIGIN}/api/webhooks/square/`, body))).status).toBe(401);
    expect((await send(body.replace('BK_1', 'BK_2'), sig)).status).toBe(401);
    expect(await d.select().from(s.webhookEvents)).toHaveLength(0);
    const first = await send(body, sig);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ ok: true, duplicate: false });
    expect((await send(body, sig)).json).toEqual({ ok: true, duplicate: true });
    const events = await d.select().from(s.webhookEvents);
    expect(events).toHaveLength(1);
    // Only the minimal envelope is kept: never Square's copy of the object (notes, contact details, amounts).
    expect(events[0]?.payload).toEqual({ event_id: 'evt-1', type: 'booking.created', merchant_id: 'MERCHANT_FAKE_1', created_at: expect.any(String), data: { type: 'booking', id: 'BK_1' } });
    expect(JSON.stringify(events[0]?.payload)).not.toMatch(/lavender|0400/);
    expect(await d.select().from(s.jobs).where(eq(s.jobs.type, 'webhook.process'))).toHaveLength(1);
    const conn = (await d.select().from(s.integrationConnections).where(eq(s.integrationConnections.provider, 'square')))[0]!;
    const seen = (conn.config as { lastWebhookAt?: string }).lastWebhookAt;
    expect(seen).toBeTruthy();

    // A correctly signed delivery for another merchant (or after a disconnect) does not count as "updates arriving".
    const lastSeen = async () => ((await d.select().from(s.integrationConnections).where(eq(s.integrationConnections.provider, 'square')))[0]!.config as { lastWebhookAt?: string }).lastWebhookAt;
    const other = JSON.stringify({ merchant_id: 'SOMEONE_ELSE', type: 'booking.updated', event_id: 'evt-other', created_at: new Date().toISOString(), data: { type: 'booking', id: 'BK_9' } });
    await new Promise((r) => setTimeout(r, 5));
    expect((await send(other, squareSignature(HOOK_KEY, `${ORIGIN}/api/webhooks/square`, other))).status).toBe(200);
    expect(await lastSeen()).toBe(seen);
    await d.update(s.integrationConnections).set({ status: 'disconnected' }).where(eq(s.integrationConnections.provider, 'square'));
    const later = JSON.stringify({ merchant_id: 'MERCHANT_FAKE_1', type: 'booking.updated', event_id: 'evt-late', created_at: new Date().toISOString(), data: { type: 'booking', id: 'BK_1' } });
    expect((await send(later, squareSignature(HOOK_KEY, `${ORIGIN}/api/webhooks/square`, later))).status).toBe(200);
    expect(await lastSeen()).toBe(seen);
    await d.update(s.integrationConnections).set({ status: 'connected' }).where(eq(s.integrationConnections.provider, 'square'));
  });

  it('lists bookings and lets owner and staff mark attendance, never over Square’s own NO_SHOW', async () => {
    const d = await db();
    const s = await schema();
    const { eq } = await import('drizzle-orm');
    await d.insert(s.customers).values({ id: ids.customer, squareCustomerId: 'CUST_1', givenName: 'Jordan', familyName: 'Lee', email: 'jordan@example.com', phone: '+61400000000', squareEnvironment: 'sandbox' });
    const row = (id: string, squareId: string, startOffset: number, status: string, attendance: string) => ({
      id,
      squareBookingId: squareId,
      customerId: ids.customer,
      squareCustomerId: 'CUST_1',
      locationId: 'LOC_1',
      teamMemberId: 'TM_SAM',
      serviceName: 'Skin fade',
      serviceVariationId: 'VAR_FADE',
      startAt: new Date(now + startOffset),
      endAt: new Date(now + startOffset + 45 * 60_000),
      durationMinutes: 45,
      status,
      attendance,
      squareEnvironment: 'sandbox',
      raw: { customerNote: 'Short on the sides', sellerNote: 'Regular', source: 'FIRST_PARTY_BUYER' },
    });
    await d.insert(s.bookings).values([row(ids.past, 'BK_PAST', -3 * 3600_000, 'ACCEPTED', 'awaiting_payment'), row(ids.noShow, 'BK_NS', -26 * 3600_000, 'NO_SHOW', 'no_show'), row(ids.future, 'BK_FUT', 26 * 3600_000, 'ACCEPTED', 'upcoming')]);
    // A booking at another Square location of the same account (copied before a location was chosen).
    const otherLocation = randomUUID();
    await d.insert(s.bookings).values({ ...row(otherLocation, 'BK_OTHER_LOC', 26 * 3600_000 + 60_000, 'ACCEPTED', 'upcoming'), locationId: 'LOC_2' });
    const { sql } = await import('drizzle-orm');
    const ic = s.integrationConnections;
    const twoLocations = {
      fetchedAt: new Date().toISOString(),
      merchantName: 'Ivanhoe Test Barbers',
      locations: [
        { id: 'LOC_1', name: 'Ivanhoe', timezone: 'Australia/Melbourne', status: 'ACTIVE', bookingSiteUrl: null },
        { id: 'LOC_2', name: 'Heidelberg', timezone: 'Australia/Melbourne', status: 'ACTIVE', bookingSiteUrl: null },
      ],
      businessProfile: null,
      teamMembers: [],
      services: [],
    };
    await d.update(ic).set({ config: sql`${ic.config} || ${JSON.stringify({ snapshot: twoLocations })}::jsonb` }).where(eq(ic.provider, 'square'));

    const list = await import('../src/app/api/appointments/route');
    const detail = await import('../src/app/api/appointments/[id]/route');
    const mark = await import('../src/app/api/appointments/[id]/attendance/route');
    const settingsRoute = await import('../src/app/api/integrations/square/route');
    signIn(staff);
    // Two active locations and none chosen: nothing is shown until the owner chooses.
    expect((await call(list.GET, 'GET', '/api/appointments?view=upcoming')).json.bookings).toEqual([]);
    signIn(owner);
    const syncsBefore = new Set((await d.select({ id: s.jobs.id }).from(s.jobs).where(eq(s.jobs.type, 'square.sync'))).map((j) => j.id));
    expect((await call(settingsRoute.PATCH, 'PATCH', '/api/integrations/square', {}, { locationId: 'LOC_1' })).status).toBe(200);
    // Choosing removes the other location's copied bookings.
    expect(await d.select().from(s.bookings).where(eq(s.bookings.id, otherLocation))).toHaveLength(0);
    expect((await d.select().from(s.auditLog).where(eq(s.auditLog.action, 'integration.square.location_selected'))).at(-1)?.data).toMatchObject({ locationId: 'LOC_1', otherLocationBookingsRemoved: 1 });
    // The first copy for the chosen location reads the wide connect range, so its past bookings are copied straight away.
    const queued = (await d.select().from(s.jobs).where(eq(s.jobs.type, 'square.sync'))).filter((j) => !syncsBefore.has(j.id));
    expect(queued.map((j) => j.payload)).toEqual([{ reason: 'connect' }]);
    signIn(staff);
    const upcoming = await call(list.GET, 'GET', '/api/appointments?view=upcoming');
    // "Upcoming" starts at the beginning of today in Melbourne, so the booking from 3 hours ago is listed too when the
    // test runs shortly after midnight there; yesterday's no-show never is.
    const upcomingIds = upcoming.json.bookings.map((b: { id: string }) => b.id);
    expect(upcomingIds).toContain(ids.future);
    expect(upcomingIds).not.toContain(ids.noShow);
    expect(upcoming.json.bookings.find((b: { id: string }) => b.id === ids.future)).toMatchObject({ clientName: 'Jordan Lee', status: 'ACCEPTED', statusLabel: 'Accepted', attendanceMark: { allowed: false } });
    const confirm = await call(list.GET, 'GET', '/api/appointments?view=confirm');
    expect(confirm.json.bookings.map((b: { id: string }) => b.id)).toEqual([ids.past]);
    expect(confirm.json.bookings[0]).toMatchObject({ attendance: 'awaiting_payment', attendanceIsEstimate: true });
    const staffView = await call(detail.GET, 'GET', `/api/appointments/${ids.past}`, { id: ids.past });
    expect(staffView.json).toMatchObject({ clientEmail: null, clientPhone: null, sellerNote: null, customerNote: null, createdIn: 'Square online booking' });

    const refused = await call(mark.POST, 'POST', `/api/appointments/${ids.noShow}/attendance`, { id: ids.noShow }, { value: 'attended' });
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toBe('Square says this was a no-show. Change it in Square first.');
    expect((await call(mark.POST, 'POST', `/api/appointments/${ids.future}/attendance`, { id: ids.future }, { value: 'attended' })).status).toBe(409);

    const marked = await call(mark.POST, 'POST', `/api/appointments/${ids.past}/attendance`, { id: ids.past }, { value: 'attended' });
    expect(marked.status).toBe(200);
    expect(marked.json).toMatchObject({ attendance: 'owner_attended', attendanceIsEstimate: false, attendanceMark: { current: 'attended' } });
    expect(marked.json.attendanceLabel).toMatch(/^Attended — marked by Sam/);
    const stored = (await d.select().from(s.bookings).where(eq(s.bookings.id, ids.past)))[0]!;
    // Sandbox (test) data: the mark is kept and labelled, but a test booking never counts as a completed visit, so
    // it can never start a real follow-up or review request.
    expect(stored).toMatchObject({ completionSource: 'none', completedAt: null, ownerAttendance: 'attended', ownerAttendanceBy: staff.id });
    const notAttended = await call(mark.POST, 'POST', `/api/appointments/${ids.past}/attendance`, { id: ids.past }, { value: 'not_attended' });
    expect(notAttended.json.attendance).toBe('owner_not_attended');
    expect((await d.select().from(s.bookings).where(eq(s.bookings.id, ids.past)))[0]).toMatchObject({ completionSource: 'none', completedAt: null });
    expect((await d.select().from(s.auditLog).where(eq(s.auditLog.action, 'booking.attendance_marked'))).map((a) => a.data)).toEqual([
      { value: 'attended', previous: null },
      { value: 'not_attended', previous: 'attended' },
    ]);

    // Past rows carry the review-request badge (design §9.1), with the same words as the Reviews page.
    await d.insert(s.reviewRequests).values({ id: randomUUID(), bookingId: ids.past, customerId: ids.customer, channel: 'email', status: 'skipped', skipReason: 'no_consent', origin: 'automation', dedupeKey: `review:${ids.past}` });
    const past = await call(list.GET, 'GET', '/api/appointments?view=past');
    const pastRow = past.json.bookings.find((b: { id: string }) => b.id === ids.past);
    expect(pastRow.reviewRequest).toEqual({ status: 'skipped', label: 'Review request: Skipped — no email permission recorded' });
    expect(past.json.bookings.find((b: { id: string }) => b.id === ids.noShow).reviewRequest).toBeNull();
    // A request that went out before Square marked the booking a no-show (design §4.3 step 6).
    await d.insert(s.reviewRequests).values({ id: randomUUID(), bookingId: ids.noShow, customerId: ids.customer, channel: 'email', status: 'sent', origin: 'automation', dedupeKey: `review:${ids.noShow}`, sentAt: new Date() });
    const changed = (await call(list.GET, 'GET', '/api/appointments?view=past')).json.bookings.find((b: { id: string }) => b.id === ids.noShow);
    expect(changed.reviewRequest).toEqual({ status: 'booking_changed', label: 'Review request: Sent before the booking changed' });
    expect((await call(list.GET, 'GET', '/api/appointments?view=upcoming')).json.bookings.find((b: { id: string }) => b.id === ids.future).reviewRequest).toBeNull();

    signIn(owner);
    const ownerView = await call(detail.GET, 'GET', `/api/appointments/${ids.past}`, { id: ids.past });
    expect(ownerView.json).toMatchObject({ clientEmail: 'jordan@example.com', customerNote: 'Short on the sides', sellerNote: 'Regular' });
  });

  it('shows client contact details to the owner only', async () => {
    const clients = await import('../src/app/api/appointments/clients/route');
    const client = await import('../src/app/api/appointments/clients/[id]/route');
    signIn(staff);
    const st = await call(clients.GET, 'GET', '/api/appointments/clients?q=jord');
    expect(st.json.clients).toEqual([{ id: ids.customer, name: 'Jordan Lee', email: null, phone: null }]);
    expect((await call(clients.GET, 'GET', '/api/appointments/clients?q=jordan%40example')).json.clients).toEqual([]);
    signIn(owner);
    expect((await call(clients.GET, 'GET', '/api/appointments/clients?q=jordan%40example')).json.clients[0]).toMatchObject({ email: 'jordan@example.com' });
    const detail = await call(client.GET, 'GET', `/api/appointments/clients/${ids.customer}`, { id: ids.customer });
    expect(detail.json.bookings).toHaveLength(3);
  });

  it('labels services, records a confirmation, refuses switching changes on, and checks availability requests', async () => {
    const d = await db();
    const s = await schema();
    const { eq, sql } = await import('drizzle-orm');
    const snapshot = {
      fetchedAt: new Date().toISOString(),
      merchantName: 'Ivanhoe Test Barbers',
      locations: [{ id: 'LOC_1', name: 'Ivanhoe', timezone: 'Australia/Melbourne', status: 'ACTIVE', bookingSiteUrl: null }],
      businessProfile: null,
      teamMembers: [{ id: 'TM_SAM', displayName: 'Sam', isBookable: true }],
      services: [
        { itemId: 'I1', itemName: 'Skin fade', variationId: 'VAR_FADE', variationName: 'Regular', version: '7', durationMinutes: 45, price: { amount: '5500', currency: 'AUD' }, availableForBooking: true, teamMemberIds: ['TM_SAM'], archived: false, noShowFeeSeen: null },
        { itemId: 'I2', itemName: 'Beard trim', variationId: 'VAR_BEARD', variationName: 'Regular', version: '3', durationMinutes: 30, price: null, availableForBooking: true, teamMemberIds: ['TM_SAM'], archived: false, noShowFeeSeen: { amount: '1000', currency: 'AUD' } },
      ],
    };
    const t = s.integrationConnections;
    await d.update(t).set({ config: sql`${t.config} || ${JSON.stringify({ snapshot })}::jsonb` }).where(eq(t.provider, 'square'));
    const services = await import('../src/app/api/appointments/services/route');
    const r = await import('../src/app/api/integrations/square/route');
    const avail = await import('../src/app/api/appointments/availability/route');
    signIn(staff);
    const list = await call(services.GET, 'GET', '/api/appointments/services');
    expect(list.json.services.map((x: { label: string; priceLabel: string | null }) => [x.label, x.priceLabel])).toEqual([
      ['needs_confirmation', '$55.00'],
      ['book_in_square', null],
    ]);
    expect((await call(r.PATCH, 'PATCH', '/api/integrations/square', {}, { serviceConfirmation: { variationId: 'VAR_FADE', confirmed: true } })).status).toBe(403);
    signIn(owner);
    const confirmed = await call(r.PATCH, 'PATCH', '/api/integrations/square', {}, { serviceConfirmation: { variationId: 'VAR_FADE', confirmed: true } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.services[0]).toMatchObject({ label: 'bookable', confirmed: true });
    const on = await call(r.PATCH, 'PATCH', '/api/integrations/square', {}, { writesEnabled: true });
    expect(on.status).toBe(409);
    expect(on.json.error.message).toMatch(/aren’t available yet/);
    expect((await call(r.PATCH, 'PATCH', '/api/integrations/square', {}, { locationId: 'NOPE' })).status).toBe(400);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect((await call(avail.POST, 'POST', '/api/appointments/availability', {}, { serviceVariationId: 'VAR_NOPE', fromDate: today, days: 7 })).status).toBe(400);
    expect((await call(avail.POST, 'POST', '/api/appointments/availability', {}, { serviceVariationId: 'VAR_FADE', fromDate: '2020-01-01', days: 7 })).status).toBe(400);
    expect((await call(avail.POST, 'POST', '/api/appointments/availability', {}, { serviceVariationId: 'VAR_FADE', fromDate: today, days: 15 })).status).toBe(400);
    const started = await call(avail.POST, 'POST', '/api/appointments/availability', {}, { serviceVariationId: 'VAR_FADE', teamMemberId: 'TM_SAM', fromDate: today, days: 7 });
    expect(started.status).toBe(200);
    const job = (await d.select().from(s.jobs).where(eq(s.jobs.id, started.json.jobId)))[0]!;
    expect(job).toMatchObject({ type: 'square.availability', refId: started.json.searchId });
    const poll = await import('../src/app/api/appointments/availability/[searchId]/route');
    expect((await call(poll.GET, 'GET', `/api/appointments/availability/${started.json.searchId}`, { searchId: started.json.searchId })).json).toMatchObject({ status: 'queued', slots: [] });
  });

  it('disconnects with a purge, keeps clients other modules may point at, and queues the revoke', async () => {
    const r = await import('../src/app/api/integrations/square/route');
    const d = await db();
    const s = await schema();
    const { eq } = await import('drizzle-orm');
    signIn(staff);
    expect((await call(r.DELETE, 'DELETE', '/api/integrations/square', {}, { purgeData: true })).status).toBe(403);
    signIn(owner);
    const res = await call(r.DELETE, 'DELETE', '/api/integrations/square', {}, { purgeData: true });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'disconnected', purged: true });
    const conn = (await d.select().from(s.integrationConnections).where(eq(s.integrationConnections.provider, 'square')))[0]!;
    expect(conn).toMatchObject({ status: 'disconnected', accessTokenEncrypted: null, refreshTokenEncrypted: null });
    expect(await d.select().from(s.bookings)).toHaveLength(0);
    // Stored Square webhook deliveries go too.
    expect(await d.select().from(s.webhookEvents).where(eq(s.webhookEvents.provider, 'square'))).toHaveLength(0);
    const customer = (await d.select().from(s.customers).where(eq(s.customers.id, ids.customer)))[0]!;
    expect(customer).toMatchObject({ squareCustomerId: null, givenName: '', email: null });
    expect(customer.deletedAt).not.toBeNull();
    const revoke = await d.select().from(s.jobs).where(eq(s.jobs.type, 'square.revoke'));
    expect(revoke.map((j) => j.payload)).toEqual([{ merchantId: 'MERCHANT_FAKE_1', environment: 'sandbox' }]);
    // Nothing was ever written to Square from the web app.
    expect(fake.callsTo('write')).toHaveLength(0);

    // The owner sees the revoke outcome on the card (design §6): waiting, then Square's answer.
    const card = async () => (await call(r.GET, 'GET', '/api/integrations/square')).json.revoke;
    expect(await card()).toMatchObject({ state: 'pending' });
    await d.insert(s.auditLog).values({ id: randomUUID(), action: 'integration.square.revoke_failed', entityType: 'integration_connection', data: { merchantId: 'MERCHANT_FAKE_1', environment: 'sandbox', reason: 'environment_changed' } });
    const failed = await card();
    expect(failed.state).toBe('failed');
    expect(failed.message).toMatch(/App integrations page/);
    expect(failed.message).toMatch(/sandbox \(test\) account/);
    await d.insert(s.auditLog).values({ id: randomUUID(), action: 'integration.square.revoked', entityType: 'integration_connection', data: {}, createdAt: new Date(Date.now() + 1000) });
    expect(await card()).toMatchObject({ state: 'revoked' });
    signIn(staff);
    expect(await card()).toBeNull();
    signIn(owner);
  });

  it('reconnecting in the other environment purges that environment’s copied data first', async () => {
    const connect = await import('../src/app/api/integrations/square/connect/route');
    const callback = await import('../src/app/api/integrations/square/callback/route');
    const d = await db();
    const s = await schema();
    const { eq } = await import('drizzle-orm');
    const t = s.integrationConnections;
    // A live (production) connection with copied live data, then the server is switched to the sandbox.
    await d.update(t).set({ status: 'connected', config: { environment: 'production' }, externalAccountId: 'MERCHANT_FAKE_1' }).where(eq(t.provider, 'square'));
    await d.insert(s.customers).values({ id: randomUUID(), squareCustomerId: 'CUST_LIVE', givenName: 'Live', familyName: 'Client', squareEnvironment: 'production' });
    await d.insert(s.bookings).values({ id: randomUUID(), squareBookingId: 'BK_LIVE', startAt: new Date(now + 3600_000), status: 'ACCEPTED', squareEnvironment: 'production' });
    signIn(owner);
    const status = await import('../src/app/api/integrations/square/route');
    expect((await call(status.GET, 'GET', '/api/integrations/square')).json).toMatchObject({ state: 'needs_reauth', dataEnvironment: 'production' });
    const started = await call(connect.GET, 'GET', '/api/integrations/square/connect');
    const state = new URL(started.res.headers.get('location')!).searchParams.get('state')!;
    const cookie = started.res.headers.get('set-cookie')!.split(';')[0]!;
    await call(callback.GET, 'GET', `/api/integrations/square/callback?code=fake-square-code&state=${encodeURIComponent(state)}`, {}, undefined, { origin: ORIGIN, cookie });
    expect(await d.select().from(s.bookings).where(eq(s.bookings.squareEnvironment, 'production'))).toHaveLength(0);
    const live = (await d.select().from(s.customers).where(eq(s.customers.givenName, 'Live')));
    expect(live).toHaveLength(0);
    expect((await d.select().from(t).where(eq(t.provider, 'square')))[0]).toMatchObject({ status: 'connected', config: { environment: 'sandbox' } });
    const purged = await d.select().from(s.auditLog).where(eq(s.auditLog.action, 'integration.square.data_purged'));
    expect(purged.at(-1)?.data).toMatchObject({ environment: 'production', reason: 'environment_changed' });
  });
});
