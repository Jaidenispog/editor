import { ownershipHost, type SiteScope } from '@studio/core';
import type { WorkerContext } from '../../context.js';
import { httpRequest, readJson } from '../http.js';

/**
 * Google Search Console, read-only (scope `webmasters.readonly`, memo §7; website design §7.2). The host, paths,
 * `rowLimit`, default `dataState` and Pacific-time dates are general knowledge of the API rather than memo facts (⚠):
 * every response is parsed defensively, an unrecognised shape fails with a plain message instead of storing guesses,
 * and the owner smoke test (docs/testing.md) confirms them against the real API.
 */

export const SEARCH_CONSOLE_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
export const SEARCH_ROW_LIMIT = 25_000;
/** Search Console keeps 16 months of data (memo §7). */
export const BACKFILL_MONTHS = 16;
export const WINDOW_DAYS = 31;
/** Daily and manual syncs re-fetch this many days, so late data overwrites earlier numbers. */
export const REFRESH_DAYS = 10;
const SC_TIMEOUT_MS = 30_000;

/** One Search Console property the account can see. */
export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

/** Plain labels for permission levels. `siteUnverifiedUser` cannot read data (⚠ value names from the API reference). */
export function permissionLabel(level: string): string {
  switch (level) {
    case 'siteOwner':
      return 'Owner';
    case 'siteFullUser':
      return 'Full';
    case 'siteRestrictedUser':
      return 'Restricted';
    default:
      return 'No access';
  }
}

/** True when the permission level can read search data. */
export function canRead(level: string): boolean {
  return level === 'siteOwner' || level === 'siteFullUser' || level === 'siteRestrictedUser';
}

/** A Search Console error mapped to what the owner should do. */
export class SearchConsoleError extends Error {
  constructor(
    readonly kind: 'reauth' | 'api_disabled' | 'no_access' | 'not_found' | 'transient' | 'unrecognised',
    message: string,
  ) {
    super(message);
    this.name = 'SearchConsoleError';
  }
}

/** Maps an HTTP error from Search Console (design §7.2 error mapping). */
export function mapSearchConsoleError(status: number, body: unknown): SearchConsoleError {
  const text = JSON.stringify(body ?? '').slice(0, 2000);
  if (status === 401) return new SearchConsoleError('reauth', 'Google needs you to sign in again. Reconnect Search Console in Settings → Integrations.');
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(text))
    return new SearchConsoleError('api_disabled', 'Turn on the Google Search Console API in your Google Cloud project, then press Check again.');
  if (status === 403) return new SearchConsoleError('no_access', "Your Google account can't read this Search Console property.");
  if (status === 404) return new SearchConsoleError('not_found', 'This Search Console property is no longer available to your account. Choose the property again.');
  return new SearchConsoleError('transient', `Google Search Console didn't answer properly (HTTP ${status}). We'll try again.`);
}

async function call(ctx: Pick<WorkerContext, 'fetch' | 'logger'>, token: string, url: string, init: RequestInit, label: string, signal?: AbortSignal): Promise<unknown> {
  const res = await httpRequest(
    ctx,
    url,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    },
    { label, signal, timeoutMs: SC_TIMEOUT_MS },
  );
  const json = await readJson(res);
  if (!res.ok) throw mapSearchConsoleError(res.status, json);
  return json;
}

/** `sites.list`: every property the account can see, with its permission level. */
export async function listSites(ctx: Pick<WorkerContext, 'fetch' | 'logger'>, token: string, signal?: AbortSignal): Promise<SiteEntry[]> {
  const json = await call(ctx, token, `${SEARCH_CONSOLE_BASE}/sites`, { method: 'GET' }, 'search_console.sites', signal);
  if (json === null || typeof json !== 'object') throw new SearchConsoleError('unrecognised', "Google's response format wasn't recognised.");
  const entries = (json as { siteEntry?: unknown }).siteEntry;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new SearchConsoleError('unrecognised', "Google's response format wasn't recognised.");
  return entries
    .filter((e): e is { siteUrl: string; permissionLevel?: unknown } => Boolean(e) && typeof (e as { siteUrl?: unknown }).siteUrl === 'string')
    .map((e) => ({
      siteUrl: e.siteUrl.slice(0, 300),
      permissionLevel: typeof e.permissionLevel === 'string' ? e.permissionLevel : 'unknown',
    }))
    .slice(0, 100);
}

/**
 * The property to use automatically: exactly one readable match, preferring the Domain property
 * (`sc-domain:<host without www>`, memo §7), else a URL-prefix property for the website's origin (either www twin).
 * Null when there is no match or the choice is ambiguous (the owner chooses).
 */
