import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';

/**
 * Stage B/C foundations against a throwaway database (TEST_DATABASE_URL): webhook intake, legal pages, the Google
 * connect/callback flow with a fake token endpoint (no request leaves the machine), feedback recording and the
 * settings merge. The session lookup is replaced so handlers see a signed-in owner. Skipped without TEST_DATABASE_URL.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: { id: string; email: string; displayName: string; role: 'owner' | 'staff' }; expiresAt: Date } }));
vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));

const ORIGIN = 'http://localhost:3000';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, init: { body?: unknown; cookie?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (init.cookie) headers['cookie'] = init.cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), { params: Promise.resolve({}) });
}

suite('Stage B/C foundations (database-backed)', () => {
  const dbName = `sa_foundtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

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
    const authLib = await import('../src/lib/auth');
    const owner = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    auth.session = { sessionId: 'session-owner', user: { id: owner.id, email: owner.email, displayName: owner.displayName, role: 'owner' }, expiresAt: new Date(Date.now() + 3600_000) };
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  it('stores a redelivered webhook event once and queues one job', async () => {
    const { storeWebhookEvent } = await import('../src/lib/webhooks');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const event = { provider: 'square', externalEventId: 'evt-123', eventType: 'booking.updated', payload: { data: { id: 'b1' } }, signatureValid: true };
    const [first, second] = await Promise.all([storeWebhookEvent(event), storeWebhookEvent(event)]);
    expect([first.stored, second.stored].sort()).toEqual([false, true]);
    const third = await storeWebhookEvent(event);
    expect(third).toEqual({ stored: false, webhookEventId: null });
    const rows = await getDb().select().from(schema.webhookEvents).where(eq(schema.webhookEvents.externalEventId, 'evt-123'));
    expect(rows).toHaveLength(1);
    const jobs = await getDb().select().from(schema.jobs).where(eq(schema.jobs.type, 'webhook.process'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ refId: rows[0]?.id, status: 'queued', payload: { webhookEventId: rows[0]?.id } });
    expect(jobs[0]?.bossJobId).toBeTruthy();
    // The same id from another provider is a different event.
    expect((await storeWebhookEvent({ ...event, provider: 'postmark' })).stored).toBe(true);
  });

  it('serves a legal page only after the owner publishes it, and keeps it when other sections are saved', async () => {
    const { loadPublishedLegalPage } = await import('../src/app/privacy/load');
    const settingsRoute = await import('../src/app/api/settings/route');
    await expect(loadPublishedLegalPage('privacy')).rejects.toMatchObject({ digest: expect.stringContaining('404') });

    const draft = await call(settingsRoute.PUT, 'PUT', '/api/settings', { body: { legal: { privacy: { draft: 'Draft only', published: '', publishedAt: null } } } });
    expect(draft.status).toBe(200);
    await expect(loadPublishedLegalPage('privacy')).rejects.toMatchObject({ digest: expect.stringContaining('404') });

    const publishedAt = '2026-11-14T02:00:00.000Z';
    const pub = await call(settingsRoute.PUT, 'PUT', '/api/settings', { body: { legal: { privacy: { draft: 'Who we are\nIvanhoe Cuts.', published: 'Who we are\nIvanhoe Cuts.', publishedAt } } } });
    expect(pub.status).toBe(200);
    expect(await loadPublishedLegalPage('privacy')).toEqual({ businessName: 'My Barber Studio', title: 'Privacy policy', body: 'Who we are\nIvanhoe Cuts.', publishedAt });
    await expect(loadPublishedLegalPage('terms')).rejects.toMatchObject({ digest: expect.stringContaining('404') });

    // Saving the business section afterwards must not drop the legal pages.
    const biz = await call(settingsRoute.PUT, 'PUT', '/api/settings', { body: { business: { phone: '03 9000 0000', privacyUrl: '' } } });
    expect(biz.status).toBe(200);
    expect((await loadPublishedLegalPage('privacy')).body).toBe('Who we are\nIvanhoe Cuts.');

    const bad = await call(settingsRoute.PUT, 'PUT', '/api/settings', { body: { legal: { privacy: { draft: 'x', published: 'x', publishedAt: 'yesterday' } } } });
    expect(bad.status).toBe(400);

    auth.session = auth.session ? { ...auth.session, user: { ...auth.session.user, role: 'staff' } } : null;
    const staff = await call(settingsRoute.PUT, 'PUT', '/api/settings', { body: { legal: { privacy: { draft: '', published: '', publishedAt: null } } } });
    expect(staff.status).toBe(403);
    auth.session = auth.session ? { ...auth.session, user: { ...auth.session.user, role: 'owner' } } : null;
  });

  it('connects Google Search Console through the state cookie and stores only encrypted tokens', async () => {
    const connect = await import('../src/app/api/integrations/google/connect/route');
    const callback = await import('../src/app/api/integrations/google/callback/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const { decryptToken } = await import('../src/lib/crypto');

    const start = await call(connect.GET, 'GET', '/api/integrations/google/connect?product=search_console');
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location') ?? '');
    expect(location.host).toBe('accounts.google.com');
    expect(location.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/integrations/google/callback`);
    const state = location.searchParams.get('state') ?? '';
    const setCookie = start.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/sa_oauth_google=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\/api\/integrations\/google/);
    const cookie = setCookie.split(';')[0] ?? '';

    // A wrong state changes nothing and never calls Google.
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      expect(body).toContain('code=auth-code');
      expect(body).toContain('code_verifier=');
      return new Response(JSON.stringify({ access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3599, scope: 'https://www.googleapis.com/auth/webmasters.readonly', token_type: 'Bearer' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const wrong = await call(callback.GET, 'GET', `/api/integrations/google/callback?state=forged&code=auth-code`, { cookie });
    expect(wrong.status).toBe(302);
    expect(new URL(wrong.headers.get('location') ?? '').searchParams.get('google_error')).toMatch(/could not be confirmed/);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Another session cannot finish this sign-in.
    const owner = auth.session;
    auth.session = owner ? { ...owner, sessionId: 'another-session' } : null;
    const other = await call(callback.GET, 'GET', `/api/integrations/google/callback?state=${encodeURIComponent(state)}&code=auth-code`, { cookie });
    expect(new URL(other.headers.get('location') ?? '').searchParams.get('google_error')).toMatch(/different session/);
    auth.session = owner;

    const done = await call(callback.GET, 'GET', `/api/integrations/google/callback?state=${encodeURIComponent(state)}&code=auth-code`, { cookie });
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get('location') ?? '');
    expect(back.pathname).toBe('/settings');
    expect(Object.fromEntries(back.searchParams)).toEqual({ tab: 'integrations', connected: 'search_console' });
    expect(done.headers.get('set-cookie')).toMatch(/sa_oauth_google=;.*Max-Age=0/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://oauth2.googleapis.com/token');

    const row = await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_search_console') });
    expect(row).toMatchObject({ status: 'connected', scopes: ['https://www.googleapis.com/auth/webmasters.readonly'], lastError: null });
    expect(row?.accessTokenEncrypted).not.toContain('ya29');
    expect(decryptToken(row?.accessTokenEncrypted ?? '')).toBe('ya29.access');
    expect(decryptToken(row?.refreshTokenEncrypted ?? '')).toBe('1//refresh');
    expect(await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_business_profile') })).toBeUndefined();
    // The follow-up check belongs to the website package; until it registers its job type nothing is queued.
    expect(await getDb().select().from(schema.jobs).where(eq(schema.jobs.type, 'website.connection_check'))).toHaveLength(0);
    const audits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.entityType, 'integration_connection'));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['integration.google_search_console.connect_started', 'integration.google_search_console.connected']));
    expect(JSON.stringify(audits)).not.toMatch(/ya29|1\/\/refresh|auth-code/);
  });

  it('records feedback only when the caller commits', async () => {
    const { recordFeedback } = await import('../src/lib/feedback');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const editId = randomUUID();
    await expect(
      getDb().transaction(async (tx) => {
        await recordFeedback(tx, { type: 'favourite', userId: auth.session?.user.id ?? null, projectId: null, editId, editVersionId: 'v1', styleId: 'beat_montage', data: { value: true } });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await getDb().select().from(schema.feedbackEvents).where(eq(schema.feedbackEvents.editId, editId))).toHaveLength(0);
    await getDb().transaction(async (tx) => {
      await recordFeedback(tx, { type: 'favourite', userId: null, projectId: null, editId, editVersionId: 'v1', styleId: 'beat_montage', data: { value: true } });
    });
    const rows = await getDb().select().from(schema.feedbackEvents).where(eq(schema.feedbackEvents.editId, editId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toEqual({ value: true });
  });
});
