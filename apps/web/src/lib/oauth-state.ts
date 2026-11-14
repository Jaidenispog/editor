import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@studio/db';
import type { NextResponse } from 'next/server';
import { getEncryptionKey } from './crypto.js';
import { getEnv } from './env.js';
import { shouldUseSecureCookies } from './shared/session-cookie.js';

/** How long an OAuth sign-in may take before its state expires. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Cookie holding one provider's pending OAuth state. */
export function oauthStateCookieName(provider: string): string {
  return `sa_oauth_${provider.replace(/[^a-z0-9_]/gi, '')}`;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** What a connect route passes in. */
export interface OAuthStateInput {
  /** Provider family, e.g. `google`, `meta`, `square`. One pending sign-in per provider at a time. */
  provider: string;
  /** The owner's session id; the callback must come back on the same session. */
  sessionId: string;
  /** Narrowest path that covers the callback, e.g. `/api/integrations/google`. */
  cookiePath: string;
  /** Create a PKCE verifier (S256) and return its challenge. */
  pkce?: boolean;
  /** Small non-secret values to carry to the callback (e.g. the Google product). Never trusted from the query. */
  extra?: Record<string, string>;
}

/** The state to send to the provider and the cookie to set on the redirect. */
export interface CreatedOAuthState {
  state: string;
  codeVerifier: string | null;
  codeChallenge: string | null;
  cookie: { name: string; value: string; options: { httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number } };
}

interface StatePayload {
  p: string;
  h: string;
  s: string;
  e: number;
  v: string | null;
  x: Record<string, string>;
}

/**
 * Creates a random `state` (and optionally a PKCE verifier) and the HttpOnly, SameSite=Lax, 10-minute cookie that
 * remembers it. The cookie is encrypted and authenticated with the app key (AES-256-GCM): it holds only
 * `sha256(state)`, the session id, the expiry, the verifier and `extra`, and any change makes it unreadable.
 */
export function createOAuthState(input: OAuthStateInput, options: { key?: Buffer; now?: Date; secure?: boolean } = {}): CreatedOAuthState {
  const key = options.key ?? getEncryptionKey();
  const now = options.now ?? new Date();
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = input.pkce ? randomBytes(48).toString('base64url') : null;
  const codeChallenge = codeVerifier ? sha256(codeVerifier).toString('base64url') : null;
  const payload: StatePayload = {
    p: input.provider,
    h: sha256(state).toString('base64url'),
    s: input.sessionId,
    e: now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000,
    v: codeVerifier,
    x: input.extra ?? {},
  };
  const secure = options.secure ?? (() => {
    const env = getEnv();
    return shouldUseSecureCookies(env.NODE_ENV, env.APP_URL);
  })();
  return {
    state,
    codeVerifier,
    codeChallenge,
    cookie: {
      name: oauthStateCookieName(input.provider),
      value: encryptSecret(JSON.stringify(payload), key),
      options: { httpOnly: true, sameSite: 'lax', secure, path: input.cookiePath, maxAge: OAUTH_STATE_TTL_SECONDS },
    },
  };
}

/** Why a callback's state was refused (shown to the owner as one plain message). */
export type OAuthStateFailure = 'missing' | 'tampered' | 'expired' | 'wrong_session' | 'mismatch';

/** Result of checking a callback against its cookie. */
export type ConsumedOAuthState = { ok: true; codeVerifier: string | null; extra: Record<string, string> } | { ok: false; reason: OAuthStateFailure };

/** Anything with request cookies (a NextRequest). */
interface CookieSource {
  cookies: { get(name: string): { value: string } | undefined };
}

/**
 * Checks a callback: the cookie must exist, decrypt, be for this provider, be unexpired, belong to the same session,
 * and its stored hash must equal `sha256(state)` (compared in constant time). The caller always clears the cookie
 * with {@link clearOAuthStateCookie}, whatever the result, so a state can be used only once.
 */
export function consumeOAuthState(
  req: CookieSource,
  provider: string,
  check: { state: string | null; sessionId: string },
  options: { key?: Buffer; now?: Date } = {},
): ConsumedOAuthState {
  const raw = req.cookies.get(oauthStateCookieName(provider))?.value;
  if (!raw) return { ok: false, reason: 'missing' };
  let payload: StatePayload;
  try {
    payload = JSON.parse(decryptSecret(raw, options.key ?? getEncryptionKey())) as StatePayload;
  } catch {
    return { ok: false, reason: 'tampered' };
  }
  if (payload.p !== provider) return { ok: false, reason: 'tampered' };
  if ((options.now ?? new Date()).getTime() > payload.e) return { ok: false, reason: 'expired' };
  const sessionMatches = timingSafeEqual(sha256(payload.s), sha256(check.sessionId));
  if (!sessionMatches) return { ok: false, reason: 'wrong_session' };
  if (!check.state) return { ok: false, reason: 'mismatch' };
  const expected = Buffer.from(payload.h, 'base64url');
  const actual = sha256(check.state);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: 'mismatch' };
  return { ok: true, codeVerifier: payload.v, extra: payload.x };
}

/** Removes the provider's state cookie on a response (call on every callback outcome). */
export function clearOAuthStateCookie(res: NextResponse, provider: string, cookiePath: string): void {
  res.cookies.set(oauthStateCookieName(provider), '', { httpOnly: true, sameSite: 'lax', path: cookiePath, maxAge: 0 });
}

/** Plain message for a refused callback. */
export function oauthStateMessage(reason: OAuthStateFailure): string {
  switch (reason) {
    case 'expired':
      return 'The sign-in took longer than 10 minutes. Please press Connect again.';
    case 'wrong_session':
      return 'The sign-in finished in a different session. Please press Connect again from this browser.';
    default:
      return 'The sign-in could not be confirmed. Please press Connect again.';
  }
}
