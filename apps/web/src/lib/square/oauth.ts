import 'server-only';
import { eq } from 'drizzle-orm';
import { testOnlyBaseUrl, type Env } from '@studio/config';
import { AppError, SQUARE_HOSTS, newId, parseSquareConfig, type SquareEnvironmentName } from '@studio/core';
import { schema, type Database } from '@studio/db';
import { purgeSquareData } from '@studio/db/square-purge';
import { encryptToken } from '../crypto.js';

/** Narrowest cookie path covering the connect and callback routes. */
export const SQUARE_OAUTH_PATH = '/api/integrations/square';
/** One exchange call, no retry (authorisation codes are short-lived). */
export const SQUARE_EXCHANGE_TIMEOUT_MS = 10_000;

/** The callback address registered in Square's Developer Console (OAuth page) for each environment. */
export function squareRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${SQUARE_OAUTH_PATH}/callback`;
}

/** Square's host for this server's environment (a local fake only when NODE_ENV=test). */
export function squareAuthBase(env: Pick<Env, 'NODE_ENV' | 'SQUARE_API_BASE_URL'>, environment: SquareEnvironmentName): string {
  return testOnlyBaseUrl(env, env.SQUARE_API_BASE_URL) ?? SQUARE_HOSTS[environment];
}

/**
 * Square's authorise address (code flow): the requested permissions space-separated, `session=false` (from Square's
 * OAuth guide, confirmed by the sandbox smoke test), the state, and the fixed redirect address.
 */
export function buildSquareAuthUrl(input: { base: string; applicationId: string; scopes: string[]; state: string; redirectUri: string }): string {
  const u = new URL('/oauth2/authorize', input.base);
  u.searchParams.set('client_id', input.applicationId);
  u.searchParams.set('scope', input.scopes.join(' '));
  u.searchParams.set('session', 'false');
  u.searchParams.set('state', input.state);
  u.searchParams.set('redirect_uri', input.redirectUri);
  return u.toString();
}

/** Tokens from the single code exchange (never logged, never sent to the browser). */
export interface SquareTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  merchantId: string;
}

/** Why the exchange failed, with a plain message for Settings. */
export class SquareExchangeError extends Error {
  constructor(
    readonly reason: 'timeout' | 'unreachable' | 'rejected' | 'incomplete',
    message: string,
  ) {
    super(message);
    this.name = 'SquareExchangeError';
  }
}

/** `POST {base}/oauth2/token` with the authorisation code (code flow: the server holds the application secret). */
export async function exchangeSquareCode(input: { base: string; applicationId: string; applicationSecret: string; code: string; redirectUri: string; fetchImpl?: typeof fetch }): Promise<SquareTokens> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${input.base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'square-version': '2026-09-16' },
      body: JSON.stringify({ client_id: input.applicationId, client_secret: input.applicationSecret, code: input.code, grant_type: 'authorization_code', redirect_uri: input.redirectUri }),
      signal: AbortSignal.timeout(SQUARE_EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new SquareExchangeError(timedOut ? 'timeout' : 'unreachable', 'Square could not be reached. Please try again in a minute.');
  }
  type TokenBody = { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; merchant_id?: unknown; errors?: Array<{ code?: unknown }> };
  const body: TokenBody | null = await res.json().then(
    (v: unknown) => (v && typeof v === 'object' ? (v as TokenBody) : null),
    () => null,
  );
  if (!res.ok) {
    const code = typeof body?.errors?.[0]?.code === 'string' ? body.errors[0].code : `HTTP ${res.status}`;
    throw new SquareExchangeError('rejected', `Square didn’t accept the connection (${code}). Try again.`);
  }
  if (typeof body?.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.merchant_id !== 'string') {
    throw new SquareExchangeError('incomplete', 'Square didn’t send everything Studio Assistant needs. Try again.');
  }
  const expiresAt = typeof body.expires_at === 'string' && !Number.isNaN(Date.parse(body.expires_at)) ? new Date(body.expires_at) : null;
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt, merchantId: body.merchant_id };
}

/**
 * Stores the tokens (encrypted) on the single `square` connection row. When the stored row belongs to another
 * environment or another Square account, that data is purged first (bookings deleted, customers scrubbed) in the
 * same transaction. Choices that belong to the same account and environment (location, service confirmations) are
 * kept on a reconnect. Returns the row id and whether anything was purged.
 */
export async function storeSquareConnection(
  db: Database,
  input: { tokens: SquareTokens; environment: SquareEnvironmentName; userId: string; key?: Buffer },
): Promise<{ connectionId: string; purged: boolean }> {
  return db.transaction(async (tx) => {
    const t = schema.integrationConnections;
    const existing = (await tx.select().from(t).where(eq(t.provider, 'square')).for('update').limit(1))[0];
    const prev = existing ? parseSquareConfig(existing.config) : null;
    const sameAccount = Boolean(existing && prev && prev.environment === input.environment && existing.externalAccountId === input.tokens.merchantId);
    let purged = false;
    if (existing && !sameAccount && existing.externalAccountId) {
      const otherMerchant = existing.externalAccountId !== input.tokens.merchantId;
      await purgeSquareData(tx as unknown as Database, { environment: otherMerchant ? null : (prev?.environment ?? null), userId: input.userId, reason: otherMerchant ? 'merchant_changed' : 'environment_changed' });
      purged = true;
    }
    const config = sameAccount && prev ? { ...prev, environment: input.environment } : { environment: input.environment };
    const values = {
      status: 'connected' as const,
      externalAccountId: input.tokens.merchantId,
      accessTokenEncrypted: encryptToken(input.tokens.accessToken, input.key),
      refreshTokenEncrypted: encryptToken(input.tokens.refreshToken, input.key),
      tokenExpiresAt: input.tokens.expiresAt,
      config,
      ...(sameAccount ? {} : { capabilities: {}, scopes: [], displayName: '', lastSyncAt: null }),
      lastError: null,
      updatedAt: new Date(),
    };
    const rows = await tx
      .insert(t)
      .values({ id: newId(), provider: 'square', ...values })
      .onConflictDoUpdate({ target: t.provider, set: values })
      .returning({ id: t.id });
    const id = rows[0]?.id;
    if (!id) throw new AppError('INTERNAL', 'The Square connection could not be saved.');
    return { connectionId: id, purged };
  });
}
