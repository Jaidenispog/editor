import { PERFORMANCE_METRICS, type PerformanceMetric } from '@studio/core';
import type { WorkerContext } from '../../context.js';
import { BusinessProfileError, UNRECOGNISED_RESPONSE_MESSAGE, gbpGet, isLocationName } from './business-profile.js';

/**
 * Business Profile Performance API, read-only (website design §7.3; memo §7: `fetchMultiDailyMetricsTimeSeries`, "only
 * daily data is available", and monthly search keywords). ⚠ The memo names the methods but not the exact query
 * parameter names or the response nesting: the requests below follow the design, the parser accepts only the nesting
 * the design describes, and anything else fails with "Google's response format wasn't recognised" instead of storing
 * guesses. A missing `value` is kept as null (shown "—"), never 0. The owner smoke test (docs/testing.md) confirms the
 * shapes once Google approves access.
 */

export const PERFORMANCE_BASE = 'https://businessprofileperformance.googleapis.com/v1';
const API_NAME = 'Business Profile Performance API';
/** First successful sync backfills this many months of daily numbers (⚠ retention not in the memo; we keep what Google returns). */
export const PERFORMANCE_BACKFILL_MONTHS = 18;
/** Later syncs re-fetch this many days, so late numbers overwrite earlier ones. */
export const PERFORMANCE_REFRESH_DAYS = 35;
/** Daily numbers are requested in windows of at most this many days. */
export const PERFORMANCE_WINDOW_DAYS = 92;
/** Months of search keywords on the first sync, and on later syncs. */
export const KEYWORD_BACKFILL_MONTHS = 6;
export const KEYWORD_REFRESH_MONTHS = 2;
export const MAX_KEYWORD_PAGES = 10;
/** The read-only probe asks for this many days. */
export const PROBE_DAYS = 7;

type Ctx = Pick<WorkerContext, 'fetch' | 'logger'>;

/** One daily value as Google returned it (null when the day was listed without a value). */
export interface DailyMetricRow {
  date: string;
  metric: PerformanceMetric;
  value: number | null;
}

/** One monthly search keyword: an exact count, or Google's "fewer than N" threshold. */
export interface KeywordRow {
  keyword: string;
  value: number | null;
  threshold: number | null;
}

/** A whole-number value Google sent as a number or an int64 string; undefined when absent, throws when malformed. */
export function parseCount(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
  throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
}

