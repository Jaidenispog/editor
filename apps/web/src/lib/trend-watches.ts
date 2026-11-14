import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppError, formatTrendDateTime, nextManualRefreshAt, YOUTUBE_CHART_REGION, newId, type TrendWatchProvider, type TrendWatchStatus } from '@studio/core';
import { schema, type TrendWatch } from '@studio/db';
import { z } from 'zod';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { youTubeChartStatus, type TrendWatchFact } from './integrations/trends.js';
import { ACTIVE_JOB_STATUSES, createTrackedJob } from './jobs.js';
import type { IntegrationStatus } from './shared/integration-types.js';
import { listTrends, type TrendItemDto } from './trends.js';

/**
 * Live trend sources the owner turns on (`trend_watches`). Turning one on, removing it and refreshing it by hand
 * are owner actions and are audit-logged. Every fetch is read-only and runs in the worker (`trends.refresh`).
 */

/** Body for POST /api/trends/watches. The Instagram hashtag watch is accepted by the schema but built by WP5. */
export const AddWatchSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('youtube_chart') }),
  z.object({ provider: z.literal('instagram_hashtag'), hashtag: z.string().trim().min(1).max(100) }),
]);

/** A watch as sent to the browser (never any credential). */
export interface TrendWatchDto {
  id: string;
  provider: TrendWatchProvider;
  query: string;
  enabled: boolean;
  status: TrendWatchStatus;
  statusMessage: string;
  lastQueriedAt: string | null;
  lastSuccessAt: string | null;
  /** When the owner may next refresh it by hand; null means now. */
  nextRefreshAt: string | null;
}

/** One live source card: its status (shared integration contract) and its watch, if turned on. */
export interface TrendSourceDto {
  provider: TrendWatchProvider;
  status: IntegrationStatus;
  watch: TrendWatchDto | null;
}

/** Everything Settings → Trends shows, in its three groups. */
export interface TrendsOverview {
  live: Array<{ watch: TrendWatchDto; items: TrendItemDto[] }>;
  noted: TrendItemDto[];
  curated: TrendItemDto[];
  sources: TrendSourceDto[];
  viewer: { id: string; isOwner: boolean };
}

function toWatchDto(w: TrendWatch, now: Date): TrendWatchDto {
  const next = nextManualRefreshAt({ status: w.status, lastQueriedAt: w.lastQueriedAt }, now);
  return {
    id: w.id,
    provider: w.provider,
    query: w.query,
    enabled: w.enabled,
    status: w.status,
    statusMessage: w.statusMessage,
    lastQueriedAt: w.lastQueriedAt?.toISOString() ?? null,
    lastSuccessAt: w.lastSuccessAt?.toISOString() ?? null,
    nextRefreshAt: next?.toISOString() ?? null,
  };
}

/** Every watch, newest first (turned-off ones are kept for 7 days for the Instagram hashtag budget). */
export async function listWatches(): Promise<TrendWatch[]> {
  return getDb().select().from(schema.trendWatches).orderBy(desc(schema.trendWatches.createdAt));
}

/** The status of each live source this version offers, from the server settings and the stored watches. */
export function trendSourceStatuses(env: { YOUTUBE_API_KEY?: string | undefined }, watches: TrendWatch[], now: Date = new Date()): TrendSourceDto[] {
  const facts: TrendWatchFact[] = watches.map((w) => ({ provider: w.provider, enabled: w.enabled, status: w.status, statusMessage: w.statusMessage, lastSuccessAt: w.lastSuccessAt }));
  const youtube = watches.find((w) => w.provider === 'youtube_chart' && w.enabled) ?? null;
  return [{ provider: 'youtube_chart', status: youTubeChartStatus(env, facts), watch: youtube ? toWatchDto(youtube, now) : null }];
}

/** The three groups plus the source cards, for GET /api/trends and the Settings page. */
export async function getTrendsOverview(viewer: SessionUser, now: Date = new Date()): Promise<TrendsOverview> {
  const [items, watches] = await Promise.all([listTrends(now), listWatches()]);
  const live = watches
    .filter((w) => w.enabled)
    .map((w) => ({ watch: toWatchDto(w, now), items: items.filter((i) => i.kind === 'live' && i.watchId === w.id) }));
  return {
    live,
    noted: items.filter((i) => i.kind === 'noted'),
    curated: items.filter((i) => i.kind === 'curated'),
    sources: trendSourceStatuses(getEnv(), watches, now),
    viewer: { id: viewer.id, isOwner: viewer.role === 'owner' },
  };
}

