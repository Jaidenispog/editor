import { z } from 'zod';

/**
 * Shared vocabulary for every integration (Stage B/C). One contract for all modules, so the Settings cards, the
 * section pages and the worker's capability checks always use the same words.
 */

/** What the owner sees on an integration card. */
export const INTEGRATION_STATES = [
  /** A server setting is missing (only its name is ever shown). */
  'not_configured',
  /** Server settings are present but no account is connected (or it was disconnected, or the source is off). */
  'not_connected',
  'connected',
  /** The provider has not approved access yet (for example Google Business Profile quota 0). */
  'awaiting_approval',
  /** A read-only capability check says this account or app cannot do this. */
  'unavailable',
  /** The provider wants the owner to sign in again. */
  'needs_reauth',
  'error',
] as const;
export const IntegrationStateSchema = z.enum(INTEGRATION_STATES);
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

/** Whether a connection reaches real data, a provider's test environment, or only reads. */
export const LIVE_MODES = ['live', 'development_live', 'sandbox', 'staging', 'read_only'] as const;
export const LiveModeSchema = z.enum(LIVE_MODES);
export type LiveMode = z.infer<typeof LiveModeSchema>;

/** Providers that may have a row in `integration_connections` (one row per provider). */
export const CONNECTION_PROVIDERS = [
  'square',
  'resend',
  'google_business_profile',
  'google_search_console',
  'website',
  'meta',
  'zernio',
  'postmark',
  'google_places',
] as const;
export const ConnectionProviderSchema = z.enum(CONNECTION_PROVIDERS);
export type ConnectionProvider = z.infer<typeof ConnectionProviderSchema>;

/** Stored status of an `integration_connections` row. */
export const CONNECTION_STATUSES = ['not_configured', 'connected', 'needs_reauth', 'error', 'disconnected'] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/**
 * Capabilities a read-only check verified against the live account, plus verification markers written only by
 * explicit owner actions (for example `verifiedDirectAt` after the first real post).
 */
export type ConnectionCapabilities = Record<string, boolean | string | number | null>;

/** Google products connected through the shared Google OAuth routes, each into its own connection row. */
export const GOOGLE_OAUTH_PRODUCTS = {
  business_profile: {
    label: 'Google Business Profile',
    scope: 'https://www.googleapis.com/auth/business.manage',
    provider: 'google_business_profile',
    /** Read-only job enqueued after connecting, when its module has registered it. */
    followUpJob: { type: 'reviews.gbp.sync', payload: { reason: 'connect' } },
  },
  search_console: {
    label: 'Google Search Console',
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    provider: 'google_search_console',
    followUpJob: { type: 'website.connection_check', payload: { provider: 'google_search_console', reason: 'connect' } },
  },
} as const satisfies Record<string, { label: string; scope: string; provider: ConnectionProvider; followUpJob: { type: string; payload: Record<string, unknown> } }>;
export const GoogleProductSchema = z.enum(['business_profile', 'search_console']);
export type GoogleProduct = z.infer<typeof GoogleProductSchema>;

/** The Google product a connection row belongs to, or null for other providers. */
export function googleProductForProvider(provider: string): GoogleProduct | null {
  for (const [product, def] of Object.entries(GOOGLE_OAUTH_PRODUCTS)) if (def.provider === provider) return product as GoogleProduct;
  return null;
}
