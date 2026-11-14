import type { TrendCategory, TrendWatchProvider, TrendWatchStatus } from '@studio/core';
import type { TrendWatch } from '@studio/db';
import type { WorkerContext } from '../../context.js';
import type { TrackedRun } from '../../lib/job-tracker.js';

/** One live item a source returned, ready to store in `trend_references` (`source_kind = 'live'`). */
export interface LiveTrendItemInput {
  /** The source's own id for the item (YouTube video id, Instagram media id). */
  externalId: string;
  title: string;
  summary?: string;
  category: TrendCategory;
  /** The source's fixed name (the full label, with the fetch time, comes from `trendLabel` when shown). */
  sourceName: string;
  /** Link to the item on the source (opened in a new tab). */
  sourceUrl: string;
  /** Only the fields the design allows for this source (validated before storage). */
  data: Record<string, unknown>;
}

/**
 * What one read of a live source produced. `ok` replaces the watch's items; any other status keeps the items it
 * already has (they go out of date and are deleted after 7 days) and shows `message` to the owner.
 */
export type TrendSourceOutcome =
  | { status: 'ok'; items: LiveTrendItemInput[] }
  | { status: Exclude<TrendWatchStatus, 'ok' | 'pending'>; message: string; reason?: string | null };

/**
 * Reads one watch's source. Read-only: it must never post, change or delete anything on any account. Network
 * failures and server errors throw (the job retries once); refusals the owner must fix are returned as an outcome.
 */
export type TrendSourceRefresher = (ctx: WorkerContext, run: TrackedRun, watch: TrendWatch) => Promise<TrendSourceOutcome>;

/** Refreshers by watch provider. The YouTube chart is built in WP3; the Instagram hashtag watch is added by WP5. */
export type TrendSourceRegistry = Partial<Record<TrendWatchProvider, TrendSourceRefresher>>;

/** Plain name of a source, for messages. */
export function trendSourceName(provider: string): string {
  switch (provider) {
    case 'youtube_chart':
      return 'YouTube';
    case 'instagram_hashtag':
      return 'Instagram';
    default:
      return 'This source';
  }
}
