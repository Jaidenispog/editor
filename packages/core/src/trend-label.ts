import { z } from 'zod';
import { isMelbourneDate, melbourneDateOf, melbourneTimeOf, type MelbourneDate } from './time.js';

/**
 * Trends (Stage B, research memo §11): three groups that are never mixed in one list.
 *
 * - **Live signals** come only from official APIs (the YouTube AU popular chart; the Instagram hashtag watch is added
 *   later). Each item carries its source and the time it was fetched in Melbourne time, and goes out of date.
 * - **Noted by staff** are things a person saw themselves ("Note a trend"), for example on TikTok, which has no
 *   permitted API for trend data.
 * - **Curated references** are a static, dated list of barber content formats with their sources.
 *
 * Every label shown for a trend item comes from {@link trendLabel}, so no label ever calls anything "trending" or
 * "viral". Nothing in this module is ever passed to an edit planner.
 */

/** Kinds of trend reference rows (`trend_references.source_kind`). */
export const TREND_SOURCE_KINDS = ['curated', 'live', 'noted'] as const;
export type TrendSourceKind = (typeof TREND_SOURCE_KINDS)[number];

/** Categories a trend reference can have (`trend_references.category`). */
export const TREND_CATEGORIES = ['format', 'sound', 'hook', 'text_style', 'pacing', 'other'] as const;
export const TrendCategorySchema = z.enum(TREND_CATEGORIES);
export type TrendCategory = z.infer<typeof TrendCategorySchema>;

/** Plain labels for the categories. */
export const TREND_CATEGORY_LABELS: Record<TrendCategory, string> = {
  format: 'Format',
  sound: 'Sound',
  hook: 'Hook',
  text_style: 'Text style',
  pacing: 'Pacing',
  other: 'Other',
};

/** Live sources a trend watch can read (`trend_watches.provider`). */
export const TREND_WATCH_PROVIDERS = ['instagram_hashtag', 'youtube_chart'] as const;
export const TrendWatchProviderSchema = z.enum(TREND_WATCH_PROVIDERS);
export type TrendWatchProvider = z.infer<typeof TrendWatchProviderSchema>;

/** Stored state of a trend watch (`trend_watches.status`). */
export const TREND_WATCH_STATUSES = ['pending', 'ok', 'unavailable', 'needs_reauth', 'quota', 'error'] as const;
export const TrendWatchStatusSchema = z.enum(TREND_WATCH_STATUSES);
export type TrendWatchStatus = z.infer<typeof TrendWatchStatusSchema>;

/** Where a staff member saw something they noted. */
export const NOTED_TREND_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'in_person', 'other'] as const;
export const NotedTrendPlatformSchema = z.enum(NOTED_TREND_PLATFORMS);
export type NotedTrendPlatform = z.infer<typeof NotedTrendPlatformSchema>;

/** How each platform is named in a "Noted by" label. */
export const NOTED_TREND_PLATFORM_LABELS: Record<NotedTrendPlatform, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  in_person: 'in the shop',
  other: 'somewhere else',
};

/** The region the YouTube popular chart is read for (the business is in Ivanhoe, Victoria). */
export const YOUTUBE_CHART_REGION = 'AU';
/** Number of chart rows fetched and shown. */
export const YOUTUBE_CHART_MAX_RESULTS = 20;
/** The fixed name of the YouTube source (memo §11: the chart covers music, movies and gaming only since July 2025). */
export const YOUTUBE_CHART_SOURCE_NAME = 'YouTube AU popular chart (music/movies/gaming)';
/** Shown under the YouTube chart, every time it is shown. */
export const YOUTUBE_CHART_FOOTER = 'Popular videos and songs are not licensed for your edits.';

/** Plain names for the chart's main YouTube category ids; any other id shows as "Other". */
const YOUTUBE_CATEGORY_NAMES: Record<string, string> = { '1': 'Film & animation', '10': 'Music', '20': 'Gaming' };

/** A YouTube chart row's category as shown to the owner. */
export function youTubeCategoryName(categoryId: string): string {
  return YOUTUBE_CATEGORY_NAMES[categoryId] ?? 'Other';
}

/** Opens TikTok Creative Center, where the owner signs in with their own TikTok for Business login. */
export const TIKTOK_CREATIVE_CENTER_URL = 'https://ads.tiktok.com/business/creativecenter/';
/** Google Trends for Australia (a deep link only; no Google Trends data is fetched). */
export const GOOGLE_TRENDS_URL = 'https://trends.google.com/trends/explore?geo=AU';

/** A live item shows "Out of date" this long after it was fetched. */
export const LIVE_TREND_STALE_HOURS = 48;
/** Live items, and disabled watches, are deleted this many days after they were last fetched or queried. */
export const LIVE_TREND_RETENTION_DAYS = 7;
/** A curated reference is "Due for review" this many days after it was last reviewed. */
export const CURATED_REVIEW_INTERVAL_DAYS = 180;
/** The owner may refresh one watch by hand at most this often (each fetch uses the source's quota). */
export const MANUAL_REFRESH_INTERVAL_HOURS = 6;
/** After a failed fetch the owner may try again this soon (fixing a setting should not mean a six-hour wait). */
export const RETRY_AFTER_ERROR_MINUTES = 5;
/** Longest title stored for a trend item (text from other services is length-limited before storage). */
export const TREND_TITLE_MAX = 160;

/** `data` of a YouTube chart item: only these fields are stored (no images, descriptions or statistics). */
export const YouTubeChartItemDataSchema = z.object({
  provider: z.literal('youtube_chart'),
  channelTitle: z.string().max(TREND_TITLE_MAX),
  categoryId: z.string().max(20),
  url: z.string().url().max(200),
  /** Position in the chart as YouTube returned it (1 = first). */
  position: z.number().int().min(1).max(50),
});
export type YouTubeChartItemData = z.infer<typeof YouTubeChartItemDataSchema>;

