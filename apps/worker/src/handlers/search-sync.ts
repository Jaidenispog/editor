import { and, count, eq, sql } from 'drizzle-orm';
import { AppError, NonRetryableError, newId, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { loadConnection, recordConnectionCheck } from '../lib/connections.js';
import { getGoogleAccessToken } from '../lib/google/oauth.js';
import { SearchConsoleError, fetchWindow, pacificToday, syncWindows, type MetricRow } from '../lib/google/search-console.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { syncProfilePerformance } from '../modules/business_profile/performance.js';
import { defaultWebsiteDeps, type WebsiteDeps } from '../website/deps.js';

/** At most one Search Console request per second (design §7.2). */
export const SEARCH_REQUEST_GAP_MS = 1_000;
const UPSERT_BATCH = 500;

/**
 * `search.sync` for Search Console (design §7.2, §8): a first sync backfills 16 months in 31-day windows, oldest
 * first; daily and manual syncs re-fetch the last 10 days so late numbers overwrite earlier ones. Rows are upserted on
 * (source, property, granularity, day, kind, key), so running it twice gives identical rows. Only numbers Google
 * returned are stored. Skips with a message when Search Console isn't connected or no property is chosen. Source
 * `business_profile` syncs the Business Profile Performance numbers instead (only once Google has approved access).
 */
export async function handleSearchSync(
  ctx: WorkerContext,
  run: TrackedRun,
  payload: JobPayload<'search.sync'>,
  deps: WebsiteDeps = defaultWebsiteDeps(ctx),
  pace: () => Promise<void> = defaultPace(run.signal),
): Promise<void> {
  // Business Profile Performance numbers (WP9, design §7.3), on the shared Business Profile connection.
  if (payload.source === 'business_profile') {
    await syncProfilePerformance(ctx, run, payload.reason, deps.now);
    return;
  }
  const conn = await loadConnection(ctx.db, 'google_search_console');
  if (!conn || conn.status !== 'connected') {
    await run.message('Search Console is not connected');
    return;
  }
  const siteUrl = typeof conn.config['siteUrl'] === 'string' ? conn.config['siteUrl'] : null;
  if (!siteUrl) {
    await run.message('Choose your Search Console property first');
    return;
  }
  let token: string;
  try {
    token = await getGoogleAccessToken(ctx, 'google_search_console', run.signal);
  } catch (err) {
    if (err instanceof AppError && err.code === 'INTEGRATION_NOT_CONFIGURED') throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', err.message);
    throw err;
  }
  const m = schema.searchMetrics;
  const existing = await ctx.db
    .select({ n: count() })
    .from(m)
    .where(and(eq(m.source, 'search_console'), eq(m.property, siteUrl)));
  const backfill = payload.reason === 'connect' || (existing[0]?.n ?? 0) === 0;
  const windows = syncWindows(backfill, pacificToday(deps.now()));
  let stored = 0;
  for (const [i, w] of windows.entries()) {
    run.checkCancelled();
    await run.progress(i / windows.length, `Fetching search data for ${monthLabel(w.startDate)}`);
    let rows: MetricRow[];
    try {
      rows = await fetchWindow(ctx, token, siteUrl, w, run.signal, pace);
    } catch (err) {
      if (err instanceof SearchConsoleError && err.kind !== 'transient') {
        if (err.kind === 'not_found') {
          const t = schema.integrationConnections;
          await ctx.db
            .update(t)
            .set({
              config: sql`${t.config} || '{"siteUrl": null}'::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(t.provider, 'google_search_console'));
        }
        await recordConnectionCheck(ctx.db, 'google_search_console', {
          status: err.kind === 'reauth' ? 'needs_reauth' : err.kind === 'not_found' ? 'connected' : 'error',
          lastError: err.message,
          capabilities: { searchConsoleProblem: err.kind },
        });
        throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', err.message);
      }
      throw err;
    }
    stored += await upsertRows(ctx, siteUrl, rows, deps.now());
  }
  const t = schema.integrationConnections;
  await ctx.db
    .update(t)
    .set({
      lastSyncAt: deps.now(),
      lastError: null,
      capabilities: sql`${t.capabilities} || ${JSON.stringify({ searchSyncedAt: deps.now().toISOString(), searchConsoleProblem: null })}::jsonb`,
      updatedAt: deps.now(),
    })
    .where(eq(t.provider, 'google_search_console'));
  await run.progress(1, `Stored ${stored} search row${stored === 1 ? '' : 's'}`);
}

/** Upserts rows in batches; returns how many were written. */
export async function upsertRows(ctx: Pick<WorkerContext, 'db'>, siteUrl: string, rows: MetricRow[], now: Date): Promise<number> {
  const m = schema.searchMetrics;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH).map((r) => ({
      id: newId(),
      source: 'search_console' as const,
      property: siteUrl,
      granularity: 'day' as const,
      periodStart: r.periodStart,
      kind: r.kind,
      key: r.key,
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
      fetchedAt: now,
    }));
    await ctx.db
      .insert(m)
      .values(batch)
      .onConflictDoUpdate({
        target: [m.source, m.property, m.granularity, m.periodStart, m.kind, m.key],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          position: sql`excluded.position`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
  return rows.length;
}

function monthLabel(date: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function defaultPace(signal: AbortSignal): () => Promise<void> {
  let last = 0;
  return async () => {
    const wait = last + SEARCH_REQUEST_GAP_MS - Date.now();
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('Stopped'));
          },
          { once: true },
        );
      });
    }
    last = Date.now();
  };
}
