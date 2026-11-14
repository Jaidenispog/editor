import type { Env } from '@studio/config';
import type { ConnectionCapabilities, TrendWatchProvider, TrendWatchStatus } from '@studio/core';
import type { IntegrationStatus } from '../shared/integration-types.js';

/** Settings the Stage A cards read (always present in callers). */
type CoreIntegrationEnv = Pick<
  Env,
  | 'AI_PROVIDER'
  | 'ANTHROPIC_API_KEY'
  | 'AI_PLANNER_MODEL'
  | 'AI_VISION_MODEL'
  | 'TRANSCRIPTION_PROVIDER'
  | 'DEEPGRAM_API_KEY'
  | 'DEEPGRAM_MODEL'
  | 'OPENAI_API_KEY'
  | 'OPENAI_TRANSCRIPTION_MODEL'
  | 'STORAGE_DRIVER'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_ENDPOINT'
  | 'META_APP_ID'
  | 'META_APP_SECRET'
  | 'TIKTOK_CLIENT_KEY'
  | 'TIKTOK_CLIENT_SECRET'
  | 'SQUARE_APPLICATION_ID'
  | 'SQUARE_APPLICATION_SECRET'
  | 'SQUARE_WEBHOOK_SIGNATURE_KEY'
  | 'RESEND_API_KEY'
  | 'EMAIL_FROM'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
>;

/**
 * Server settings an integration builder may read (only presence and non-secret values are ever shown). The Stage
 * B/C settings are optional here so a builder must treat a missing value as "not set up".
 */
export type IntegrationEnv = CoreIntegrationEnv &
  Partial<
    Pick<
      Env,
      | 'NODE_ENV'
      | 'AI_WEBSITE_MODEL'
      | 'META_LOGIN_CONFIG_ID'
      | 'META_GRAPH_VERSION'
      | 'TIKTOK_PUBLISH_PROVIDER'
      | 'ZERNIO_API_BASE_URL'
      | 'ZERNIO_WEBHOOK_SECRET'
      | 'YOUTUBE_API_KEY'
      | 'SQUARE_ENVIRONMENT'
      | 'SQUARE_WEBHOOK_NOTIFICATION_URL'
      | 'EMAIL_PROVIDER'
      | 'POSTMARK_SERVER_TOKEN'
      | 'POSTMARK_TRANSACTIONAL_STREAM'
      | 'POSTMARK_BROADCAST_STREAM'
      | 'POSTMARK_WEBHOOK_USERNAME'
      | 'POSTMARK_WEBHOOK_PASSWORD'
      | 'GOOGLE_MAPS_API_KEY'
    >
  >;

/** Facts about one stored connection (never its credential). */
export interface ConnectionFact {
  provider: string;
  status: string;
  displayName: string;
  capabilities?: ConnectionCapabilities;
  config?: Record<string, unknown>;
  lastError?: string | null;
  lastSyncAt?: Date | null;
}

/** What a status card needs to know about a live trend source's watch (never any fetched content). */
export interface TrendWatchFact {
  provider: TrendWatchProvider;
  enabled: boolean;
  status: TrendWatchStatus;
  statusMessage: string;
  lastSuccessAt: Date | string | null;
}

/** Minimal connection facts read from integration_connections, social_accounts and trend_watches. */
export interface ConnectionFacts {
  connections: ConnectionFact[];
  socialAccounts: Array<{ platform: string; status: string; username: string; capabilities?: Record<string, unknown> }>;
  /** Trend watches, when the caller read them; absent means "not read" and cards fall back to settings only. */
  trendWatches?: TrendWatchFact[];
}

/** Builds one module's status cards. Pure (no database or network access), so it is unit tested. */
export type IntegrationBuilder = (env: IntegrationEnv, facts: ConnectionFacts) => IntegrationStatus[];

/** Names of the given settings that are missing or blank. */
export function missingEnv(env: IntegrationEnv, names: Array<keyof IntegrationEnv>): string[] {
  return names.filter((n) => {
    const v = env[n];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  }) as string[];
}

/** "A", "A and B", "A, B and C". */
export function envSentence(names: string[]): string {
  if (names.length === 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The stored connection for a provider, if any. */
export function connectionFor(facts: ConnectionFacts, provider: string): ConnectionFact | undefined {
  return facts.connections.find((c) => c.provider === provider);
}
