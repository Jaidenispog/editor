import { z } from 'zod';
import { TREND_TITLE_MAX, YOUTUBE_CHART_MAX_RESULTS, YOUTUBE_CHART_REGION } from '@studio/core';
import type { WorkerContext } from '../context.js';
import { httpRequest, readJson } from './http.js';

/**
 * YouTube Data API v3, `videos.list` with `chart=mostPopular` (research memo §11): one quota unit per call against
 * the default 10,000 units a day. Since 21 July 2025 the chart covers music, movies and gaming only, and no
 * parameter identifies Shorts. Read-only; the API key is a server setting and only ever appears in the request URL,
 * which the HTTP helper redacts (`key`) before logging.
 */
export const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
/** Time limit for one chart request (design §8: 15 s, no retries inside the handler). */
export const YOUTUBE_TIMEOUT_MS = 15_000;

/** One chart row, reduced to what the app stores: no thumbnails, descriptions or view counts. */
export interface YouTubeChartItem {
  videoId: string;
  title: string;
  channelTitle: string;
  categoryId: string;
  url: string;
  position: number;
}

/** Why a chart request did not return items. `transient` failures may be retried; the others need the owner. */
export type YouTubeFailureKind = 'key_invalid' | 'access_not_configured' | 'quota' | 'forbidden' | 'transient';

/** Outcome of one chart request. */
export type YouTubeChartResult = { ok: true; items: YouTubeChartItem[] } | { ok: false; kind: YouTubeFailureKind; status: number; reason: string | null };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

const ChartResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.unknown(),
        snippet: z
          .object({ title: z.unknown().optional(), channelTitle: z.unknown().optional(), categoryId: z.unknown().optional() })
          .passthrough()
          .optional(),
      }).passthrough(),
    )
    .default([]),
}).passthrough();

const ErrorResponseSchema = z.object({
  error: z
    .object({
      code: z.number().optional(),
      status: z.string().optional(),
      errors: z.array(z.object({ reason: z.string().optional() }).passthrough()).optional(),
      details: z.array(z.object({ reason: z.string().optional() }).passthrough()).optional(),
    })
    .passthrough(),
}).passthrough();

/** Trims text from another service to a safe single line of at most `max` characters. */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Maps the documented error reasons (design §8.2) to a failure kind. */
export function classifyYouTubeError(status: number, body: unknown): { kind: YouTubeFailureKind; reason: string | null } {
  const parsed = ErrorResponseSchema.safeParse(body);
  const reasons = parsed.success ? [...(parsed.data.error.errors ?? []).map((e) => e.reason), ...(parsed.data.error.details ?? []).map((d) => d.reason)].filter((r): r is string => Boolean(r)) : [];
  const reason = reasons[0] ?? null;
  const has = (...names: string[]) => reasons.some((r) => names.includes(r));
  if (status >= 500 || status === 429) return { kind: 'transient', reason };
  if (has('quotaExceeded', 'dailyLimitExceeded')) return { kind: 'quota', reason };
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) return { kind: 'access_not_configured', reason };
  // keyInvalid / badRequest / API_KEY_INVALID: the request itself is fixed, so a 400 can only mean the key.
  if (status === 400) return { kind: 'key_invalid', reason };
  if (status === 401 || status === 403) return { kind: 'forbidden', reason };
  return { kind: 'transient', reason };
}

/** Turns a 200 response body into chart rows, skipping any row without a usable id or title. */
export function parseYouTubeChart(body: unknown): YouTubeChartItem[] {
  const parsed = ChartResponseSchema.safeParse(body);
  if (!parsed.success) return [];
  const items: YouTubeChartItem[] = [];
  for (const raw of parsed.data.items) {
    if (typeof raw.id !== 'string' || !VIDEO_ID_RE.test(raw.id)) continue;
    const title = cleanText(raw.snippet?.title, TREND_TITLE_MAX);
    if (!title) continue;
    const categoryId = cleanText(raw.snippet?.categoryId, 20);
    items.push({
      videoId: raw.id,
      title,
      channelTitle: cleanText(raw.snippet?.channelTitle, TREND_TITLE_MAX),
      categoryId: /^\d+$/.test(categoryId) ? categoryId : '',
      url: `https://www.youtube.com/watch?v=${raw.id}`,
      position: items.length + 1,
    });
    if (items.length >= YOUTUBE_CHART_MAX_RESULTS) break;
  }
  return items;
}

/**
 * Reads YouTube's popular chart for Australia. HTTP failures are returned as a result; a network failure or time-out
 * throws (the job may retry), and a cancelled run throws CancelledError.
 */
export async function fetchYouTubePopularChart(ctx: Pick<WorkerContext, 'fetch' | 'logger'>, apiKey: string, signal?: AbortSignal): Promise<YouTubeChartResult> {
  const url = new URL(YOUTUBE_VIDEOS_URL);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('regionCode', YOUTUBE_CHART_REGION);
  url.searchParams.set('maxResults', String(YOUTUBE_CHART_MAX_RESULTS));
  url.searchParams.set('key', apiKey);
  const res = await httpRequest(ctx, url.toString(), { method: 'GET', headers: { accept: 'application/json' } }, { label: 'youtube.chart', signal, timeoutMs: YOUTUBE_TIMEOUT_MS });
  const body = await readJson(res);
  if (res.ok) return { ok: true, items: parseYouTubeChart(body) };
  const { kind, reason } = classifyYouTubeError(res.status, body);
  ctx.logger.warn({ youtube: { status: res.status, reason } }, 'youtube chart request refused');
  return { ok: false, kind, status: res.status, reason };
}

