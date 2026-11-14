import 'server-only';
import { and, count, eq, gt, gte, lt, ne, sql } from 'drizzle-orm';
import { AppError, newId } from '@studio/core';
import { schema } from '@studio/db';
import {
  LOGIN_LIMITS,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  isLoginBlocked,
  isWellFormedSessionToken,
  passwordProblem,
  verifyAgainstDummy,
  verifyPassword,
} from './auth-core.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { SESSION_TTL_SECONDS } from './shared/session-cookie.js';

/** The signed-in person as exposed to pages and route handlers (never includes the password hash). */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'staff';
}

/** A session that passed validation. `sessionId` is the stored SHA-256 of the cookie token. */
export interface ValidatedSession {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
}

/** Where a request came from, recorded on sessions and login attempts. */
export interface RequestMeta {
  ipAddress: string;
  userAgent: string;
}

/** How often (at most) a session's expiry slides forward, to avoid a write on every request. */
const SLIDE_INTERVAL_MS = 60 * 60 * 1000;

function toSessionUser(row: { id: string; email: string; displayName: string; role: 'owner' | 'staff' }): SessionUser {
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role };
}

/** Extracts the client IP and user agent from request headers (first X-Forwarded-For hop wins). */
export function requestMetaFromHeaders(headers: Headers): RequestMeta {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || headers.get('x-real-ip')?.trim() || '';
  return { ipAddress: ip.slice(0, 64), userAgent: (headers.get('user-agent') ?? '').slice(0, 300) };
}

/** Creates a session row for the user and returns the raw token for the cookie (only its hash is stored). */
export async function createSession(userId: string, meta: RequestMeta): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await getDb().insert(schema.sessions).values({
    id: hashSessionToken(token),
    userId,
    expiresAt,
    lastSeenAt: new Date(),
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });
  return { token, expiresAt };
}

/**
 * Looks up the session for a cookie token. Returns null for unknown, expired or disabled-user sessions.
 * Active sessions slide forward to a fresh 30-day expiry (at most once an hour).
 */
export async function validateSession(token: string | undefined | null): Promise<ValidatedSession | null> {
  if (!isWellFormedSessionToken(token)) return null;
  const db = getDb();
  const id = hashSessionToken(token);
  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      expiresAt: schema.sessions.expiresAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      userId: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      role: schema.users.role,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return null;
  }
  if (row.disabledAt) return null;
  let expiresAt = row.expiresAt;
  if (now - row.lastSeenAt.getTime() > SLIDE_INTERVAL_MS) {
    expiresAt = new Date(now + SESSION_TTL_SECONDS * 1000);
    await db.update(schema.sessions).set({ lastSeenAt: new Date(now), expiresAt }).where(eq(schema.sessions.id, id));
  }
  return {
    sessionId: row.sessionId,
    expiresAt,
    user: toSessionUser({ id: row.userId, email: row.email, displayName: row.displayName, role: row.role }),
  };
}

/** Deletes the session belonging to a cookie token (logout). */
export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!isWellFormedSessionToken(token)) return;
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, hashSessionToken(token)));
}

/** Revokes one of the user's sessions by its stored id; returns false when it does not belong to them. */
export async function destroySessionById(userId: string, sessionId: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
    .returning({ id: schema.sessions.id });
  return deleted.length > 0;
}

/** Signs the user out everywhere except the given session (used after a password change). */
export async function destroyOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const deleted = await getDb()
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepSessionId)))
    .returning({ id: schema.sessions.id });
  return deleted.length;
}

/** Active sessions for the Users & security settings tab. */
export async function listUserSessions(userId: string) {
  return getDb()
    .select({
      id: schema.sessions.id,
      createdAt: schema.sessions.createdAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      expiresAt: schema.sessions.expiresAt,
      userAgent: schema.sessions.userAgent,
      ipAddress: schema.sessions.ipAddress,
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())))
    .orderBy(sql`${schema.sessions.lastSeenAt} desc`);
}

/** Number of accounts; zero means first-run setup is still open. */
export async function countUsers(): Promise<number> {
  const rows = await getDb().select({ n: count() }).from(schema.users);
  return Number(rows[0]?.n ?? 0);
}

