import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { LIVE_TREND_RETENTION_DAYS, LIVE_TREND_STALE_HOURS, TREND_TITLE_MAX, newId, type TrendWatchStatus } from '@studio/core';
import { schema, type TrendWatch } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { trendSourceName, type LiveTrendItemInput, type TrendSourceOutcome, type TrendSourceRegistry } from '../modules/trends/sources.js';
import { claimHashtagQuery, refreshInstagramHashtag, type HashtagLimitRefusal } from '../modules/trends/instagram.js';
import { refreshYouTubeChart } from '../modules/trends/youtube.js';

/** Live sources this version can read: the YouTube AU popular chart (WP3) and the Instagram hashtag watch (WP5). */
export const TREND_SOURCES: TrendSourceRegistry = {
  youtube_chart: refreshYouTubeChart,
  instagram_hashtag: refreshInstagramHashtag,
};

/** Shown on a watch whose provider this version cannot read. */
export const UNSUPPORTED_SOURCE_MESSAGE = 'This source isn’t available in this version of the app.';

/**
 * `trends.refresh`. With `watchId: null` (the daily schedule) it queues one refresh per enabled watch and stops.
 * For one watch it records the query time, reads the source and then, in one transaction, replaces the watch's items
 * (upsert on `(watch_id, external_id)`, items missing from the new result deleted) and marks the watch `ok`. A
 * refusal (quota, bad key, permission) keeps the existing items and shows a plain message. Read-only towards every
 * external service, and safe to run again: a repeat simply fetches the same data.
 */
export async function handleTrendsRefresh(ctx: WorkerContext, run: TrackedRun, payload: { watchId: string | null }, sources: TrendSourceRegistry = TREND_SOURCES): Promise<void> {
  const w = schema.trendWatches;
  if (payload.watchId === null) {
    const watches = await ctx.db.select({ id: w.id }).from(w).where(eq(w.enabled, true));
    for (const watch of watches) {
      run.checkCancelled();
      await enqueueTracked(ctx, 'trends.refresh', { watchId: watch.id }, { singletonKey: `trends:${watch.id}` });
    }
    await run.progress(1, watches.length ? `Queued ${watches.length} trend source${watches.length === 1 ? '' : 's'}` : 'No trend sources are turned on');
    return;
  }

  const watch = await ctx.db.query.trendWatches.findFirst({ where: eq(w.id, payload.watchId) });
  if (!watch || !watch.enabled) {
    await run.progress(1, 'This source is turned off; nothing to fetch');
    return;
  }
  const refresh = sources[watch.provider];
  if (!refresh) {
    await setWatchStatus(ctx, watch, { status: 'error', message: UNSUPPORTED_SOURCE_MESSAGE, reason: 'unsupported_provider' });
    await run.progress(1, UNSUPPORTED_SOURCE_MESSAGE);
    return;
  }

  // Recorded before the call, so a query always counts (the Instagram budget counts every hashtag touched). An
  // Instagram hashtag is checked against the weekly limit of 30 in the same step.
  const claim = await markQueried(ctx, watch);
  if (claim === 'off') {
    await run.progress(1, 'This source was turned off; nothing to fetch');
    return;
  }
  if (claim !== 'claimed') {
    await setWatchStatus(ctx, watch, claim);
    await run.progress(1, claim.message);
    return;
  }

  await run.progress(0.2, `Reading ${trendSourceName(watch.provider)}`);
  let outcome: TrendSourceOutcome;
  try {
    outcome = await refresh(ctx, run, watch);
  } catch (err) {
    run.checkCancelled();
    if (!run.willRetry) {
      await setWatchStatus(ctx, watch, {
        status: 'error',
        message: `${trendSourceName(watch.provider)} could not be reached. Press Try again later, or wait for tomorrow’s refresh.`,
        reason: 'unreachable',
      });
    }
    throw err;
  }
  run.checkCancelled();

  if (outcome.status !== 'ok') {
    await setWatchStatus(ctx, watch, outcome);
    await run.progress(1, outcome.message);
    return;
  }
  const stored = await storeLiveItems(ctx, watch, outcome.items);
  if (stored === null) await run.progress(1, 'This source was turned off while it was being read; nothing was kept');
  else await run.progress(1, `Fetched ${stored} item${stored === 1 ? '' : 's'}`);
}

/**
 * Sets `last_queried_at` just before a read. For an Instagram hashtag this also takes a place in the weekly limit
 * (or returns the refusal with the date a place frees up). `off` means the watch was turned off meanwhile.
 */
