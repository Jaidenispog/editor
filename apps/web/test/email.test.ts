import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../src/lib/public-routes';
import { buildEmailIntegrations, placesCard, postmarkCard } from '../src/lib/integrations/email';
import { emailRefId } from '../src/lib/jobs/email';
import { checkPostmarkBasicAuth, postmarkExternalEventId } from '../src/lib/email';

/** Email module units with no database: webhook ids and credentials, the integration cards, ref ids, public paths. */
const env = (over: Record<string, unknown> = {}) => ({ EMAIL_PROVIDER: 'postmark', POSTMARK_SERVER_TOKEN: 't', EMAIL_FROM: 'Studio <hello@studio.example>', GOOGLE_MAPS_API_KEY: 'k', ...over }) as never;
const conn = (over: Record<string, unknown> = {}) => ({ provider: 'postmark', status: 'connected', displayName: 'Server', capabilities: { deliveryType: 'live', webhooksConfigured: true }, config: {}, lastError: null, lastSyncAt: new Date(), ...over });

describe('Postmark webhook ids', () => {
  it('are deterministic and never contain the raw address', () => {
    const raw = '{"RecordType":"Bounce","ID":4323372036854775807,"Email":"client@example.com","MessageID":"m1"}';
    expect(postmarkExternalEventId(raw, JSON.parse(raw)).id).toBe('bounce:4323372036854775807');
    const sc = { RecordType: 'SpamComplaint', ID: 42, Email: 'client@example.com' };
    expect(postmarkExternalEventId(JSON.stringify(sc), sc).id).toBe('complaint:42');
    const d = { RecordType: 'Delivery', MessageID: 'm1', Recipient: 'Client@Example.com' };
    const del = postmarkExternalEventId(JSON.stringify(d), d).id;
    expect(del).toMatch(/^delivery:m1:[0-9a-f]{16}$/);
    expect(del).not.toContain('example');
    expect(postmarkExternalEventId(JSON.stringify(d), { ...d, Recipient: 'client@example.com' }).id).toBe(del);
    const s = { RecordType: 'SubscriptionChange', MessageID: 'm1', Recipient: 'client@example.com', ChangedAt: '2026-11-14T00:00:00Z', SuppressSending: true };
    expect(postmarkExternalEventId(JSON.stringify(s), s).id).toMatch(/^subscription:m1:[0-9a-f]{16}:2026-11-14T00:00:00Z:true$/);
    const o = { RecordType: 'Open', MessageID: 'm1' };
    expect(postmarkExternalEventId(JSON.stringify(o), o).id).toMatch(/^other:[0-9a-f]{64}$/);
  });

  it('checks Basic credentials in constant time and says when none are configured', () => {
    const e = { POSTMARK_WEBHOOK_USERNAME: 'hook-user', POSTMARK_WEBHOOK_PASSWORD: 'a-long-random-password-for-the-hook' };
    const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
    expect(checkPostmarkBasicAuth(basic('hook-user:a-long-random-password-for-the-hook'), e)).toBe('ok');
    expect(checkPostmarkBasicAuth(basic('hook-user:wrong'), e)).toBe('bad');
    expect(checkPostmarkBasicAuth(null, e)).toBe('bad');
    expect(checkPostmarkBasicAuth('Bearer x', e)).toBe('bad');
    expect(checkPostmarkBasicAuth(basic('a:b'), {})).toBe('not_configured');
  });
});

