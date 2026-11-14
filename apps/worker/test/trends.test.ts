import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { DEFAULT_SETTINGS, newId, type AssetAnalysis, type GenerationSettings } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import type { WorkerContext } from '../src/context.js';
import { buildPlannerInput } from '../src/handlers/generate.js';
import { TREND_SOURCES, UNSUPPORTED_SOURCE_MESSAGE, cleanupTrends, handleTrendsRefresh } from '../src/handlers/trends.js';
import { loadProjectFootage, loadSettings } from '../src/lib/plan-context.js';
import { classifyYouTubeError, parseYouTubeChart, YOUTUBE_VIDEOS_URL } from '../src/lib/youtube-client.js';
import { trendsModule } from '../src/modules/trends/index.js';
import { YOUTUBE_MESSAGES } from '../src/modules/trends/youtube.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeFetch, fakeRun, json } from './helpers/fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'yt-test-key-0123456789';

/** A YouTube chart response with `n` videos (ids are 11 characters, like YouTube's). */
function chart(ids: string[]): unknown {
  return {
    kind: 'youtube#videoListResponse',
    items: ids.map((id, i) => ({ kind: 'youtube#video', id, snippet: { title: `Video ${id}`, channelTitle: `Channel ${i + 1}`, categoryId: i % 2 ? '20' : '10', thumbnails: { default: { url: 'https://i.ytimg.com/x.jpg' } } } })),
  };
}

function googleError(status: number, reason: string, detailReason?: string): Response {
  return json(status, { error: { code: status, message: 'refused', errors: [{ reason, domain: 'youtube' }], ...(detailReason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: detailReason }] } : {}) } });
}

describe('YouTube chart client', () => {
  it('maps the documented refusals to plain outcomes', () => {
    expect(classifyYouTubeError(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }).kind).toBe('quota');
    expect(classifyYouTubeError(403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }).kind).toBe('quota');
    expect(classifyYouTubeError(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }).kind).toBe('access_not_configured');
    expect(classifyYouTubeError(400, { error: { errors: [{ reason: 'keyInvalid' }] } }).kind).toBe('key_invalid');
    expect(classifyYouTubeError(400, { error: { errors: [{ reason: 'badRequest' }], details: [{ reason: 'API_KEY_INVALID' }] } }).kind).toBe('key_invalid');
    expect(classifyYouTubeError(403, { error: { errors: [{ reason: 'forbidden' }] } }).kind).toBe('forbidden');
    expect(classifyYouTubeError(503, null).kind).toBe('transient');
    expect(classifyYouTubeError(429, null).kind).toBe('transient');
  });

  it('keeps only ids, titles, channels and categories, trimmed and length-limited', () => {
    const items = parseYouTubeChart({
      items: [
        { id: 'abcdefghijk', snippet: { title: `  A\nlong ${'x'.repeat(300)}`, channelTitle: 'Chan', categoryId: '10', description: 'not stored' } },
        { id: 'bad id!', snippet: { title: 'skipped' } },
        { id: 'lmnopqrstuv', snippet: { title: '' } },
        { id: 'wxyz0123456', snippet: { title: 'Second', categoryId: 'music' } },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ videoId: 'abcdefghijk', channelTitle: 'Chan', categoryId: '10', url: 'https://www.youtube.com/watch?v=abcdefghijk', position: 1 });
    expect(items[0]?.title.length).toBeLessThanOrEqual(160);
    expect(items[0]?.title.startsWith('A long')).toBe(true);
    expect(items[1]).toMatchObject({ videoId: 'wxyz0123456', categoryId: '', position: 2 });
    expect(parseYouTubeChart({ nope: true })).toEqual([]);
  });

  it('registers one handler, a daily keyed schedule, a cleanup task and the watch as ref id', () => {
    expect(trendsModule.handlers?.map((h) => h.type)).toEqual(['trends.refresh']);
    expect(trendsModule.crons).toEqual([{ type: 'trends.refresh', cron: '41 5 * * *', payload: { watchId: null }, key: 'daily' }]);
    expect(trendsModule.cleanupTasks?.map((t) => t.name)).toEqual(['trends']);
    expect(trendsModule.refIdFor?.('trends.refresh', { watchId: 'w1' })).toBe('w1');
    expect(trendsModule.refIdFor?.('trends.refresh', { watchId: null })).toBeNull();
    expect(trendsModule.refIdFor?.('render.export', {})).toBeUndefined();
  });
});

