import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Google Business Profile routes against a throwaway database (TEST_DATABASE_URL) with the real CSRF guard,
 * validation and pg-boss queue: owner-only access, "waiting for Google approval" without numbers or reviews, the
 * location choice limited to what Google listed, reviews and numbers shown only as stored from Google, and disconnect
 * with optional deletion. Google is never contacted. Skipped without TEST_DATABASE_URL.
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

const ORIGIN = 'http://localhost:3000';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }): Promise<{ status: number; json: any }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve({}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

suite('Business Profile routes (database-backed)', () => {
  const dbName = `sa_gbptest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;
  const as = (u: User) => {
    auth.session = { sessionId: `s-${u.id}`, user: u, expiresAt: new Date(Date.now() + 3600_000) };
  };
  const connId = randomUUID();

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
    process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.STORAGE_DRIVER = 'local';
    process.env.AI_PROVIDER = 'none';
    const authLib = await import('../src/lib/auth');
    const o = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    owner = { id: o.id, email: o.email, displayName: o.displayName, role: 'owner' };
    staff = { id: randomUUID(), email: 'staff@example.com', displayName: 'Staff', role: 'staff' };
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    await getDb().insert(schema.users).values({ id: staff.id, email: staff.email, displayName: staff.displayName, passwordHash: 'x', role: 'staff' });
    as(owner);
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
  }, 60_000);

  it('is owner-only and refuses cross-site requests', async () => {
    const reviews = await import('../src/app/api/reviews/google/route');
    const check = await import('../src/app/api/integrations/google-business-profile/check/route');
    const perf = await import('../src/app/api/website/business-profile-performance/route');
    as(staff);
    expect((await call(reviews.GET, 'GET', '/api/reviews/google')).status).toBe(403);
    expect((await call(perf.GET, 'GET', '/api/website/business-profile-performance')).status).toBe(403);
    expect((await call(check.POST, 'POST', '/api/integrations/google-business-profile/check', {})).status).toBe(403);
    as(owner);
    expect((await call(check.POST, 'POST', '/api/integrations/google-business-profile/check', {}, { origin: 'https://evil.example' })).status).toBe(403);
    const none = await call(reviews.GET, 'GET', '/api/reviews/google');
    expect(none.status).toBe(200);
    expect(none.json.profile).toMatchObject({ state: 'not_connected', reviews: [], totalReviewCount: null, averageRating: null });
    expect((await call(perf.GET, 'GET', '/api/website/business-profile-performance')).json).toMatchObject({ state: 'not_connected', totals: null, keywords: null });
    // Nothing to check before connecting.
    expect((await call(check.POST, 'POST', '/api/integrations/google-business-profile/check', {})).status).toBe(422);
  });

  it('while Google has not approved access: "waiting", no reviews and no numbers, even if old rows exist', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    await getDb()
      .insert(schema.integrationConnections)
      .values({ id: connId, provider: 'google_business_profile', status: 'connected', refreshTokenEncrypted: 'x', capabilities: { apiAccess: 'awaiting_approval' } });
    await getDb()
      .insert(schema.reviews)
      .values({ id: randomUUID(), provider: 'google_business_profile', externalReviewId: 'old', rating: 5, raw: { location: 'locations/9' }, reviewUpdatedAt: new Date() });
    const reviews = await import('../src/app/api/reviews/google/route');
    const perf = await import('../src/app/api/website/business-profile-performance/route');
    const r = await call(reviews.GET, 'GET', '/api/reviews/google');
    expect(r.json.profile).toMatchObject({ state: 'awaiting_approval', reviews: [] });
    const p = await call(perf.GET, 'GET', '/api/website/business-profile-performance');
    expect(p.json).toMatchObject({ state: 'awaiting_approval', totals: null, viewParts: null, keywords: null, dataThrough: null });
    expect((await call(perf.POST, 'POST', '/api/website/business-profile-performance', {})).status).toBe(422);
  });

  it('lets the owner choose only a listed location, then shows that location’s reviews and queues read-only jobs', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    await getDb()
      .update(schema.integrationConnections)
      .set({
        capabilities: { apiAccess: 'available', totalReviewCount: 2, averageRating: 4.5, reviewsSyncedAt: '2026-11-14T03:00:00.000Z' },
        config: {
          locations: [
            { account: 'accounts/1', name: 'locations/2', title: 'Ivanhoe Barber Co', address: '12 Upper Heidelberg Rd, Ivanhoe' },
            { account: 'accounts/1', name: 'locations/3', title: 'Other shop', address: '' },
          ],
        },
      })
      .where(eq(schema.integrationConnections.id, connId));
    const reviews = await import('../src/app/api/reviews/google/route');
    const location = await import('../src/app/api/integrations/google-business-profile/location/route');
    const choose = await call(reviews.GET, 'GET', '/api/reviews/google');
    expect(choose.json.profile.state).toBe('choose_location');
    expect(choose.json.profile.locations.map((l: { name: string }) => l.name)).toEqual(['locations/2', 'locations/3']);
    expect((await call(location.PUT, 'PUT', '/api/integrations/google-business-profile/location', { locationName: 'locations/99' })).status).toBe(400);
    expect((await call(location.PUT, 'PUT', '/api/integrations/google-business-profile/location', { locationName: '../x' })).status).toBe(400);
    const ok = await call(location.PUT, 'PUT', '/api/integrations/google-business-profile/location', { locationName: 'locations/2' });
    expect(ok.status).toBe(200);
    expect(ok.json.state).toBe('connected');
    // Reviews of another listing are removed; the first read and the Performance probe are queued.
    expect(await getDb().select().from(schema.reviews)).toHaveLength(0);
    const jobs = await getDb().select({ type: schema.jobs.type, payload: schema.jobs.payload }).from(schema.jobs);
    expect(jobs).toEqual(
      expect.arrayContaining([
        { type: 'reviews.gbp.sync', payload: { reason: 'manual' } },
        { type: 'website.connection_check', payload: { provider: 'business_profile_performance', reason: 'connect' } },
      ]),
    );
    await getDb()
      .insert(schema.reviews)
      .values([
        { id: randomUUID(), provider: 'google_business_profile', externalReviewId: 'a', rating: 5, reviewerName: 'Sam', comment: 'Great fade', raw: { location: 'locations/2', reviewReplyState: 'REPLY_PUBLISHED' }, reviewCreatedAt: new Date('2026-11-01T00:00:00Z'), reviewUpdatedAt: new Date('2026-11-01T00:00:00Z') },
        { id: randomUUID(), provider: 'google_business_profile', externalReviewId: 'b', rating: 4, reviewerName: 'Anonymous', raw: { location: 'locations/2' }, reviewCreatedAt: new Date('2026-11-05T00:00:00Z'), reviewUpdatedAt: new Date('2026-11-05T00:00:00Z') },
      ]);
    const list = await call(reviews.GET, 'GET', '/api/reviews/google');
    expect(list.json.profile).toMatchObject({ state: 'connected', location: { name: 'locations/2', title: 'Ivanhoe Barber Co' }, totalReviewCount: 2, averageRating: 4.5, locations: [] });
    expect(list.json.profile.reviews.map((r: { reviewerName: string; replyState: string | null }) => [r.reviewerName, r.replyState])).toEqual([
      ['Anonymous', null],
      ['Sam', 'Reply published'],
    ]);
    // A refresh was queued moments ago by the location choice: the 10-minute limit applies.
    const refresh = await import('../src/app/api/reviews/google/refresh/route');
    expect((await call(refresh.POST, 'POST', '/api/reviews/google/refresh', {})).status).toBe(429);
  });

  it('shows Performance numbers only as stored from Google, then disconnect can delete everything stored', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const perf = await import('../src/app/api/website/business-profile-performance/route');
    expect((await call(perf.GET, 'GET', '/api/website/business-profile-performance')).json).toMatchObject({ state: 'not_checked', totals: null });
    await getDb()
      .update(schema.integrationConnections)
      .set({ capabilities: { apiAccess: 'available', performanceApi: 'available' } })
      .where(eq(schema.integrationConnections.id, connId));
    await getDb().update(schema.jobs).set({ status: 'succeeded' });
    expect((await call(perf.GET, 'GET', '/api/website/business-profile-performance')).json).toMatchObject({ state: 'no_data', totals: null, canRefresh: true });
    const metric = (d: string, key: string, value: number | null) => ({ id: randomUUID(), source: 'business_profile' as const, property: 'locations/2', granularity: 'day' as const, periodStart: d, kind: 'metric' as const, key, value });
    await getDb()
      .insert(schema.searchMetrics)
      .values([
        metric('2026-11-01', 'CALL_CLICKS', 2),
        metric('2026-11-02', 'CALL_CLICKS', null),
        metric('2026-11-02', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 30),
        { id: randomUUID(), source: 'business_profile' as const, property: 'locations/2', granularity: 'month' as const, periodStart: '2026-10-01', kind: 'keyword' as const, key: 'barber ivanhoe', value: null, valueThreshold: 15 },
      ]);
    const shown = await call(perf.GET, 'GET', '/api/website/business-profile-performance?range=3m');
    expect(shown.json).toMatchObject({
      state: 'connected',
      range: '3m',
      dataThrough: '2026-11-02',
      totals: { calls: 2, directions: null, website: null, bookings: null, messages: null, search_views: 30, maps_views: null },
      viewParts: { search: { mobile: null, desktop: 30 }, maps: { mobile: null, desktop: null } },
    });
    expect(shown.json.keywords.month).toBe('2026-10');
    const refreshed = await call(perf.POST, 'POST', '/api/website/business-profile-performance', {});
    expect(refreshed.status).toBe(202);
    expect(refreshed.json.job.type).toBe('search.sync');
    expect((await call(perf.POST, 'POST', '/api/website/business-profile-performance', {})).status).toBe(429);

    const disconnect = await import('../src/app/api/integrations/google-business-profile/route');
    expect((await call(disconnect.DELETE, 'DELETE', '/api/integrations/google-business-profile?deleteData=true')).status).toBe(202);
    const row = await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, connId) });
    expect(row?.status).toBe('disconnected');
    expect(await getDb().select().from(schema.reviews)).toHaveLength(0);
    expect(await getDb().select().from(schema.searchMetrics).where(eq(schema.searchMetrics.source, 'business_profile'))).toHaveLength(0);
    expect((await getDb().select().from(schema.jobs).where(eq(schema.jobs.type, 'google.disconnect'))).length).toBe(1);
    const reviews = await import('../src/app/api/reviews/google/route');
    expect((await call(reviews.GET, 'GET', '/api/reviews/google')).json.profile).toMatchObject({ state: 'not_connected', reviews: [] });
  });
});