describe('email integration cards', () => {
  it('cover every Postmark state without claiming anything that is not true', () => {
    expect(postmarkCard(env({ EMAIL_PROVIDER: 'none' }), undefined)).toMatchObject({ id: 'postmark', state: 'not_configured', missingEnv: ['EMAIL_PROVIDER'] });
    expect(postmarkCard(env({ EMAIL_PROVIDER: 'none', POSTMARK_SERVER_TOKEN: '', EMAIL_FROM: '' }), undefined).missingEnv).toEqual(['EMAIL_PROVIDER', 'POSTMARK_SERVER_TOKEN', 'EMAIL_FROM']);
    expect(postmarkCard(env(), undefined)).toMatchObject({ state: 'not_connected', stateLabel: 'Ready to check' });
    expect(postmarkCard(env(), conn({ status: 'needs_reauth' }))).toMatchObject({ state: 'needs_reauth' });
    expect(postmarkCard(env(), conn({ status: 'error', lastError: 'Postmark has no Broadcast stream' }))).toMatchObject({ state: 'error', message: 'Postmark has no Broadcast stream' });
    expect(postmarkCard(env(), conn({ capabilities: { deliveryType: 'live', approved: false } }))).toMatchObject({ state: 'awaiting_approval' });
    expect(postmarkCard(env(), conn({ capabilities: { deliveryType: 'sandbox', webhooksConfigured: true } }))).toMatchObject({ state: 'connected', liveMode: 'sandbox', stateLabel: 'Test server' });
    expect(postmarkCard(env(), conn({ capabilities: { deliveryType: 'live', webhooksConfigured: false } }))).toMatchObject({ state: 'connected', stateLabel: 'Webhooks missing' });
    expect(postmarkCard(env(), conn())).toMatchObject({ state: 'connected', liveMode: 'live', stateLabel: 'Live', verified: false });
    expect(postmarkCard(env(), conn({ capabilities: { deliveryType: 'live', webhooksConfigured: true, dmarcFound: false, returnPathFound: true } })).detail).toMatch(/From: Studio <hello@studio\.example> We couldn't find a DMARC record/);
    for (const c of [postmarkCard(env({ EMAIL_PROVIDER: 'none' }), undefined), postmarkCard(env(), conn())]) {
      expect(c.message).not.toMatch(/^Needs setup:/);
      expect(c.name).not.toMatch(/Resend/);
    }
  });

  it('cover every Google rating state', () => {
    expect(placesCard(env({ GOOGLE_MAPS_API_KEY: '' }), undefined)).toMatchObject({ id: 'google_places', state: 'not_configured' });
    expect(placesCard(env(), undefined)).toMatchObject({ state: 'not_connected' });
    expect(placesCard(env(), { ...conn({ provider: 'google_places' }), config: { placeId: 'ChIJxxxxxxxxxx' } })).toMatchObject({ state: 'not_connected', stateLabel: 'Confirm your place' });
    expect(placesCard(env(), { ...conn({ provider: 'google_places', status: 'error', lastError: 'Not found' }), config: { placeId: 'ChIJxxxxxxxxxx' } })).toMatchObject({ state: 'error' });
    expect(placesCard(env(), { ...conn({ provider: 'google_places' }), config: { placeId: 'ChIJxxxxxxxxxx', confirmed: true } })).toMatchObject({ state: 'connected', liveMode: 'read_only' });
    expect(buildEmailIntegrations(env(), { connections: [], socialAccounts: [] }).map((c) => c.id)).toEqual(['postmark', 'google_places']);
  });
});

describe('email jobs and public paths', () => {
  it('resolve ref ids like the worker', () => {
    expect(emailRefId('email.send', { emailMessageId: 'm' })).toBe('m');
    expect(emailRefId('email.campaign.expand', { campaignId: 'c' })).toBe('c');
    expect(emailRefId('email.dispatch', {})).toBeNull();
    expect(emailRefId('render.export', {})).toBeUndefined();
  });
  it('keep the webhook, unsubscribe and review-link paths public and the pages private', () => {
    for (const p of ['/api/webhooks/postmark', '/api/public/unsubscribe/abc', '/u/abc', '/r/abc']) expect(isPublicPath(p)).toBe(true);
    for (const p of ['/emails', '/reviews', '/api/email/messages', '/api/customers', '/api/reviews/requests']) expect(isPublicPath(p)).toBe(false);
  });
});
