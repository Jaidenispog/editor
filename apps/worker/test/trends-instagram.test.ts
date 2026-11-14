import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { HASHTAG_WEEKLY_LIMIT, hashtagLimitMessage, newId } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import type { WorkerContext } from '../src/context.js';
import { handleTrendsRefresh, TREND_SOURCES } from '../src/handlers/trends.js';
import { encryptCredential } from '../src/lib/credentials.js';
import { HttpTimeoutError } from '../src/lib/http.js';
import { GraphApiError } from '../src/lib/meta/graph.js';
import { INSTAGRAM_HASHTAG_MESSAGES, TOP_MEDIA_FIELDS, claimHashtagQuery, hashtagErrorOutcome, parseTopMedia, refreshInstagramHashtag } from '../src/modules/trends/instagram.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeFetch, fakeRun, json, type FakeCall } from './helpers/fakes.js';

/**
 * Instagram hashtag watch (WP5) against a Graph fake: no Meta endpoint is ever contacted. The fake answers on a
 * test-only base URL (honoured only when NODE_ENV=test) and records every request, so the tests can check what was
 * asked for and that the token never appears in a URL, a payload or a log line.
 */

const TOKEN = 'EAAG-system-user-token-for-tests-0123456789';
const GRAPH = 'http://graph.fake.test';
const IG_USER = '17841400000000001';

function media(ids: string[], extra: Record<string, unknown> = {}): unknown {
  return {
    data: ids.map((id, i) => ({
      id,
      media_type: i % 2 ? 'IMAGE' : 'VIDEO',
      permalink: `https://www.instagram.com/p/${id}/`,
      timestamp: '2026-11-12T03:04:05+0000',
      like_count: 100 + i,
      comments_count: i,
      caption: 'A caption that must never be stored',
      media_url: 'https://scontent.cdninstagram.com/x.mp4',
      username: 'someone',
      ...extra,
    })),
  };
}

function graphError(status: number, code: number, message = 'Refused', subcode?: number): Response {
  return json(status, { error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'x' } });
}

/** Routes the fake by endpoint: `search` and `top` answer for the two calls. */
function graphFake(answers: { search?: () => Response; top?: () => Response }): typeof fetch & { calls: FakeCall[] } {
  return fakeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith('/ig_hashtag_search')) return answers.search ? answers.search() : json(200, { data: [{ id: '17843853986012965' }] });
    if (url.pathname.endsWith('/top_media')) return answers.top ? answers.top() : json(200, media(['18000000000000001', '18000000000000002']));
    return json(404, { error: { message: 'Unknown path in fake', code: 803 } });
  });
}

