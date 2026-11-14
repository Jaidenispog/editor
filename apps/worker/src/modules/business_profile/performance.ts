import { and, count, eq, sql } from 'drizzle-orm';
import { businessProfileApiState, melbourneDateOf, newId } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../../context.js';
import { loadConnection } from '../../lib/connections.js';
import { fetchDailyMetrics, fetchMonthlyKeywords, keywordMonths, performanceWindows, probeWindow, type DailyMetricRow, type KeywordRow } from '../../lib/google/business-profile-performance.js';
import type { TrackedRun } from '../../lib/job-tracker.js';
import { enqueueTracked } from '../../lib/jobs.js';
import { PROVIDER, ProfileStoppedError, chosenLocation, handleProfileError, isUsable, profileAccessToken, setProfileCapabilities, whileSignedIn } from './connection.js';

/**
 * Business Profile Performance (website design §7.3, §8), on the shared `google_business_profile` connection and
 * its chosen location. The probe and the sync are read-only towards Google. The numbers go into `search_metrics`
 * (source `business_profile`, property `locations/{id}`) with idempotent upserts; only values Google returned are
 * stored, and a day Google listed without a value is stored as NULL.
 */

const UPSERT_BATCH = 500;

/** Said when the owner chose another location while Google was being asked about the old one. */
const LOCATION_CHANGED = 'Another Business Profile location was chosen while checking; nothing was recorded for the old one.';

/**
 * `website.connection_check` with provider `business_profile_performance`: one 7-day daily-metrics read. 200 →
 * `performanceApi = available` (and the first sync is queued); quota 0 → `awaiting_approval` (no retry); API off →
 * `api_disabled`; refused sign-in → the shared row needs reconnecting. The weekly Monday run only re-probes while
 * the API is not available yet. Nothing is stored from the probe.
 */
export async function checkProfilePerformance(ctx: WorkerContext, run: TrackedRun, reason: 'connect' | 'manual' | 'daily', now: () => Date = () => new Date()): Promise<'not_connected' | 'no_location' | 'skipped' | 'awaiting_approval' | 'available'> {
  const conn = await loadConnection(ctx.db, PROVIDER);
  if (!isUsable(conn) || conn.status === 'needs_reauth') {
    await run.message('Google Business Profile is not connected');
    return 'not_connected';
  }
  const location = chosenLocation(conn);
  if (!location) {
    await run.message('Choose your Business Profile location first');
    return 'no_location';
  }
  const before = businessProfileApiState(conn.capabilities['performanceApi']);
  if (reason === 'daily' && before === 'available') {
    await run.message('Performance numbers are already available; the daily sync keeps them current');
    return 'skipped';
  }
  await run.progress(0.2, 'Checking Business Profile performance access (read-only)…');
  const token = await profileAccessToken(ctx, run.signal);
  try {
    await fetchDailyMetrics(ctx, token, location.location, probeWindow(melbourneDateOf(now())), run.signal);
  } catch (err) {
    await handleProfileError(ctx, err, 'performanceApi', location.location);
    await run.progress(1, "Waiting for Google's approval of API access");
    return 'awaiting_approval';
  }
  const recorded = await setProfileCapabilities(ctx, { performanceApi: 'available', performanceMessage: null, performanceCheckedAt: now().toISOString() }, location.location, now());
  if (!recorded) {
    await run.progress(1, LOCATION_CHANGED);
    return 'skipped';
  }
  if (before !== 'available' || reason === 'connect') {
    await enqueueTracked(ctx, 'search.sync', { source: 'business_profile', reason: 'connect' }, { singletonKey: 'search-sync:business_profile' });
  }
  await run.progress(1, 'Performance numbers are available');
  return 'available';
}

/**
 * `search.sync` with source `business_profile`: runs only while `performanceApi = available`. The first sync (or
 * `connect`) backfills 18 months of daily numbers in windows and the last 6 complete months of search keywords;
 * later syncs re-fetch 35 days and 2 months. Running it twice gives identical rows.
 */
