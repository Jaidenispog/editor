import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath } from './lib/public-routes';
import { SESSION_COOKIE_NAME, sessionCookieAttributes, shouldUseSecureCookies } from './lib/shared/session-cookie';

/** Paths reachable without a session cookie (the list lives in lib/public-routes.ts). */
const isPublic = isPublicPath;

/**
 * Request interception (Next 16 "proxy"). Only checks whether the session cookie is present — the real
 * session validation happens in server code (app layout and API handlers):
 * - signed-out page requests go to /login?next=…; signed-out API requests get a JSON 401;
 * - /login with a cookie goes to the app;
 * - page navigations with a cookie refresh its 30-day lifetime (sliding expiry).
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const hasSession = Boolean(token);

  if (pathname === '/login' && hasSession && request.nextUrl.searchParams.get('reason') !== 'expired') {
    const next = request.nextUrl.searchParams.get('next');
    const target = next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
    return NextResponse.redirect(new URL(target, request.url));
  }

  if (isPublic(pathname)) return NextResponse.next();

  if (!hasSession) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { code: 'UNAUTHORISED', message: 'Please sign in again.' } }, { status: 401 });
    }
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  // Forward the requested path so the app layout can send an expired session back to the same page.
  const forwarded = new Headers(request.headers);
  forwarded.set('x-studio-pathname', `${pathname}${search}`);
  const res = NextResponse.next({ request: { headers: forwarded } });
  if (!pathname.startsWith('/api/') && request.method === 'GET' && token) {
    res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieAttributes(shouldUseSecureCookies(process.env.NODE_ENV, process.env.APP_URL)));
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt|woff2?)$).*)'],
};
