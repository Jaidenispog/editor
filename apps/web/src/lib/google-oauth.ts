import 'server-only';
import { AppError, GOOGLE_OAUTH_PRODUCTS, GoogleProductSchema, JOB_PAYLOAD_SCHEMAS, isJobType, newId, type GoogleProduct } from '@studio/core';
import { schema, type Database } from '@studio/db';
import { encryptToken } from './crypto.js';

/** Google's authorisation and token endpoints. */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Path both Google routes live under (the state cookie is scoped to it). */
export const GOOGLE_OAUTH_PATH = '/api/integrations/google';
/** The single code exchange happens inside the callback request, with this time limit and no retry. */
export const GOOGLE_EXCHANGE_TIMEOUT_MS = 10_000;

/** Reads `?product=`; anything other than a known product is a 400 with a plain message. */
export function parseGoogleProduct(value: string | null): GoogleProduct {
  const parsed = GoogleProductSchema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION', 'Choose what to connect: Google Business Profile or Google Search Console.');
  return parsed.data;
}

/** The callback address registered in the Google Cloud OAuth client. */
export function googleRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${GOOGLE_OAUTH_PATH}/callback`;
}

/**
 * Google's consent-screen address for one product: only that product's scope, offline access (a refresh token),
 * a fresh consent so the refresh token is always returned, no previously granted scopes, and PKCE S256.
 */
export function buildGoogleAuthUrl(input: { clientId: string; redirectUri: string; product: GoogleProduct; state: string; codeChallenge: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_PRODUCTS[input.product].scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** Tokens from the one code exchange. */
export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

/** Why a code exchange failed, for a plain message. */
export class GoogleExchangeError extends Error {
  constructor(
    readonly reason: 'timeout' | 'rejected' | 'no_refresh_token' | 'scope_missing' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'GoogleExchangeError';
  }
}

/**
 * Exchanges the single-use code for tokens (10 s limit, no retry: the code cannot be used twice). Requires a refresh
 * token and the product's scope in what Google granted (the owner can untick it on the consent screen).
 */
export async function exchangeGoogleCode(input: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  product: GoogleProduct;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<GoogleTokens> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.codeVerifier,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(GOOGLE_EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new GoogleExchangeError(timedOut ? 'timeout' : 'unreachable', timedOut ? 'Google did not answer in time.' : 'Google could not be reached.');
  }
  const json = await readTokenJson(res);
  if (!res.ok || typeof json?.access_token !== 'string') {
    throw new GoogleExchangeError('rejected', `Google refused the sign-in (HTTP ${res.status}${typeof json?.error === 'string' ? `, ${json.error}` : ''}).`);
  }
  if (typeof json.refresh_token !== 'string' || !json.refresh_token) throw new GoogleExchangeError('no_refresh_token', 'Google did not grant ongoing access.');
  const scopes = typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [];
  if (!scopes.includes(GOOGLE_OAUTH_PRODUCTS[input.product].scope)) throw new GoogleExchangeError('scope_missing', 'The permission Studio Assistant needs was not ticked.');
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: new Date((input.now ?? new Date()).getTime() + expiresIn * 1000), scopes };
}

type TokenJson = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };

/** The token endpoint's JSON body, or null when it is not JSON. */
async function readTokenJson(res: Response): Promise<TokenJson | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? (body as TokenJson) : null;
  } catch {
    return null;
  }
}

/** Plain message for a failed exchange (shown in Settings → Integrations). */
export function googleExchangeMessage(err: GoogleExchangeError): string {
  switch (err.reason) {
    case 'scope_missing':
      return 'Google did not give the permission Studio Assistant needs. Press Connect again and leave the permission ticked.';
    case 'no_refresh_token':
      return 'Google did not grant ongoing access. Press Connect again and allow access.';
    case 'timeout':
    case 'unreachable':
      return 'Google could not be reached. Please try again in a minute.';
    default:
      return 'Google did not accept the sign-in. Please press Connect again.';
  }
}

/**
 * Stores the product's tokens (encrypted) in its own `integration_connections` row, as `connected`. Choices kept in
 * `config` (for example a chosen Search Console property) survive a reconnect; the last error is cleared.
 */
export async function storeGoogleConnection(db: Database, product: GoogleProduct, tokens: GoogleTokens, key?: Buffer): Promise<{ connectionId: string; provider: string }> {
  const provider = GOOGLE_OAUTH_PRODUCTS[product].provider;
  const values = {
    status: 'connected' as const,
    accessTokenEncrypted: encryptToken(tokens.accessToken, key),
    refreshTokenEncrypted: encryptToken(tokens.refreshToken, key),
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    lastError: null,
    updatedAt: new Date(),
  };
  const rows = await db
    .insert(schema.integrationConnections)
    .values({ id: newId(), provider, ...values })
    .onConflictDoUpdate({ target: schema.integrationConnections.provider, set: values })
    .returning({ id: schema.integrationConnections.id });
  const id = rows[0]?.id;
  if (!id) throw new AppError('INTERNAL', 'The Google connection could not be saved.');
  return { connectionId: id, provider };
}

/**
 * The read-only follow-up job for a product, when its module has registered the job type and the payload fits;
 * otherwise null, and nothing is enqueued (the tokens are still stored).
 */
export function googleFollowUpJob(product: GoogleProduct): { type: string; payload: Record<string, unknown> } | null {
  const job = GOOGLE_OAUTH_PRODUCTS[product].followUpJob;
  // Widened to string: the type names are only registered once the owning module (WP8, WP9) has merged.
  const type: string = job.type;
  if (!isJobType(type)) return null;
  const schemaForType: { safeParse(v: unknown): { success: boolean; data?: unknown } } = JOB_PAYLOAD_SCHEMAS[type];
  const parsed = schemaForType.safeParse(job.payload);
  return parsed.success ? { type, payload: parsed.data as Record<string, unknown> } : null;
}