export function autoSelectProperty(sites: SiteEntry[], scope: SiteScope | null): string | null {
  if (!scope) return null;
  const readable = sites.filter((s) => canRead(s.permissionLevel));
  const domain = readable.filter((s) => s.siteUrl.toLowerCase() === `sc-domain:${ownershipHost(scope.host)}`);
  if (domain.length === 1) return domain[0]?.siteUrl ?? null;
  const prefix = readable.filter((s) => {
    try {
      const u = new URL(s.siteUrl);
      return ownershipHost(u.hostname) === ownershipHost(scope.host) && (u.pathname === '/' || scope.pathPrefix.startsWith(u.pathname));
    } catch {
      return false;
    }
  });
  return prefix.length === 1 ? (prefix[0]?.siteUrl ?? null) : null;
}

/** One stored row before upsert. */
export interface MetricRow {
  periodStart: string;
  kind: 'total' | 'query';
  key: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses `searchAnalytics.query` rows (`keys`, `clicks`, `impressions`, `position`); `ctr` is recomputed, not stored. */
export function parseAnalyticsRows(json: unknown, kind: 'total' | 'query'): MetricRow[] {
  if (json === null || typeof json !== 'object') throw new SearchConsoleError('unrecognised', "Google's response format wasn't recognised.");
  const rows = (json as { rows?: unknown }).rows;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new SearchConsoleError('unrecognised', "Google's response format wasn't recognised.");
  const out: MetricRow[] = [];
  for (const r of rows) {
    const keys = (r as { keys?: unknown }).keys;
    const clicks = (r as { clicks?: unknown }).clicks;
    const impressions = (r as { impressions?: unknown }).impressions;
    const position = (r as { position?: unknown }).position;
    if (!Array.isArray(keys) || typeof keys[0] !== 'string' || !DATE.test(keys[0]) || typeof clicks !== 'number' || typeof impressions !== 'number') {
      throw new SearchConsoleError('unrecognised', "Google's response format wasn't recognised.");
    }
    const key = kind === 'query' ? (typeof keys[1] === 'string' ? keys[1].slice(0, 500) : null) : '';
    if (key === null) throw new SearchConsoleError('unrecognised', "Google's response format wasn't recognised.");
    out.push({
      periodStart: keys[0],
      kind,
      key,
      clicks: Math.round(clicks),
      impressions: Math.round(impressions),
      position: typeof position === 'number' && Number.isFinite(position) ? position : null,
    });
  }
  return out;
}

/** Today's date in US Pacific time, which is how Search Console counts days (⚠). */
export function pacificToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Date windows to fetch: a backfill of 16 months in 31-day windows, oldest first (first sync), otherwise the last 10
 * days as one window.
 */
export function syncWindows(backfill: boolean, today: string): Array<{ startDate: string; endDate: string }> {
  if (!backfill) return [{ startDate: addDays(today, -(REFRESH_DAYS - 1)), endDate: today }];
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - BACKFILL_MONTHS);
  const windows: Array<{ startDate: string; endDate: string }> = [];
  for (let s = start.toISOString().slice(0, 10); s <= today; s = addDays(s, WINDOW_DAYS)) {
    const e = addDays(s, WINDOW_DAYS - 1);
    windows.push({ startDate: s, endDate: e > today ? today : e });
  }
  return windows;
}

/**
 * Fetches one window: daily totals, then daily per-query rows paged with `startRow` until a page comes back shorter
 * than `rowLimit`. `dataState` is omitted (final data only, ⚠ the API default).
 */
export async function fetchWindow(
  ctx: Pick<WorkerContext, 'fetch' | 'logger'>,
  token: string,
  siteUrl: string,
  window: { startDate: string; endDate: string },
  signal?: AbortSignal,
  pace: () => Promise<void> = async () => {},
): Promise<MetricRow[]> {
  const url = `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const post = (body: Record<string, unknown>) =>
    call(
      ctx,
      token,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      'search_console.query',
      signal,
    );
  await pace();
  const totals = parseAnalyticsRows(
    await post({
      startDate: window.startDate,
      endDate: window.endDate,
      dimensions: ['date'],
      type: 'web',
    }),
    'total',
  );
  const queries: MetricRow[] = [];
  for (let startRow = 0; ; startRow += SEARCH_ROW_LIMIT) {
    await pace();
    const page = parseAnalyticsRows(
      await post({
        startDate: window.startDate,
        endDate: window.endDate,
        dimensions: ['date', 'query'],
        type: 'web',
        rowLimit: SEARCH_ROW_LIMIT,
        startRow,
      }),
      'query',
    );
    queries.push(...page);
    if (page.length < SEARCH_ROW_LIMIT) break;
  }
  return [...totals, ...queries];
}
