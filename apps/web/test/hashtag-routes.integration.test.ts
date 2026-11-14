import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Instagram hashtag watch routes (WP5) against a throwaway database (TEST_DATABASE_URL): who may add hashtags, the
 * Instagram connection it needs, the hashtag rules, the 10-watched and 30-a-week limits, and the shape Settings →
 * Trends reads. The session lookup is replaced; the CSRF guard, validation, database and pg-boss queue are real. No
 * Meta endpoint is called: reads run only in the worker, which is not running here. Skipped without TEST_DATABASE_URL.
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

// The test switches the Meta settings on and off, so read the settings fresh each time.
vi.mock('../src/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/env')>();
  const { loadEnv } = await import('@studio/config');
  return { ...actual, getEnv: () => loadEnv({ ...process.env }) };
});

const ORIGIN = 'http://localhost:3000';
const STORED_TOKEN = 'stored-encrypted-token-value-never-shown';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { origin: ORIGIN } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

const signIn = (user: User) => {
  auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + 3600_000) };
};

const META_ENV = { META_APP_ID: 'fake-app', META_APP_SECRET: 'fake-app-secret', META_LOGIN_CONFIG_ID: 'fake-config' };

suite('Instagram hashtag watch routes (database-backed)', () => {
  const dbName = `sa_hashtagtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;

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
    for (const k of Object.keys(META_ENV)) delete process.env[k];
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const mk = async (role: 'owner' | 'staff', name: string): Promise<User> => {
      const u = { id: randomUUID(), email: `${name.toLowerCase()}@example.com`, displayName: name, role };
      await getDb().insert(schema.users).values({ ...u, passwordHash: 'x' });
      return u;
    };
    owner = await mk('owner', 'Owner');
    staff = await mk('staff', 'Jordan');
  }, 60_000);

  afterAll(async () => {
    for (const k of Object.keys(META_ENV)) delete process.env[k];
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
  }, 60_000);

  it('needs the owner, the Meta settings and a connected Instagram account', async () => {
    const watches = await import('../src/app/api/trends/watches/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');

    signIn(staff);
    expect((await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'skinfade' })).status).toBe(403);

    signIn(owner);
    const noSettings = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'skinfade' });
    expect(noSettings.status).toBe(422);
    expect(noSettings.json.error.code).toBe('INTEGRATION_NOT_CONFIGURED');

    Object.assign(process.env, META_ENV);
    const noAccount = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'skinfade' });
    expect(noAccount.status).toBe(422);
    expect(noAccount.json.error.message).toMatch(/Connect Instagram in Settings → Integrations first/);

    const connId = randomUUID();
    await getDb().insert(schema.integrationConnections).values({ id: connId, provider: 'meta', status: 'needs_reauth', accessTokenEncrypted: STORED_TOKEN });
    await getDb().insert(schema.socialAccounts).values({ id: randomUUID(), platform: 'instagram', externalId: '17841400000000001', username: 'studio', provider: 'meta_graph', connectionId: connId, status: 'connected' });
    const reauth = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'skinfade' });
    expect(reauth.status).toBe(422);
    expect(reauth.json.error.message).toMatch(/Reconnect Instagram/);
    await getDb().update(schema.integrationConnections).set({ status: 'connected' });
    expect(await getDb().select().from(schema.trendWatches)).toHaveLength(0);
  }, 60_000);

  it('adds a hashtag once, queues its first read with only the watch id, and refuses bad hashtags', async () => {
    const watches = await import('../src/app/api/trends/watches/route');
    const trends = await import('../src/app/api/trends/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    signIn(owner);

    for (const hashtag of ['skin fade', 'fade!', 'viralfade', '#']) {
      const bad = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag });
      expect(bad.status, hashtag).toBe(400);
      expect(bad.json.error.code).toBe('VALIDATION');
    }

    const added = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: '#SkinFade' });
    expect(added.status).toBe(200);
    expect(added.json.watch).toMatchObject({ provider: 'instagram_hashtag', query: 'skinfade', enabled: true, status: 'pending' });
    expect(added.text).not.toContain(STORED_TOKEN);
    const watchId: string = added.json.watch.id;
    const job = await getDb().query.jobs.findFirst({ where: eq(schema.jobs.id, added.json.jobId) });
    expect(job).toMatchObject({ type: 'trends.refresh', refId: watchId, payload: { watchId }, status: 'queued' });
    expect(JSON.stringify(job)).not.toContain(STORED_TOKEN);
    const row = await getDb().query.trendWatches.findFirst({ where: eq(schema.trendWatches.id, watchId) });
    expect(row?.socialAccountId).toBeTruthy();
    expect(await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'trends.watch_added'))).toHaveLength(1);
    expect((await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'skinfade' })).json.jobId).toBeNull();

    // Fetched posts (as the worker stores them), ranked by Instagram; the overview keeps that order.
    await getDb().update(schema.trendWatches).set({ status: 'ok', lastQueriedAt: new Date(), lastSuccessAt: new Date() }).where(eq(schema.trendWatches.id, watchId));
    await getDb().update(schema.jobs).set({ status: 'succeeded' }).where(eq(schema.jobs.id, added.json.jobId));
    const item = (rank: number, id: string, mediaType: string) => ({
      id: randomUUID(),
      title: `${mediaType === 'VIDEO' ? 'Video' : 'Photo'} under #skinfade, posted 12 Nov 2026`,
      sourceName: 'Instagram hashtag watch',
      sourceUrl: `https://www.instagram.com/p/${id}/`,
      sourceKind: 'live' as const,
      lastVerifiedAt: new Date(),
      watchId,
      externalId: id,
      fetchedAt: new Date(),
      staleAfter: new Date(Date.now() + 3_600_000),
      data: { provider: 'instagram_hashtag', hashtag: 'skinfade', rank, mediaType, postedAt: '2026-11-12T03:04:05.000Z', likeCount: 10 * rank, commentsCount: null, permalink: `https://www.instagram.com/p/${id}/` },
    });
    await getDb().insert(schema.trendReferences).values([item(2, '18000000000000002', 'IMAGE'), item(1, '18000000000000001', 'VIDEO')]);

    const overview = await call(trends.GET, 'GET', '/api/trends');
    expect(overview.status).toBe(200);
    expect(overview.text).not.toContain(STORED_TOKEN);
    const ig = overview.json.sources.find((s: { provider: string }) => s.provider === 'instagram_hashtag');
    expect(ig).toMatchObject({ status: { id: 'instagram_hashtags', state: 'connected', liveMode: 'read_only' }, watches: [{ id: watchId, query: 'skinfade' }], budget: { used: 1, limit: 30, enabled: 1, maxEnabled: 10, nextFreeAt: null } });
    const group = overview.json.live.find((l: { watch: { id: string } }) => l.watch.id === watchId);
    expect(group.items.map((i: { externalId?: string; sourceUrl: string }) => i.sourceUrl)).toEqual(['https://www.instagram.com/p/18000000000000001/', 'https://www.instagram.com/p/18000000000000002/']);
    expect(group.items[0].label).toMatch(/^Top posts under #skinfade — Instagram, fetched /);
    expect(group.posts).toEqual([
      expect.objectContaining({ rank: 1, mediaTypeLabel: 'Video', likeCount: 10, commentsCount: null, countsLine: '10 likes' }),
      expect.objectContaining({ rank: 2, mediaTypeLabel: 'Photo', countsLine: '20 likes' }),
    ]);
    // Staff see the card read-only.
    signIn(staff);
    expect((await call(trends.GET, 'GET', '/api/trends')).json.sources[1].watches).toHaveLength(1);
  }, 60_000);

  it('watches at most 10 hashtags and keeps to Instagram’s 30 a week; turned-off ones still count', async () => {
    const watches = await import('../src/app/api/trends/watches/route');
    const watch = await import('../src/app/api/trends/watches/[id]/route');
    const trends = await import('../src/app/api/trends/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    signIn(owner);

    // One is watched already (previous test); nine more reach the limit of ten.
    for (let i = 0; i < 9; i += 1) expect((await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: `fade${i}` })).status).toBe(200);
    const eleventh = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'onemore' });
    expect(eleventh.status).toBe(409);
    expect(eleventh.json.error.message).toMatch(/watching 10 hashtags/);

    // Turning one off frees a watched place, deletes its posts and keeps the row (it still counts this week).
    const fade0 = await getDb().query.trendWatches.findFirst({ where: eq(schema.trendWatches.query, 'fade0') });
    await getDb().update(schema.trendWatches).set({ lastQueriedAt: new Date() }).where(eq(schema.trendWatches.id, fade0!.id));
    signIn(staff);
    expect((await call(watch.DELETE, 'DELETE', `/api/trends/watches/${fade0!.id}`, { id: fade0!.id })).status).toBe(403);
    signIn(owner);
    expect((await call(watch.DELETE, 'DELETE', `/api/trends/watches/${fade0!.id}`, { id: fade0!.id })).status).toBe(200);
    expect(await getDb().query.trendWatches.findFirst({ where: eq(schema.trendWatches.id, fade0!.id) })).toMatchObject({ enabled: false });

    // 30 hashtags queried this week (28 turned-off rows plus fade0 and skinfade; fade1–8 were never read): a new one waits.
    const oldest = new Date(Date.now() - 6 * 86_400_000);
    await getDb()
      .insert(schema.trendWatches)
      .values(Array.from({ length: 28 }, (_, i) => ({ id: randomUUID(), provider: 'instagram_hashtag' as const, query: `used${i}`, enabled: false, lastQueriedAt: i === 0 ? oldest : new Date() })));
    const limited = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'brandnew' });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('RATE_LIMITED');
    expect(limited.json.error.message).toMatch(/^Instagram allows 30 hashtags a week\. You can add another on \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);
    expect(limited.json.error.details.nextFreeAt).toBe(new Date(oldest.getTime() + 7 * 86_400_000).toISOString());
    const overview = await call(trends.GET, 'GET', '/api/trends');
    expect(overview.json.sources[1].budget).toMatchObject({ used: 30, enabled: 9, nextFreeAt: limited.json.error.details.nextFreeAt });

    // A hashtag already counted this week can be turned back on: it does not add to the count.
    const back = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'fade0' });
    expect(back.status).toBe(200);
    expect(back.json.watch).toMatchObject({ id: fade0!.id, enabled: true, status: 'pending' });
  }, 60_000);
});
