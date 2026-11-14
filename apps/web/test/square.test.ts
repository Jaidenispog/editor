import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveEncryptionKey } from '@studio/db';
import { buildIntegrationStatuses } from '../src/lib/integrations';
import { defaultRefId } from '../src/lib/jobs';
import { consumeOAuthState, createOAuthState, oauthStateCookieName } from '../src/lib/oauth-state';
import { attendanceMarkAllowed } from '../src/lib/shared/square-dto';
import { buildSquareAuthUrl, squareRedirectUri } from '../src/lib/square/oauth';
import { squareNotificationUrl, squareSignature, verifySquareSignature } from '../src/lib/square/webhook';
import { WORDING_CASES } from './integration-wording-cases';

describe('Square webhook signature', () => {
  const key = 'sig-key-123';
  const url = 'https://studio.example.com.au/api/webhooks/square';
  const body = '{"merchant_id":"M1","type":"booking.created","event_id":"e1","data":{"id":"B1"}}';
  // Computed independently: base64(HMAC-SHA256(key, url + body)).
  const vector = createHmac('sha256', key).update(url + body).digest('base64');

  it('accepts the documented vector', () => {
    expect(squareSignature(key, url, body)).toBe(vector);
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body, signature: vector })).toBe(true);
  });
  it('refuses a different URL (a trailing slash matters), a tampered body, a wrong key and odd lengths without throwing', () => {
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: `${url}/`, rawBody: body, signature: vector })).toBe(false);
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body.replace('B1', 'B2'), signature: vector })).toBe(false);
    expect(verifySquareSignature({ signatureKey: 'other', notificationUrl: url, rawBody: body, signature: vector })).toBe(false);
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body, signature: 'short' })).toBe(false);
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body, signature: `${vector}xx` })).toBe(false);
    expect(verifySquareSignature({ signatureKey: key, notificationUrl: url, rawBody: body, signature: null })).toBe(false);
  });
  it('signs with the registered address, which an explicit setting overrides', () => {
    expect(squareNotificationUrl({ APP_URL: 'https://a.example/', SQUARE_WEBHOOK_NOTIFICATION_URL: undefined })).toBe('https://a.example/api/webhooks/square');
    expect(squareNotificationUrl({ APP_URL: 'https://a.example', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://hooks.example/square/' })).toBe('https://hooks.example/square/');
  });
});

describe('Square OAuth', () => {
  it('builds the code-flow authorise address with space-separated read scopes', () => {
    const u = new URL(buildSquareAuthUrl({ base: 'https://connect.squareupsandbox.com', applicationId: 'sq0idp-x', scopes: ['APPOINTMENTS_READ', 'CUSTOMERS_READ'], state: 'st', redirectUri: squareRedirectUri('https://studio.example/') }));
    expect(u.origin + u.pathname).toBe('https://connect.squareupsandbox.com/oauth2/authorize');
    expect(u.searchParams.get('scope')).toBe('APPOINTMENTS_READ CUSTOMERS_READ');
    expect(u.searchParams.get('session')).toBe('false');
    expect(u.searchParams.get('redirect_uri')).toBe('https://studio.example/api/integrations/square/callback');
    expect(u.searchParams.get('state')).toBe('st');
  });
  it('round-trips the state cookie for Square and refuses another session', () => {
    const key = deriveEncryptionKey('test-secret-test-secret-test-secret-0123');
    const now = new Date('2026-11-14T01:00:00Z');
    const s = createOAuthState({ provider: 'square', sessionId: 'sess-1', cookiePath: '/api/integrations/square', extra: { access: 'read', environment: 'sandbox' } }, { key, now, secure: false });
    const req = { cookies: { get: (n: string) => (n === oauthStateCookieName('square') ? { value: s.cookie.value } : undefined) } };
    expect(consumeOAuthState(req, 'square', { state: s.state, sessionId: 'sess-1' }, { key, now })).toEqual({ ok: true, codeVerifier: null, extra: { access: 'read', environment: 'sandbox' } });
    expect(consumeOAuthState(req, 'square', { state: s.state, sessionId: 'sess-2' }, { key, now })).toEqual({ ok: false, reason: 'wrong_session' });
    expect(consumeOAuthState(req, 'square', { state: 'forged', sessionId: 'sess-1' }, { key, now })).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('Square integration card wording', () => {
  const env = WORDING_CASES.find((c) => c.name === 'everything configured, nothing connected')?.env as never as Record<string, unknown>;
  const square = (e: Record<string, unknown>, connections: unknown[]) => buildIntegrationStatuses(e as never, { connections: connections as never, socialAccounts: [] }).find((i) => i.id === 'square');

  it('says what is missing without a "Needs setup:" prefix', () => {
    const s = square({ ...env, SQUARE_APPLICATION_ID: undefined, SQUARE_APPLICATION_SECRET: undefined }, []);
    expect(s).toMatchObject({ state: 'not_configured', liveMode: null, configured: false });
    expect(s?.message).toMatch(/^Add SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET/);
    expect(s?.message).not.toMatch(/^Needs setup/);
  });
  it('is ready to connect, then connected, and labels sandbox', () => {
    expect(square(env, [])).toMatchObject({ state: 'not_connected', liveMode: 'sandbox' });
    const c = square(env, [{ provider: 'square', status: 'connected', displayName: 'Ivanhoe Studio', config: { environment: 'sandbox' }, lastSyncAt: new Date() }]);
    expect(c).toMatchObject({ state: 'connected', connected: true, verified: false, detail: 'Ivanhoe Studio' });
    expect(c?.message).toMatch(/^Connected to Ivanhoe Studio\. Bookings sync from Square every 10 minutes/);
  });
  it('asks to reconnect after an environment switch, and shows sync errors', () => {
    const live = square({ ...env, SQUARE_ENVIRONMENT: 'production' }, [{ provider: 'square', status: 'connected', displayName: '', config: { environment: 'sandbox' } }]);
    expect(live).toMatchObject({ state: 'needs_reauth', liveMode: 'live' });
    expect(live?.message).toMatch(/now set to live Square/);
    const err = square(env, [{ provider: 'square', status: 'error', displayName: '', config: { environment: 'sandbox' }, lastError: 'Square sync failed: Square didn’t answer.' }]);
    expect(err?.state).toBe('error');
    expect(err?.message).toMatch(/tries again automatically/);
  });
});

describe('Square helpers', () => {
  const now = new Date('2026-11-14T06:00:00Z');
  it('allows attendance marks only on started ACCEPTED bookings', () => {
    expect(attendanceMarkAllowed('ACCEPTED', new Date(now.getTime() - 60_000), now)).toEqual({ allowed: true, reason: null });
    expect(attendanceMarkAllowed('ACCEPTED', new Date(now.getTime() + 60_000), now).allowed).toBe(false);
    expect(attendanceMarkAllowed('NO_SHOW', new Date(now.getTime() - 60_000), now)).toEqual({ allowed: false, reason: 'Square says this was a no-show. Change it in Square first.' });
    for (const s of ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'PENDING']) expect(attendanceMarkAllowed(s, new Date(0), now).allowed).toBe(false);
  });
  it('puts Square job progress on the right card', () => {
    expect(defaultRefId('square.availability', { searchId: 's1' })).toBe('s1');
    expect(defaultRefId('square.refresh', { entity: 'booking', squareId: 'B1' })).toBe('B1');
    expect(defaultRefId('square.sync', { reason: 'manual' })).toBeNull();
  });
});
