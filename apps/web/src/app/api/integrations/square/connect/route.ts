import { NextResponse } from 'next/server';
import { AppError, SQUARE_TIER1_AVAILABLE, squareScopes } from '@studio/core';
import { handleApi, requireOwner } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { createOAuthState } from '@/lib/oauth-state';
import { SQUARE_OAUTH_PATH, buildSquareAuthUrl, squareAuthBase, squareRedirectUri } from '@/lib/square/oauth';

/**
 * GET /api/integrations/square/connect?access=read (owner): sends the owner to Square's authorise page (code flow)
 * with the read permissions only. The state is bound to this session in a 10-minute HttpOnly cookie. Write
 * permissions (`access=write`) are asked for only once booking changes exist (WP6b).
 */
export const GET = handleApi(async ({ req, user, session }) => {
  requireOwner(user);
  const env = getEnv();
  if (!env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Square is not set up on the server yet: SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET are needed.', { status: 409 });
  }
  const access = req.nextUrl.searchParams.get('access') ?? 'read';
  if (access !== 'read' && access !== 'write') throw new AppError('VALIDATION', 'Unknown access level.');
  if (access === 'write' && !SQUARE_TIER1_AVAILABLE) throw new AppError('UNSUPPORTED', 'Booking changes from Studio Assistant aren’t available yet, so only read access is requested.');
  const created = createOAuthState({ provider: 'square', sessionId: session.sessionId, cookiePath: SQUARE_OAUTH_PATH, extra: { access, environment: env.SQUARE_ENVIRONMENT } });
  const target = buildSquareAuthUrl({
    base: squareAuthBase(env, env.SQUARE_ENVIRONMENT),
    applicationId: env.SQUARE_APPLICATION_ID,
    scopes: squareScopes(access),
    state: created.state,
    redirectUri: squareRedirectUri(env.APP_URL),
  });
  const res = NextResponse.redirect(target, 302);
  res.cookies.set(created.cookie.name, created.cookie.value, created.cookie.options);
  await writeAudit({ userId: user.id, action: 'integration.square.connect_started', entityType: 'integration_connection', data: { environment: env.SQUARE_ENVIRONMENT, access } });
  return res;
});
