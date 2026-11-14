import { NextResponse } from 'next/server';
import { handlePublicApi } from '@/lib/api';
import { clearSessionCookie, getCurrentSession } from '@/lib/session';
import { safeNextPath } from '@/lib/shared/session-cookie';

/**
 * GET /api/auth/session-expired?next=… — the app layout sends browsers here when their cookie no longer
 * matches a session. A stale cookie is cleared (so the proxy stops treating the browser as signed in) and the
 * browser goes to the sign-in page. A valid session is left alone.
 */
export const GET = handlePublicApi(async ({ req }) => {
  const next = safeNextPath(req.nextUrl.searchParams.get('next'));
  const session = await getCurrentSession();
  if (session) return NextResponse.redirect(new URL(next, req.nextUrl.origin), 303);
  await clearSessionCookie();
  const login = new URL('/login', req.nextUrl.origin);
  if (next !== '/') login.searchParams.set('next', next);
  login.searchParams.set('reason', 'expired');
  return NextResponse.redirect(login, 303);
});
