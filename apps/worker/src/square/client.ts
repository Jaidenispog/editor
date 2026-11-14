import { eq, sql } from 'drizzle-orm';
import { testOnlyBaseUrl, type Env } from '@studio/config';
import { NonRetryableError, SQUARE_HOSTS, mapSquareError, parseSquareConfig, type SquareConnectionConfig, type SquareEnvironmentName } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { loadConnection, refreshIfExpiring, withConnectionLock, type ConnectionRow, type RefreshedTokens } from '../lib/connections.js';
import { decryptCredential, decryptOptionalCredential } from '../lib/credentials.js';
import { httpRequest, readJson } from '../lib/http.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { SquareApiError, createSdkSquareApi, type SquareApi } from './api.js';

/** Refresh the access token when it expires within 3 days (Square access tokens last 30 days). */
export const SQUARE_REFRESH_SKEW_SECONDS = 3 * 24 * 3600;

/** An open Square connection for one job attempt. */
export interface SquareSession {
  api: SquareApi;
  conn: ConnectionRow;
  config: SquareConnectionConfig;
  environment: SquareEnvironmentName;
  merchantId: string;
}

/** Square's API host for this deployment (a local fake only when NODE_ENV=test). */
export function squareBaseUrl(env: Pick<Env, 'NODE_ENV' | 'SQUARE_API_BASE_URL'>, environment: SquareEnvironmentName): string {
  return testOnlyBaseUrl(env, env.SQUARE_API_BASE_URL) ?? SQUARE_HOSTS[environment];
}

/** Turns an OAuth endpoint's error answer into a {@link SquareApiError}. */
async function oauthError(res: Response, label: string): Promise<SquareApiError> {
  const body = (await readJson(res)) as { errors?: Array<{ code?: string; category?: string; detail?: string }>; type?: string; message?: string } | null;
  const errors = body?.errors?.length ? body.errors.map((e) => ({ code: String(e.code ?? ''), category: String(e.category ?? ''), ...(e.detail ? { detail: e.detail } : {}) })) : body?.type ? [{ code: String(body.type).toUpperCase(), detail: body.message ?? label }] : [];
  const mapped = mapSquareError({ statusCode: res.status, errors });
  return new SquareApiError(mapped.kind, mapped.code, mapped.message, res.status, errors);
}

/**
 * `POST /oauth2/token` with the stored refresh token (code flow: the refresh token is multi-use and does not
 * expire, so Square normally sends the same one back). Plain fetch through the worker's HTTP helper.
 */
