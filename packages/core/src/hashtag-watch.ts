import { z } from 'zod';
import { formatTrendDate, normaliseHashtag, TREND_TITLE_MAX } from './trend-label.js';

/**
 * Instagram hashtag watch (Stage B, WP5; preferences design §4.12, §6.3 and §8.1; research memo §11).
 *
 * A live trend source that reads `ig_hashtag_search` and then `top_media` for a hashtag the owner chose, through the
 * Instagram account the publishing module connected. Everything here is pure so the web app and the worker apply the
 * same rules:
 *
 * - Instagram allows "a maximum of 30 unique hashtags within a 7 day period" per professional account (memo §11).
 *   Whether `top_media` also counts is not known, so every hashtag touched by either call counts for 7 days.
 * - The app keeps a safety margin: at most 10 hashtags are watched at once.
 * - Only the media type, posted time, like and comment counts (when Instagram returns them) and the permalink are
 *   stored. Never captions, images or account names.
 */

/** Unique hashtags one Instagram account may query in any rolling 7 days (memo §11). */
export const HASHTAG_WEEKLY_LIMIT = 30;
/** Length of the rolling window the weekly limit applies to. */
export const HASHTAG_BUDGET_WINDOW_DAYS = 7;
/** Most hashtags the app watches at once (a safety margin under the weekly limit). */
export const MAX_ENABLED_HASHTAGS = 10;
/** Posts read per hashtag on each refresh. */
export const HASHTAG_TOP_MEDIA_LIMIT = 9;
/** Longest hashtag accepted (Instagram's own limit is not documented in the memo; this keeps URLs short). */
export const HASHTAG_MAX_LENGTH = 100;
/** The fixed name stored with each item (the shown label, with the fetch time, comes from `trendLabel`). */
export const INSTAGRAM_HASHTAG_SOURCE_NAME = 'Instagram hashtag watch';

const WINDOW_MS = HASHTAG_BUDGET_WINDOW_DAYS * 86_400_000;

/** True for an `https://instagram.com/…` or `https://www.instagram.com/…` link (the only links stored for a post). */
export function isInstagramPermalink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'instagram.com' || u.hostname === 'www.instagram.com') && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}

/** `data` of one live item from a hashtag watch: only the fields the design allows. */
export const InstagramHashtagItemDataSchema = z.object({
  provider: z.literal('instagram_hashtag'),
  /** The watched hashtag, lower case, without `#` (read by `trendLabel`). */
  hashtag: z.string().min(1).max(HASHTAG_MAX_LENGTH),
  /** Position in Instagram's `top_media` answer (1 = first). */
  rank: z.number().int().min(1).max(50),
  /** Instagram's `media_type` (for example IMAGE, VIDEO or CAROUSEL_ALBUM). */
  mediaType: z.string().min(1).max(40),
  /** Instagram's `timestamp` of the post, as an ISO instant, or null when not returned. */
  postedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Counts exactly as Instagram reported them at fetch time; null when not returned. */
  likeCount: z.number().int().min(0).nullable(),
  commentsCount: z.number().int().min(0).nullable(),
  permalink: z.string().max(300).refine(isInstagramPermalink, 'Only Instagram links are kept'),
});
export type InstagramHashtagItemData = z.infer<typeof InstagramHashtagItemDataSchema>;

/** Why a typed hashtag cannot be watched, or null when it can. */
export function hashtagProblem(input: string): string | null {
  const tag = normaliseHashtag(input);
  if (!tag) return 'Type a hashtag to watch.';
  if (tag.length > HASHTAG_MAX_LENGTH) return `Hashtags can be at most ${HASHTAG_MAX_LENGTH} characters.`;
  if (!/^[\p{L}\p{N}_]+$/u.test(tag)) return 'Use letters, numbers and underscores only, with no spaces or # in the middle.';
  if (/trending|viral/i.test(tag)) return 'Hashtags with “trending” or “viral” in them can’t be watched: the app never labels anything that way.';
  return null;
}

