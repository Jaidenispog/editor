import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MediaLinkClaims {
  key: string;
  /** Unix seconds. */
  exp: number;
  downloadName?: string;
  contentType?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Compact signed token for the local storage driver: base64url(JSON claims) + "." + HMAC-SHA256.
 * The web app serves /api/media/<token> only when the signature verifies and the link has not expired.
 */
export function signMediaLink(claims: MediaLinkClaims, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = createHmac('sha256', secret).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}

export function verifyMediaLink(token: string, secret: string, now: number = Math.floor(Date.now() / 1000)): MediaLinkClaims | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: MediaLinkClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MediaLinkClaims;
  } catch {
    return null;
  }
  if (typeof claims.key !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp < now) return null;
  return claims;
}