export async function refreshSquareToken(ctx: Pick<WorkerContext, 'env' | 'fetch' | 'logger'>, conn: ConnectionRow, signal: AbortSignal | undefined): Promise<RefreshedTokens> {
  const env = ctx.env;
  const refreshToken = decryptOptionalCredential(env, conn.refreshTokenEncrypted);
  if (!refreshToken || !env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET) {
    throw new SquareApiError('reauth', 'NO_REFRESH_TOKEN', 'Square needs you to reconnect.', null, []);
  }
  const environment = parseSquareConfig(conn.config).environment;
  const res = await httpRequest(
    ctx,
    `${squareBaseUrl(env, environment)}/oauth2/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'square-version': '2026-09-16' },
      body: JSON.stringify({ client_id: env.SQUARE_APPLICATION_ID, client_secret: env.SQUARE_APPLICATION_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken }),
    },
    { label: 'square.token_refresh', signal, timeoutMs: 20_000 },
  );
  if (!res.ok) throw await oauthError(res, 'Token refresh refused');
  const body = (await readJson(res)) as { access_token?: string; refresh_token?: string; expires_at?: string } | null;
  if (!body?.access_token) throw new SquareApiError('transient', 'EMPTY_TOKEN', 'Square sent an empty answer. Trying again shortly.', res.status, []);
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: body.expires_at ? new Date(body.expires_at) : null };
}

/** Marks the connection as needing the owner to reconnect, with a plain reason, and audits it (once per change). */
export async function markSquareNeedsReauth(ctx: WorkerContext, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  const t = schema.integrationConnections;
  const rows = await ctx.db
    .update(t)
    .set({
      status: 'needs_reauth',
      lastError: message.slice(0, 500),
      ...(Object.keys(extra).length ? { capabilities: sql`${t.capabilities} || ${JSON.stringify(extra)}::jsonb` } : {}),
      updatedAt: new Date(),
    })
    .where(sql`${t.provider} = 'square' AND ${t.status} <> 'needs_reauth'`)
    .returning({ id: t.id });
  if (rows.length) await writeWorkerAudit(ctx.db, { userId: null, action: 'integration.square.needs_reauth', entityType: 'integration_connection', entityId: rows[0]?.id ?? null, data: { reason: message } }, ctx.logger);
}

/**
 * Opens Square for one attempt: the connection must be connected (or in a transient error state) in the environment
 * this server is set to; the access token is refreshed first when it expires within 3 days, under the row lock.
 * Returns a plain reason instead when there is nothing to do (the job then completes without calling Square).
 */
export async function openSquare(ctx: WorkerContext, run: Pick<TrackedRun, 'signal'>): Promise<SquareSession | { skip: string }> {
  const env = ctx.env;
  if (!env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET) return { skip: 'Square is not set up on the server.' };
  const first = await loadConnection(ctx.db, 'square');
  if (!first || (first.status !== 'connected' && first.status !== 'error')) return { skip: 'Square is not connected.' };
  const config = parseSquareConfig(first.config);
  if (config.environment !== env.SQUARE_ENVIRONMENT) {
    return { skip: `Studio Assistant is now set to ${env.SQUARE_ENVIRONMENT === 'production' ? 'live' : 'sandbox'} Square. Reconnect Square to load that account.` };
  }
  if (!first.externalAccountId) return { skip: 'Square is not connected.' };
  let conn: ConnectionRow;
  try {
    conn = await withConnectionLock(ctx.db, 'square', async (tx, locked) => {
      if (!locked) throw new NonRetryableError('NOT_FOUND', 'Square is not connected.');
      return (await refreshIfExpiring(tx, env, locked, SQUARE_REFRESH_SKEW_SECONDS, (c) => refreshSquareToken(ctx, c, run.signal))).conn;
    });
  } catch (err) {
    if (err instanceof SquareApiError && err.kind === 'reauth') {
      await markSquareNeedsReauth(ctx, 'Square needs you to reconnect.');
      throw new NonRetryableError('UNAUTHORISED', 'Square needs you to reconnect.');
    }
    throw err;
  }
  if (!conn.accessTokenEncrypted) return { skip: 'Square is not connected.' };
  const api = createSdkSquareApi({
    token: decryptCredential(env, conn.accessTokenEncrypted),
    environment: config.environment,
    baseUrl: testOnlyBaseUrl(env, env.SQUARE_API_BASE_URL),
    signal: run.signal,
    fetch: ctx.fetch,
  });
  return { api, conn, config: parseSquareConfig(conn.config), environment: config.environment, merchantId: conn.externalAccountId ?? first.externalAccountId };
}

/**
 * What every Square handler does with a failure: reconnect problems mark the connection and stop for good;
 * other refusals stop for good with Square's code; time-outs, 5xx and rate limits are retried, and the last
 * attempt leaves a plain error on the card.
 */
export async function failSquareJob(ctx: WorkerContext, run: Pick<TrackedRun, 'willRetry'>, err: unknown, what: string): Promise<never> {
  if (err instanceof SquareApiError) {
    if (err.kind === 'reauth') {
      await markSquareNeedsReauth(ctx, err.code === 'INSUFFICIENT_SCOPES' ? 'Square didn’t grant all the read permissions Studio Assistant needs.' : err.message, err.code === 'INSUFFICIENT_SCOPES' ? { readScopesOk: false } : {});
      throw new NonRetryableError('UNAUTHORISED', err.message);
    }
    if (err.kind === 'transient' || err.kind === 'rate_limited') {
      if (!run.willRetry) await recordSquareError(ctx, `${what}: ${err.message}`);
      throw err;
    }
    await recordSquareError(ctx, `${what}: ${err.message}`);
    throw new NonRetryableError('PROCESSING_FAILED', `${what}: ${err.message}`);
  }
  if (!run.willRetry) await recordSquareError(ctx, `${what}: Square could not be reached.`);
  throw err;
}

/** Leaves a plain error on a connected Square card (a later successful sync clears it). */
export async function recordSquareError(ctx: WorkerContext, message: string): Promise<void> {
  const t = schema.integrationConnections;
  await ctx.db
    .update(t)
    .set({ status: 'error', lastError: message.slice(0, 500), updatedAt: new Date() })
    .where(sql`${t.provider} = 'square' AND ${t.status} IN ('connected', 'error')`);
}

/** Merges top-level keys into the Square connection's config without overwriting keys other writers own. */
export async function mergeSquareConfig(ctx: Pick<WorkerContext, 'db'>, patch: Partial<SquareConnectionConfig>): Promise<void> {
  const t = schema.integrationConnections;
  await ctx.db
    .update(t)
    .set({ config: sql`${t.config} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(t.provider, 'square'));
}