/** Queues one read of a watch's source, unless one is already waiting or running. Returns the job id. */
async function queueRefresh(watchId: string): Promise<string> {
  const j = schema.jobs;
  const active = await getDb()
    .select({ id: j.id })
    .from(j)
    .where(and(eq(j.type, 'trends.refresh'), eq(j.refId, watchId), inArray(j.status, [...ACTIVE_JOB_STATUSES])))
    .limit(1);
  if (active[0]) return active[0].id;
  const job = await createTrackedJob({ type: 'trends.refresh', payload: { watchId }, refId: watchId, singletonKey: `trends:${watchId}` });
  return job.id;
}

/**
 * Turns a live source on (owner) and queues its first read, which is also its capability check. Turning on a
 * source that is already on changes nothing and queues nothing.
 */
export async function addWatch(user: SessionUser, input: z.infer<typeof AddWatchSchema>): Promise<{ watch: TrendWatchDto; jobId: string | null }> {
  if (input.provider === 'instagram_hashtag') {
    throw new AppError('UNSUPPORTED', 'The Instagram hashtag watch isn’t available in this version yet. Everything else on this page works without it.');
  }
  if (!getEnv().YOUTUBE_API_KEY?.trim()) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Add a YouTube Data API key (YOUTUBE_API_KEY) to the server first.');
  }
  const w = schema.trendWatches;
  const db = getDb();
  const now = new Date();
  const existing = await db.query.trendWatches.findFirst({ where: and(eq(w.provider, 'youtube_chart'), eq(w.query, YOUTUBE_CHART_REGION)) });
  if (existing?.enabled) return { watch: toWatchDto(existing, now), jobId: null };
  const rows = await db
    .insert(w)
    .values({ id: newId(), provider: 'youtube_chart', query: YOUTUBE_CHART_REGION, enabled: true, status: 'pending', statusMessage: '', createdBy: user.id })
    .onConflictDoUpdate({ target: [w.provider, w.query], set: { enabled: true, status: 'pending', statusMessage: '', updatedAt: now } })
    .returning();
  const watch = rows[0];
  if (!watch) throw new AppError('INTERNAL', 'The chart could not be turned on.');
  await writeAudit({ userId: user.id, action: 'trends.watch_added', entityType: 'trend_watch', entityId: watch.id, data: { provider: watch.provider, query: watch.query } });
  const jobId = await queueRefresh(watch.id);
  return { watch: toWatchDto(watch, now), jobId };
}

/** Turns a source off (owner): its items are deleted; the row stays 7 days for the hashtag budget. */
export async function removeWatch(user: SessionUser, id: string): Promise<void> {
  const w = schema.trendWatches;
  const r = schema.trendReferences;
  const removed = await getDb().transaction(async (tx) => {
    const rows = await tx.update(w).set({ enabled: false, updatedAt: new Date() }).where(eq(w.id, id)).returning({ id: w.id, provider: w.provider, query: w.query });
    if (!rows[0]) return null;
    await tx.delete(r).where(eq(r.watchId, id));
    return rows[0];
  });
  if (!removed) throw new AppError('NOT_FOUND', 'That source could not be found.');
  await writeAudit({ userId: user.id, action: 'trends.watch_removed', entityType: 'trend_watch', entityId: id, data: { provider: removed.provider, query: removed.query } });
}

/**
 * Refreshes one source now (owner). Limited to once every 6 hours per source (5 minutes after a failed read) so the
 * source's quota is respected; sooner requests get RATE_LIMITED with the time it becomes possible.
 */
export async function requestWatchRefresh(id: string, now: Date = new Date()): Promise<{ jobId: string }> {
  const w = schema.trendWatches;
  const watch = await getDb().query.trendWatches.findFirst({ where: eq(w.id, id) });
  if (!watch || !watch.enabled) throw new AppError('NOT_FOUND', 'That source is not turned on.');
  const next = nextManualRefreshAt({ status: watch.status, lastQueriedAt: watch.lastQueriedAt }, now);
  if (next) {
    throw new AppError('RATE_LIMITED', `This source was read recently. You can refresh it again from ${formatTrendDateTime(next)}.`, { details: { nextRefreshAt: next.toISOString() } });
  }
  return { jobId: await queueRefresh(watch.id) };
}
