import 'server-only';
import { and, desc, eq, gt, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  AppError,
  QUERY_GROUPS,
  buildQueryClassifier,
  classifyQuery,
  googleWords,
  performanceDataThrough,
  performanceTotals,
  type PerformanceDayValue,
  type QueryClassifier,
  type QueryGroup,
} from '@studio/core';
import { schema } from '@studio/db';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { businessProfileState, chosenProfileLocation, profilePerformanceState } from './integrations/business_profile.js';
import type { ConnectionFact } from './integrations/types.js';
import { createTrackedJob, toJobDto } from './jobs.js';
import type { GoogleReviewDto, GoogleReviewsDto, ProfileKeywordDto, ProfileLocationDto, ProfilePerformanceDto } from './shared/business-profile-dto.js';
import { getSettings } from './settings.js';

/**
 * Google Business Profile data and actions for the Reviews and Website pages (email design §4.8 and §7.4, website
 * design §4.6 and §9). Everything here is owner-only (routes call `requireOwner`). Nothing calls Google: reads and
 * checks are worker jobs. Only what Google returned is shown; a number Google did not send is null ("—").
 */

const PROVIDER = 'google_business_profile' as const;
/** Minimum gap between manual review refreshes (email design §7.4). */
export const REVIEWS_REFRESH_COOLDOWN_MS = 10 * 60_000;
/** Minimum gap between manual Performance refreshes (website design §4.5). */
export const PERFORMANCE_REFRESH_COOLDOWN_MS = 15 * 60_000;
/** Reviews listed on the tab (newest first). */
export const REVIEWS_SHOWN = 200;

type ConnRow = typeof schema.integrationConnections.$inferSelect;

async function profileRow(): Promise<ConnRow | null> {
  return (await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, PROVIDER) })) ?? null;
}

function fact(conn: ConnRow | null): ConnectionFact | undefined {
  return conn ? { provider: conn.provider, status: conn.status, displayName: conn.displayName, capabilities: conn.capabilities, config: conn.config, lastError: conn.lastError, lastSyncAt: conn.lastSyncAt } : undefined;
}

