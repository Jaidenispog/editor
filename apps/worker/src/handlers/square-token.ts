import { NonRetryableError, parseSquareConfig, type JobPayload } from '@studio/core';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { loadConnection, refreshIfExpiring, withConnectionLock } from '../lib/connections.js';
import { httpRequest, readJson } from '../lib/http.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { SquareApiError } from '../square/api.js';
import { markSquareNeedsReauth, refreshSquareToken, squareBaseUrl } from '../square/client.js';

/** True when the `square` row is live again for the same seller and environment the revoke was queued for. */
async function reconnectedSince(ctx: WorkerContext, payload: JobPayload<'square.revoke'>): Promise<boolean> {
  const conn = await loadConnection(ctx.db, 'square');
  if (!conn || !['connected', 'error', 'needs_reauth'].includes(conn.status)) return false;
  return conn.externalAccountId === payload.merchantId && parseSquareConfig(conn.config).environment === payload.environment;
}

/** The daily job refreshes when fewer than this many days are left (about weekly, as access tokens last 30 days). */
export const SQUARE_DAILY_REFRESH_SKEW_SECONDS = 23 * 24 * 3600;

/**
 * `square.token_refresh` (daily): refreshes the access token when it expires within 23 days, under the connection
 * lock. A refused refresh (revoked, app disabled) asks the owner to reconnect; other failures are retried.
 */
export async function handleSquareTokenRefresh(ctx: WorkerContext, run: TrackedRun, _payload: JobPayload<'square.token_refresh'>): Promise<void> {
  const conn = await loadConnection(ctx.db, 'square');
  if (!conn || (conn.status !== 'connected' && conn.status !== 'error') || !ctx.env.SQUARE_APPLICATION_ID || !ctx.env.SQUARE_APPLICATION_SECRET) {
    await run.progress(1, 'Square is not connected.');
    return;
  }
  if (parseSquareConfig(conn.config).environment !== ctx.env.SQUARE_ENVIRONMENT) {
    await run.progress(1, 'Square is set to the other environment; nothing to refresh.');
    return;
  }
  try {
    const refreshed = await withConnectionLock(ctx.db, 'square', async (tx, locked) =>
      locked ? (await refreshIfExpiring(tx, ctx.env, locked, SQUARE_DAILY_REFRESH_SKEW_SECONDS, (c) => refreshSquareToken(ctx, c, run.signal))).refreshed : false,
    );
    await run.progress(1, refreshed ? 'Square access renewed.' : 'Square access is still valid.');
  } catch (err) {
    if (err instanceof SquareApiError && err.kind === 'reauth') {
      await markSquareNeedsReauth(ctx, 'Square needs you to reconnect.');
      throw new NonRetryableError('UNAUTHORISED', 'Square needs you to reconnect.');
    }
    throw err;
  }
}

/**
 * `square.revoke`: after the owner disconnects, asks Square to revoke every token of this app for that seller
 * (`POST /oauth2/revoke` with `Authorization: Client <application secret>`; no stored token is needed). The outcome
 * is audited; when Square cannot be reached after the retries, the owner is told to remove the app in Square.
 *
 * Square revokes EVERY token of the app for that seller, so a revoke that runs after the owner has already
 * reconnected the same Square account (a busy or restarted worker, or a retry) would kill the new connection. It is
 * skipped then (audited as `integration.square.revoke_skipped`): the owner's reconnect wins.
 */
export async function handleSquareRevoke(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.revoke'>): Promise<void> {
  const env = ctx.env;
  const audit = (action: 'integration.square.revoked' | 'integration.square.revoke_failed' | 'integration.square.revoke_skipped', data: Record<string, unknown>) =>
    writeWorkerAudit(ctx.db, { userId: null, action, entityType: 'integration_connection', data: { merchantId: payload.merchantId, environment: payload.environment, ...data } }, ctx.logger);
  if (await reconnectedSince(ctx, payload)) {
    await audit('integration.square.revoke_skipped', { reason: 'reconnected' });
    await run.progress(1, 'Not revoked: you connected this Square account again after disconnecting.');
    return;
  }
  if (!env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET) {
    await audit('integration.square.revoke_failed', { reason: 'not_configured' });
    await run.progress(1, 'Square is not set up on the server, so access could not be revoked. Remove Studio Assistant in Square’s App integrations page.');
    return;
  }
  const res = await httpRequest(
    ctx,
    `${squareBaseUrl(env, payload.environment)}/oauth2/revoke`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Client ${env.SQUARE_APPLICATION_SECRET}`, 'square-version': '2026-09-16' },
      body: JSON.stringify({ client_id: env.SQUARE_APPLICATION_ID, merchant_id: payload.merchantId }),
    },
    { label: 'square.revoke', signal: run.signal, timeoutMs: 20_000 },
  );
  const body = (await readJson(res)) as { success?: boolean; errors?: Array<{ code?: string }> } | null;
  if (res.ok && body?.success !== false) {
    await audit('integration.square.revoked', {});
    await run.progress(1, 'Square access revoked.');
    return;
  }
  const code = body?.errors?.[0]?.code ?? `HTTP_${res.status}`;
  if ((res.status >= 500 || res.status === 429) && run.willRetry) throw new Error(`Square could not revoke access yet (${code}).`);
  await audit('integration.square.revoke_failed', { code });
  throw new NonRetryableError('PROCESSING_FAILED', 'Square did not confirm that access was revoked. Remove Studio Assistant in Square’s App integrations page.');
}