/** `data` of a noted trend. */
export const NotedTrendDataSchema = z.object({
  platform: NotedTrendPlatformSchema,
  /** The Melbourne date it was seen, `YYYY-MM-DD`. */
  seenOn: z.string().refine(isMelbourneDate, 'Use a real date'),
});
export type NotedTrendData = z.infer<typeof NotedTrendDataSchema>;

/** `data` of a curated reference: every source the format was collected from (the first is also `source_url`). */
export const CuratedTrendDataSchema = z.object({
  sources: z.array(z.object({ name: z.string().max(160), url: z.string().url().max(500) })).max(10).default([]),
});
export type CuratedTrendData = z.infer<typeof CuratedTrendDataSchema>;

/** What {@link trendLabel} needs to know about one item. */
export type TrendLabelInput =
  | { kind: 'live'; provider: 'instagram_hashtag'; hashtag: string; fetchedAt: Date | string }
  | { kind: 'live'; provider: 'youtube_chart'; fetchedAt: Date | string }
  | { kind: 'noted'; notedByName: string; seenOn: MelbourneDate; platform?: NotedTrendPlatform | null }
  | { kind: 'curated'; sourceName: string; sourceUrl: string; lastReviewedAt: Date | string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A `YYYY-MM-DD` date as "14 Nov 2026". */
export function formatTrendDay(date: MelbourneDate): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** An instant as its Melbourne date, "14 Nov 2026". */
export function formatTrendDate(at: Date | string): string {
  return formatTrendDay(melbourneDateOf(typeof at === 'string' ? new Date(at) : at));
}

/** An instant in Melbourne time, "14 Nov 2026, 6:05 am" (daylight saving included). */
export function formatTrendDateTime(at: Date | string): string {
  const instant = typeof at === 'string' ? new Date(at) : at;
  const [h, min] = melbourneTimeOf(instant).split(':').map(Number);
  const hour = h ?? 0;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${formatTrendDate(instant)}, ${hour12}:${String(min ?? 0).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** A hashtag as the owner types it, reduced to what Instagram searches for: lower case, no `#`, no spaces. */
export function normaliseHashtag(input: string): string {
  return input.trim().replace(/^#+/, '').toLowerCase();
}

/** Words no trend label may contain (the unit test checks every label against this). */
const LABEL_CLAIM_RE = /trending|viral/i;

/** Text typed by a person or returned by a source, or `fallback` when it contains a popularity claim. */
function claimFree(text: string, fallback: string): string {
  return LABEL_CLAIM_RE.test(text) ? fallback : text;
}

/**
 * The one label for a trend item. Live items name their source and fetch time; noted items name the person and the
 * day; curated items name their source (or say they have none) and when they were last reviewed. No output ever
 * contains "trending" or "viral" (unit-tested): typed text that does is replaced by a neutral wording.
 */
export function trendLabel(item: TrendLabelInput): string {
  switch (item.kind) {
    case 'live':
      if (item.provider === 'instagram_hashtag') {
        const tag = normaliseHashtag(item.hashtag);
        return `${claimFree(`Top posts under #${tag}`, 'Top posts under a watched hashtag')} — Instagram, fetched ${formatTrendDateTime(item.fetchedAt)}`;
      }
      return `${YOUTUBE_CHART_SOURCE_NAME} — fetched ${formatTrendDateTime(item.fetchedAt)}`;
    case 'noted': {
      const base = `Noted by ${claimFree(item.notedByName.trim(), '') || 'a team member'} on ${formatTrendDay(item.seenOn)}`;
      return item.platform ? `${base} · seen on ${NOTED_TREND_PLATFORM_LABELS[item.platform]}` : base;
    }
    case 'curated':
      if (!item.sourceUrl.trim()) return `Editor suggestion — no external source · last reviewed ${formatTrendDate(item.lastReviewedAt)}`;
      return `${claimFree(item.sourceName.trim(), 'Source named by the owner') || 'Source named by the owner'} · last reviewed ${formatTrendDate(item.lastReviewedAt)}`;
  }
}

/** True when a live item was fetched more than {@link LIVE_TREND_STALE_HOURS} ago (shown as "Out of date"). */
export function isLiveTrendStale(staleAfter: Date | string | null, now: Date = new Date()): boolean {
  if (!staleAfter) return true;
  return new Date(staleAfter).getTime() <= now.getTime();
}

/** True when a curated reference was last reviewed {@link CURATED_REVIEW_INTERVAL_DAYS} or more days ago. */
export function isCuratedDueForReview(lastReviewedAt: Date | string, now: Date = new Date()): boolean {
  return now.getTime() - new Date(lastReviewedAt).getTime() >= CURATED_REVIEW_INTERVAL_DAYS * 86_400_000;
}

/**
 * When the owner may next refresh a watch by hand: six hours after the last query, or five minutes after a failed
 * one (so a fixed setting can be checked straight away). Null means now.
 */
export function nextManualRefreshAt(watch: { status: TrendWatchStatus; lastQueriedAt: Date | string | null }, now: Date = new Date()): Date | null {
  if (!watch.lastQueriedAt) return null;
  const last = new Date(watch.lastQueriedAt).getTime();
  const waitMs = watch.status === 'error' || watch.status === 'pending' ? RETRY_AFTER_ERROR_MINUTES * 60_000 : MANUAL_REFRESH_INTERVAL_HOURS * 3_600_000;
  const next = last + waitMs;
  return next > now.getTime() ? new Date(next) : null;
}
