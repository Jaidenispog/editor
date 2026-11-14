import 'server-only';
import { AppError } from '@studio/core';
import type { NextRequest } from 'next/server';

/**
 * In-memory per-IP limit for the public routes (design §7.5): 60 a minute for `/r` and `/u`, 300 a minute for
 * webhooks. Per process only, which is enough for one small studio; it never logs addresses.
 */
const buckets = new Map<string, { windowStart: number; count: number }>();
const WINDOW_MS = 60_000;

/** The caller's IP as the proxy reports it (first `x-forwarded-for` entry), or a fixed key. */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd?.split(',')[0] ?? req.headers.get('x-real-ip') ?? 'unknown').trim().slice(0, 64);
}

/** Counts one request; throws RATE_LIMITED (429) when the caller went over `perMinute` in the current minute. */
export function enforcePublicRateLimit(req: NextRequest, scope: 'link' | 'webhook', perMinute = scope === 'webhook' ? 300 : 60, now: number = Date.now()): void {
  const key = `${scope}:${clientIp(req)}`;
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (now - v.windowStart >= WINDOW_MS) buckets.delete(k);
    }
    return;
  }
  b.count += 1;
  if (b.count > perMinute) throw new AppError('RATE_LIMITED', 'Too many requests. Please wait a minute and try again.');
}
