import { HASHTAG_WEEKLY_LIMIT, formatTrendDateTime, type IntegrationState, type TrendWatchStatus } from '@studio/core';
import type { IntegrationStatus } from '../shared/integration-types.js';
import { connectionFor, envSentence, missingEnv, type ConnectionFacts, type IntegrationBuilder, type IntegrationEnv, type TrendWatchFact } from './types.js';

export type { TrendWatchFact } from './types.js';

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

/** Messages of the Instagram hashtag watch card (design §4.12). */
export const INSTAGRAM_HASHTAG_STATUS_MESSAGES = {
  noAccount: 'Connect Instagram in Settings → Integrations first. Hashtag watch also needs the hashtag search permission on your Meta app.',
  reconnect: 'Reconnect Instagram in Settings → Integrations.',
  unavailable: "Your Meta app setup doesn't allow hashtag search. This is optional; everything else works.",
} as const;

/** The Meta app settings the hashtag watch shares with Instagram publishing (one login configuration). */
const META_ENV = ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'] as const;

/** Latest of a list of instants, or null. */
function latest(values: Array<Date | string | null>): Date | null {
  const times = values.filter((v): v is Date | string => v !== null).map((v) => new Date(v).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * Status of the Instagram hashtag watch (WP5). It reads through the Instagram account the publishing module
 * connected, so it needs that connection first; whether Meta allows hashtag search for this app setup is only known
 * after the first read, and "not available" is a valid end state. `watches` is null when the caller does not read
 * them. Read-only in every state: nothing is posted or changed on Instagram.
 */
export function instagramHashtagStatus(env: IntegrationEnv, facts: Pick<ConnectionFacts, 'connections' | 'socialAccounts'>, watches: TrendWatchFact[] | null): IntegrationStatus {
  const base = { id: 'instagram_hashtags', name: 'Instagram hashtag watch', areas: ['trends' as const], verified: false };
  const missing = missingEnv(env, [...META_ENV]);
  if (missing.length) {
    return {
      ...base,
      configured: false,
      connected: false,
      state: 'not_configured',
      liveMode: null,
      missingEnv: missing,
      message: `Optional. Shows Instagram's top posts for hashtags you choose. It reads through your connected Instagram account, so ${envSentence(missing)} must be added to the server and Instagram connected first.`,
    };
  }
  const configured = { ...base, configured: true, missingEnv: [] as string[] };
  const meta = connectionFor({ connections: facts.connections, socialAccounts: facts.socialAccounts }, 'meta');
  const accounts = facts.socialAccounts.filter((a) => a.platform === 'instagram');
  const account = accounts.find((a) => a.status === 'connected');
  if (meta?.status === 'needs_reauth' || (!account && accounts.some((a) => a.status === 'needs_reauth'))) {
    return { ...configured, connected: false, state: 'needs_reauth', liveMode: null, message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.reconnect };
  }
  if (!meta || meta.status !== 'connected' || !account) {
    return { ...configured, connected: false, state: 'not_connected', liveMode: null, message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.noAccount };
  }
  const readOnly = { ...configured, liveMode: 'read_only' as const };
  if (account.capabilities?.['hashtagSearch'] === false) {
    return { ...readOnly, connected: false, state: 'unavailable', message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.unavailable };
  }
  if (watches === null) {
    return { ...readOnly, connected: false, state: 'not_connected', message: `Instagram is connected as @${account.username}. Which hashtags are watched, and when they were fetched, is shown in Settings → Trends.` };
  }
  const on = watches.filter((w) => w.provider === 'instagram_hashtag' && w.enabled);
  if (!on.length) {
    return { ...readOnly, connected: false, state: 'not_connected', message: `Ready. The owner can add a hashtag to watch in Settings → Trends. Instagram allows ${HASHTAG_WEEKLY_LIMIT} hashtags a week.` };
  }
  const fetchedAt = latest(on.map((w) => w.lastSuccessAt));
  const withDetail = (s: IntegrationStatus): IntegrationStatus => (fetchedAt ? { ...s, detail: `Last fetched ${formatTrendDateTime(fetchedAt)}.` } : s);
  if (on.some((w) => w.status === 'needs_reauth')) return withDetail({ ...readOnly, connected: false, state: 'needs_reauth', message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.reconnect });
  if (on.some((w) => w.status === 'unavailable')) return withDetail({ ...readOnly, connected: false, state: 'unavailable', message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.unavailable });
  const ok = on.filter((w) => w.status === 'ok').length;
  const troubled = on.filter((w) => w.status === 'error' || w.status === 'quota');
  if (ok) {
    const problem = troubled.length ? ` ${troubled.length === 1 ? 'One hashtag has' : `${troubled.length} hashtags have`} a problem; see Settings → Trends.` : '';
    return withDetail({ ...readOnly, connected: true, state: 'connected', message: `Watching ${on.length} hashtag${on.length === 1 ? '' : 's'}. Fetched once a day; read-only.${problem}` });
  }
  if (troubled[0]) return withDetail({ ...readOnly, connected: false, state: 'error', message: troubled[0].statusMessage || 'The last fetch did not work.' });
  return withDetail({ ...readOnly, connected: false, state: 'not_connected', message: 'Turned on. Waiting for the first fetch.' });
}

/**
 * Integration cards of the trends module: the YouTube AU popular chart and the Instagram hashtag watch. Pure: no
 * database or network access. TikTok and Google Trends have no card: they are links the owner opens with their own
 * logins.
 */
export const buildTrendsIntegrations: IntegrationBuilder = (env, facts) => [youTubeChartStatus(env, facts.trendWatches ?? null), instagramHashtagStatus(env, facts, facts.trendWatches ?? null)];