/** Plain name for Instagram's `media_type`. */
export function instagramMediaTypeLabel(mediaType: string): string {
  switch (mediaType.toUpperCase()) {
    case 'IMAGE':
      return 'Photo';
    case 'VIDEO':
      return 'Video';
    case 'CAROUSEL_ALBUM':
      return 'Carousel';
    default:
      return 'Post';
  }
}

/** Title stored for a post: "Video under #skinfade, posted 12 Nov 2026" (no caption, no account name). */
export function instagramPostTitle(hashtag: string, mediaType: string, postedAt: string | null): string {
  const base = `${instagramMediaTypeLabel(mediaType)} under #${normaliseHashtag(hashtag)}`;
  return (postedAt ? `${base}, posted ${formatTrendDate(postedAt)}` : base).slice(0, TREND_TITLE_MAX);
}

/** "120 likes · 4 comments", from whatever Instagram returned (empty when it returned neither). */
export function instagramCountsLine(likeCount: number | null, commentsCount: number | null): string {
  const parts: string[] = [];
  if (likeCount !== null) parts.push(`${likeCount.toLocaleString('en-AU')} like${likeCount === 1 ? '' : 's'}`);
  if (commentsCount !== null) parts.push(`${commentsCount.toLocaleString('en-AU')} comment${commentsCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** One hashtag watch as the budget sees it. */
export interface HashtagBudgetWatch {
  id: string;
  lastQueriedAt: Date | string | null;
}

/** How much of the weekly hashtag limit is used. */
export interface HashtagBudget {
  /** Distinct hashtags queried in the last 7 days (turned-off watches included until their week is over). */
  used: number;
  limit: number;
  /** When the oldest counted hashtag stops counting, if the limit is reached; null when a new one can be added now. */
  nextFreeAt: Date | null;
}

/** True when a watch's last query still counts towards the weekly limit. */
export function hashtagCounts(lastQueriedAt: Date | string | null, now: Date = new Date()): boolean {
  if (!lastQueriedAt) return false;
  return now.getTime() - new Date(lastQueriedAt).getTime() < WINDOW_MS;
}

/** The weekly hashtag budget from every Instagram hashtag watch row (enabled or not). */
export function hashtagBudget(watches: readonly HashtagBudgetWatch[], now: Date = new Date()): HashtagBudget {
  const counted = watches.filter((w) => hashtagCounts(w.lastQueriedAt, now)).map((w) => new Date(w.lastQueriedAt as Date | string).getTime());
  const used = counted.length;
  const nextFreeAt = used >= HASHTAG_WEEKLY_LIMIT ? new Date(Math.min(...counted) + WINDOW_MS) : null;
  return { used, limit: HASHTAG_WEEKLY_LIMIT, nextFreeAt };
}

/**
 * Whether one watch may query Instagram now. A hashtag already counted this week may always be read again (it does
 * not add to the count); a new one needs a free place in the weekly limit.
 */
export function mayQueryHashtag(watchId: string, watches: readonly HashtagBudgetWatch[], now: Date = new Date()): { ok: true } | { ok: false; nextFreeAt: Date } {
  const self = watches.find((w) => w.id === watchId);
  if (self && hashtagCounts(self.lastQueriedAt, now)) return { ok: true };
  const others = hashtagBudget(
    watches.filter((w) => w.id !== watchId),
    now,
  );
  return others.used < HASHTAG_WEEKLY_LIMIT ? { ok: true } : { ok: false, nextFreeAt: others.nextFreeAt ?? new Date(now.getTime() + WINDOW_MS) };
}

/** "Instagram allows 30 hashtags a week. You can add another on 18 Nov 2026." */
export function hashtagLimitMessage(nextFreeAt: Date | string): string {
  return `Instagram allows ${HASHTAG_WEEKLY_LIMIT} hashtags a week. You can add another on ${formatTrendDate(nextFreeAt)}.`;
}