async function markQueried(ctx: WorkerContext, watch: TrendWatch): Promise<'claimed' | 'off' | HashtagLimitRefusal> {
  if (watch.provider === 'instagram_hashtag') return claimHashtagQuery(ctx.db, watch);
  const w = schema.trendWatches;
  const marked = await ctx.db
    .update(w)
    .set({ lastQueriedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(w.id, watch.id), eq(w.enabled, true)))
    .returning({ id: w.id });
  return marked.length ? 'claimed' : 'off';
}

/**
 * Replaces a watch's live items in one transaction and marks the watch `ok`. Returns the number of items kept, or
 * null when the watch was turned off in the meantime (then nothing is written).
 */
export async function storeLiveItems(ctx: WorkerContext, watch: TrendWatch, items: LiveTrendItemInput[], now: Date = new Date()): Promise<number | null> {
  const w = schema.trendWatches;
  const r = schema.trendReferences;
  const unique = new Map<string, LiveTrendItemInput>();
  for (const item of items) if (item.externalId && !unique.has(item.externalId)) unique.set(item.externalId, item);
  const staleAfter = new Date(now.getTime() + LIVE_TREND_STALE_HOURS * 3_600_000);
  return ctx.db.transaction(async (tx) => {
    const locked = await tx.select({ id: w.id, enabled: w.enabled, status: w.status }).from(w).where(eq(w.id, watch.id)).for('update');
    if (!locked[0]?.enabled) return null;
    for (const item of unique.values()) {
      const values = {
        title: item.title.slice(0, TREND_TITLE_MAX),
        summary: item.summary ?? '',
        category: item.category,
        sourceName: item.sourceName,
        sourceUrl: item.sourceUrl,
        sourceKind: 'live' as const,
        lastVerifiedAt: now,
        enabled: true,
        fetchedAt: now,
        staleAfter,
        data: item.data,
        updatedAt: now,
      };
      await tx
        .insert(r)
        .values({ id: newId(), watchId: watch.id, externalId: item.externalId, ...values })
        .onConflictDoUpdate({ target: [r.watchId, r.externalId], targetWhere: sql`external_id is not null`, set: values });
    }
    const keep = [...unique.keys()];
    await tx.delete(r).where(and(eq(r.watchId, watch.id), keep.length ? notInArray(r.externalId, keep) : sql`true`));
    await tx.update(w).set({ status: 'ok', statusMessage: '', lastSuccessAt: now, updatedAt: now }).where(eq(w.id, watch.id));
    if (locked[0].status !== 'ok') {
      await writeWorkerAudit(tx, { userId: null, action: 'trends.source_ok', entityType: 'trend_watch', entityId: watch.id, data: { provider: watch.provider, from: locked[0].status } });
    }
    return unique.size;
  });
}

/** Records a refusal on the watch (items are kept) and audits the change of state. */
async function setWatchStatus(ctx: WorkerContext, watch: TrendWatch, outcome: { status: Exclude<TrendWatchStatus, 'ok' | 'pending'>; message: string; reason?: string | null | undefined }): Promise<void> {
  const w = schema.trendWatches;
  await ctx.db.transaction(async (tx) => {
    const before = await tx.select({ status: w.status }).from(w).where(eq(w.id, watch.id)).for('update');
    if (!before[0]) return;
    await tx.update(w).set({ status: outcome.status, statusMessage: outcome.message.slice(0, 500), updatedAt: new Date() }).where(eq(w.id, watch.id));
    if (before[0].status !== outcome.status) {
      await writeWorkerAudit(tx, {
        userId: null,
        action: `trends.source_${outcome.status}`,
        entityType: 'trend_watch',
        entityId: watch.id,
        data: { provider: watch.provider, from: before[0].status, reason: outcome.reason ?? null },
      });
    }
  });
}

/**
 * Cleanup for `maintenance.cleanup`: deletes live items fetched more than 7 days ago and turned-off watches last
 * queried more than 7 days ago (kept until then so the Instagram hashtag budget stays correct).
 */
export async function cleanupTrends(ctx: WorkerContext, now: Date = new Date()): Promise<string> {
  const cutoff = new Date(now.getTime() - LIVE_TREND_RETENTION_DAYS * 86_400_000);
  const r = schema.trendReferences;
  const w = schema.trendWatches;
  const items = await ctx.db
    .delete(r)
    .where(and(eq(r.sourceKind, 'live'), lt(r.fetchedAt, cutoff)))
    .returning({ id: r.id });
  const oldWatches = await ctx.db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.enabled, false), lt(sql`coalesce(${w.lastQueriedAt}, ${w.updatedAt})`, cutoff)));
  if (oldWatches.length) await ctx.db.delete(w).where(and(eq(w.enabled, false), inArray(w.id, oldWatches.map((x) => x.id))));
  return `trends: ${items.length} old live item${items.length === 1 ? '' : 's'}, ${oldWatches.length} removed source${oldWatches.length === 1 ? '' : 's'}`;
}
