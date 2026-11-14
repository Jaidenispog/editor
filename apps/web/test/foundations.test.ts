import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { deriveEncryptionKey } from '@studio/db';
import { buildIntegrationStatuses } from '../src/lib/integrations';
import { integrationStateOf, liveModeLabel } from '../src/lib/shared/integration-types';
import { consumeOAuthState, createOAuthState, oauthStateCookieName, oauthStateMessage, OAUTH_STATE_TTL_SECONDS } from '../src/lib/oauth-state';
import { buildGoogleAuthUrl, exchangeGoogleCode, googleFollowUpJob, googleRedirectUri, parseGoogleProduct } from '../src/lib/google-oauth';
import { isPublicPath } from '../src/lib/public-routes';
import { readRawBody } from '../src/lib/webhooks';
import { defaultRefId } from '../src/lib/jobs';
import { statusLabel, toneForStatus } from '../src/components/ui/status-words';
import { WORDING_CASES } from './integration-wording-cases';

const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: { id: string; email: string; displayName: string; role: 'owner' | 'staff' }; expiresAt: Date } }));
vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));

const key = deriveEncryptionKey('test-secret-test-secret-test-secret-0123');

describe('integration statuses', () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/integration-statuses-stage-a.json', import.meta.url), 'utf8')) as Array<{ name: string; statuses: Array<Record<string, unknown>> }>;

  it.each(WORDING_CASES.map((c) => [c.name, c] as const))('keeps the Stage A wording for existing entries: %s', (name, c) => {
    const now = buildIntegrationStatuses(c.env as never, c.facts as never);
    const expected = before.find((b) => b.name === name)?.statuses ?? [];
    // Cards added by Stage B/C modules are new; every Stage A card must still read exactly as before.
    const legacy = now.filter((s) => expected.some((e) => e['id'] === s.id)).map(({ state: _s, liveMode: _l, verified: _v, ...rest }) => rest);
    expect(legacy).toEqual(expected);
  });

  it('adds the shared state, live mode and verification fields', () => {
    const connected = WORDING_CASES.find((c) => c.name === 'everything connected');
    const list = buildIntegrationStatuses(connected?.env as never, connected?.facts as never);
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(byId['square']).toMatchObject({ state: 'connected', liveMode: 'sandbox', verified: false });
    expect(byId['google_search_console']).toMatchObject({ state: 'connected', liveMode: 'read_only' });
    const reauth = WORDING_CASES.find((c) => c.name === 'square needs reauth');
    const r = buildIntegrationStatuses(reauth?.env as never, reauth?.facts as never);
    expect(r.find((s) => s.id === 'square')?.state).toBe('needs_reauth');
    const none = buildIntegrationStatuses(WORDING_CASES[0]?.env as never, WORDING_CASES[0]?.facts as never);
    expect(none.find((s) => s.id === 'instagram')?.state).toBe('not_configured');
    expect(none.every((s) => s.verified === false)).toBe(true);
  });

  it('refuses two cards with the same id', () => {
    const dup = () => [{ id: 'x', name: 'X', areas: [], configured: false, connected: false, message: '', missingEnv: [] }];
    expect(() => buildIntegrationStatuses(WORDING_CASES[0]?.env as never, { connections: [], socialAccounts: [] }, [dup, dup])).toThrow(/x/);
  });

  it('derives a state for cards without one and labels live modes plainly', () => {
    expect(integrationStateOf({ configured: false, connected: false })).toBe('not_configured');
    expect(integrationStateOf({ configured: true, connected: false })).toBe('not_connected');
    expect(integrationStateOf({ configured: true, connected: true })).toBe('connected');
    expect(integrationStateOf({ configured: true, connected: false, state: 'awaiting_approval' })).toBe('awaiting_approval');
    expect(liveModeLabel('sandbox')).toBe('Sandbox: test data only');
    expect(liveModeLabel(null)).toBeNull();
  });
});

