/**
 * Session cookie constants shared by the proxy (which only checks the cookie is present) and the server-side
 * session code (which validates it against the database). Kept free of Node-only imports.
 */
export const SESSION_COOKIE_NAME = 'sa_session';
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

/**
 * Cookies are marked Secure in production. A production build served over plain http (for example a local
 * docker test on http://localhost) keeps working because Secure cookies would never be sent back there.
 */
export function shouldUseSecureCookies(nodeEnv: string | undefined, appUrl: string | undefined): boolean {
  if (nodeEnv !== 'production') return false;
  if (!appUrl) return true;
  try {
    return new URL(appUrl).protocol === 'https:';
  } catch {
    return true;
  }
}

/** Attributes for the session cookie (HttpOnly, SameSite=Lax, path "/", 30-day expiry). */
export function sessionCookieAttributes(secure: boolean, maxAgeSeconds: number = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Returns a safe in-app path for post-login redirects: must start with a single "/" and never point at
 * another origin ("//evil.example", "/\\evil.example") or back at the auth pages.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next || typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  if (next === '/login' || next.startsWith('/login?') || next === '/setup' || next.startsWith('/api/')) return fallback;
  return next;
}
