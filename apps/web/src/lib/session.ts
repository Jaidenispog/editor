import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { validateSession, type SessionUser, type ValidatedSession } from './auth.js';
import { getEnv } from './env.js';
import { SESSION_COOKIE_NAME, sessionCookieAttributes, shouldUseSecureCookies } from './shared/session-cookie.js';

/** Raw session token from the request cookie, if any. */
export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

/**
 * The validated session for the current request (memoised per request with React `cache`, so layouts, pages
 * and handlers share one database lookup).
 */
export const getCurrentSession = cache(async (): Promise<ValidatedSession | null> => {
  const token = await getSessionToken();
  if (!token) return null;
  return validateSession(token);
});

/** The signed-in user for server components and route handlers, or null when signed out. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await getCurrentSession())?.user ?? null;
}

/** Writes the session cookie (route handlers and server actions only). */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const env = getEnv();
  const maxAge = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  (await cookies()).set(SESSION_COOKIE_NAME, token, sessionCookieAttributes(shouldUseSecureCookies(env.NODE_ENV, env.APP_URL), maxAge));
}

/** Removes the session cookie (route handlers and server actions only). */
export async function clearSessionCookie(): Promise<void> {
  const env = getEnv();
  (await cookies()).set(SESSION_COOKIE_NAME, '', sessionCookieAttributes(shouldUseSecureCookies(env.NODE_ENV, env.APP_URL), 0));
}