describe('OAuth state cookie', () => {
  const now = new Date('2026-11-14T01:00:00Z');
  const make = () => createOAuthState({ provider: 'google', sessionId: 'session-a', cookiePath: '/api/integrations/google', pkce: true, extra: { product: 'search_console' } }, { key, now, secure: true });
  const reqWith = (value: string | undefined) => ({ cookies: { get: (name: string) => (name === oauthStateCookieName('google') && value !== undefined ? { value } : undefined) } });

  it('creates an HttpOnly, SameSite=Lax, 10-minute cookie that hides the state and verifier', () => {
    const s = make();
    expect(s.cookie.name).toBe('sa_oauth_google');
    expect(s.cookie.options).toEqual({ httpOnly: true, sameSite: 'lax', secure: true, path: '/api/integrations/google', maxAge: OAUTH_STATE_TTL_SECONDS });
    expect(s.cookie.value).not.toContain(s.state);
    expect(s.cookie.value).not.toContain(s.codeVerifier ?? 'x');
    expect(s.codeVerifier?.length).toBeGreaterThanOrEqual(43);
    expect(s.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts the matching state once per cookie and returns the verifier and extra values', () => {
    const s = make();
    const res = consumeOAuthState(reqWith(s.cookie.value), 'google', { state: s.state, sessionId: 'session-a' }, { key, now: new Date(now.getTime() + 60_000) });
    expect(res).toEqual({ ok: true, codeVerifier: s.codeVerifier, extra: { product: 'search_console' } });
  });

  it('refuses a missing, tampered, expired, wrong-session or mismatched state', () => {
    const s = make();
    const later = { key, now: new Date(now.getTime() + 60_000) };
    expect(consumeOAuthState(reqWith(undefined), 'google', { state: s.state, sessionId: 'session-a' }, later)).toEqual({ ok: false, reason: 'missing' });
    const flipped = `${s.cookie.value.slice(0, -3)}${s.cookie.value.slice(-3) === 'AAA' ? 'BBB' : 'AAA'}`;
    expect(consumeOAuthState(reqWith(flipped), 'google', { state: s.state, sessionId: 'session-a' }, later)).toEqual({ ok: false, reason: 'tampered' });
    expect(consumeOAuthState(reqWith(s.cookie.value), 'google', { state: s.state, sessionId: 'session-a' }, { key: deriveEncryptionKey('another-secret-another-secret-another-1') })).toEqual({ ok: false, reason: 'tampered' });
    expect(consumeOAuthState(reqWith(s.cookie.value), 'google', { state: s.state, sessionId: 'session-a' }, { key, now: new Date(now.getTime() + (OAUTH_STATE_TTL_SECONDS + 1) * 1000) })).toEqual({ ok: false, reason: 'expired' });
    expect(consumeOAuthState(reqWith(s.cookie.value), 'google', { state: s.state, sessionId: 'session-b' }, later)).toEqual({ ok: false, reason: 'wrong_session' });
    expect(consumeOAuthState(reqWith(s.cookie.value), 'google', { state: 'not-the-state', sessionId: 'session-a' }, later)).toEqual({ ok: false, reason: 'mismatch' });
    expect(consumeOAuthState(reqWith(s.cookie.value), 'google', { state: null, sessionId: 'session-a' }, later)).toEqual({ ok: false, reason: 'mismatch' });
    const other = createOAuthState({ provider: 'square', sessionId: 'session-a', cookiePath: '/x' }, { key, now, secure: false });
    expect(consumeOAuthState(reqWith(other.cookie.value), 'google', { state: other.state, sessionId: 'session-a' }, later)).toEqual({ ok: false, reason: 'tampered' });
    expect(oauthStateMessage('expired')).toMatch(/10 minutes/);
  });
});

describe('Google OAuth', () => {
  it('maps only the two known products; anything else is a 400', async () => {
    expect(parseGoogleProduct('business_profile')).toBe('business_profile');
    expect(parseGoogleProduct('search_console')).toBe('search_console');
    for (const bad of [null, '', 'gmail', 'BUSINESS_PROFILE', 'search_console ']) {
      expect(() => parseGoogleProduct(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION', status: 400 }));
    }
    auth.session = { sessionId: 's1', user: { id: 'u1', email: 'o@example.com', displayName: 'Owner', role: 'owner' }, expiresAt: new Date(Date.now() + 3600_000) };
    const route = await import('../src/app/api/integrations/google/connect/route');
    const res = await route.GET(new NextRequest('http://localhost:3000/api/integrations/google/connect?product=gmail'), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Business Profile or Google Search Console/);
    auth.session = { ...auth.session, user: { ...auth.session.user, role: 'staff' } };
    const staff = await route.GET(new NextRequest('http://localhost:3000/api/integrations/google/connect?product=search_console'), { params: Promise.resolve({}) });
    expect(staff.status).toBe(403);
  });

  it('asks Google for one product scope, offline access, fresh consent and PKCE', () => {
    const url = new URL(buildGoogleAuthUrl({ clientId: 'cid', redirectUri: googleRedirectUri('https://studio.example.com/'), product: 'search_console', state: 'st', codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://studio.example.com/api/integrations/google/callback',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code once and refuses answers without a refresh token or without the scope', async () => {
    const calls: string[] = [];
    const answer = (body: unknown, status = 200) =>
      (async (_u: unknown, init?: RequestInit) => {
        calls.push(String(init?.body));
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const base = { code: 'c0de', codeVerifier: 'v', clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://x/cb', product: 'business_profile' as const, now: new Date('2026-11-14T00:00:00Z') };
    const ok = await exchangeGoogleCode({ ...base, fetchImpl: answer({ access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: 'https://www.googleapis.com/auth/business.manage' }) });
    expect(ok).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date('2026-11-14T00:59:59Z'), scopes: ['https://www.googleapis.com/auth/business.manage'] });
    expect(calls[0]).toContain('grant_type=authorization_code');
    expect(calls[0]).toContain('code_verifier=v');
    await expect(exchangeGoogleCode({ ...base, fetchImpl: answer({ access_token: 'a', expires_in: 10, scope: 'https://www.googleapis.com/auth/business.manage' }) })).rejects.toMatchObject({ reason: 'no_refresh_token' });
    await expect(exchangeGoogleCode({ ...base, fetchImpl: answer({ access_token: 'a', refresh_token: 'r', scope: 'openid' }) })).rejects.toMatchObject({ reason: 'scope_missing' });
    await expect(exchangeGoogleCode({ ...base, fetchImpl: answer({ error: 'invalid_grant' }, 400) })).rejects.toMatchObject({ reason: 'rejected' });
  });

  it('enqueues no follow-up job while the owning module has not registered it', () => {
    expect(googleFollowUpJob('business_profile')).toBeNull();
    expect(googleFollowUpJob('search_console')).toBeNull();
  });
});

describe('public routes', () => {
  it('lists the webhook, unsubscribe, review-link and legal paths', () => {
    for (const p of ['/privacy', '/terms', '/data-deletion', '/api/webhooks/square', '/api/webhooks/postmark', '/api/webhooks/zernio', '/api/public/unsubscribe/abc', '/u/tok123', '/r/tok123', '/login', '/api/health', '/api/media/x']) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('keeps the app private', () => {
    for (const p of ['/', '/settings', '/settings/privacy', '/studio/p1', '/reviews', '/r', '/u', '/privacy/edit', '/api/settings', '/api/integrations/google/callback', '/api/integrations/google/connect', '/api/webhooks', '/api/publicity']) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it('lets signed-out visitors reach legal pages but not settings', async () => {
    const { proxy } = await import('../src/proxy');
    const legal = proxy(new NextRequest('http://localhost:3000/privacy'));
    expect(legal.headers.get('location')).toBeNull();
    const settings = proxy(new NextRequest('http://localhost:3000/settings'));
    expect(settings.status).toBe(307);
    expect(settings.headers.get('location')).toBe('http://localhost:3000/login?next=%2Fsettings');
    const api = proxy(new NextRequest('http://localhost:3000/api/settings'));
    expect(api.status).toBe(401);
    const hook = proxy(new NextRequest('http://localhost:3000/api/webhooks/square', { method: 'POST' }));
    expect(hook.status).toBe(200);
  });
});

describe('webhook bodies, ref ids and status words', () => {
  it('reads a raw body up to the limit and refuses larger ones with 413', async () => {
    expect(await readRawBody(new Request('http://x/', { method: 'POST', body: '{"a":1}' }), 100)).toBe('{"a":1}');
    await expect(readRawBody(new Request('http://x/', { method: 'POST', body: 'x'.repeat(101) }), 100)).rejects.toMatchObject({ status: 413 });
    await expect(readRawBody(new Request('http://x/', { method: 'POST', body: 'x', headers: { 'content-length': '999999' } }), 100)).rejects.toMatchObject({ status: 413 });
  });

  it('gives shared jobs a ref id', () => {
    expect(defaultRefId('webhook.process', { webhookEventId: 'w1' })).toBe('w1');
    expect(defaultRefId('google.disconnect', { connectionId: 'c1' })).toBe('c1');
    expect(defaultRefId('render.preview', { editVersionId: 'v1', projectId: 'p' })).toBe('v1');
  });

  it('labels and colours every Stage B/C status word', () => {
    const expected: Array<[string, string, string]> = [
      ['published', 'success', 'Published'],
      ['manual_step_required', 'warning', 'Action needed'],
      ['awaiting_approval', 'warning', 'Waiting for Google'],
      ['pending_approval', 'warning', 'Waiting for approval'],
      ['complained', 'danger', 'Spam complaint'],
      ['suppressed', 'warning', 'Not sent'],
      ['sending', 'info', 'Sending'],
      ['delivered', 'success', 'Delivered'],
      ['bounced', 'danger', 'Bounced'],
      ['skipped', 'neutral', 'Skipped'],
      ['scheduled', 'neutral', 'Scheduled'],
      ['apply_failed', 'danger', 'Not applied'],
      ['superseded', 'neutral', 'Out of date'],
      ['applied', 'success', 'Done'],
      ['critical', 'danger', 'Urgent'],
      ['high', 'warning', 'Important'],
      ['medium', 'info', 'Worth doing'],
      ['low', 'neutral', 'Minor'],
      ['not_configured', 'warning', 'Needs setup'],
      ['not_connected', 'neutral', 'Not connected'],
      ['unavailable', 'warning', 'Not available'],
      ['disconnected', 'neutral', 'Disconnected'],
      ['CANCELLED_BY_CUSTOMER', 'warning', 'Cancelled by client'],
      ['NO_SHOW', 'danger', 'No-show'],
      ['payment_matched', 'success', 'Paid (matched)'],
      ['no_payment_matched', 'warning', 'No payment found'],
      ['check_before_retry', 'warning', 'Check before retrying'],
      ['quota', 'warning', 'Daily limit reached'],
      ['preview_ready', 'success', 'Preview ready'],
      ['queued', 'neutral', 'Queued'],
    ];
    for (const [status, tone, label] of expected) {
      expect(toneForStatus(status), status).toBe(tone);
      expect(statusLabel(status), status).toBe(label);
    }
    expect(toneForStatus('toString')).toBe('neutral');
    expect(statusLabel('something_new')).toBe('Something new');
  });
});
