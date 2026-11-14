import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Settings → Trends routes against a throwaway database (TEST_DATABASE_URL): who may note, delete and turn on
 * sources, the curated re-sourcing step, the manual refresh limit and the response shape. The session lookup is
 * replaced; the CSRF guard, validation, database and pg-boss queue are real. No external service is called: the
 * YouTube fetch runs only in the worker, which is not running here. Skipped when TEST_DATABASE_URL is unset.
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

// The app caches its validated settings; the test switches YOUTUBE_API_KEY on and off, so read them fresh each time.
vi.mock('../src/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/env')>();
  const { loadEnv } = await import('@studio/config');
  return { ...actual, getEnv: () => loadEnv({ ...process.env }) };
});

const ORIGIN = 'http://localhost:3000';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }): Promise<{ status: number; json: any }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const signIn = (user: User) => {
  auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + 3600_000) };
};

suite('Trends routes (database-backed)', () => {
  const dbName = `sa_trendtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;
  let otherStaff: User;

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
    delete process.env.YOUTUBE_API_KEY;
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const mk = async (role: 'owner' | 'staff', name: string): Promise<User> => {
      const u = { id: randomUUID(), email: `${name.toLowerCase()}@example.com`, displayName: name, role };
      await getDb().insert(schema.users).values({ ...u, passwordHash: 'x' });
      return u;
    };
    owner = await mk('owner', 'Owner');
    staff = await mk('staff', 'Jordan');
    otherStaff = await mk('staff', 'Alex');
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
  }, 60_000);

  it('re-sources only the rows the first seed created and still carry its wording', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const seed = await import('../src/lib/seed-trends');
    const db = getDb();
    const r = schema.trendReferences;
    // A database as the first seed left it: eight rows, one summary edited by the owner, one renamed, one the owner's.
    const v1At = new Date('2026-11-01T00:00:00Z');
    await db.insert(r).values(
      seed.CURATED_TRENDS_V1.map((t) => ({ id: randomUUID(), title: t.title, summary: t.summary, category: t.category, sourceName: seed.ORIGINAL_SEED_SOURCE_NAME, sourceUrl: '', sourceKind: 'curated' as const, lastVerifiedAt: v1At })),
    );
    await db.update(r).set({ summary: 'My own words about reveals' }).where(eq(r.title, 'Before/after reveal'));
    await db.update(r).set({ title: 'Our POV shots' }).where(eq(r.title, 'POV chair'));
    const ownersId = randomUUID();
    await db.insert(r).values({ id: ownersId, title: 'Beard sculpt', summary: 'Mine', sourceName: 'My notes', sourceUrl: 'https://example.com/mine', sourceKind: 'curated', lastVerifiedAt: v1At });
    await db.insert(schema.auditLog).values({ id: randomUUID(), userId: null, action: 'trends.seeded_curated', entityType: 'trend_references', data: { inserted: 8 } });

    const result = await seed.ensureCuratedTrends();
    expect(result).toEqual({ updated: 7, inserted: 3 });
    const rows = await db.select().from(r);
    const byTitle = (t: string) => rows.find((x) => x.title === t);

    // Untouched seed rows get the new wording and the memo's sources.
    expect(byTitle('Fade process, no voiceover')).toMatchObject({ sourceName: seed.CURATED_SOURCE_NAME, sourceUrl: seed.CURATED_SOURCES[0].url, lastVerifiedAt: seed.CURATED_REVIEWED_AT });
    expect((byTitle('Fade process, no voiceover')?.data as { sources: unknown[] }).sources).toHaveLength(4);
    expect(byTitle('Speed-ramp montage')).toMatchObject({ sourceName: seed.EDITOR_SUGGESTION_SOURCE_NAME, sourceUrl: '' });
    // The owner's edited summary is kept (with its original title); only the source changes.
    expect(byTitle('Before/after reveal')).toMatchObject({ summary: 'My own words about reveals', sourceName: seed.CURATED_SOURCE_NAME });
    // Renamed and owner-added rows are not touched.
    expect(byTitle('Our POV shots')).toMatchObject({ sourceName: seed.ORIGINAL_SEED_SOURCE_NAME, lastVerifiedAt: v1At });
    expect(rows.find((x) => x.id === ownersId)).toMatchObject({ sourceName: 'My notes', sourceUrl: 'https://example.com/mine', lastVerifiedAt: v1At });
    // The memo's other sourced formats are added once.
    for (const t of ['Technique explainer', 'Fast cut montage', 'Timelapse, posted to both apps']) expect(byTitle(t)).toMatchObject({ sourceKind: 'curated', sourceName: seed.CURATED_SOURCE_NAME });
    expect(rows.every((x) => !/trending|viral/i.test(`${x.title} ${x.summary}`))).toBe(true);

    expect(await seed.ensureCuratedTrends()).toEqual({ inserted: 0, updated: 0 });
    expect(await db.select().from(r)).toHaveLength(rows.length);
  }, 60_000);

  it('lets staff note a trend and delete only their own notes; the owner may delete any', async () => {
    const notes = await import('../src/app/api/trends/notes/route');
    const note = await import('../src/app/api/trends/notes/[id]/route');
    const trends = await import('../src/app/api/trends/route');

    signIn(staff);
    const created = await call(notes.POST, 'POST', '/api/trends/notes', {}, { title: 'Slow fade close-ups, no talking', platform: 'tiktok', seenOn: '2026-11-12', category: 'format', sourceUrl: 'https://www.tiktok.com/@someone/video/1' });
    expect(created.status).toBe(201);
    expect(created.json.trend).toMatchObject({ kind: 'noted', label: 'Noted by Jordan on 12 Nov 2026 · seen on TikTok', notedById: staff.id });
    const bad = await call(notes.POST, 'POST', '/api/trends/notes', {}, { title: '', platform: 'tiktok', seenOn: '2026-11-12' });
    expect(bad.status).toBe(400);
    const noOrigin = await call(notes.POST, 'POST', '/api/trends/notes', {}, { title: 'X', platform: 'tiktok', seenOn: '2026-11-12' }, {});
    expect(noOrigin.status).toBe(403);

    signIn(otherStaff);
    const forbidden = await call(note.DELETE, 'DELETE', `/api/trends/notes/${created.json.trend.id}`, { id: created.json.trend.id });
    expect(forbidden.status).toBe(403);
    const second = await call(notes.POST, 'POST', '/api/trends/notes', {}, { title: 'Mirror reveal', platform: 'in_person', seenOn: '2026-11-13' });
    expect((await call(note.DELETE, 'DELETE', `/api/trends/notes/${second.json.trend.id}`, { id: second.json.trend.id })).status).toBe(200);

    // Staff cannot change curated references.
    expect((await call(trends.POST, 'POST', '/api/trends', {}, { title: 'X', sourceName: 'Me' })).status).toBe(403);

    signIn(owner);
    const overview = await call(trends.GET, 'GET', '/api/trends');
    expect(overview.status).toBe(200);
    expect(overview.json.noted.map((n: { title: string }) => n.title)).toEqual(['Slow fade close-ups, no talking']);
    expect(overview.json.curated.every((c: { kind: string }) => c.kind === 'curated')).toBe(true);
    expect(overview.json.live).toEqual([]);
    expect(overview.json.viewer).toEqual({ id: owner.id, isOwner: true });
    expect(overview.json.sources).toEqual([
      expect.objectContaining({ provider: 'youtube_chart', watch: null, status: expect.objectContaining({ state: 'not_configured', missingEnv: ['YOUTUBE_API_KEY'] }) }),
      // The Instagram hashtag watch (WP5) has its own route tests in hashtag-routes.integration.test.ts.
      expect.objectContaining({ provider: 'instagram_hashtag', watch: null, watches: [] }),
    ]);
    const labels = [...overview.json.noted, ...overview.json.curated].map((i: { label: string }) => i.label);
    expect(labels.every((l: string) => !/trending|viral/i.test(l))).toBe(true);
    expect((await call(note.DELETE, 'DELETE', `/api/trends/notes/${created.json.trend.id}`, { id: created.json.trend.id })).status).toBe(200);

    // Curated routes never touch noted or live rows.
    const again = await call(notes.POST, 'POST', '/api/trends/notes', {}, { title: 'Keep me', platform: 'youtube', seenOn: '2026-11-13' });
    expect((await call(trends.DELETE, 'DELETE', `/api/trends?id=${again.json.trend.id}`)).status).toBe(404);
    expect((await call(trends.PUT, 'PUT', '/api/trends', {}, { id: again.json.trend.id, title: 'Changed' })).status).toBe(404);
  }, 60_000);

  it('lets only the owner turn on the YouTube chart, once a key is set, and limits manual refreshes', async () => {
    const watches = await import('../src/app/api/trends/watches/route');
    const watch = await import('../src/app/api/trends/watches/[id]/route');
    const refresh = await import('../src/app/api/trends/watches/[id]/refresh/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');

    signIn(staff);
    expect((await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'youtube_chart' })).status).toBe(403);

    signIn(owner);
    const noKey = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'youtube_chart' });
    expect(noKey.status).toBe(422);
    expect(noKey.json.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
    expect((await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'instagram_hashtag', hashtag: 'skinfade' })).status).toBe(422);

    process.env.YOUTUBE_API_KEY = 'yt-test-key';
    try {
      const added = await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'youtube_chart' });
      expect(added.status).toBe(200);
      expect(added.json.watch).toMatchObject({ provider: 'youtube_chart', query: 'AU', enabled: true, status: 'pending' });
      expect(added.json.jobId).toBeTruthy();
      const watchId: string = added.json.watch.id;
      const job = await getDb().query.jobs.findFirst({ where: eq(schema.jobs.id, added.json.jobId) });
      expect(job).toMatchObject({ type: 'trends.refresh', refId: watchId, payload: { watchId }, status: 'queued' });
      expect(JSON.stringify(job)).not.toContain('yt-test-key');
      const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'trends.watch_added'));
      expect(audit).toHaveLength(1);

      // Turning it on again changes nothing; refreshing while a read is queued reuses that job.
      expect((await call(watches.POST, 'POST', '/api/trends/watches', {}, { provider: 'youtube_chart' })).json.jobId).toBeNull();
      expect((await call(refresh.POST, 'POST', `/api/trends/watches/${watchId}/refresh`, { id: watchId })).json.jobId).toBe(added.json.jobId);

      // After a successful read, a manual refresh waits 6 hours.
      await getDb().update(schema.jobs).set({ status: 'succeeded' }).where(eq(schema.jobs.id, added.json.jobId));
      await getDb().update(schema.trendWatches).set({ status: 'ok', lastQueriedAt: new Date(), lastSuccessAt: new Date() }).where(eq(schema.trendWatches.id, watchId));
      signIn(staff);
      expect((await call(refresh.POST, 'POST', `/api/trends/watches/${watchId}/refresh`, { id: watchId })).status).toBe(403);
      signIn(owner);
      const limited = await call(refresh.POST, 'POST', `/api/trends/watches/${watchId}/refresh`, { id: watchId });
      expect(limited.status).toBe(429);
      expect(limited.json.error.code).toBe('RATE_LIMITED');
      expect(limited.json.error.details.nextRefreshAt).toBeTruthy();
      await getDb().update(schema.trendWatches).set({ lastQueriedAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(schema.trendWatches.id, watchId));
      const fresh = await call(refresh.POST, 'POST', `/api/trends/watches/${watchId}/refresh`, { id: watchId });
      expect(fresh.status).toBe(200);
      expect(fresh.json.jobId).not.toBe(added.json.jobId);

      // A fetched item, then turning the source off: the items go, the row stays (budget), and staff cannot do it.
      await getDb().insert(schema.trendReferences).values({ id: randomUUID(), title: 'A video', sourceName: 'YouTube AU popular chart (music/movies/gaming)', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', sourceKind: 'live', lastVerifiedAt: new Date(), watchId, externalId: 'abcdefghijk', fetchedAt: new Date(), staleAfter: new Date(Date.now() + 3_600_000), data: { provider: 'youtube_chart', channelTitle: 'C', categoryId: '10', url: 'https://www.youtube.com/watch?v=abcdefghijk', position: 1 } });
      const trends = await import('../src/app/api/trends/route');
      const overview = await call(trends.GET, 'GET', '/api/trends');
      expect(overview.json.live).toHaveLength(1);
      expect(overview.json.live[0].items[0]).toMatchObject({ kind: 'live', title: 'A video', label: expect.stringMatching(/^YouTube AU popular chart \(music\/movies\/gaming\) — fetched /) });
      expect(overview.json.sources[0]).toMatchObject({ status: { state: 'connected', liveMode: 'read_only' }, watch: { id: watchId } });
      signIn(staff);
      expect((await call(watch.DELETE, 'DELETE', `/api/trends/watches/${watchId}`, { id: watchId })).status).toBe(403);
      signIn(owner);
      expect((await call(watch.DELETE, 'DELETE', `/api/trends/watches/${watchId}`, { id: watchId })).status).toBe(200);
      expect(await getDb().select().from(schema.trendReferences).where(eq(schema.trendReferences.watchId, watchId))).toHaveLength(0);
      expect(await getDb().query.trendWatches.findFirst({ where: eq(schema.trendWatches.id, watchId) })).toMatchObject({ enabled: false });
      expect((await call(trends.GET, 'GET', '/api/trends')).json.live).toEqual([]);
      expect((await call(refresh.POST, 'POST', `/api/trends/watches/${watchId}/refresh`, { id: watchId })).status).toBe(404);
    } finally {
      delete process.env.YOUTUBE_API_KEY;
    }
  }, 60_000);
});