function dateString(d: unknown): string {
  const o = (d ?? {}) as Record<string, unknown>;
  const { year, month, day } = o;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number' || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parses `fetchMultiDailyMetricsTimeSeries`: `multiDailyMetricTimeSeries[].dailyMetricTimeSeries[]` with `dailyMetric`
 * and `timeSeries.datedValues[] { date: {year, month, day}, value? }`. Metrics we did not ask for are ignored. An
 * absent list means Google has no numbers for the range.
 */
export function parseDailyMetrics(json: Record<string, unknown>): DailyMetricRow[] {
  const outer = json['multiDailyMetricTimeSeries'];
  if (outer === undefined) return [];
  if (!Array.isArray(outer)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
  const known = new Set<string>(PERFORMANCE_METRICS);
  const rows: DailyMetricRow[] = [];
  for (const group of outer) {
    const inner = (group ?? {}) as Record<string, unknown>;
    const series = inner['dailyMetricTimeSeries'];
    if (!Array.isArray(series)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
    for (const s of series) {
      const item = (s ?? {}) as Record<string, unknown>;
      const metric = item['dailyMetric'];
      if (typeof metric !== 'string') throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
      const ts = (item['timeSeries'] ?? {}) as Record<string, unknown>;
      const values = ts['datedValues'] ?? [];
      if (!Array.isArray(values)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
      if (!known.has(metric)) continue;
      for (const dv of values) {
        const v = (dv ?? {}) as Record<string, unknown>;
        rows.push({ date: dateString(v['date']), metric: metric as PerformanceMetric, value: parseCount(v['value']) ?? null });
      }
    }
  }
  return rows;
}

/** Parses one `searchkeywords/impressions/monthly` page: `searchKeywordsCounts[] { searchKeyword, insightsValue: { value | threshold } }`. */
export function parseKeywords(json: Record<string, unknown>): { rows: KeywordRow[]; nextPageToken: string | null } {
  const list = json['searchKeywordsCounts'];
  if (list !== undefined && !Array.isArray(list)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
  const rows: KeywordRow[] = [];
  for (const item of list ?? []) {
    const k = (item ?? {}) as Record<string, unknown>;
    const insights = (k['insightsValue'] ?? null) as Record<string, unknown> | null;
    if (typeof k['searchKeyword'] !== 'string' || !insights || typeof insights !== 'object') throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
    const value = parseCount(insights['value']);
    const threshold = parseCount(insights['threshold']);
    if (value === undefined && threshold === undefined) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
    rows.push({ keyword: k['searchKeyword'].slice(0, 300), value: value ?? null, threshold: value === undefined ? (threshold ?? null) : null });
  }
  const next = json['nextPageToken'];
  return { rows, nextPageToken: typeof next === 'string' && next ? next : null };
}

function checkLocation(location: string): void {
  if (!isLocationName(location)) throw new BusinessProfileError('not_found', 'This location is no longer available; choose it again.');
}

/** The daily-metrics request URL for one window (repeated `dailyMetrics`, `dailyRange` start and end dates ⚠). */
export function dailyMetricsUrl(location: string, window: { startDate: string; endDate: string }): string {
  const url = new URL(`${PERFORMANCE_BASE}/${location}:fetchMultiDailyMetricsTimeSeries`);
  for (const m of PERFORMANCE_METRICS) url.searchParams.append('dailyMetrics', m);
  const [sy, sm, sd] = window.startDate.split('-').map(Number);
  const [ey, em, ed] = window.endDate.split('-').map(Number);
  url.searchParams.set('dailyRange.startDate.year', String(sy));
  url.searchParams.set('dailyRange.startDate.month', String(sm));
  url.searchParams.set('dailyRange.startDate.day', String(sd));
  url.searchParams.set('dailyRange.endDate.year', String(ey));
  url.searchParams.set('dailyRange.endDate.month', String(em));
  url.searchParams.set('dailyRange.endDate.day', String(ed));
  return url.toString();
}

/** Daily numbers for one window. */
export async function fetchDailyMetrics(ctx: Ctx, token: string, location: string, window: { startDate: string; endDate: string }, signal?: AbortSignal): Promise<DailyMetricRow[]> {
  checkLocation(location);
  return parseDailyMetrics(await gbpGet(ctx, token, dailyMetricsUrl(location, window), 'google.gbp.performance.daily', API_NAME, signal));
}

/** Search keywords for one month (`YYYY-MM`), every page up to {@link MAX_KEYWORD_PAGES}. */
export async function fetchMonthlyKeywords(ctx: Ctx, token: string, location: string, month: string, signal?: AbortSignal): Promise<KeywordRow[]> {
  checkLocation(location);
  const [y, m] = month.split('-').map(Number);
  const rows: KeywordRow[] = [];
  let next: string | null = null;
  for (let page = 0; page < MAX_KEYWORD_PAGES; page++) {
    const url = new URL(`${PERFORMANCE_BASE}/${location}/searchkeywords/impressions/monthly`);
    url.searchParams.set('monthlyRange.startMonth.year', String(y));
    url.searchParams.set('monthlyRange.startMonth.month', String(m));
    url.searchParams.set('monthlyRange.endMonth.year', String(y));
    url.searchParams.set('monthlyRange.endMonth.month', String(m));
    url.searchParams.set('pageSize', '100');
    if (next) url.searchParams.set('pageToken', next);
    const parsed = parseKeywords(await gbpGet(ctx, token, url.toString(), 'google.gbp.performance.keywords', API_NAME, signal));
    rows.push(...parsed.rows);
    next = parsed.nextPageToken;
    if (!next) break;
  }
  return rows;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The read-only probe's window: the last {@link PROBE_DAYS} days up to `today`. */
export function probeWindow(today: string): { startDate: string; endDate: string } {
  return { startDate: addDays(today, -(PROBE_DAYS - 1)), endDate: today };
}

/** Daily windows to fetch, oldest first: 18 months on a backfill, otherwise the last 35 days. */
export function performanceWindows(backfill: boolean, today: string): Array<{ startDate: string; endDate: string }> {
  let start: string;
  if (backfill) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - PERFORMANCE_BACKFILL_MONTHS);
    start = d.toISOString().slice(0, 10);
  } else {
    start = addDays(today, -(PERFORMANCE_REFRESH_DAYS - 1));
  }
  const out: Array<{ startDate: string; endDate: string }> = [];
  for (let s = start; s <= today; s = addDays(s, PERFORMANCE_WINDOW_DAYS)) {
    const e = addDays(s, PERFORMANCE_WINDOW_DAYS - 1);
    out.push({ startDate: s, endDate: e > today ? today : e });
  }
  return out;
}

/** Complete months (`YYYY-MM`) before `today`'s month, oldest first. */
export function keywordMonths(backfill: boolean, today: string): string[] {
  const count = backfill ? KEYWORD_BACKFILL_MONTHS : KEYWORD_REFRESH_MONTHS;
  const [y, m] = today.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}
