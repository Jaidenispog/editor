import { AppError, YOUTUBE_CHART_SOURCE_NAME, YouTubeChartItemDataSchema } from '@studio/core';
import { fetchYouTubePopularChart, type YouTubeFailureKind } from '../../lib/youtube-client.js';
import type { LiveTrendItemInput, TrendSourceOutcome, TrendSourceRefresher } from './sources.js';

/** Messages the owner sees for each refusal (design §4.12 and §8.2). */
export const YOUTUBE_MESSAGES: Record<Exclude<YouTubeFailureKind, 'transient'> | 'no_key', string> = {
  no_key: 'No YouTube Data API key is set on the server any more, so the chart cannot be fetched.',
  key_invalid: 'The YouTube API key isn’t valid.',
  access_not_configured: 'Turn on YouTube Data API v3 in your Google Cloud project.',
  quota: 'YouTube’s daily limit was reached. It will try again tomorrow.',
  forbidden: 'YouTube refused the request. Check that the API key is allowed to use YouTube Data API v3.',
};

/**
 * The YouTube AU popular chart (music, movies and gaming only). One request, one quota unit. A 5xx or 429 answer
 * throws so the job retries once after 5 minutes.
 */
export const refreshYouTubeChart: TrendSourceRefresher = async (ctx, run, _watch): Promise<TrendSourceOutcome> => {
  const apiKey = ctx.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) return { status: 'error', message: YOUTUBE_MESSAGES.no_key, reason: 'no_key' };
  const result = await fetchYouTubePopularChart(ctx, apiKey, run.signal);
  if (!result.ok) {
    if (result.kind === 'transient') throw new AppError('PROCESSING_FAILED', `YouTube answered with an error (${result.status}); it will try again shortly.`);
    return { status: result.kind === 'quota' ? 'quota' : 'error', message: YOUTUBE_MESSAGES[result.kind], reason: result.reason ?? result.kind };
  }
  const items: LiveTrendItemInput[] = result.items.map((item) => ({
    externalId: item.videoId,
    title: item.title,
    category: 'other',
    sourceName: YOUTUBE_CHART_SOURCE_NAME,
    sourceUrl: item.url,
    data: YouTubeChartItemDataSchema.parse({ provider: 'youtube_chart', channelTitle: item.channelTitle, categoryId: item.categoryId, url: item.url, position: item.position }),
  }));
  return { status: 'ok', items };
};