describe('Instagram hashtag reads (pure parts)', () => {
  it('keeps only the allowed post fields, Instagram links only, at most nine in Instagram’s order', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `1800000000000${String(i).padStart(4, '0')}`);
    const body = media(ids) as { data: Array<Record<string, unknown>> };
    body.data[1]!['permalink'] = 'https://evil.example.com/p/x/';
    body.data[2]!['id'] = 'not-a-number';
    body.data[3]!['like_count'] = undefined;
    const items = parseTopMedia(body, '#SkinFade');
    expect(items).toHaveLength(9);
    expect(items[0]).toEqual({
      externalId: ids[0],
      title: 'Video under #skinfade, posted 12 Nov 2026',
      category: 'other',
      sourceName: 'Instagram hashtag watch',
      sourceUrl: `https://www.instagram.com/p/${ids[0]}/`,
      data: { provider: 'instagram_hashtag', hashtag: 'skinfade', rank: 1, mediaType: 'VIDEO', postedAt: '2026-11-12T03:04:05.000Z', likeCount: 100, commentsCount: 0, permalink: `https://www.instagram.com/p/${ids[0]}/` },
    });
    expect(items.map((i) => i.externalId)).not.toContain(ids[1]);
    expect(items.map((i) => i.externalId)).not.toContain('not-a-number');
    expect(items[1]?.data).toMatchObject({ rank: 2, likeCount: null, commentsCount: 3 });
    const stored = JSON.stringify(items);
    for (const banned of ['caption', 'A caption', 'scontent', 'someone']) expect(stored).not.toContain(banned);
    expect(parseTopMedia({ nope: true }, 'x')).toEqual([]);
  });

  it('maps Graph refusals as the design says, and leaves temporary failures to the retry', () => {
    expect(hashtagErrorOutcome(new GraphApiError(400, 190, 463, 'Session has expired', null))).toMatchObject({ status: 'needs_reauth', message: INSTAGRAM_HASHTAG_MESSAGES.reconnect });
    expect(hashtagErrorOutcome(new GraphApiError(403, 10, null, 'Application does not have permission for this action', null))).toMatchObject({ status: 'unavailable', message: INSTAGRAM_HASHTAG_MESSAGES.unavailable });
    expect(hashtagErrorOutcome(new GraphApiError(403, 200, null, 'Permissions error', null))).toMatchObject({ status: 'unavailable' });
    expect(hashtagErrorOutcome(new GraphApiError(400, 100, null, 'This feature is not available to this app', null))).toMatchObject({ status: 'unavailable' });
    for (const code of [4, 17, 32, 613]) expect(hashtagErrorOutcome(new GraphApiError(400, code, null, 'Too many calls', null))).toMatchObject({ status: 'quota', message: INSTAGRAM_HASHTAG_MESSAGES.slowDown });
    expect(hashtagErrorOutcome(new GraphApiError(400, 24, 2207024, 'You can query a maximum of 30 unique hashtags within a 7 day period', null))).toMatchObject({ status: 'quota', message: INSTAGRAM_HASHTAG_MESSAGES.weeklyLimitAtInstagram });
    expect(hashtagErrorOutcome(new GraphApiError(400, 100, null, 'Invalid parameter', null))).toMatchObject({ status: 'error', message: expect.stringContaining('Instagram said: Invalid parameter') });
    expect(hashtagErrorOutcome(new GraphApiError(500, 2, null, 'Service temporarily unavailable', null))).toBeNull();
    expect(hashtagErrorOutcome(new GraphApiError(503, null, null, 'HTTP 503', null))).toBeNull();
    expect(hashtagErrorOutcome(new HttpTimeoutError('meta.hashtag_top_media', 15_000))).toBeNull();
    expect(hashtagErrorOutcome(new Error('socket hang up'))).toBeNull();
  });

  it('is registered as the instagram_hashtag source of trends.refresh', () => {
    expect(TREND_SOURCES.instagram_hashtag).toBe(refreshInstagramHashtag);
    expect(TREND_SOURCES.youtube_chart).toBeTypeOf('function');
  });
});

const skip = !testDatabaseUrl();