async function recentFailures(emailLower: string, ipAddress: string): Promise<{ byEmail: number; byIp: number }> {
  const db = getDb();
  const since = new Date(Date.now() - LOGIN_LIMITS.windowMinutes * 60 * 1000);
  const [byEmail, byIp] = await Promise.all([
    db
      .select({ n: count() })
      .from(schema.loginAttempts)
      .where(and(eq(schema.loginAttempts.emailLower, emailLower), eq(schema.loginAttempts.succeeded, false), gte(schema.loginAttempts.createdAt, since))),
    ipAddress
      ? db
          .select({ n: count() })
          .from(schema.loginAttempts)
          .where(and(eq(schema.loginAttempts.ipAddress, ipAddress), eq(schema.loginAttempts.succeeded, false), gte(schema.loginAttempts.createdAt, since)))
      : Promise.resolve([{ n: 0 }]),
  ]);
  return { byEmail: Number(byEmail[0]?.n ?? 0), byIp: Number(byIp[0]?.n ?? 0) };
}

async function recordAttempt(emailLower: string, ipAddress: string, succeeded: boolean): Promise<void> {
  const db = getDb();
  await db.insert(schema.loginAttempts).values({ id: newId(), emailLower, ipAddress, succeeded });
  // Keep the table small: attempts older than a day are no longer useful for throttling.
  if (Math.random() < 0.05) {
    await db.delete(schema.loginAttempts).where(lt(schema.loginAttempts.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));
  }
}

/**
 * Checks an email/password pair with throttling. Throws RATE_LIMITED when too many recent failures exist and
 * UNAUTHORISED with a deliberately generic message when the details do not match.
 */
export async function authenticate(email: string, password: string, meta: RequestMeta): Promise<SessionUser> {
  const emailLower = email.trim().toLowerCase();
  const failures = await recentFailures(emailLower, meta.ipAddress);
  if (isLoginBlocked(failures)) {
    await writeAudit({ userId: null, action: 'auth.login_blocked', entityType: 'user', data: { email: emailLower, ip: meta.ipAddress } });
    throw new AppError('RATE_LIMITED', `Too many unsuccessful sign-in attempts. Please wait ${LOGIN_LIMITS.windowMinutes} minutes and try again.`);
  }
  const user = await getDb().query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${emailLower}` });
  if (!user) {
    await verifyAgainstDummy(password);
    await recordAttempt(emailLower, meta.ipAddress, false);
    throw new AppError('UNAUTHORISED', 'That email and password do not match an account.');
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok || user.disabledAt) {
    await recordAttempt(emailLower, meta.ipAddress, false);
    await writeAudit({ userId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, data: { ip: meta.ipAddress } });
    throw new AppError('UNAUTHORISED', user.disabledAt && ok ? 'This account has been switched off.' : 'That email and password do not match an account.');
  }
  await recordAttempt(emailLower, meta.ipAddress, true);
  await getDb().update(schema.users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  await writeAudit({ userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, data: { ip: meta.ipAddress } });
  return toSessionUser(user);
}

/**
 * Creates the first (owner) account. Serialised with a transaction-scoped advisory lock so two simultaneous
 * setup submissions cannot both succeed. Throws CONFLICT once any account exists.
 */
export async function createOwnerAccount(input: { email: string; password: string; displayName: string }): Promise<SessionUser> {
  const problem = passwordProblem(input.password);
  if (problem) throw new AppError('VALIDATION', problem, { details: { field: 'password' } });
  const passwordHash = await hashPassword(input.password);
  const user = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('studio-assistant-setup'))`);
    const existing = await tx.select({ n: count() }).from(schema.users);
    if (Number(existing[0]?.n ?? 0) > 0) {
      throw new AppError('CONFLICT', 'Setup has already been completed. Please sign in instead.');
    }
    const id = newId();
    const inserted = await tx
      .insert(schema.users)
      .values({ id, email: input.email.trim(), displayName: input.displayName.trim(), passwordHash, role: 'owner' })
      .returning();
    return inserted[0];
  });
  if (!user) throw new AppError('INTERNAL', 'The account could not be created.');
  await writeAudit({ userId: user.id, action: 'auth.setup', entityType: 'user', entityId: user.id });
  return toSessionUser(user);
}

/** Changes a password after checking the current one. Other sessions are signed out. */
export async function changePassword(userId: string, keepSessionId: string, currentPassword: string, newPassword: string): Promise<{ signedOutSessions: number }> {
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new AppError('NOT_FOUND', 'Your account could not be found.');
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError('VALIDATION', 'Your current password is not correct.', { details: { field: 'currentPassword' } });
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw new AppError('VALIDATION', problem, { details: { field: 'newPassword' } });
  if (currentPassword === newPassword) {
    throw new AppError('VALIDATION', 'Choose a password that is different from the current one.', { details: { field: 'newPassword' } });
  }
  await db.update(schema.users).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(schema.users.id, userId));
  const signedOutSessions = await destroyOtherSessions(userId, keepSessionId);
  await writeAudit({ userId, action: 'auth.password_changed', entityType: 'user', entityId: userId, data: { signedOutSessions } });
  return { signedOutSessions };
}
