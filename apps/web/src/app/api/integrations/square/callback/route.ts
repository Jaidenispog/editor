import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { clearOAuthStateCookie, consumeOAuthState, oauthStateMessage } from '@/lib/oauth-state';
import { SQUARE_OAUTH_PATH, SquareExchangeError, exchangeSquareCode, squareAuthBase, squareRedirectUri, storeSquareConnection } from '@/lib/square/oauth';
import { queueSquareSync } from '@/lib/square/status';

/**
 * GET /api/integrations/square/callback?code&state (owner, same session). Checks the state cookie, does the single
 * code exchange inline (10 s, no retry), purges another environment's or account's data, stores the tokens
 * encrypted, audits, and queues the first read-only `square.sync`. Every outcome returns to Settings → Integrations
 * and clears the state cookie.
 */
export const GET = handleApi(async ({ req, user, session }) => {
  requireOwner(user);
  const env = getEnv();
  const q = req.nextUrl.searchParams;
  const finish = (params: Record<string, string>) => {
    const url = new URL('/settings', env.APP_URL);
    url.searchParams.set('tab', 'integrations');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = NextResponse.redirect(url, 302);
    clearOAuthStateCookie(res, 'square', SQUARE_OAUTH_PATH);
    return res;
  };
  const checked = consumeOAuthState(req, 'square', { state: q.get('state'), sessionId: session.sessionId });
  if (!checked.ok) return finish({ square_error: oauthStateMessage(checked.reason) });
  if (q.get('error')) {
    await writeAudit({ userId: user.id, action: 'integration.square.connect_declined', entityType: 'integration_connection', data: { error: q.get('error')?.slice(0, 60) ?? '' } });
    return finish({ square_error: 'Square connection was cancelled. Nothing was changed.' });
  }
  const code = q.get('code');
  if (!code || !env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET) return finish({ square_error: oauthStateMessage('mismatch') });
  // The environment the sign-in started in; a server switch in between asks for a fresh sign-in.
  if (checked.extra['environment'] && checked.extra['environment'] !== env.SQUARE_ENVIRONMENT) {
    return finish({ square_error: 'The Square environment changed during the sign-in. Please press Connect again.' });
  }
  try {
    const tokens = await exchangeSquareCode({
      base: squareAuthBase(env, env.SQUARE_ENVIRONMENT),
      applicationId: env.SQUARE_APPLICATION_ID,
      applicationSecret: env.SQUARE_APPLICATION_SECRET,
      code,
      redirectUri: squareRedirectUri(env.APP_URL),
    });
    const stored = await storeSquareConnection(getDb(), { tokens, environment: env.SQUARE_ENVIRONMENT, userId: user.id });
    await writeAudit({
      userId: user.id,
      action: 'integration.square.connected',
      entityType: 'integration_connection',
      entityId: stored.connectionId,
      data: { environment: env.SQUARE_ENVIRONMENT, merchantId: tokens.merchantId, access: checked.extra['access'] ?? 'read', purged: stored.purged },
    });
    try {
      await queueSquareSync('connect');
      return finish({ square: 'checking' });
    } catch (err) {
      // The tokens are stored; the 10-minute sync picks the connection up.
      getLogger().warn({ err }, 'could not queue the first Square sync');
      return finish({ square: 'connected' });
    }
  } catch (err) {
    if (err instanceof SquareExchangeError) {
      await writeAudit({ userId: user.id, action: 'integration.square.connect_failed', entityType: 'integration_connection', data: { reason: err.reason } });
      return finish({ square_error: err.message });
    }
    throw err;
  }
});