describe.skipIf(skip)('trends.refresh for an Instagram hashtag (Graph fake, real database)', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let ctx: WorkerContext;
  let accountId: string;
  let connId: string;
  const logLines: string[] = [];
  const enqueued: Array<{ type: string; payload: unknown }> = [];

  beforeAll(async () => {
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    const sink = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    });
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: t.url,
      APP_SECRET: 'test-secret-test-secret-test-secret-0123',
      META_APP_ID: 'fake-app',
      META_APP_SECRET: 'fake-app-secret',
      META_LOGIN_CONFIG_ID: 'fake-config',
      META_GRAPH_BASE_URL: GRAPH,
    });
    ctx = {
      env,
      db: handle.db,
      store: {} as WorkerContext['store'],
      queue: {
        enqueue: async (type: string, payload: unknown) => {
          enqueued.push({ type, payload });
          return `boss-${enqueued.length}`;
        },
      } as unknown as WorkerContext['queue'],
      ai: {} as WorkerContext['ai'],
      logger: pino({ level: 'debug' }, sink),
      workerId: 'test-worker',
      fontsDir: '',
      tmpRoot: '',
      fetch: fakeFetch(() => {
        throw new Error('No network access in tests');
      }),
    };
    connId = newId();
    await handle.db.insert(schema.integrationConnections).values({ id: connId, provider: 'meta', status: 'connected', accessTokenEncrypted: encryptCredential(env, TOKEN) });
    accountId = newId();
    await handle.db.insert(schema.socialAccounts).values({ id: accountId, platform: 'instagram', externalId: IG_USER, username: 'studio', provider: 'meta_graph', connectionId: connId, status: 'connected', capabilities: { contentPublish: true } });
  }, 60_000);

  afterAll(async () => {
    await drop();
  });

  beforeEach(async () => {
    await handle.db.delete(schema.trendWatches);
    await handle.db.delete(schema.trendReferences);
    await handle.db.delete(schema.auditLog);
    await handle.db.update(schema.socialAccounts).set({ status: 'connected', capabilities: { contentPublish: true } }).where(eq(schema.socialAccounts.id, accountId));
    await handle.db.update(schema.integrationConnections).set({ status: 'connected' }).where(eq(schema.integrationConnections.id, connId));
    enqueued.length = 0;
    logLines.length = 0;
  });

  async function addWatch(values: Partial<typeof schema.trendWatches.$inferInsert> = {}): Promise<string> {
    const id = newId();
    await handle.db.insert(schema.trendWatches).values({ id, provider: 'instagram_hashtag', query: 'skinfade', socialAccountId: accountId, ...values });
    return id;
  }
  const watchRow = (id: string) => handle.db.query.trendWatches.findFirst({ where: eq(schema.trendWatches.id, id) });
  const itemsOf = (id: string) => handle.db.select().from(schema.trendReferences).where(eq(schema.trendReferences.watchId, id));
  const account = () => handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, accountId) });
  const audits = (action: string, id: string) => handle.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.entityId, id)));

  it('searches once, stores the hashtag id and the top posts, then upserts and removes posts no longer listed', async () => {
    const watchId = await addWatch();
    const first = graphFake({});
    await handleTrendsRefresh({ ...ctx, fetch: first }, fakeRun(), { watchId });

    expect(first.calls).toHaveLength(2);
    const search = new URL(first.calls[0]!.url);
    expect(`${search.origin}${search.pathname}`).toBe(`${GRAPH}/${ctx.env.META_GRAPH_VERSION}/ig_hashtag_search`);
    expect(search.searchParams.get('user_id')).toBe(IG_USER);
    expect(search.searchParams.get('q')).toBe('skinfade');
    const top = new URL(first.calls[1]!.url);
    expect(top.pathname).toBe(`/${ctx.env.META_GRAPH_VERSION}/17843853986012965/top_media`);
    expect(Object.fromEntries(top.searchParams)).toMatchObject({ user_id: IG_USER, fields: TOP_MEDIA_FIELDS, limit: '9' });
    // The token travels only in the Authorization header: never in a URL, a log line or the job payload.
    for (const call of first.calls) {
      expect(call.method).toBe('GET');
      expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
      expect(new URL(call.url).searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    }

    const watch = await watchRow(watchId);
    expect(watch).toMatchObject({ status: 'ok', statusMessage: '', externalId: '17843853986012965' });
    expect(watch?.lastQueriedAt).toBeInstanceOf(Date);
    let items = await itemsOf(watchId);
    expect(items.map((i) => i.externalId).sort()).toEqual(['18000000000000001', '18000000000000002']);
    const a = items.find((i) => i.externalId === '18000000000000001')!;
    expect(a).toMatchObject({ sourceKind: 'live', title: 'Video under #skinfade, posted 12 Nov 2026', sourceUrl: 'https://www.instagram.com/p/18000000000000001/', summary: '' });
    expect(a.data).toEqual({ provider: 'instagram_hashtag', hashtag: 'skinfade', rank: 1, mediaType: 'VIDEO', postedAt: '2026-11-12T03:04:05.000Z', likeCount: 100, commentsCount: 0, permalink: 'https://www.instagram.com/p/18000000000000001/' });
    expect(a.staleAfter!.getTime() - a.fetchedAt!.getTime()).toBe(48 * 3_600_000);
    expect((await account())?.capabilities).toMatchObject({ hashtagSearch: true, contentPublish: true });

    const second = graphFake({ top: () => json(200, media(['18000000000000002', '18000000000000003'])) });
    await handleTrendsRefresh({ ...ctx, fetch: second }, fakeRun(), { watchId });
    expect(second.calls.map((c) => new URL(c.url).pathname.split('/').pop())).toEqual(['top_media']);
    items = await itemsOf(watchId);
    expect(items.map((i) => i.externalId).sort()).toEqual(['18000000000000002', '18000000000000003']);
    expect(items.find((i) => i.externalId === '18000000000000002')?.data).toMatchObject({ rank: 1 });

    const logs = logLines.join('\n');
    expect(logs).toContain('meta.hashtag_top_media');
    expect(logs).not.toContain(TOKEN);

    await handleTrendsRefresh(ctx, fakeRun(), { watchId: null });
    expect(enqueued).toEqual([{ type: 'trends.refresh', payload: { watchId } }]);
    const jobs = await handle.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'trends.refresh'));
    expect(JSON.stringify(jobs)).not.toContain(TOKEN);
    expect(JSON.stringify(await handle.db.select().from(schema.auditLog))).not.toContain(TOKEN);
  });

  it('code 190: the watch needs reconnecting, items are kept, the account is left to the publishing check', async () => {
    const watchId = await addWatch();
    await handleTrendsRefresh({ ...ctx, fetch: graphFake({}) }, fakeRun(), { watchId });
    const run = fakeRun();
    await handleTrendsRefresh({ ...ctx, fetch: graphFake({ top: () => graphError(400, 190, 'Error validating access token: Session has expired', 463) }) }, run, { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'needs_reauth', statusMessage: INSTAGRAM_HASHTAG_MESSAGES.reconnect });
    expect(await itemsOf(watchId)).toHaveLength(2);
    expect(run.messages.at(-1)).toBe(INSTAGRAM_HASHTAG_MESSAGES.reconnect);
    expect(await audits('trends.source_needs_reauth', watchId)).toHaveLength(1);
    expect((await account())?.status).toBe('connected');
  });

  it('code 10: hashtag search is not available, recorded on the account, without a retry', async () => {
    const watchId = await addWatch();
    const fake = graphFake({ search: () => graphError(403, 10, 'Application does not have permission for this action') });
    await handleTrendsRefresh({ ...ctx, fetch: fake }, fakeRun({ willRetry: true }), { watchId });
    expect(fake.calls).toHaveLength(1);
    expect(await watchRow(watchId)).toMatchObject({ status: 'unavailable', statusMessage: INSTAGRAM_HASHTAG_MESSAGES.unavailable, externalId: null });
    expect((await account())?.capabilities).toMatchObject({ hashtagSearch: false });
    expect(await audits('trends.source_unavailable', watchId)).toHaveLength(1);
  });

  it('code 4: Instagram asked us to slow down; no retry, tried again tomorrow', async () => {
    const watchId = await addWatch({ externalId: '17843853986012965' });
    await handleTrendsRefresh({ ...ctx, fetch: graphFake({ top: () => graphError(400, 4, 'Application request limit reached') }) }, fakeRun({ willRetry: true }), { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'quota', statusMessage: INSTAGRAM_HASHTAG_MESSAGES.slowDown });
  });

  it('an empty search result says the hashtag was not found', async () => {
    const watchId = await addWatch({ query: 'nosuchtagatall' });
    const fake = graphFake({ search: () => json(200, { data: [] }) });
    await handleTrendsRefresh({ ...ctx, fetch: fake }, fakeRun(), { watchId });
    expect(fake.calls).toHaveLength(1);
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: INSTAGRAM_HASHTAG_MESSAGES.notFound, externalId: null });
    expect(await itemsOf(watchId)).toHaveLength(0);
  });

  it('keeps to 30 hashtags in any 7 days: a new one waits, one already counted is read again', async () => {
    const now = Date.now();
    const oldest = new Date(now - 6 * 86_400_000);
    // 30 hashtags queried this week (some turned off since; they still count), plus one from 8 days ago that does not.
    await handle.db.insert(schema.trendWatches).values(
      Array.from({ length: HASHTAG_WEEKLY_LIMIT }, (_, i) => ({
        id: newId(),
        provider: 'instagram_hashtag' as const,
        query: `tag${i}`,
        socialAccountId: accountId,
        enabled: i < 5,
        status: 'ok' as const,
        externalId: `1784385398601${String(i).padStart(4, '0')}`,
        lastQueriedAt: i === 0 ? oldest : new Date(now - 3_600_000),
      })),
    );
    await addWatch({ query: 'lastweek', enabled: false, lastQueriedAt: new Date(now - 8 * 86_400_000) });

    const fresh = await addWatch({ query: 'taperfade' });
    const fake = graphFake({});
    const run = fakeRun();
    await handleTrendsRefresh({ ...ctx, fetch: fake }, run, { watchId: fresh });
    expect(fake.calls).toHaveLength(0);
    const refused = await watchRow(fresh);
    const freeOn = new Date(oldest.getTime() + 7 * 86_400_000);
    expect(refused).toMatchObject({ status: 'quota', lastQueriedAt: null });
    expect(refused?.statusMessage).toBe(hashtagLimitMessage(freeOn));
    expect(refused?.statusMessage).toMatch(/^Instagram allows 30 hashtags a week\. You can add another on \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);
    expect(run.messages.at(-1)).toBe(refused?.statusMessage);

    // A hashtag already counted this week may be read again: it does not add to the count.
    const counted = await handle.db.query.trendWatches.findFirst({ where: eq(schema.trendWatches.query, 'tag1') });
    const again = graphFake({});
    await handleTrendsRefresh({ ...ctx, fetch: again }, fakeRun(), { watchId: counted!.id });
    expect(again.calls.map((c) => new URL(c.url).pathname.split('/').pop())).toEqual(['top_media']);
    expect((await watchRow(counted!.id))?.status).toBe('ok');

    // Once the oldest query is more than 7 days old, a place frees up.
    await handle.db.update(schema.trendWatches).set({ lastQueriedAt: new Date(now - 7 * 86_400_000 - 60_000) }).where(eq(schema.trendWatches.query, 'tag0'));
    const later = graphFake({});
    await handleTrendsRefresh({ ...ctx, fetch: later }, fakeRun(), { watchId: fresh });
    expect(later.calls).toHaveLength(2);
    expect(await watchRow(fresh)).toMatchObject({ status: 'ok' });
  });

  it('gives the last free place to one of two hashtags read at the same moment', async () => {
    const now = new Date();
    await handle.db.insert(schema.trendWatches).values(
      Array.from({ length: HASHTAG_WEEKLY_LIMIT - 1 }, (_, i) => ({ id: newId(), provider: 'instagram_hashtag' as const, query: `busy${i}`, socialAccountId: accountId, enabled: false, lastQueriedAt: new Date(now.getTime() - 3_600_000) })),
    );
    const a = await addWatch({ query: 'first' });
    const b = await addWatch({ query: 'second' });
    const results = await Promise.all([claimHashtagQuery(handle.db, { id: a }, now), claimHashtagQuery(handle.db, { id: b }, now)]);
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => typeof r === 'object' && r.status === 'quota')).toHaveLength(1);
  });

  it('retries a Graph server error once, then shows a plain error', async () => {
    const watchId = await addWatch({ externalId: '17843853986012965' });
    const failing = graphFake({ top: () => graphError(500, 2, 'An unexpected error has occurred. Please retry your request later.') });
    await expect(handleTrendsRefresh({ ...ctx, fetch: failing }, fakeRun({ willRetry: true }), { watchId })).rejects.toBeInstanceOf(GraphApiError);
    expect((await watchRow(watchId))?.status).toBe('pending');
    await expect(handleTrendsRefresh({ ...ctx, fetch: failing }, fakeRun({ willRetry: false }), { watchId })).rejects.toThrow();
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: expect.stringMatching(/Instagram could not be reached/) });
  });

  it('calls nothing without a usable Instagram connection, and asks to reconnect when it needs it', async () => {
    const orphan = await addWatch({ query: 'noaccount', socialAccountId: null });
    const fake = graphFake({});
    await handleTrendsRefresh({ ...ctx, fetch: fake }, fakeRun(), { watchId: orphan });
    expect(await watchRow(orphan)).toMatchObject({ status: 'error', statusMessage: INSTAGRAM_HASHTAG_MESSAGES.noAccount });

    const watchId = await addWatch();
    await handle.db.update(schema.integrationConnections).set({ status: 'needs_reauth' }).where(eq(schema.integrationConnections.id, connId));
    await handleTrendsRefresh({ ...ctx, fetch: fake }, fakeRun(), { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'needs_reauth', statusMessage: INSTAGRAM_HASHTAG_MESSAGES.reconnect });

    await handle.db.update(schema.integrationConnections).set({ status: 'disconnected' }).where(eq(schema.integrationConnections.id, connId));
    await handleTrendsRefresh({ ...ctx, fetch: fake }, fakeRun(), { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: INSTAGRAM_HASHTAG_MESSAGES.noAccount });
    expect(fake.calls).toHaveLength(0);
  });
});
