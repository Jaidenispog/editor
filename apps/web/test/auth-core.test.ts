import { NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  isLoginBlocked,
  isWellFormedSessionToken,
  LOGIN_LIMITS,
  passwordProblem,
  verifyPassword,
} from '../src/lib/auth-core';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, safeNextPath, sessionCookieAttributes, shouldUseSecureCookies } from '../src/lib/shared/session-cookie';

describe('password hashing', () => {
  it('hashes with Argon2id and verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=19456,t=2,p=1');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery')).toBe(false);
  });

  it('produces a different salt each time', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here'), hashPassword('same password here')]);
    expect(a).not.toBe(b);
  });

  it('treats a malformed hash as a mismatch instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('explains weak passwords in plain language', () => {
    expect(passwordProblem('short')).toMatch(/at least 10/);
    expect(passwordProblem('          ')).toMatch(/spaces/);
    expect(passwordProblem('a long enough password')).toBeNull();
  });
});

describe('session tokens', () => {
  it('are 32 random bytes in base64url and unique', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateSessionToken()));
    expect(tokens.size).toBe(50);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(t, 'base64url')).toHaveLength(32);
      expect(isWellFormedSessionToken(t)).toBe(true);
    }
  });

  it('store only a SHA-256 hash that is stable for the same token', () => {
    const t = generateSessionToken();
    expect(hashSessionToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
    expect(hashSessionToken(t)).not.toBe(hashSessionToken(generateSessionToken()));
  });

  it('rejects malformed cookie values before any database lookup', () => {
    expect(isWellFormedSessionToken(undefined)).toBe(false);
    expect(isWellFormedSessionToken('')).toBe(false);
    expect(isWellFormedSessionToken('abc')).toBe(false);
    expect(isWellFormedSessionToken(`${'a'.repeat(42)}=`)).toBe(false);
  });

  it('round-trips through the Set-Cookie header with the expected attributes', () => {
    const token = generateSessionToken();
    const res = new NextResponse(null);
    res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieAttributes(true));
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toContain(`${SESSION_COOKIE_NAME}=${token}`);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    const parsed = /sa_session=([^;]+)/.exec(header)?.[1];
    expect(parsed).toBe(token);
    expect(hashSessionToken(parsed ?? '')).toBe(hashSessionToken(token));
  });

  it('omits Secure outside production and on plain-http production URLs', () => {
    expect(shouldUseSecureCookies('development', 'https://studio.example.com')).toBe(false);
    expect(shouldUseSecureCookies('production', 'https://studio.example.com')).toBe(true);
    expect(shouldUseSecureCookies('production', 'http://localhost:3000')).toBe(false);
    expect(shouldUseSecureCookies('production', undefined)).toBe(true);
  });
});

describe('login throttling', () => {
  it('blocks after 8 failures per email or 30 per IP', () => {
    expect(isLoginBlocked({ byEmail: LOGIN_LIMITS.maxFailuresPerEmail - 1, byIp: 0 })).toBe(false);
    expect(isLoginBlocked({ byEmail: 8, byIp: 0 })).toBe(true);
    expect(isLoginBlocked({ byEmail: 0, byIp: 29 })).toBe(false);
    expect(isLoginBlocked({ byEmail: 0, byIp: 30 })).toBe(true);
  });
});

describe('post-login redirect', () => {
  it('only allows in-app paths', () => {
    expect(safeNextPath('/studio/abc?x=1')).toBe('/studio/abc?x=1');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('/login?next=/x')).toBe('/');
    expect(safeNextPath('/api/settings')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
  });
});