export async function syncProfilePerformance(ctx: WorkerContext, run: TrackedRun, reason: 'connect' | 'daily' | 'manual', now: () => Date = () => new Date()): Promise<{ stored: number; outcome: 'skipped' | 'awaiting_approval' | 'synced' }> {
  const conn = await loadConnection(ctx.db, PROVIDER);
  const location = chosenLocation(conn);
  if (!isUsable(conn) || conn.status === 'needs_reauth' || !location) {
    await run.message(location ? 'Google Business Profile is not connected' : 'Choose your Business Profile location first');
    return { stored: 0, outcome: 'skipped' };
  }
  if (businessProfileApiState(conn.capabilities['performanceApi']) !== 'available') {
    await run.message('Business Profile performance numbers are not available yet');
    return { stored: 0, outcome: 'skipped' };
  }
  const token = await profileAccessToken(ctx, run.signal);
  const m = schema.searchMetrics;
  const [existing] = await ctx.db
    .select({ n: count() })
    .from(m)
    .where(and(eq(m.source, 'business_profile'), eq(m.property, location.location), eq(m.kind, 'metric')));
  const backfill = reason === 'connect' || (existing?.n ?? 0) === 0;
  const today = melbourneDateOf(now());
  const windows = performanceWindows(backfill, today);
  const months = keywordMonths(backfill, today);
  const steps = windows.length + months.length;
  let stored = 0;
  try {
    for (const [i, w] of windows.entries()) {
      run.checkCancelled();
      await run.progress(i / steps, `Fetching Business Profile numbers from ${w.startDate}`);
      const rows = await fetchDailyMetrics(ctx, token, location.location, w, run.signal);
      stored += await upsertDailyMetrics(ctx, location.location, rows, now());
    }
    for (const [i, month] of months.entries()) {
      run.checkCancelled();
      await run.progress((windows.length + i) / steps, `Fetching search keywords for ${month}`);
      const rows = await fetchMonthlyKeywords(ctx, token, location.location, month, run.signal);
      stored += await replaceMonthKeywords(ctx, location.location, month, rows, now());
    }
  } catch (err) {
    if (err instanceof ProfileStoppedError) {
      await run.progress(1, err.message);
      return { stored, outcome: 'skipped' };
    }
    await handleProfileError(ctx, err, 'performanceApi', location.location);
    await run.progress(1, "Waiting for Google's approval of API access");
    return { stored, outcome: 'awaiting_approval' };
  }
  if (!(await setProfileCapabilities(ctx, { performanceApi: 'available', performanceMessage: null, performanceSyncedAt: now().toISOString() }, location.location, now()))) {
    await run.progress(1, LOCATION_CHANGED);
    return { stored, outcome: 'skipped' };
  }
  await run.progress(1, `Stored ${stored} Business Profile number${stored === 1 ? '' : 's'}`);
  return { stored, outcome: 'synced' };
}

/**
 * Upserts daily values on (source, property, granularity, day, kind, key); a missing value is stored as NULL. Only
 * while the row is still signed in with this location (otherwise ProfileStoppedError, and nothing is stored).
 */
export async function upsertDailyMetrics(ctx: Pick<WorkerContext, 'db'>, location: string, rows: DailyMetricRow[], fetchedAt: Date): Promise<number> {
  const m = schema.searchMetrics;
  const unique = [...new Map(rows.map((r) => [`${r.date}|${r.metric}`, r])).values()];
  await whileSignedIn(ctx, location, async (tx) => {
    for (let i = 0; i < unique.length; i += UPSERT_BATCH) {
      await tx
        .insert(m)
        .values(
          unique.slice(i, i + UPSERT_BATCH).map((r) => ({
            id: newId(),
            source: 'business_profile' as const,
            property: location,
            granularity: 'day' as const,
            periodStart: r.date,
            kind: 'metric' as const,
            key: r.metric,
            value: r.value,
            valueThreshold: null,
            fetchedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [m.source, m.property, m.granularity, m.periodStart, m.kind, m.key],
          set: { value: sql`excluded.value`, fetchedAt: sql`excluded.fetched_at` },
        });
    }
  });
  return unique.length;
}

/**
 * Replaces one month's keywords in a transaction (a keyword Google no longer lists for that month disappears), so a
 * re-run gives identical rows. Only while the row is still signed in with this location.
 */
export async function replaceMonthKeywords(ctx: Pick<WorkerContext, 'db'>, location: string, month: string, rows: KeywordRow[], fetchedAt: Date): Promise<number> {
  const m = schema.searchMetrics;
  const periodStart = `${month}-01`;
  const unique = [...new Map(rows.map((r) => [r.keyword, r])).values()];
  await whileSignedIn(ctx, location, async (tx) => {
    await tx
      .delete(m)
      .where(and(eq(m.source, 'business_profile'), eq(m.property, location), eq(m.granularity, 'month'), eq(m.periodStart, periodStart), eq(m.kind, 'keyword')));
    for (let i = 0; i < unique.length; i += UPSERT_BATCH) {
      await tx.insert(m).values(
        unique.slice(i, i + UPSERT_BATCH).map((r) => ({
          id: newId(),
          source: 'business_profile' as const,
          property: location,
          granularity: 'month' as const,
          periodStart,
          kind: 'keyword' as const,
          key: r.keyword,
          value: r.value,
          valueThreshold: r.threshold,
          fetchedAt,
        })),
      );
    }
  });
  return unique.length;
}
