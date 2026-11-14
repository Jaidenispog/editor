import { AppError } from '@studio/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mapErrorToResponse } from '../src/lib/api-errors';
import { isSameOriginRequest } from '../src/lib/csrf';

describe('mapErrorToResponse', () => {
  it('maps AppError codes to their status and keeps details', () => {
    const m = mapErrorToResponse(new AppError('NOT_FOUND', 'That project could not be found.', { details: { id: 'x' } }), 'req-1');
    expect(m.status).toBe(404);
    expect(m.log).toBe(false);
    expect(m.body).toEqual({ error: { code: 'NOT_FOUND', message: 'That project could not be found.', details: { id: 'x' }, requestId: 'req-1' } });
  });

  it.each([
    ['VALIDATION', 400],
    ['UNAUTHORISED', 401],
    ['FORBIDDEN', 403],
    ['CONFLICT', 409],
    ['UNSUPPORTED', 422],
    ['RATE_LIMITED', 429],
    ['INTERNAL', 500],
  ] as const)('%s → %i', (code, status) => {
    expect(mapErrorToResponse(new AppError(code, 'x')).status).toBe(status);
  });

  it('turns zod errors into a 400 with per-field details', () => {
    const schema = z.object({ brand: z.object({ accentColour: z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a hex colour') }) });
    const result = schema.safeParse({ brand: { accentColour: 'gold' } });
    expect(result.success).toBe(false);
    const m = mapErrorToResponse(result.error);
    expect(m.status).toBe(400);
    expect(m.body.error.code).toBe('VALIDATION');
    expect(m.body.error.details).toEqual([{ path: 'brand.accentColour', message: 'Expected a hex colour' }]);
    expect(m.body.error.message).toContain('brand.accentColour');
  });

  it('hides unexpected errors behind a plain 500 and asks for them to be logged', () => {
    const m = mapErrorToResponse(new Error('connect ECONNREFUSED 127.0.0.1:5432'), 'req-2');
    expect(m.status).toBe(500);
    expect(m.log).toBe(true);
    expect(m.body.error.code).toBe('INTERNAL');
    expect(m.body.error.message).not.toContain('ECONNREFUSED');
    expect(m.body.error.requestId).toBe('req-2');
  });

  it('logs AppErrors that are server faults', () => {
    expect(mapErrorToResponse(new AppError('INTERNAL', 'Queue down')).log).toBe(true);
  });
});

describe('isSameOriginRequest (CSRF guard)', () => {
  const allowed = ['http://localhost:3000', 'https://studio.example.com'];
  it('lets safe methods through', () => {
    expect(isSameOriginRequest({ method: 'GET', origin: 'https://evil.example', secFetchSite: 'cross-site', allowedOrigins: allowed })).toBe(true);
  });
  it('accepts a matching Origin', () => {
    expect(isSameOriginRequest({ method: 'POST', origin: 'https://studio.example.com', secFetchSite: null, allowedOrigins: allowed })).toBe(true);
  });
  it('rejects a foreign Origin even if Sec-Fetch-Site claims same-origin', () => {
    expect(isSameOriginRequest({ method: 'DELETE', origin: 'https://evil.example', secFetchSite: 'same-origin', allowedOrigins: allowed })).toBe(false);
  });
  it('falls back to Sec-Fetch-Site when Origin is missing', () => {
    expect(isSameOriginRequest({ method: 'PUT', origin: null, secFetchSite: 'same-origin', allowedOrigins: allowed })).toBe(true);
    expect(isSameOriginRequest({ method: 'PUT', origin: null, secFetchSite: 'same-site', allowedOrigins: allowed })).toBe(false);
  });
  it('rejects requests with neither header, and the opaque "null" origin', () => {
    expect(isSameOriginRequest({ method: 'POST', origin: null, secFetchSite: null, allowedOrigins: allowed })).toBe(false);
    expect(isSameOriginRequest({ method: 'POST', origin: 'null', secFetchSite: null, allowedOrigins: allowed })).toBe(false);
  });
});
