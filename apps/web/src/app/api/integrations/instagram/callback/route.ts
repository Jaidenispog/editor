import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { clearOAuthStateCookie, consumeOAuthState, oauthStateMessage } from '@/lib/oauth-state';
import { META_OAUTH_PATH, MetaExchangeError, exchangeMetaCode, metaRedirectUri, queueSocialCheck, storeMetaConnection } from '@/lib/publishing';

/**
 * GET /api/integrations/instagram/callback?code&state (owner, same session). Checks the state cookie, does the single
 * code exchange inline (10 s, no retry), stores the token encrypted on the `meta` connection, audits, and queues the
 * read-only `social.check`. Every outcome returns to Settings → Integrations and clears the state cookie.
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
    clearOAuthStateCookie(res, 'meta', META_OAUTH_PATH);
    return res;
  };
  const checked = consumeOAuthState(req, 'meta', { state: q.get('state'), sessionId: session.sessionId });
  if (!checked.ok) return finish({ instagram_error: oauthStateMessage(checked.reason) });
  if (q.get('error')) {
    await writeAudit({ userId: user.id, action: 'integration.meta.connect_declined', entityType: 'integration_connection', data: { error: q.get('error')?.slice(0, 60) ?? '' } });
    return finish({ instagram_error: 'Instagram connection was cancelled.' });
  }
  const code = q.get('code');
  if (!code || !env.META_APP_ID || !env.META_APP_SECRET) return finish({ instagram_error: oauthStateMessage('mismatch') });
  try {
    const token = await exchangeMetaCode({ code, redirectUri: metaRedirectUri(env.APP_URL) });
    const connectionId = await storeMetaConnection(token);
    await writeAudit({ userId: user.id, action: 'integration.meta.connected', entityType: 'integration_connection', entityId: connectionId });
    try {
      await queueSocialCheck('connect', connectionId);
      return finish({ instagram: 'checking' });
    } catch (err) {
      // The token is stored; the daily check (or Check connection) picks the connection up.
      getLogger().warn({ err }, 'could not queue the first Instagram check');
      return finish({ instagram: 'connected' });
    }
  } catch (err) {
    if (err instanceof MetaExchangeError) {
      await writeAudit({ userId: user.id, action: 'integration.meta.connect_failed', entityType: 'integration_connection', data: { reason: err.reason } });
      return finish({ instagram_error: err.message });
    }
    throw err;
  }
});
