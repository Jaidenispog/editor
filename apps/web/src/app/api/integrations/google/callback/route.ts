import { NextResponse } from 'next/server';
import { GOOGLE_OAUTH_PRODUCTS, GoogleProductSchema, isJobType } from '@studio/core';
import { handleApi, requireOwner } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { GOOGLE_OAUTH_PATH, GoogleExchangeError, exchangeGoogleCode, googleExchangeMessage, googleFollowUpJob, googleRedirectUri, storeGoogleConnection } from '@/lib/google-oauth';
import { createTrackedJob } from '@/lib/jobs';
import { getLogger } from '@/lib/logger';
import { clearOAuthStateCookie, consumeOAuthState, oauthStateMessage } from '@/lib/oauth-state';

/** Settings → Integrations, with a short outcome the page can show. */
function backToSettings(appUrl: string, params: Record<string, string>): NextResponse {
  const url = new URL('/settings', appUrl);
  url.searchParams.set('tab', 'integrations');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 302);
}

/**
 * GET /api/integrations/google/callback?code=…&state=… (owner, same session that started it).
 * Checks the state cookie, does the single code exchange inline (10 s, no retry), stores the tokens encrypted in the
 * product's own connection row, audits, and queues the product's read-only check when its module has registered it.
 * Every outcome returns to Settings → Integrations with a plain message, and the state cookie is always cleared.
 */
export const GET = handleApi(async ({ req, user, session }) => {
  requireOwner(user);
  const env = getEnv();
  const q = req.nextUrl.searchParams;
  const checked = consumeOAuthState(req, 'google', { state: q.get('state'), sessionId: session.sessionId });
  const finish = (params: Record<string, string>) => {
    const res = backToSettings(env.APP_URL, params);
    clearOAuthStateCookie(res, 'google', GOOGLE_OAUTH_PATH);
    return res;
  };
  if (!checked.ok) return finish({ google_error: oauthStateMessage(checked.reason) });
  const product = GoogleProductSchema.safeParse(checked.extra['product']);
  if (!product.success) return finish({ google_error: oauthStateMessage('tampered') });
  const def = GOOGLE_OAUTH_PRODUCTS[product.data];
  if (q.get('error')) {
    await writeAudit({ userId: user.id, action: `integration.${def.provider}.connect_declined`, entityType: 'integration_connection', data: { error: q.get('error')?.slice(0, 60) ?? '' } });
    return finish({ google_error: `${def.label} was not connected because access was not allowed on Google's page.` });
  }
  const code = q.get('code');
  if (!code || !checked.codeVerifier || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return finish({ google_error: oauthStateMessage('mismatch') });

  try {
    const tokens = await exchangeGoogleCode({
      code,
      codeVerifier: checked.codeVerifier,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: googleRedirectUri(env.APP_URL),
      product: product.data,
    });
    const { connectionId, provider } = await storeGoogleConnection(getDb(), product.data, tokens);
    await writeAudit({ userId: user.id, action: `integration.${provider}.connected`, entityType: 'integration_connection', entityId: connectionId, data: { scopes: tokens.scopes } });
    const followUp = googleFollowUpJob(product.data);
    if (followUp && isJobType(followUp.type)) {
      try {
        await createTrackedJob({ type: followUp.type, payload: followUp.payload as never, projectId: null, singletonKey: `${followUp.type}:connect` });
        return finish({ checking: product.data });
      } catch (err) {
        // The tokens are stored; the module's own daily check will pick the connection up.
        getLogger().warn({ err, product: product.data }, 'could not queue the first Google check');
      }
    }
    return finish({ connected: product.data });
  } catch (err) {
    if (err instanceof GoogleExchangeError) {
      await writeAudit({ userId: user.id, action: `integration.${def.provider}.connect_failed`, entityType: 'integration_connection', data: { reason: err.reason } });
      return finish({ google_error: googleExchangeMessage(err) });
    }
    throw err;
  }
});
