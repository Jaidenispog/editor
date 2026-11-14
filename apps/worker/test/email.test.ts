/**
 * Email module units with no database and no network: Postmark's response mapping, webhook parsing (fixtures in
 * test/fixtures/postmark/), the provider against a fake fetch (check, send, findSent, suppress), DNS hints, the Places
 * error mapping and the module's registrations. No real Postmark or Google call is ever made.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ALL_JOB_TYPES } from '@studio/core';
import { QUEUE_SETTINGS } from '@studio/queue';
import { POSTMARK_API_BASE, PostmarkProvider, mapSendResponse, parsePostmarkWebhook } from '../src/lib/email/postmark.js';
import { createEmailProvider } from '../src/lib/email/provider.js';
import { hashLinkToken, newLinkToken } from '../src/lib/email/tokens.js';
import { dnsHints } from '../src/handlers/email-check.js';
import { placesErrorFor } from '../src/lib/google/places.js';
import { emailModule } from '../src/modules/email/index.js';
import { fakeFetch, json } from './helpers/fakes.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'postmark', `${name}.json`), 'utf8'));
const logger = pino({ level: 'silent' });
const settings = { token: 'server-token', from: 'Studio <hello@studio.example>', transactionalStream: 'outbound', broadcastStream: 'broadcast' };
const signal = new AbortController().signal;

describe('Postmark send responses (design §8.1.1)', () => {
  it.each([
    [200, { ErrorCode: 0, MessageID: 'abc', SubmittedAt: '2026-11-14T00:00:00Z' }, 'ok'],
    [422, { ErrorCode: 406, Message: 'Inactive recipient' }, 'inactive_recipient'],
    [422, { ErrorCode: 300, Message: 'Invalid email request' }, 'invalid_recipient'],
    [422, { ErrorCode: 400, Message: 'Sender signature not found' }, 'sender_not_verified'],
    [422, { ErrorCode: 401, Message: 'Sender signature not confirmed' }, 'sender_not_verified'],
    [401, { ErrorCode: 10, Message: 'Bad or missing server token' }, 'auth'],
    [412, { ErrorCode: 412, Message: 'Account pending approval' }, 'pending_approval'],
    [429, { ErrorCode: 429, Message: 'Rate limit' }, 'transient'],
    [500, null, 'transient'],
    [503, null, 'transient'],
    [422, { ErrorCode: 1234, Message: 'Something else' }, 'rejected'],
  ] as const)('HTTP %i %j → %s', (status, body, kind) => {
    const r = mapSendResponse(status, body as Record<string, unknown> | null);
    expect(r.ok ? 'ok' : r.kind).toBe(kind);
  });

  it('keeps unknown codes verbatim', () => {
    const r = mapSendResponse(422, { ErrorCode: 1234, Message: 'Something else' });
    expect(r).toMatchObject({ ok: false, code: '1234', message: 'Something else' });
  });
});

describe('Postmark webhook parsing', () => {
  it('normalises each record type', () => {
    expect(parsePostmarkWebhook(fixture('delivery'))[0]).toMatchObject({ type: 'delivered', email: 'client@example.com', providerMessageId: '883953f4-6105-42a2-a16a-77a8eac79483', stream: 'broadcast' });
    expect(parsePostmarkWebhook(fixture('bounce-hard'))[0]).toMatchObject({ type: 'bounced', hard: true, suppressionReason: 'HardBounce' });
    expect(parsePostmarkWebhook(fixture('bounce-soft'))[0]).toMatchObject({ type: 'bounced', hard: false, suppressionReason: 'SoftBounce' });
    expect(parsePostmarkWebhook(fixture('spam-complaint'))[0]).toMatchObject({ type: 'complained', hard: true });
    expect(parsePostmarkWebhook(fixture('subscription-unsubscribe'))[0]).toMatchObject({ type: 'subscription_change', suppressSending: true, suppressionReason: 'ManualSuppression' });
    expect(parsePostmarkWebhook(fixture('subscription-reactivate'))[0]).toMatchObject({ type: 'subscription_change', suppressSending: false });
    expect(parsePostmarkWebhook(fixture('open'))[0]).toMatchObject({ type: 'ignored' });
    expect(parsePostmarkWebhook('nonsense')).toEqual([]);
  });
});

describe('PostmarkProvider against a fake fetch', () => {
  it('sends with the server token, the right stream and no tracking', async () => {
    const f = fakeFetch(() => json(200, { ErrorCode: 0, MessageID: 'pm-1', SubmittedAt: '2026-11-14T00:00:00Z', To: 'client@example.com' }));
    const p = new PostmarkProvider({ fetch: f, logger }, settings);
    const r = await p.send({ emailMessageId: 'm1', to: 'client@example.com', from: settings.from, replyTo: 'hello@studio.example', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', stream: 'broadcast', tag: 'campaign', metadata: { emailMessageId: 'm1' } }, signal);
    expect(r).toEqual({ ok: true, providerMessageId: 'pm-1', submittedAt: '2026-11-14T00:00:00Z' });
    expect(f.calls[0]?.url).toBe(`${POSTMARK_API_BASE}/email`);
    expect(f.calls[0]?.headers['x-postmark-server-token']).toBe('server-token');
    const body = JSON.parse(f.calls[0]?.body ?? '{}');
    expect(body).toMatchObject({ MessageStream: 'broadcast', TrackOpens: false, TrackLinks: 'None', Metadata: { emailMessageId: 'm1' } });
  });

  it('treats a network failure after the request as an unknown outcome (never as "not sent")', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('socket hang up');
    });
    const p = new PostmarkProvider({ fetch: f, logger }, settings);
    const r = await p.send({ emailMessageId: 'm1', to: 'a@example.com', from: settings.from, replyTo: null, subject: 'x', html: 'x', text: 'x', stream: 'transactional', tag: 't', metadata: {} }, signal);
    expect(r).toMatchObject({ ok: false, kind: 'unknown_outcome' });
  });

  it('finds an earlier send by metadata and treats several matches as "not sure"', async () => {
    const one = fakeFetch(() => json(200, { TotalCount: 1, Messages: [{ MessageID: 'pm-9' }] }));
    expect(await new PostmarkProvider({ fetch: one, logger }, settings).findSent('m1', 'a@example.com', signal)).toBe('pm-9');
    expect(one.calls[0]?.url).toContain('metadata_emailMessageId=m1');
    const none = fakeFetch(() => json(200, { TotalCount: 0, Messages: [] }));
    expect(await new PostmarkProvider({ fetch: none, logger }, settings).findSent('m1', 'a@example.com', signal)).toBeNull();
    const two = fakeFetch(() => json(200, { TotalCount: 2, Messages: [{ MessageID: 'a' }, { MessageID: 'b' }] }));
    expect(await new PostmarkProvider({ fetch: two, logger }, settings).findSent('m1', 'a@example.com', signal)).toBeNull();
  });

  it('checks server, streams and webhooks read-only (GET only) and reports each state', async () => {
    const hook = (url: string) => ({ Url: url, Triggers: { Delivery: { Enabled: true }, Bounce: { Enabled: true }, SpamComplaint: { Enabled: true }, SubscriptionChange: { Enabled: true } } });
    const streams = { MessageStreams: [{ ID: 'outbound', MessageStreamType: 'Transactional' }, { ID: 'broadcast', MessageStreamType: 'Broadcasts' }] };
    const ok = fakeFetch((c) => {
      if (c.url.endsWith('/server')) return json(200, { Name: 'Studio Assistant', DeliveryType: 'Sandbox' });
      if (c.url.endsWith('/message-streams')) return json(200, streams);
      return json(200, { Webhooks: [hook('https://app.example/api/webhooks/postmark')] });
    });
    const r = await new PostmarkProvider({ fetch: ok, logger }, settings).check(signal);
    expect(r).toMatchObject({ state: 'connected', deliveryType: 'sandbox', streams: { transactional: true, broadcast: true }, webhooks: { configured: true } });
    expect(ok.calls.every((c) => c.method === 'GET')).toBe(true);

    const noHooks = fakeFetch((c) => (c.url.endsWith('/server') ? json(200, { Name: 'S', DeliveryType: 'Live' }) : c.url.endsWith('/message-streams') ? json(200, streams) : json(200, { Webhooks: [] })));
    expect(await new PostmarkProvider({ fetch: noHooks, logger }, settings).check(signal)).toMatchObject({ state: 'needs_attention', deliveryType: 'live', webhooks: { configured: false } });

    const hidden = fakeFetch((c) => (c.url.endsWith('/server') ? json(200, { Name: 'S' }) : c.url.endsWith('/message-streams') ? json(200, streams) : json(403, { ErrorCode: 10 })));
    expect(await new PostmarkProvider({ fetch: hidden, logger }, settings).check(signal)).toMatchObject({ state: 'connected', deliveryType: 'unknown', webhooks: { configured: null } });

    const badToken = fakeFetch(() => json(401, { ErrorCode: 10, Message: 'Bad token' }));
    expect(await new PostmarkProvider({ fetch: badToken, logger }, settings).check(signal)).toMatchObject({ state: 'needs_reauth' });

    const noStream = fakeFetch((c) => (c.url.endsWith('/server') ? json(200, { Name: 'S', DeliveryType: 'Live' }) : c.url.endsWith('/message-streams') ? json(200, { MessageStreams: [{ ID: 'outbound', MessageStreamType: 'Transactional' }] }) : json(200, { Webhooks: [] })));
    expect(await new PostmarkProvider({ fetch: noStream, logger }, settings).check(signal)).toMatchObject({ state: 'error' });
  });

  it('adds addresses to a suppression list and fails loudly when Postmark does not', async () => {
    const ok = fakeFetch(() => json(200, { Suppressions: [{ EmailAddress: 'a@example.com', Status: 'Suppressed' }] }));
    await new PostmarkProvider({ fetch: ok, logger }, settings).suppress('a@example.com', 'broadcast', signal);
    expect(ok.calls[0]?.url).toBe(`${POSTMARK_API_BASE}/message-streams/broadcast/suppressions`);
    const failed = fakeFetch(() => json(200, { Suppressions: [{ EmailAddress: 'a@example.com', Status: 'Failed' }] }));
    await expect(new PostmarkProvider({ fetch: failed, logger }, settings).suppress('a@example.com', 'broadcast', signal)).rejects.toThrow(/suppression list/);
  });

  it('exists only when EMAIL_PROVIDER=postmark with a token and a sender', () => {
    const env = (over: Record<string, unknown>) => ({ EMAIL_PROVIDER: 'none', POSTMARK_TRANSACTIONAL_STREAM: 'outbound', POSTMARK_BROADCAST_STREAM: 'broadcast', ...over }) as never;
    expect(createEmailProvider({ env: env({}), logger })).toBeNull();
    expect(createEmailProvider({ env: env({ EMAIL_PROVIDER: 'postmark', POSTMARK_SERVER_TOKEN: 't' }), logger })).toBeNull();
    expect(createEmailProvider({ env: env({ EMAIL_PROVIDER: 'postmark', POSTMARK_SERVER_TOKEN: 't', EMAIL_FROM: 'a@b.example' }), logger })).toBeInstanceOf(PostmarkProvider);
  });
});

describe('link tokens', () => {
  it('are random 32-byte base64url values stored only as SHA-256', () => {
    const a = newLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newLinkToken()).not.toBe(a);
    expect(hashLinkToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('DNS hints', () => {
  it('reports DMARC and Return-Path as hints, never errors', async () => {
    const found = await dnsHints('studio.example', { resolveTxt: async () => [['v=DMARC1; p=none']], resolveCname: async () => ['pm.mtasv.net'] });
    expect(found).toEqual({ dmarcFound: true, returnPathFound: true });
    const missing = await dnsHints('studio.example', {
      resolveTxt: async () => {
        throw new Error('ENOTFOUND');
      },
      resolveCname: async () => [],
    });
    expect(missing).toEqual({ dmarcFound: false, returnPathFound: false });
  });
});

describe('Places errors', () => {
  it('maps statuses to plain messages', () => {
    expect(placesErrorFor(400, 'INVALID_ARGUMENT').message).toMatch(/Place ID isn't valid/);
    expect(placesErrorFor(403, 'PERMISSION_DENIED').message).toMatch(/billing is off/);
    expect(placesErrorFor(404, 'NOT_FOUND')).toMatchObject({ transient: false });
    expect(placesErrorFor(429, 'RESOURCE_EXHAUSTED')).toMatchObject({ transient: true });
    expect(placesErrorFor(503, null)).toMatchObject({ transient: true });
  });
});

describe('email module registrations', () => {
  it('registers every email job type with queue settings and the right ref ids', () => {
    const types = (emailModule.handlers ?? []).map((h) => h.type);
    expect(types.sort()).toEqual(['email.automation.sweep', 'email.campaign.expand', 'email.dispatch', 'email.provider.check', 'email.send', 'email.suppression.push', 'reviews.places.sync']);
    for (const t of types) {
      expect(ALL_JOB_TYPES).toContain(t);
      expect(QUEUE_SETTINGS[t].heartbeatSeconds).toBe(30);
      expect(QUEUE_SETTINGS[t].expireInSeconds).toBeGreaterThanOrEqual(4 * 30);
    }
    expect(QUEUE_SETTINGS['email.send'].policy).toBe('stately');
    expect(emailModule.refIdFor?.('email.send', { emailMessageId: 'm' })).toBe('m');
    expect(emailModule.refIdFor?.('email.dispatch', {})).toBeNull();
    expect(emailModule.refIdFor?.('render.export', {})).toBeUndefined();
    expect(Object.keys(emailModule.webhookHandlers ?? {})).toEqual(['postmark']);
    expect((emailModule.crons ?? []).map((c) => `${c.type} ${c.cron}`)).toEqual(['email.dispatch * * * * *', 'email.automation.sweep */10 * * * *', 'email.provider.check 37 4 * * *', 'reviews.places.sync 41 5 * * *']);
  });
});
