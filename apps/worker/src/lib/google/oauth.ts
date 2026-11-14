import { AppError, GOOGLE_OAUTH_PRODUCTS, googleProductForProvider, type ConnectionProvider } from '@studio/core';
import { eq } from 'drizzle-orm';
import { schema } from '@studio/db';
import type { WorkerContext } from '../../context.js';
import { refreshIfExpiring, withConnectionLock, type ConnectionRow, type RefreshedTokens } from '../connections.js';
import { decryptCredential } from '../credentials.js';
import { httpRequest, readJson } from '../http.js';

/** Google's token endpoint (refresh) and revocation endpoint. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Refresh this long before the access token expires. */
const REFRESH_SKEW_SECONDS = 120;
const TOKEN_TIMEOUT_MS = 15_000;

/** Google connection rows (one per product). */
export type GoogleProvider = Extract<ConnectionProvider, 'google_business_profile' | 'google_search_console'>;

/** Plain message shown when Google wants the owner to sign in again. */
export function googleReauthMessage(provider: string): string {
  const product = googleProductForProvider(provider);
  const label = product ? GOOGLE_OAUTH_PRODUCTS[product].label : 'Google';
  return `${label} needs you to sign in again. Reconnect it in Settings → Integrations.`;
}

/** Google refused the stored refresh token (revoked, expired or password changed). */
export class GoogleInvalidGrantError extends Error {
  constructor() {
    super('Google refused the stored sign-in (invalid_grant)');
    this.name = 'GoogleInvalidGrantError';
  }
}

/** Calls Google's token endpoint with the stored refresh token. */
export async function refreshGoogleToken(ctx: Pick<WorkerContext, 'env' | 'fetch' | 'logger'>, conn: ConnectionRow, signal?: AbortSignal): Promise<RefreshedTokens> {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = ctx.env;
  if (!clientId || !clientSecret) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Google sign-in is not set up on the server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).');
  if (!conn.refreshTokenEncrypted) throw new GoogleInvalidGrantError();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: decryptCredential(ctx.env, conn.refreshTokenEncrypted),
  });
  const res = await httpRequest(
    ctx,
    GOOGLE_TOKEN_URL,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body },
    { label: 'google.token_refresh', signal, timeoutMs: TOKEN_TIMEOUT_MS },
  );
  const json = (await readJson(res)) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown; error?: unknown } | null;
  if (res.status === 400 && json?.error === 'invalid_grant') throw new GoogleInvalidGrantError();
  if (!res.ok || typeof json?.access_token !== 'string') {
    throw new AppError('PROCESSING_FAILED', `Google did not refresh the sign-in (HTTP ${res.status}${typeof json?.error === 'string' ? `, ${json.error}` : ''}).`);
  }
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : undefined,
  };
}

/**
 * Returns a valid access token for a Google connection, refreshing and storing it under the row lock when it is
 * about to expire. `invalid_grant` marks the connection `needs_reauth` and throws a plain INTEGRATION_NOT_CONFIGURED
 * error; a missing connection throws the same code.
 */
export async function getGoogleAccessToken(ctx: WorkerContext, provider: GoogleProvider, signal?: AbortSignal): Promise<string> {
  const outcome = await withConnectionLock(ctx.db, provider, async (tx, conn) => {
    if (!conn || conn.status === 'disconnected' || !conn.refreshTokenEncrypted) return { kind: 'missing' as const };
    if (conn.status === 'needs_reauth') return { kind: 'reauth' as const };
    try {
      const { conn: fresh } = await refreshIfExpiring(tx, ctx.env, conn, REFRESH_SKEW_SECONDS, (c) => refreshGoogleToken(ctx, c, signal));
      if (!fresh.accessTokenEncrypted) return { kind: 'missing' as const };
      return { kind: 'ok' as const, token: decryptCredential(ctx.env, fresh.accessTokenEncrypted) };
    } catch (err) {
      if (!(err instanceof GoogleInvalidGrantError)) throw err;
      await tx
        .update(schema.integrationConnections)
        .set({ status: 'needs_reauth', lastError: googleReauthMessage(provider), updatedAt: new Date() })
        .where(eq(schema.integrationConnections.id, conn.id));
      return { kind: 'reauth' as const };
    }
  });
  if (outcome.kind === 'ok') return outcome.token;
  if (outcome.kind === 'reauth') throw new AppError('INTEGRATION_NOT_CONFIGURED', googleReauthMessage(provider));
  const product = googleProductForProvider(provider);
  throw new AppError('INTEGRATION_NOT_CONFIGURED', `${product ? GOOGLE_OAUTH_PRODUCTS[product].label : 'Google'} is not connected.`);
}

/**
 * Asks Google to revoke a token (which also ends the refresh token's grant). `already_invalid` means Google no
 * longer knew it (HTTP 400), which is the same end state. Other failures throw so the job can retry.
 */
export async function revokeGoogleToken(ctx: Pick<WorkerContext, 'fetch' | 'logger'>, token: string, signal?: AbortSignal): Promise<'revoked' | 'already_invalid'> {
  const res = await httpRequest(
    ctx,
    GOOGLE_REVOKE_URL,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) },
    { label: 'google.revoke', signal, timeoutMs: TOKEN_TIMEOUT_MS },
  );
  if (res.ok) return 'revoked';
  if (res.status === 400) return 'already_invalid';
  throw new AppError('PROCESSING_FAILED', `Google did not confirm the sign-out (HTTP ${res.status}).`);
}
