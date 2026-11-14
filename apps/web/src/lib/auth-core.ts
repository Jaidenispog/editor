import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** Argon2id parameters (OWASP baseline: 19 MiB memory, 2 iterations, 1 lane). */
export const ARGON2_OPTIONS = {
  algorithm: 2 as Algorithm, // Argon2id
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

/** Login throttling windows: block after 8 failures per email or 30 per IP address within 15 minutes. */
export const LOGIN_LIMITS = {
  windowMinutes: 15,
  maxFailuresPerEmail: 8,
  maxFailuresPerIp: 30,
};

/** Hashes a password with Argon2id. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Verifies a password against an Argon2 hash; malformed hashes count as a mismatch. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Spends the same effort as a real verification when the email is unknown, so response timing does not
 * reveal which addresses have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
}

/** 32 random bytes encoded as base64url: the raw session token that only ever lives in the cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) of a session token: the value stored as sessions.id. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Checks the shape of a cookie value before touching the database. */
export function isWellFormedSessionToken(token: string | undefined | null): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Decides whether a login should be refused, from recent failure counts. */
export function isLoginBlocked(failures: { byEmail: number; byIp: number }): boolean {
  return failures.byEmail >= LOGIN_LIMITS.maxFailuresPerEmail || failures.byIp >= LOGIN_LIMITS.maxFailuresPerIp;
}

/** Plain-language password rule check; returns a message for the owner or null when acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (password.trim().length === 0) return 'The password cannot be only spaces.';
  return null;
}
