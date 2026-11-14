import { NextResponse } from 'next/server';
import { AppError, GOOGLE_OAUTH_PRODUCTS } from '@studio/core';
import { handleApi, requireOwner } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { GOOGLE_OAUTH_PATH, buildGoogleAuthUrl, googleRedirectUri, parseGoogleProduct } from '@/lib/google-oauth';
import { createOAuthState } from '@/lib/oauth-state';

/**
 * GET /api/integrations/google/connect?product=business_profile|search_console (owner).
 * Sends the owner to Google's consent screen for that one product's scope. The product travels in the encrypted
 * state cookie, never trusted from the callback's query.
 */
export const GET = handleApi(async ({ req, user, session }) => {
  requireOwner(user);
  const product = parseGoogleProduct(req.nextUrl.searchParams.get('product'));
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Google sign-in is not set up on the server yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are needed.');
  }
  const created = createOAuthState({ provider: 'google', sessionId: session.sessionId, cookiePath: GOOGLE_OAUTH_PATH, pkce: true, extra: { product } });
  const target = buildGoogleAuthUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: googleRedirectUri(env.APP_URL),
    product,
    state: created.state,
    codeChallenge: created.codeChallenge ?? '',
  });
  const res = NextResponse.redirect(target, 302);
  res.cookies.set(created.cookie.name, created.cookie.value, created.cookie.options);
  await writeAudit({ userId: user.id, action: `integration.${GOOGLE_OAUTH_PRODUCTS[product].provider}.connect_started`, entityType: 'integration_connection', data: { product } });
  return res;
});
