import { NextResponse } from 'next/server';
import { testOnlyBaseUrl } from '@studio/config';
import { AppError } from '@studio/core';
import { handleApi, requireOwner } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { createOAuthState } from '@/lib/oauth-state';
import { META_OAUTH_PATH, buildMetaAuthUrl, metaRedirectUri } from '@/lib/publishing';

/**
 * GET /api/integrations/instagram/connect (owner): sends the owner to Meta's Unified Login dialog with the
 * configuration id and no `scope` (memo §4). The state is bound to this session in a 10-minute HttpOnly cookie.
 */
export const GET = handleApi(async ({ user, session }) => {
  requireOwner(user);
  const env = getEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_LOGIN_CONFIG_ID) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Instagram direct publishing is not set up on the server yet: META_APP_ID, META_APP_SECRET and META_LOGIN_CONFIG_ID are needed.');
  }
  const created = createOAuthState({ provider: 'meta', sessionId: session.sessionId, cookiePath: META_OAUTH_PATH });
  const target = buildMetaAuthUrl({
    version: env.META_GRAPH_VERSION,
    appId: env.META_APP_ID,
    configId: env.META_LOGIN_CONFIG_ID,
    redirectUri: metaRedirectUri(env.APP_URL),
    state: created.state,
    // Null unless NODE_ENV=test, so a deployment always sends the owner to www.facebook.com.
    dialogBase: testOnlyBaseUrl(env, env.META_DIALOG_BASE_URL),
  });
  const res = NextResponse.redirect(target, 302);
  res.cookies.set(created.cookie.name, created.cookie.value, created.cookie.options);
  await writeAudit({ userId: user.id, action: 'integration.meta.connect_started', entityType: 'integration_connection' });
  return res;
});