describe('no trend data reaches the planners (source check)', () => {
  async function filesUnder(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await filesUnder(full)));
      else if (/\.ts$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('only the trends module reads trend tables in the worker, and the AI package never does', async () => {
    const workerSrc = path.join(here, '..', 'src');
    const aiSrc = path.join(here, '..', '..', '..', 'packages', 'ai', 'src');
    const allowed = new Set([path.join(workerSrc, 'handlers', 'trends.ts')]);
    const offenders: string[] = [];
    for (const file of [...(await filesUnder(workerSrc)), ...(await filesUnder(aiSrc))]) {
      if (allowed.has(file) || file.startsWith(path.join(workerSrc, 'modules', 'trends'))) continue;
      const text = await readFile(file, 'utf8');
      if (/trendReferences|trend_references|trendWatches|trend_watches/.test(text)) offenders.push(path.relative(path.join(here, '..', '..', '..'), file));
    }
    expect(offenders).toEqual([]);
  });
});

const skip = !testDatabaseUrl();

describe.skipIf(skip)('trends.refresh on a real database (YouTube fake, no network)', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let ctx: WorkerContext;
  const logLines: string[] = [];
  const enqueued: Array<{ type: string; payload: unknown; singletonKey?: string | undefined }> = [];

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
    ctx = {
      env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: t.url, APP_SECRET: 'test-secret-test-secret-test-secret-0123', YOUTUBE_API_KEY: API_KEY }),
      db: handle.db,
      store: {} as WorkerContext['store'],
      queue: {
        enqueue: async (type: string, payload: unknown, options: { singletonKey?: string }) => {
          enqueued.push({ type, payload, singletonKey: options.singletonKey });
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
  }, 60_000);

  afterAll(async () => {
    await drop();
  });

  beforeEach(async () => {
    await handle.db.delete(schema.trendWatches);
    await handle.db.delete(schema.trendReferences);
    enqueued.length = 0;
  });

  async function addWatch(values: Partial<typeof schema.trendWatches.$inferInsert> = {}): Promise<string> {
    const id = newId();
    await handle.db.insert(schema.trendWatches).values({ id, provider: 'youtube_chart', query: 'AU', ...values });
    return id;
  }

  const watchRow = (id: string) => handle.db.query.trendWatches.findFirst({ where: eq(schema.trendWatches.id, id) });
  const itemsOf = (id: string) => handle.db.select().from(schema.trendReferences).where(eq(schema.trendReferences.watchId, id));

  it('stores a 200 chart, then upserts and removes items missing from the next fetch', async () => {
    const watchId = await addWatch();
    const first = fakeFetch(() => json(200, chart(['aaaaaaaaaa1', 'bbbbbbbbbb2', 'ccccccccccc'])));
    await handleTrendsRefresh({ ...ctx, fetch: first }, fakeRun(), { watchId });
    expect(first.calls).toHaveLength(1);
    const url = new URL(first.calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(YOUTUBE_VIDEOS_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ part: 'snippet', chart: 'mostPopular', regionCode: 'AU', maxResults: '20', key: API_KEY });

    let items = await itemsOf(watchId);
    expect(items.map((i) => i.externalId).sort()).toEqual(['aaaaaaaaaa1', 'bbbbbbbbbb2', 'ccccccccccc']);
    const a = items.find((i) => i.externalId === 'aaaaaaaaaa1');
    expect(a).toMatchObject({ sourceKind: 'live', title: 'Video aaaaaaaaaa1', sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaa1', sourceName: 'YouTube AU popular chart (music/movies/gaming)' });
    expect(a?.data).toEqual({ provider: 'youtube_chart', channelTitle: 'Channel 1', categoryId: '10', url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1', position: 1 });
    expect(a!.staleAfter!.getTime() - a!.fetchedAt!.getTime()).toBe(48 * 3_600_000);
    const w1 = await watchRow(watchId);
    expect(w1).toMatchObject({ status: 'ok', statusMessage: '' });
    expect(w1?.lastQueriedAt).toBeInstanceOf(Date);
    expect(w1?.lastSuccessAt).toBeInstanceOf(Date);
    const firstId = a!.id;

    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => json(200, chart(['ccccccccccc', 'aaaaaaaaaa1', 'ddddddddddd']))) }, fakeRun(), { watchId });
    items = await itemsOf(watchId);
    expect(items.map((i) => i.externalId).sort()).toEqual(['aaaaaaaaaa1', 'ccccccccccc', 'ddddddddddd']);
    expect(items.find((i) => i.externalId === 'aaaaaaaaaa1')).toMatchObject({ id: firstId, data: expect.objectContaining({ position: 2 }) });

    // The API key reaches only the request URL: the logs carry it redacted.
    const logs = logLines.join('\n');
    expect(logs).toContain('youtube.chart');
    expect(logs).not.toContain(API_KEY);
  });

  it('records quotaExceeded as quota and keeps the items it has', async () => {
    const watchId = await addWatch();
    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => json(200, chart(['aaaaaaaaaa1']))) }, fakeRun(), { watchId });
    const run = fakeRun();
    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => googleError(403, 'quotaExceeded')) }, run, { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'quota', statusMessage: YOUTUBE_MESSAGES.quota });
    expect(await itemsOf(watchId)).toHaveLength(1);
    expect(run.messages.at(-1)).toBe(YOUTUBE_MESSAGES.quota);
    const audit = await handle.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'trends.source_quota'), eq(schema.auditLog.entityId, watchId)));
    expect(audit).toHaveLength(1);
  });

  it('records keyInvalid and accessNotConfigured as plain errors without retrying', async () => {
    const watchId = await addWatch();
    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => googleError(400, 'badRequest', 'API_KEY_INVALID')) }, fakeRun(), { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: YOUTUBE_MESSAGES.key_invalid });
    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => googleError(400, 'keyInvalid')) }, fakeRun(), { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: YOUTUBE_MESSAGES.key_invalid });
    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => googleError(403, 'accessNotConfigured', 'SERVICE_DISABLED')) }, fakeRun(), { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: YOUTUBE_MESSAGES.access_not_configured });
    expect(await itemsOf(watchId)).toHaveLength(0);
  });

  it('retries a server error once, then shows a plain error on the last attempt', async () => {
    const watchId = await addWatch();
    const failing = fakeFetch(() => json(503, { error: { code: 503, errors: [{ reason: 'backendError' }] } }));
    await expect(handleTrendsRefresh({ ...ctx, fetch: failing }, fakeRun({ willRetry: true }), { watchId })).rejects.toThrow(/YouTube answered with an error \(503\)/);
    expect((await watchRow(watchId))?.status).toBe('pending');
    await expect(handleTrendsRefresh({ ...ctx, fetch: failing }, fakeRun({ willRetry: false }), { watchId })).rejects.toThrow();
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: expect.stringMatching(/YouTube could not be reached/) });
  });

  it('does nothing for a turned-off watch and refuses providers this version cannot read', async () => {
    const off = await addWatch({ enabled: false });
    const f = fakeFetch(() => json(200, chart(['aaaaaaaaaa1'])));
    await handleTrendsRefresh({ ...ctx, fetch: f }, fakeRun(), { watchId: off });
    expect(f.calls).toHaveLength(0);
    // A provider missing from the source list (the Instagram hashtag watch has its own tests in trends-instagram.test.ts).
    const ig = await addWatch({ provider: 'instagram_hashtag', query: 'skinfade' });
    await handleTrendsRefresh({ ...ctx, fetch: f }, fakeRun(), { watchId: ig }, { youtube_chart: TREND_SOURCES.youtube_chart });
    expect(f.calls).toHaveLength(0);
    expect(await watchRow(ig)).toMatchObject({ status: 'error', statusMessage: UNSUPPORTED_SOURCE_MESSAGE });
  });

  it('fails plainly when the key was removed from the server', async () => {
    const watchId = await addWatch();
    const noKey = { ...ctx, env: { ...ctx.env, YOUTUBE_API_KEY: undefined }, fetch: fakeFetch(() => json(200, chart(['aaaaaaaaaa1']))) };
    await handleTrendsRefresh(noKey, fakeRun(), { watchId });
    expect(await watchRow(watchId)).toMatchObject({ status: 'error', statusMessage: YOUTUBE_MESSAGES.no_key });
  });

  it('queues one refresh per enabled watch for the daily run', async () => {
    const a = await addWatch();
    await addWatch({ provider: 'youtube_chart', query: 'NZ', enabled: false });
    await handleTrendsRefresh(ctx, fakeRun(), { watchId: null });
    expect(enqueued).toEqual([{ type: 'trends.refresh', payload: { watchId: a }, singletonKey: `trends:${a}` }]);
    const jobs = await handle.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'trends.refresh'));
    expect(jobs.map((j) => j.refId)).toContain(a);
  });

  it('deletes live items after 7 days and turned-off watches a week after their last query', async () => {
    const watchId = await addWatch();
    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => json(200, chart(['aaaaaaaaaa1', 'bbbbbbbbbb2']))) }, fakeRun(), { watchId });
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    await handle.db.update(schema.trendReferences).set({ fetchedAt: eightDaysAgo }).where(eq(schema.trendReferences.externalId, 'aaaaaaaaaa1'));
    const curatedId = newId();
    await handle.db.insert(schema.trendReferences).values({ id: curatedId, title: 'Old curated', sourceName: 'Guide', sourceKind: 'curated', lastVerifiedAt: eightDaysAgo });
    const recentOff = await addWatch({ query: 'GB', enabled: false, lastQueriedAt: new Date(Date.now() - 2 * 86_400_000) });
    const oldOff = await addWatch({ query: 'US', enabled: false, lastQueriedAt: eightDaysAgo });

    const summary = await cleanupTrends(ctx);
    expect(summary).toMatch(/1 old live item, 1 removed source/);
    expect((await itemsOf(watchId)).map((i) => i.externalId)).toEqual(['bbbbbbbbbb2']);
    expect(await handle.db.query.trendReferences.findFirst({ where: eq(schema.trendReferences.id, curatedId) })).toBeTruthy();
    expect(await watchRow(recentOff)).toBeTruthy();
    expect(await watchRow(oldOff)).toBeUndefined();
  });

  it('never puts curated, noted or live trend text into planner input', async () => {
    const watchId = await addWatch();
    await handleTrendsRefresh({ ...ctx, fetch: fakeFetch(() => json(200, chart(['zzzzzzzzzz9']))) }, fakeRun(), { watchId });
    const ownerId = newId();
    await handle.db.insert(schema.users).values({ id: ownerId, email: `o-${ownerId}@example.com`, displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    await handle.db.insert(schema.trendReferences).values([
      { id: newId(), title: 'CuratedMarkerFormat', summary: 'CuratedMarkerSummary', sourceName: 'Guide', sourceUrl: 'https://example.com/curated-marker', sourceKind: 'curated', lastVerifiedAt: new Date() },
      { id: newId(), title: 'NotedMarkerTitle', summary: 'NotedMarkerSummary', sourceName: 'Noted by staff', sourceKind: 'noted', lastVerifiedAt: new Date(), notedBy: ownerId, data: { platform: 'tiktok', seenOn: '2026-11-12' } },
    ]);
    await handle.db.insert(schema.settings).values({ id: 'default', data: DEFAULT_SETTINGS }).onConflictDoNothing();
    const projectId = newId();
    await handle.db.insert(schema.projects).values({ id: projectId, ownerId, title: 'Planner input check' });
    const assetId = newId();
    await handle.db.insert(schema.mediaAssets).values({
      id: assetId,
      projectId,
      kind: 'video',
      originalFilename: 'clip.mp4',
      mimeType: 'video/mp4',
      byteSize: 1,
      originalKey: `projects/${projectId}/assets/${assetId}/original.mp4`,
      status: 'ready',
      analysis: analysisFor(assetId),
    });
    const footage = await loadProjectFootage(ctx, projectId);
    expect(footage?.assets).toHaveLength(1);
    const settings: GenerationSettings = { durationSec: 15, styles: ['beat_montage'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: 'Keep it simple', musicStartSec: null };
    const input = buildPlannerInput({ styleId: 'beat_montage', settings, footage: footage!, music: null, appSettings: await loadSettings(ctx), attempt: 0 });
    const text = JSON.stringify(input);
    for (const marker of ['CuratedMarker', 'NotedMarker', 'zzzzzzzzzz9', 'Video zzzzzzzzzz9', 'curated-marker', 'youtube.com', 'YouTube AU popular chart']) expect(text).not.toContain(marker);
  });
});

function analysisFor(assetId: string): AssetAnalysis {
  const quality = { sharpness: 0.7, brightness: 0.5, motion: 0.2, contrast: 0.4, exposureIssue: 'none' as const, score: 0.8 };
  const labels = ['before', 'cutting', 'fade_detail', 'result', 'reaction'] as const;
  return {
    version: 1,
    assetId,
    probe: {
      container: 'mp4',
      durationSec: 12,
      fileSizeBytes: 1,
      video: { codec: 'h264', codedWidth: 1080, codedHeight: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, fps: 30, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: null }, isHdr: false, hdrFormat: null, bitrate: null },
      audio: null,
    },
    shots: labels.map((label, i) => ({ id: `${assetId}-s${i}`, assetId, startSec: i * 2, endSec: i * 2 + 2, quality, label, labelSource: 'heuristic' as const, confidence: 0.6, description: '', framing: 'unknown' as const, focus: null, issues: [] })),
    sampledFrames: [],
    audio: { hasAudio: false, integratedLoudnessLufs: null, silenceRatio: 1, speechLikely: false, speechConfidence: 0 },
    transcript: null,
    labelling: { source: 'heuristic', model: null, note: '' },
    completedAt: new Date().toISOString(),
  };
}
