import { createHash, randomBytes } from 'node:crypto';

/**
 * Link tokens for the permanent unsubscribe page (`/u/{token}`) and the tracked review link (`/r/{token}`): random
 * 32 bytes, base64url, stored only as SHA-256. They never expire and do not depend on `APP_SECRET`, so rotating
 * secrets cannot break the 30-day unsubscribe rule (design §10).
 */
export function newLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) of a link token: the only form stored in the database. */
export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The public URLs built from a token. */
export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/u/${token}`;
}
export function reviewRedirectUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/r/${token}`;
}
