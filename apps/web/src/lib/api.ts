import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@studio/core';
import type { z } from 'zod';
import { mapErrorToResponse } from './api-errors.js';
import type { SessionUser, ValidatedSession } from './auth.js';
import { isSameOriginRequest } from './csrf.js';
import { getEnv } from './env.js';
import { getLogger } from './logger.js';
import { getCurrentSession } from './session.js';

/** Everything a protected handler receives. */
export interface ApiContext<P> {
  req: NextRequest;
  params: P;
  user: SessionUser;
  session: ValidatedSession;
  requestId: string;
}

/** Context for public handlers (login, setup, health, media); the user may be absent. */
export interface PublicApiContext<P> {
  req: NextRequest;
  params: P;
  requestId: string;
}

/** Shape of the second argument Next passes to route handlers. */
export interface RouteContext<P> {
  params: Promise<P>;
}

type RouteFn<P> = (req: NextRequest, context: RouteContext<P>) => Promise<Response>;

function requestIdFor(req: NextRequest): string {
  const given = req.headers.get('x-request-id');
  return given && /^[A-Za-z0-9._-]{8,80}$/.test(given) ? given : randomUUID();
}

function allowedOrigins(req: NextRequest): string[] {
  const origins = [req.nextUrl.origin];
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) {
    const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
    origins.push(`${proto}://${host}`);
  }
  try {
    origins.push(getEnv().APP_URL);
  } catch {
    // Environment problems surface elsewhere with a clear message; the request origin is still checked.
  }
  return origins;
}

/** Throws FORBIDDEN unless a state-changing request comes from the app's own origin. */
export function assertSameOrigin(req: NextRequest): void {
  const ok = isSameOriginRequest({
    method: req.method,
    origin: req.headers.get('origin'),
    secFetchSite: req.headers.get('sec-fetch-site'),
    allowedOrigins: allowedOrigins(req),
  });
  if (!ok) throw new AppError('FORBIDDEN', 'This request did not come from the Studio Assistant app, so it was blocked for your safety.');
}

/** Returns the current session or throws UNAUTHORISED (for use inside handlers). */
export async function requireSession(): Promise<ValidatedSession> {
  const session = await getCurrentSession();
  if (!session) throw new AppError('UNAUTHORISED', 'Please sign in again.');
  return session;
}

/** Returns the signed-in user or throws UNAUTHORISED. */
export async function requireUser(): Promise<SessionUser> {
  return (await requireSession()).user;
}

/** Throws FORBIDDEN unless the signed-in user is the owner. */
export function requireOwner(user: SessionUser): void {
  if (user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the studio owner can change this.');
}

/** Reads and validates a JSON body against a zod schema; malformed JSON becomes a 400. */
export async function parseJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.length ? JSON.parse(text) : {};
  } catch {
    throw new AppError('VALIDATION', 'The request body was not valid JSON.');
  }
  return schema.parse(raw) as z.infer<S>;
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result === undefined) return new NextResponse(null, { status: 204 });
  return NextResponse.json(result);
}

async function run<P>(req: NextRequest, requestId: string, work: () => Promise<unknown>): Promise<Response> {
  try {
    const res = toResponse(await work());
    res.headers.set('x-request-id', requestId);
    if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');
    return res;
  } catch (err) {
    const mapped = mapErrorToResponse(err, requestId);
    if (mapped.log) getLogger().error({ err, requestId, method: req.method, path: req.nextUrl.pathname }, 'API request failed');
    return NextResponse.json(mapped.body, { status: mapped.status, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } });
  }
}

/**
 * Wraps a protected route handler: requires a valid session, applies the CSRF guard to state-changing
 * methods, resolves params, and maps errors to the standard JSON envelope. Returning a plain value sends it
 * as JSON; returning undefined sends 204; returning a Response sends it unchanged.
 */
export function handleApi<P = Record<string, never>>(handler: (ctx: ApiContext<P>) => Promise<unknown>): RouteFn<P> {
  return async (req, context) => {
    const requestId = requestIdFor(req);
    return run(req, requestId, async () => {
      assertSameOrigin(req);
      const session = await requireSession();
      const params = await context.params;
      return handler({ req, params, user: session.user, session, requestId });
    });
  };
}

/** Same as handleApi but without the session requirement (login, setup, health, signed media). */
export function handlePublicApi<P = Record<string, never>>(
  handler: (ctx: PublicApiContext<P>) => Promise<unknown>,
  options: { csrf?: boolean } = {},
): RouteFn<P> {
  return async (req, context) => {
    const requestId = requestIdFor(req);
    return run(req, requestId, async () => {
      if (options.csrf !== false) assertSameOrigin(req);
      const params = await context.params;
      return handler({ req, params, requestId });
    });
  };
}