function capString(conn: ConnRow | null, key: string): string | null {
  const v = conn?.capabilities[key];
  return typeof v === 'string' && v ? v : null;
}
function capNumber(conn: ConnRow | null, key: string): number | null {
  const v = conn?.capabilities[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The discovered locations stored on the row (shown only while the owner chooses). */
export function locationsOf(config: Record<string, unknown> | undefined): ProfileLocationDto[] {
  const list = config?.['locations'];
  if (!Array.isArray(list)) return [];
  return list
    .filter((l): l is { name: string; title?: unknown; address?: unknown } => Boolean(l) && typeof (l as { name?: unknown }).name === 'string')
    .map((l) => ({ name: l.name, title: typeof l.title === 'string' ? l.title : '', address: typeof l.address === 'string' ? l.address : '' }));
}

/** A stored review row as the tab shows it. */
export function toGoogleReviewDto(row: Pick<typeof schema.reviews.$inferSelect, 'id' | 'rating' | 'reviewerName' | 'comment' | 'reviewCreatedAt' | 'reviewUpdatedAt' | 'replyText' | 'raw'>): GoogleReviewDto {
  return {
    id: row.id,
    rating: row.rating,
    reviewerName: row.reviewerName,
    comment: row.comment,
    createdAt: row.reviewCreatedAt?.toISOString() ?? null,
    updatedAt: row.reviewUpdatedAt?.toISOString() ?? null,
    replyText: row.replyText,
    replyState: googleWords(row.raw['reviewReplyState']),
    policyFlag: googleWords(row.raw['policyViolation']),
  };
}

/** The "Reviews on Google" tab (email design §4.8). Reviews are listed only once connected with a location chosen. */
export async function getGoogleReviews(): Promise<GoogleReviewsDto> {
  const env = getEnv();
  const conn = await profileRow();
  const f = fact(conn);
  const state = businessProfileState(env, f);
  const location = chosenProfileLocation(f);
  const base: GoogleReviewsDto = {
    state,
    message: state === 'error' || state === 'needs_reauth' || state === 'choose_location' ? (conn?.lastError ?? null) : null,
    location,
    locations: state === 'choose_location' ? locationsOf(conn?.config) : [],
    reviews: [],
    totalReviewCount: null,
    averageRating: null,
    syncedAt: capString(conn, 'reviewsSyncedAt'),
    canRefresh: false,
  };
  if (state !== 'connected' || !location) return base;
  const r = schema.reviews;
  const rows = await getDb()
    .select()
    .from(r)
    .where(and(eq(r.provider, PROVIDER), sql`${r.raw}->>'location' = ${location.name}`))
    .orderBy(desc(sql`coalesce(${r.reviewCreatedAt}, ${r.reviewUpdatedAt})`))
    .limit(REVIEWS_SHOWN);
  return {
    ...base,
    reviews: rows.map(toGoogleReviewDto),
    totalReviewCount: capNumber(conn, 'totalReviewCount'),
    averageRating: capNumber(conn, 'averageRating'),
    canRefresh: !(await recentJob('reviews.gbp.sync', REVIEWS_REFRESH_COOLDOWN_MS)),
  };
}

async function recentJob(type: 'reviews.gbp.sync' | 'search.sync', withinMs: number, source?: string): Promise<boolean> {
  const j = schema.jobs;
  const recent = await getDb().query.jobs.findFirst({
    where: and(
      eq(j.type, type),
      gt(j.createdAt, new Date(Date.now() - withinMs)),
      ne(j.status, 'failed'),
      ...(source ? [sql`${j.payload}->>'source' = ${source}`] : []),
    ),
  });
  return Boolean(recent);
}

/** Owner refresh of the reviews list (read-only; at most every 10 minutes). */
export async function refreshGoogleReviews(user: SessionUser): Promise<{ jobIds: string[] }> {
  const conn = await profileRow();
  const state = businessProfileState(getEnv(), fact(conn));
  if (!conn || state === 'not_configured' || state === 'not_connected' || state === 'needs_reauth') throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Connect Google Business Profile first.');
  if (await recentJob('reviews.gbp.sync', REVIEWS_REFRESH_COOLDOWN_MS)) throw new AppError('RATE_LIMITED', 'Updated a few minutes ago. Try again later.');
  const job = await createTrackedJob({ type: 'reviews.gbp.sync', payload: { reason: 'manual' }, projectId: null, singletonKey: 'gbp-sync' });
  await writeAudit({ userId: user.id, action: 'reviews.google.refresh_requested', entityType: 'integration_connection', entityId: conn.id });
  return { jobIds: [job.id] };
}

/** Owner "Check again": re-reads locations and reviews, and re-probes Performance (all read-only). */
export async function checkBusinessProfile(user: SessionUser): Promise<{ jobs: Array<ReturnType<typeof toJobDto>> }> {
  const conn = await profileRow();
  if (!conn || conn.status === 'disconnected' || !conn.refreshTokenEncrypted) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Connect Google Business Profile first.');
  const sync = await createTrackedJob({ type: 'reviews.gbp.sync', payload: { reason: 'manual' }, projectId: null, singletonKey: 'gbp-sync' });
  const jobs = [toJobDto(sync)];
  if (chosenProfileLocation(fact(conn))) {
    const probe = await createTrackedJob({
      type: 'website.connection_check',
      payload: { provider: 'business_profile_performance', reason: 'manual' },
      projectId: null,
      singletonKey: 'website-check:business_profile_performance',
    });
    jobs.push(toJobDto(probe));
  }
  await writeAudit({ userId: user.id, action: 'integration.google_business_profile.check_requested', entityType: 'integration_connection', entityId: conn.id });
  return { jobs };
}

/**
 * The owner chooses one of the discovered locations. Reviews stored for another location are removed (they belong to
 * a different listing), the Performance state starts again, and the first read and probe are queued.
 */
export async function chooseProfileLocation(user: SessionUser, locationName: string): Promise<{ state: GoogleReviewsDto['state'] }> {
  const conn = await profileRow();
  if (!conn || conn.status === 'disconnected' || !conn.refreshTokenEncrypted) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Connect Google Business Profile first.');
  const list = Array.isArray(conn.config['locations']) ? (conn.config['locations'] as Array<{ account?: unknown; name?: unknown; title?: unknown }>) : [];
  const entry = list.find((l) => l.name === locationName);
  if (!entry || typeof entry.account !== 'string' || !/^accounts\/[A-Za-z0-9_-]{1,100}$/.test(entry.account)) {
    throw new AppError('VALIDATION', 'Choose one of the locations Google listed for your account.');
  }
  const title = typeof entry.title === 'string' ? entry.title.slice(0, 200) : '';
  const db = getDb();
  const t = schema.integrationConnections;
  await db.transaction(async (tx) => {
    await tx
      .update(t)
      .set({
        config: sql`${t.config} || ${JSON.stringify({ account: entry.account, location: locationName, locationTitle: title })}::jsonb`,
        capabilities: sql`${t.capabilities} || ${JSON.stringify({ performanceApi: null, performanceMessage: null })}::jsonb`,
        displayName: title.slice(0, 120),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(t.id, conn.id));
    await tx.delete(schema.reviews).where(and(eq(schema.reviews.provider, PROVIDER), sql`coalesce(${schema.reviews.raw}->>'location', '') <> ${locationName}`));
  });
  await writeAudit({ userId: user.id, action: 'integration.google_business_profile.location_selected', entityType: 'integration_connection', entityId: conn.id, data: { location: locationName } });
  await createTrackedJob({ type: 'reviews.gbp.sync', payload: { reason: 'manual' }, projectId: null, singletonKey: 'gbp-sync' });
  await createTrackedJob({
    type: 'website.connection_check',
    payload: { provider: 'business_profile_performance', reason: 'connect' },
    projectId: null,
    singletonKey: 'website-check:business_profile_performance',
  });
  return { state: businessProfileState(getEnv(), fact(await profileRow())) };
}

/**
 * Disconnects the Business Profile (Google revokes through the shared `google.disconnect` job). With `deleteData`,
 * the stored Google reviews and Performance numbers are deleted too.
 */
export async function disconnectBusinessProfile(user: SessionUser, deleteData: boolean): Promise<void> {
  const conn = await profileRow();
  if (!conn || conn.status === 'disconnected') return;
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(schema.integrationConnections).set({ status: 'disconnected', lastError: null, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    if (deleteData) {
      await tx.delete(schema.reviews).where(eq(schema.reviews.provider, PROVIDER));
      await tx.delete(schema.searchMetrics).where(eq(schema.searchMetrics.source, 'business_profile'));
    }
  });
  await createTrackedJob({ type: 'google.disconnect', payload: { connectionId: conn.id }, projectId: null, singletonKey: `google-disconnect:${conn.id}` });
  await writeAudit({ userId: user.id, action: 'integration.google_business_profile.disconnected', entityType: 'integration_connection', entityId: conn.id, data: { deleteData } });
}

// ---------------------------------------------------------------------------------------------
// Performance (website design §4.6, §9.2)
// ---------------------------------------------------------------------------------------------

/** Days covered by a range ending on the last day with data. */
export function profileRangeDays(range: ProfilePerformanceDto['range']): number {
  return range === '28d' ? 28 : range === '3m' ? 91 : 365;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Sum of the values Google returned for one metric, or null when it returned none. */
function sumOf(rows: readonly PerformanceDayValue[], metric: string): number | null {
  let total: number | null = null;
  for (const r of rows) if (r.metric === metric && r.value !== null) total = (total ?? 0) + r.value;
  return total;
}

/**
 * Builds the card's numbers from stored rows (pure, unit tested): the range ends on the last day Google returned a
 * value; each tile is the sum of what Google returned (null, shown "—", when it returned nothing — never 0 unless
 * Google said 0). Keywords: the latest stored month, grouped with the Search Console query groups.
 */
export function buildProfileNumbers(
  daily: readonly PerformanceDayValue[],
  keywords: ReadonlyArray<{ month: string; keyword: string; value: number | null; threshold: number | null }>,
  classifier: QueryClassifier,
  range: ProfilePerformanceDto['range'],
): Pick<ProfilePerformanceDto, 'dataThrough' | 'totals' | 'viewParts' | 'keywords'> {
  const dataThrough = performanceDataThrough(daily);
  let totals: ProfilePerformanceDto['totals'] = null;
  let viewParts: ProfilePerformanceDto['viewParts'] = null;
  if (dataThrough) {
    const from = addDays(dataThrough, -(profileRangeDays(range) - 1));
    const inRange = daily.filter((r) => r.date >= from && r.date <= dataThrough);
    totals = performanceTotals(inRange);
    viewParts = {
      search: { mobile: sumOf(inRange, 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'), desktop: sumOf(inRange, 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') },
      maps: { mobile: sumOf(inRange, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'), desktop: sumOf(inRange, 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS') },
    };
  }
  const months = [...new Set(keywords.map((k) => k.month))].sort();
  const month = months.at(-1) ?? null;
  let kw: ProfilePerformanceDto['keywords'] = null;
  if (month) {
    const groups = Object.fromEntries(QUERY_GROUPS.map((g) => [g, [] as ProfileKeywordDto[]])) as Record<QueryGroup, ProfileKeywordDto[]>;
    const sorted = keywords.filter((k) => k.month === month).sort((a, b) => (b.value ?? b.threshold ?? 0) - (a.value ?? a.threshold ?? 0) || a.keyword.localeCompare(b.keyword));
    for (const k of sorted) {
      const list = groups[classifyQuery(k.keyword, classifier)];
      if (list.length < 20) list.push({ keyword: k.keyword, value: k.value, threshold: k.value === null ? k.threshold : null });
    }
    kw = { month, groups };
  }
  return { dataThrough, totals, viewParts, keywords: kw };
}

/** The Business Profile performance card (website design §4.6). No numbers unless Google returned them. */
export async function getProfilePerformance(range: ProfilePerformanceDto['range'], canRefreshAtAll = true): Promise<ProfilePerformanceDto> {
  const env = getEnv();
  const conn = await profileRow();
  const f = fact(conn);
  const conState = businessProfileState(env, f);
  const perf = profilePerformanceState(env, f);
  const location = chosenProfileLocation(f);
  const empty = (state: ProfilePerformanceDto['state'], message: string | null = null): ProfilePerformanceDto => ({
    state,
    message,
    location,
    range,
    dataThrough: null,
    syncedAt: capString(conn, 'performanceSyncedAt'),
    totals: null,
    viewParts: null,
    keywords: null,
    canRefresh: false,
  });
  if (conState === 'not_configured') return empty('not_configured');
  if (conState === 'not_connected' || conState === 'checking') return empty('not_connected');
  if (conState === 'needs_reauth') return empty('needs_reauth', conn?.lastError ?? null);
  if (conState === 'error') return empty('error', conn?.lastError ?? null);
  if (conState === 'awaiting_approval') return empty('awaiting_approval');
  if (conState === 'choose_location' || !location) return empty('choose_location');
  if (perf !== 'available') return empty(perf, capString(conn, 'performanceMessage'));
  const m = schema.searchMetrics;
  const db = getDb();
  const [last] = await db
    .select({ d: sql<string | null>`max(${m.periodStart})::text` })
    .from(m)
    .where(and(eq(m.source, 'business_profile'), eq(m.property, location.name), eq(m.kind, 'metric'), sql`${m.value} is not null`));
  if (!last?.d) {
    const syncing = await db.query.jobs.findFirst({ where: and(eq(schema.jobs.type, 'search.sync'), inArray(schema.jobs.status, ['queued', 'running']), sql`${schema.jobs.payload}->>'source' = 'business_profile'`) });
    return { ...empty(syncing ? 'syncing' : 'no_data'), canRefresh: canRefreshAtAll && !syncing };
  }
  const from = addDays(last.d, -(profileRangeDays(range) - 1));
  const [daily, keywordRows, settings] = await Promise.all([
    db
      .select({ date: m.periodStart, metric: m.key, value: m.value })
      .from(m)
      .where(and(eq(m.source, 'business_profile'), eq(m.property, location.name), eq(m.kind, 'metric'), eq(m.granularity, 'day'), gte(m.periodStart, from))),
    db
      .select({ periodStart: m.periodStart, keyword: m.key, value: m.value, threshold: m.valueThreshold })
      .from(m)
      .where(and(eq(m.source, 'business_profile'), eq(m.property, location.name), eq(m.kind, 'keyword'), eq(m.granularity, 'month')))
      .orderBy(desc(m.periodStart))
      .limit(2000),
    getSettings(),
  ]);
  const numbers = buildProfileNumbers(
    daily,
    keywordRows.map((k) => ({ month: k.periodStart.slice(0, 7), keyword: k.keyword, value: k.value, threshold: k.threshold })),
    buildQueryClassifier(settings),
    range,
  );
  return {
    ...empty('connected'),
    ...numbers,
    canRefresh: canRefreshAtAll && !(await recentJob('search.sync', PERFORMANCE_REFRESH_COOLDOWN_MS, 'business_profile')),
  };
}

/** Owner refresh of the Performance numbers (at most every 15 minutes; only once Google has approved access). */
export async function refreshProfilePerformance(user: SessionUser): Promise<{ job: ReturnType<typeof toJobDto> }> {
  const conn = await profileRow();
  if (profilePerformanceState(getEnv(), fact(conn)) !== 'available' || !conn) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Business Profile numbers are not available yet.');
  }
  if (await recentJob('search.sync', PERFORMANCE_REFRESH_COOLDOWN_MS, 'business_profile')) throw new AppError('RATE_LIMITED', 'Updated a few minutes ago. Try again later.');
  const job = await createTrackedJob({ type: 'search.sync', payload: { source: 'business_profile', reason: 'manual' }, projectId: null, singletonKey: 'search-sync:business_profile' });
  await writeAudit({ userId: user.id, action: 'search.sync.requested', entityType: 'integration_connection', entityId: conn.id, data: { source: 'business_profile' } });
  return { job: toJobDto(job) };
}
