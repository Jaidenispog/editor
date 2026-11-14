import { z } from 'zod';

/**
 * Google Business Profile (memo §7 Tier 2; email design §8.3, website design §7.3): the vocabulary shared by the
 * worker (which reads Google) and the web app (which shows what Google returned). Nothing here estimates or fills in a
 * number: a value Google did not send stays null and is shown as "—".
 */

/**
 * Daily Performance metrics requested from `fetchMultiDailyMetricsTimeSeries` (memo §7: impressions, direction
 * requests, calls, website clicks, bookings and `MESSAGING_CLICKS`). `BUSINESS_CONVERSATIONS` was removed by Google on
 * 31 Jan 2026 and is never requested.
 */
export const PERFORMANCE_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_DIRECTION_REQUESTS',
  'CALL_CLICKS',
  'WEBSITE_CLICKS',
  'BUSINESS_BOOKINGS',
  'MESSAGING_CLICKS',
] as const;
export const PerformanceMetricSchema = z.enum(PERFORMANCE_METRICS);
export type PerformanceMetric = z.infer<typeof PerformanceMetricSchema>;

/** The tiles on the Business Profile performance card: each one is the sum of one or more Google metrics. */
export const PERFORMANCE_TILES = [
  { id: 'calls', label: 'Calls', metrics: ['CALL_CLICKS'] },
  { id: 'directions', label: 'Direction requests', metrics: ['BUSINESS_DIRECTION_REQUESTS'] },
  { id: 'website', label: 'Website clicks', metrics: ['WEBSITE_CLICKS'] },
  { id: 'bookings', label: 'Bookings', metrics: ['BUSINESS_BOOKINGS'] },
  { id: 'messages', label: 'Message clicks', metrics: ['MESSAGING_CLICKS'] },
  { id: 'search_views', label: 'Views on Google Search', metrics: ['BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'] },
  { id: 'maps_views', label: 'Views on Google Maps', metrics: ['BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS'] },
] as const satisfies ReadonlyArray<{ id: string; label: string; metrics: readonly PerformanceMetric[] }>;
export type PerformanceTileId = (typeof PERFORMANCE_TILES)[number]['id'];

/**
 * What the last read-only call learned about one Business Profile API, stored in the connection's capabilities
 * (`apiAccess` for discovery and reviews, `performanceApi` for Performance). Google gives a project quota 0 until it
 * approves Basic API Access (memo §7), which is `awaiting_approval`, never an error.
 */
export const BUSINESS_PROFILE_API_STATES = ['available', 'awaiting_approval', 'api_disabled', 'error'] as const;
export const BusinessProfileApiStateSchema = z.enum(BUSINESS_PROFILE_API_STATES);
export type BusinessProfileApiState = z.infer<typeof BusinessProfileApiStateSchema>;

/** Reads an API state from stored capabilities; anything else (never checked) is null. */
export function businessProfileApiState(value: unknown): BusinessProfileApiState | null {
  const parsed = BusinessProfileApiStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Plain words shown while Google has not approved API access (memo §7: about 14 days, not guaranteed). */
export const BUSINESS_PROFILE_AWAITING_APPROVAL_MESSAGE =
  "Google hasn't approved API access for this project yet (it usually takes about 14 days and isn't guaranteed). Your review requests still work.";

/** Google's `starRating` words (v4 reviews) as 1–5; anything else is null (no rating shown). */
export function starRatingToNumber(value: unknown): number | null {
  switch (value) {
    case 'ONE':
      return 1;
    case 'TWO':
      return 2;
    case 'THREE':
      return 3;
    case 'FOUR':
      return 4;
    case 'FIVE':
      return 5;
    default:
      return null;
  }
}

/**
 * A Google enum value or short flag as plain words, without guessing its meaning (`REPLY_PUBLISHED` → "Reply
 * published"). Google's `reviewReplyState` and `policyViolation` values are shown this way because their full value
 * lists are not in the research memo (⚠); nothing is inferred from them.
 */
export function googleWords(value: unknown): string | null {
  if (typeof value === 'string') {
    const words = value
      .trim()
      .replace(/[_\s]+/g, ' ')
      .toLowerCase();
    if (!words) return null;
    return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 120);
  }
  if (value && typeof value === 'object') {
    for (const key of ['type', 'state', 'reason', 'policy', 'violationType']) {
      const inner = (value as Record<string, unknown>)[key];
      if (typeof inner === 'string') return googleWords(inner);
    }
    return 'Flagged by Google';
  }
  if (value === true) return 'Flagged by Google';
  return null;
}

/** One stored daily Performance value (null when Google listed the day without a value). */
export interface PerformanceDayValue {
  date: string;
  metric: string;
  value: number | null;
}

/** Tile totals over a set of days: the sum of the values Google returned, or null when it returned none. */
export function performanceTotals(rows: readonly PerformanceDayValue[]): Record<PerformanceTileId, number | null> {
  const out = {} as Record<PerformanceTileId, number | null>;
  for (const tile of PERFORMANCE_TILES) {
    const metrics = new Set<string>(tile.metrics);
    let total: number | null = null;
    for (const r of rows) {
      if (!metrics.has(r.metric) || r.value === null) continue;
      total = (total ?? 0) + r.value;
    }
    out[tile.id] = total;
  }
  return out;
}

/** Per-day tile values, oldest first (null where Google returned no value for any of the tile's metrics). */
export function performanceDaily(rows: readonly PerformanceDayValue[]): Array<{ date: string; values: Record<PerformanceTileId, number | null> }> {
  const byDate = new Map<string, PerformanceDayValue[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  return [...byDate.keys()].sort().map((date) => ({ date, values: performanceTotals(byDate.get(date) ?? []) }));
}

/** The last day for which Google returned at least one value, or null. */
export function performanceDataThrough(rows: readonly PerformanceDayValue[]): string | null {
  let last: string | null = null;
  for (const r of rows) if (r.value !== null && (last === null || r.date > last)) last = r.date;
  return last;
}
