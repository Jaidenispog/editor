/**
 * Paths reachable without a session cookie, read by `proxy.ts`. Every public path in the Stage B/C designs is listed
 * here up front so later packages never edit this file. Each public route still protects itself: webhooks check
 * their provider's signature or credentials, unsubscribe and review links use unguessable tokens, and the legal
 * pages answer 404 until the owner publishes them.
 */

/** Exact public paths. */
export const PUBLIC_EXACT: ReadonlySet<string> = new Set([
  '/login',
  '/setup',
  '/api/setup',
  '/api/health',
  '/favicon.ico',
  '/robots.txt',
  // Owner-published legal pages (Meta Privacy Policy and User Data Deletion URLs, Google consent screen, Spotify embed).
  '/privacy',
  '/terms',
  '/data-deletion',
]);

/** Public path prefixes (each ends with a slash so `/r` alone or `/reviews` never matches). */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/api/auth/',
  '/api/media/',
  '/_next/',
  // Provider webhooks: Square (HMAC), Postmark (Basic credentials), Zernio (signature or stored as unverified).
  '/api/webhooks/',
  // One-click unsubscribe (RFC 8058 POST) and other token-protected public API calls.
  '/api/public/',
  // Review-link redirect /r/[token] and unsubscribe page /u/[token].
  '/r/',
  '/u/',
];

/** True when a path may be requested without signing in. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}
