import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Email and review routes against a throwaway database (TEST_DATABASE_URL): the Postmark webhook (credentials, one
 * row and one job per delivery), the public unsubscribe (POST idempotent, one-click, GET changes nothing), owner-only
 * and CSRF guards, the gate on approval, the stale campaign preview, consent with the wording hash, the review link
 * and the /r redirect, manual review requests, automation guards and the Places refresh limit. The session lookup is
 * replaced; validation, the database and the pg-boss queue are real. Nothing is ever sent.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

type User = { id: string; email: string; displayName: string; role: 'owner' | 'staff' };
const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: User; expiresAt: Date } }));
vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));
vi.mock('../src/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/env')>();
  const { loadEnv } = await import('@studio/config');
  return { ...actual, getEnv: () => loadEnv({ ...process.env }) };
});

const ORIGIN = 'http://localhost:3000';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }): Promise<{ status: number; json: any; res: Response }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.clone().text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

const signIn = (user: User) => {
  auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + 3600_000) };
};
const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
const HOOK = basic('hook-user:a-long-random-password-for-the-postmark-hook');

suite('Email and review routes (database-backed)', () => {
  const dbName = `sa_emailtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;
  let db: any;
  let schema: any;
  let eq: any;

  const customer = async (over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.insert(schema.customers).values({ id, givenName: 'Sam', familyName: 'Client', email: `c-${id.slice(0, 8)}@example.com`, ...over });
    return (await db.query.customers.findFirst({ where: eq(schema.customers.id, id) })) as { id: string; email: string };
  };
  const grant = async (c: { id: string; email: string }) => {
    await db.insert(schema.consentEvents).values({ id: randomUUID(), customerId: c.id, emailLower: c.email.toLowerCase(), kind: 'granted', basis: 'express', method: 'in_person_device', wording: 'Yes', wordingHash: 'h', occurredAt: new Date(Date.now() - 86_400_000) });
  };
  const jobsOf = async (type: string) => db.select().from(schema.jobs).where(eq(schema.jobs.type, type));

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      APP_URL: ORIGIN,
      EMAIL_PROVIDER: 'postmark',
      POSTMARK_SERVER_TOKEN: 'fake-server-token',
      EMAIL_FROM: 'Ivanhoe Studio <hello@studio.example>',
      POSTMARK_WEBHOOK_USERNAME: 'hook-user',
      POSTMARK_WEBHOOK_PASSWORD: 'a-long-random-password-for-the-postmark-hook',
      GOOGLE_MAPS_API_KEY: 'fake-maps-key',
    });
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';
    ({ getDb: db } = { getDb: (await import('../src/lib/db')).getDb() });
    ({ schema } = await import('@studio/db'));
    ({ eq } = await import('drizzle-orm'));
    const mk = async (role: 'owner' | 'staff', name: string): Promise<User> => {
      const u = { id: randomUUID(), email: `${name.toLowerCase()}@studio.example`, displayName: name, role };
      await db.insert(schema.users).values({ ...u, passwordHash: 'x' });
      return u;
    };
    owner = await mk('owner', 'Owner');
    staff = await mk('staff', 'Jordan');
    const { AppSettingsSchema } = await import('@studio/core');
    await db.insert(schema.settings).values({
      id: 'default',
      data: AppSettingsSchema.parse({ brand: { businessName: 'Ivanhoe Studio' }, business: { addressLine: '1 Upper Heidelberg Rd', phone: '03 9000 0000', email: 'hello@studio.example' } }),
    });
    await db.insert(schema.integrationConnections).values({ id: randomUUID(), provider: 'postmark', status: 'connected', displayName: 'Fake', capabilities: { deliveryType: 'live', webhooksConfigured: true }, lastSyncAt: new Date() });
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
  }, 60_000);

  describe('Postmark webhook', () => {
    it('refuses wrong credentials with 401 and stores nothing', async () => {
      const r = await import('../src/app/api/webhooks/postmark/route');
      const body = JSON.stringify({ RecordType: 'Delivery', MessageID: 'pm-x', Recipient: 'a@example.com' });
      const bad = await call(r.POST, 'POST', '/api/webhooks/postmark', {}, body, { authorization: basic('hook-user:wrong'), 'content-type': 'application/json' });
      expect(bad.status).toBe(401);
      const none = await call(r.POST, 'POST', '/api/webhooks/postmark', {}, body, { 'content-type': 'application/json' });
      expect(none.status).toBe(401);
      expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
    });

    it('stores a replayed delivery once and queues one job', async () => {
      const r = await import('../src/app/api/webhooks/postmark/route');
      // Postmark's IDs can exceed JavaScript's safe integers: the id is read from the raw text.
      const body = '{"RecordType":"Bounce","ID":4323372036854775807,"Type":"HardBounce","MessageID":"pm-1","Email":"a@example.com","BouncedAt":"2026-11-14T00:00:00Z"}';
      const first = await call(r.POST, 'POST', '/api/webhooks/postmark', {}, body, { authorization: HOOK, 'content-type': 'application/json' });
      const again = await call(r.POST, 'POST', '/api/webhooks/postmark', {}, body, { authorization: HOOK, 'content-type': 'application/json' });
      expect(first.status).toBe(200);
      expect(again.json).toEqual({ received: true, duplicate: true });
      const rows = await db.select().from(schema.webhookEvents);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ provider: 'postmark', externalEventId: 'bounce:4323372036854775807', signatureValid: true });
      expect(await jobsOf('webhook.process')).toHaveLength(1);
    });
  });

  describe('public unsubscribe', () => {
    it('GET changes nothing; POST unsubscribes once, suppresses queued marketing and queues the Postmark push; repeats are harmless', async () => {
      const c = await customer();
      await grant(c);
      const token = 'T'.repeat(43);
      const sentId = randomUUID();
      const queuedId = randomUUID();
      await db.insert(schema.emailMessages).values([
        { id: sentId, customerId: c.id, toEmail: c.email, subject: 'News', bodyHtml: '', bodyText: '', purpose: 'campaign', messageClass: 'campaign', origin: 'campaign', dedupeKey: `t:${sentId}`, status: 'sent', unsubscribeTokenHash: createHash('sha256').update(token).digest('hex') },
        { id: queuedId, customerId: c.id, toEmail: c.email, subject: 'More news', bodyHtml: '', bodyText: '', purpose: 'campaign', messageClass: 'campaign', origin: 'campaign', dedupeKey: `t:${queuedId}`, status: 'approved' },
      ]);
      const { unsubscribePageFacts } = await import('../src/lib/email');
      const facts = await unsubscribePageFacts(token);
      expect(facts).toMatchObject({ valid: true, alreadyUnsubscribed: false, businessName: 'Ivanhoe Studio' });
      expect(facts.maskedEmail).toMatch(/^c•••@example\.com$/);
      expect(await db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.emailLower, c.email))).toHaveLength(0);

      const r = await import('../src/app/api/public/unsubscribe/[token]/route');
      const res = await call(r.POST, 'POST', `/api/public/unsubscribe/${token}`, { token }, '', { 'content-type': 'application/x-www-form-urlencoded' });
      expect(res.status).toBe(303);
      expect(res.res.headers.get('location')).toBe(`${ORIGIN}/u/${token}?done=1`);
      const oneClick = await call(r.POST, 'POST', `/api/public/unsubscribe/${token}`, { token }, 'List-Unsubscribe=One-Click', { 'content-type': 'application/x-www-form-urlencoded' });
      expect(oneClick.status).toBe(303);
      const sups = await db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.emailLower, c.email));
      expect(sups).toEqual([expect.objectContaining({ scope: 'marketing', reason: 'unsubscribe', source: 'unsubscribe_page' })]);
      const ledger = await db.select().from(schema.consentEvents).where(eq(schema.consentEvents.emailLower, c.email));
      expect(ledger.filter((e: { kind: string }) => e.kind === 'withdrawn')).toHaveLength(1);
      expect((await db.query.emailMessages.findFirst({ where: eq(schema.emailMessages.id, queuedId) })).status).toBe('suppressed');
      expect((await jobsOf('email.suppression.push')).length).toBe(1);
      expect((await unsubscribePageFacts(token)).alreadyUnsubscribed).toBe(true);

      const invalid = await call(r.POST, 'POST', '/api/public/unsubscribe/nope', { token: 'nope' }, '', { 'content-type': 'application/x-www-form-urlencoded' });
      expect(invalid.res.headers.get('location')).toBe(`${ORIGIN}/u/nope?invalid=1`);
    });
  });

  describe('owner-only actions, CSRF and the gate', () => {
    it('staff get 403 on approve, campaigns and settings; a cross-site POST is refused', async () => {
      signIn(staff);
      const approve = await import('../src/app/api/email/messages/[id]/approve/route');
      expect((await call(approve.POST, 'POST', '/api/email/messages/x/approve', { id: 'x' }, {})).status).toBe(403);
      const settings = await import('../src/app/api/email/settings/route');
      expect((await call(settings.PUT, 'PUT', '/api/email/settings', {}, { senderName: 'X' })).status).toBe(403);
      const camps = await import('../src/app/api/email/campaigns/route');
      expect((await call(camps.GET, 'GET', '/api/email/campaigns')).status).toBe(403);
      // Staff may see clients and record consent.
      const customers = await import('../src/app/api/customers/route');
      expect((await call(customers.GET, 'GET', '/api/customers')).status).toBe(200);
      signIn(owner);
      expect((await call(settings.PUT, 'PUT', '/api/email/settings', {}, { senderName: 'X' }, { origin: 'https://evil.example' })).status).toBe(403);
    });

    it('drafts are saved; approval is refused while the gate blocks (no permission) and allowed for an information-only email', async () => {
      signIn(owner);
      const c = await customer();
      const msgs = await import('../src/app/api/email/messages/route');
      const marketing = await call(msgs.POST, 'POST', '/api/email/messages', {}, { customerId: c.id, messageClass: 'campaign', subject: 'New hours', bodyMarkdown: 'Hi {{first_name}}, new hours.' });
      expect(marketing.status).toBe(200);
      expect(marketing.json.message.status).toBe('draft');
      const approve = await import('../src/app/api/email/messages/[id]/approve/route');
      const blocked = await call(approve.POST, 'POST', `/api/email/messages/${marketing.json.message.id}/approve`, { id: marketing.json.message.id }, {});
      expect(blocked.status).toBe(422);
      expect(blocked.json.error.message).toMatch(/No marketing permission/);
      const factual = await call(msgs.POST, 'POST', '/api/email/messages', {}, { customerId: c.id, messageClass: 'transactional_factual', subject: 'About your cut', bodyMarkdown: 'Hi {{first_name}}, keep the product light.' });
      const ok = await call(approve.POST, 'POST', `/api/email/messages/${factual.json.message.id}/approve`, { id: factual.json.message.id }, {});
      expect(ok.status).toBe(200);
      expect(ok.json.message.status).toBe('approved');
      expect((await jobsOf('email.send')).some((j: { refId: string }) => j.refId === factual.json.message.id)).toBe(true);
      const cancel = await import('../src/app/api/email/messages/[id]/cancel/route');
      await db.update(schema.emailMessages).set({ status: 'sent' }).where(eq(schema.emailMessages.id, factual.json.message.id));
      expect((await call(cancel.POST, 'POST', `/api/email/messages/${factual.json.message.id}/cancel`, { id: factual.json.message.id })).status).toBe(409);
    });

    it('records consent only with the current wording hash, which also reverses an unsubscribe', async () => {
      signIn(staff);
      const c = await customer();
      await db.insert(schema.emailSuppressions).values({ id: randomUUID(), emailLower: c.email, scope: 'marketing', reason: 'unsubscribe', source: 'owner' });
      const r = await import('../src/app/api/customers/[id]/consent/route');
      const detail = await call(r.GET, 'GET', `/api/customers/${c.id}/consent`, { id: c.id });
      expect(detail.json.wording).toContain('Ivanhoe Studio');
      expect((await call(r.POST, 'POST', `/api/customers/${c.id}/consent`, { id: c.id }, { method: 'in_person_device', wordingHash: '0'.repeat(64), clientConfirmed: true })).status).toBe(409);
      const ok = await call(r.POST, 'POST', `/api/customers/${c.id}/consent`, { id: c.id }, { method: 'in_person_device', wordingHash: detail.json.wordingHash, clientConfirmed: true });
      expect(ok.json.state.status).toBe('express');
      const ev = await db.select().from(schema.consentEvents).where(eq(schema.consentEvents.customerId, c.id));
      expect(ev[0]).toMatchObject({ kind: 'granted', basis: 'express', wording: detail.json.wording, recordedBy: staff.id });
      // Staff may stop review requests but not turn them back on.
      const opt = await import('../src/app/api/customers/[id]/review-opt-out/route');
      expect((await call(opt.POST, 'POST', `/api/customers/${c.id}/review-opt-out`, { id: c.id }, { value: true })).status).toBe(200);
      expect((await call(opt.POST, 'POST', `/api/customers/${c.id}/review-opt-out`, { id: c.id }, { value: false })).status).toBe(403);
    });
  });

  describe('campaigns', () => {
    it('approval with a stale audience preview answers 409; the fresh hash is accepted and expansion is queued', async () => {
      signIn(owner);
      const c = await customer();
      await grant(c);
      const camps = await import('../src/app/api/email/campaigns/route');
      const created = await call(camps.POST, 'POST', '/api/email/campaigns', {}, { name: 'Holiday hours', subject: 'Holiday hours', bodyMarkdown: 'Hi {{first_name}}, our holiday hours.', audience: { lastVisitWithinDays: null } });
      const id = created.json.campaign.id;
      const prev = await import('../src/app/api/email/campaigns/[id]/audience-preview/route');
      const p1 = await call(prev.POST, 'POST', `/api/email/campaigns/${id}/audience-preview`, { id }, {});
      expect(p1.json.included).toBeGreaterThanOrEqual(1);
      expect(p1.json.byReason.no_permission).toBeGreaterThanOrEqual(1);
      // Another client gives permission after the preview: the audience changed.
      await grant(await customer());
      const approve = await import('../src/app/api/email/campaigns/[id]/approve/route');
      expect((await call(approve.POST, 'POST', `/api/email/campaigns/${id}/approve`, { id }, { audienceHash: p1.json.audienceHash, confirmConsent: true })).status).toBe(409);
      const p2 = await call(prev.POST, 'POST', `/api/email/campaigns/${id}/audience-preview`, { id }, {});
      const ok = await call(approve.POST, 'POST', `/api/email/campaigns/${id}/approve`, { id }, { audienceHash: p2.json.audienceHash, confirmConsent: true });
      expect(ok.status).toBe(200);
      expect(ok.json.campaign.status).toBe('approved');
      expect(await jobsOf('email.campaign.expand')).toHaveLength(1);
    });
  });

  describe('reviews', () => {
    it('validates the review link, and /r always redirects to it (counting known tokens only)', async () => {
      signIn(owner);
      const link = await import('../src/app/api/reviews/link/route');
      expect((await call(link.PUT, 'PUT', '/api/reviews/link', {}, { url: 'https://g.page.evil.example/r/abc' })).status).toBe(400);
      const ok = await call(link.PUT, 'PUT', '/api/reviews/link', {}, { url: 'https://g.page/r/ivanhoe/review' });
      expect(ok.json).toMatchObject({ url: 'https://g.page/r/ivanhoe/review', valid: true });
      const c = await customer();
      const token = 'R'.repeat(43);
      await db.insert(schema.reviewRequests).values({ id: randomUUID(), customerId: c.id, channel: 'email', status: 'sent', clickTokenHash: createHash('sha256').update(token).digest('hex'), dedupeKey: `t:${randomUUID()}` });
      const r = await import('../src/app/r/[token]/route');
      const known = await call(r.GET, 'GET', `/r/${token}`, { token }, undefined, {});
      const unknown = await call(r.GET, 'GET', `/r/${'X'.repeat(43)}`, { token: 'X'.repeat(43) }, undefined, {});
      expect(known.status).toBe(302);
      expect(known.res.headers.get('location')).toBe('https://g.page/r/ivanhoe/review');
      expect(unknown.res.headers.get('location')).toBe('https://g.page/r/ivanhoe/review');
      const row = await db.query.reviewRequests.findFirst({ where: eq(schema.reviewRequests.customerId, c.id) });
      expect(row).toMatchObject({ clickCount: 1 });
      expect(row.firstClickedAt).not.toBeNull();
    });

    it('a manual request needs the attestation, skips clients without permission, and refuses a second one for the same visit', async () => {
      signIn(owner);
      const { melbourneDateOf } = await import('@studio/core');
      const today = melbourneDateOf(new Date());
      const reqs = await import('../src/app/api/reviews/requests/route');
      const noPerm = await customer();
      const skipped = await call(reqs.POST, 'POST', '/api/reviews/requests', {}, { customerId: noPerm.id, visitDate: today, attest: true });
      expect(skipped.json.request).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });
      const yes = await customer();
      await grant(yes);
      expect((await call(reqs.POST, 'POST', '/api/reviews/requests', {}, { customerId: yes.id, visitDate: today, attest: false })).status).toBe(400);
      const made = await call(reqs.POST, 'POST', '/api/reviews/requests', {}, { customerId: yes.id, visitDate: today, attest: true });
      expect(made.json.request.status).toBe('pending_approval');
      expect((await call(reqs.POST, 'POST', '/api/reviews/requests', {}, { customerId: yes.id, visitDate: today, attest: true })).status).toBe(409);
      const list = await call(reqs.GET, 'GET', '/api/reviews/requests');
      expect(list.json.items.some((i: { id: string; status: string }) => i.id === made.json.request.id && i.status === 'pending_approval')).toBe(true);
      const skip = await import('../src/app/api/reviews/requests/[id]/skip/route');
      expect((await call(skip.POST, 'POST', `/api/reviews/requests/${made.json.request.id}/skip`, { id: made.json.request.id }, { reason: 'other' })).status).toBe(400);
      const s = await call(skip.POST, 'POST', `/api/reviews/requests/${made.json.request.id}/skip`, { id: made.json.request.id }, { reason: 'asked_in_person' });
      expect(s.json.request).toMatchObject({ status: 'skipped', skipReason: 'asked_in_person' });
    });

    it('the review automation cannot be switched on while Square already asks for feedback', async () => {
      signIn(owner);
      const set = await import('../src/app/api/email/settings/route');
      await call(set.PUT, 'PUT', '/api/email/settings', {}, { squareSends: { confirmations: true, reminders: true, feedbackOrReviews: true } });
      const auto = await import('../src/app/api/email/automations/[name]/route');
      const body = { enabled: true, mode: 'approve_each', templateId: null, delayHours: 3, dailyCap: 10 };
      const refused = await call(auto.PUT, 'PUT', '/api/email/automations/review_request', { name: 'review_request' }, body);
      expect(refused.status).toBe(422);
      expect(refused.json.error.message).toMatch(/Square is already asking/);
      await call(set.PUT, 'PUT', '/api/email/settings', {}, { squareSends: { confirmations: true, reminders: true, feedbackOrReviews: false } });
      const on = await call(auto.PUT, 'PUT', '/api/email/automations/review_request', { name: 'review_request' }, body);
      expect(on.json.automation).toMatchObject({ enabled: true, mode: 'approve_each' });
      expect(on.json.automation.enabledAt).toBeTruthy();
    });

    it('limits the Google rating refresh to once every 10 minutes', async () => {
      signIn(owner);
      const places = await import('../src/app/api/integrations/google-places/route');
      const put = await call(places.PUT, 'PUT', '/api/integrations/google-places', {}, { placeId: 'ChIJ-fake-place-id-123' });
      expect(put.json.state).toBe('checking');
      await db.update(schema.integrationConnections).set({ config: { placeId: 'ChIJ-fake-place-id-123', confirmed: true }, lastSyncAt: new Date() }).where(eq(schema.integrationConnections.provider, 'google_places'));
      const refresh = await import('../src/app/api/integrations/google-places/refresh/route');
      expect((await call(refresh.POST, 'POST', '/api/integrations/google-places/refresh')).status).toBe(429);
      await db.update(schema.integrationConnections).set({ lastSyncAt: new Date(Date.now() - 11 * 60_000) }).where(eq(schema.integrationConnections.provider, 'google_places'));
      expect((await call(refresh.POST, 'POST', '/api/integrations/google-places/refresh')).status).toBe(200);
    });
  });
});
