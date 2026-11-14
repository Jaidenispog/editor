import { formatTrendDateTime, type IntegrationState, type TrendWatchProvider, type TrendWatchStatus } from '@studio/core';
import type { IntegrationStatus } from '../shared/integration-types.js';
import { missingEnv, type IntegrationBuilder, type IntegrationEnv } from './types.js';

/** What the status builder needs to know about a live source's watch (never any fetched content). */
export interface TrendWatchFact {
  provider: TrendWatchProvider;
  enabled: boolean;
  status: TrendWatchStatus;
  statusMessage: string;
  lastSuccessAt: Date | string | null;
}

/** Shown when no YouTube Data API key is set (design §4.12). */
export const YOUTUBE_NOT_CONFIGURED_MESSAGE =
  "Optional. Add a YouTube Data API key to the server to see YouTube's Australian popular chart (music, movies and gaming only).";

/**
 * Status of the YouTube AU popular chart. `watches` is the list of trend watches, or null when the caller does not
 * read them (Settings → Integrations): then the card says only what the server settings allow and points to
 * Settings → Trends for the chart's own state. Read-only in every state: nothing is ever posted or changed.
 */
export function youTubeChartStatus(env: Pick<IntegrationEnv, 'YOUTUBE_API_KEY'>, watches: TrendWatchFact[] | null): IntegrationStatus {
  const base = { id: 'youtube_chart', name: 'YouTube AU popular chart', areas: ['trends' as const], verified: false };
  const missing = missingEnv(env as IntegrationEnv, ['YOUTUBE_API_KEY']);
  if (missing.length) {
    return { ...base, configured: false, connected: false, state: 'not_configured', liveMode: null, missingEnv: missing, message: YOUTUBE_NOT_CONFIGURED_MESSAGE };
  }
  const configured = { ...base, configured: true, missingEnv: [], liveMode: 'read_only' as const };
  if (watches === null) {
    return {
      ...configured,
      connected: false,
      state: 'not_connected',
      message: 'A YouTube Data API key is set. Whether the chart is on, and when it was last fetched, is shown under Trend sources below and in Settings → Trends.',
    };
  }
  const watch = watches.find((w) => w.provider === 'youtube_chart' && w.enabled);
  if (!watch) {
    return { ...configured, connected: false, state: 'not_connected', message: 'Ready. The owner can turn it on with Show the chart in Settings → Trends. Each fetch uses 1 of the 10,000 free daily quota units.' };
  }
  const fetched = watch.lastSuccessAt ? `Last fetched ${formatTrendDateTime(watch.lastSuccessAt)}.` : undefined;
  const withDetail = <T extends IntegrationStatus>(s: T): T => (fetched ? { ...s, detail: fetched } : s);
  const states: Record<TrendWatchStatus, { state: IntegrationState; connected: boolean; message: string }> = {
    pending: { state: 'not_connected', connected: false, message: 'Turned on. Waiting for the first fetch.' },
    ok: { state: 'connected', connected: true, message: 'Turned on. Fetched once a day; read-only.' },
    quota: { state: 'error', connected: false, message: watch.statusMessage || 'YouTube’s daily limit was reached. It will try again tomorrow.' },
    error: { state: 'error', connected: false, message: watch.statusMessage || 'The last fetch did not work.' },
    unavailable: { state: 'unavailable', connected: false, message: watch.statusMessage || 'Not available for this setup.' },
    needs_reauth: { state: 'needs_reauth', connected: false, message: watch.statusMessage || 'Needs to be set up again.' },
  };
  return withDetail({ ...configured, ...states[watch.status] });
}

/**
 * Integration cards of the trends module. Pure: no database or network access. The Instagram hashtag watch card is
 * added by WP5. TikTok and Google Trends have no card: they are links the owner opens with their own logins.
 */
export const buildTrendsIntegrations: IntegrationBuilder = (env) => [youTubeChartStatus(env, null)];
