/**
 * Email and review requests on a real (throwaway) database with a fake email provider and a fake fetch for Google:
 * the email.send state machine (duplicate protection, unknown outcomes, 429/406/412), the gate (consent, Square's
 * opt-out), the automation sweep (once per booking even when run twice at the same time, enabledAt, cancellation),
 * daily caps in Melbourne time, dispatch, campaigns (expand twice, auto-pause), Postmark webhooks, the provider check
 * and the Places snapshot. Nothing is ever sent anywhere. Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { AppSettingsSchema, dedupeKeys, newId, type JobType } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import type { WorkerContext } from '../src/context.js';
import { handleEmailSend } from '../src/handlers/email-send.js';
import { handleEmailDispatch } from '../src/handlers/email-dispatch.js';
import { handleEmailSweep } from '../src/handlers/email-sweep.js';
import { handleEmailCampaignExpand } from '../src/handlers/email-campaign.js';
import { handleEmailProviderCheck } from '../src/handlers/email-check.js';
import { handleEmailSuppressionPush } from '../src/handlers/email-suppression.js';
import { handleReviewsPlacesSync } from '../src/handlers/reviews-places.js';
import { handleWebhookProcess, webhookLookupFor } from '../src/handlers/webhook-process.js';
import { emailModule } from '../src/modules/email/index.js';
import type { EmailDeps } from '../src/lib/email/provider.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeFetch, fakeRun, json } from './helpers/fakes.js';
import { FakeEmailProvider } from './helpers/fake-email.js';

const skip = !testDatabaseUrl();
/** Monday 16 November 2026, 11:00 am in Melbourne (AEDT, UTC+11): inside the default 9–7 window. */
const NOW = new Date('2026-11-16T00:00:00Z');
const HOUR = 3600_000;

interface Queued {
  type: JobType;
  payload: Record<string, unknown>;
}

describe.skipIf(skip)('email and review requests (database-backed, fake provider)', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let ctx: WorkerContext;
  let fake: FakeEmailProvider;
  let deps: EmailDeps;
  const queue: Queued[] = [];
  const ownerId = newId();
  const m = () => schema.emailMessages;

  const settings = (over: Record<string, unknown> = {}) =>
    AppSettingsSchema.parse({
      brand: { businessName: 'Ivanhoe Studio' },
      business: { addressLine: '1 Upper Heidelberg Rd', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', phone: '03 9000 0000', email: 'hello@studio.example', googleReviewLink: 'https://g.page/r/ivanhoe-studio/review' },
      email: { followUp: { enabled: true, enabledAt: new Date(NOW.getTime() - 48 * HOUR).toISOString(), mode: 'send_automatically', dailyCap: 10 } },
      reviews: { automation: { enabled: true, enabledAt: new Date(NOW.getTime() - 48 * HOUR).toISOString(), mode: 'approve_each' } },
      ...over,
    });
  const saveSettings = async (over: Record<string, unknown> = {}) => {
    await handle.db.insert(schema.settings).values({ id: 'default', data: settings(over) }).onConflictDoUpdate({ target: schema.settings.id, set: { data: settings(over) } });
  };

  const customer = async (over: Partial<typeof schema.customers.$inferInsert> = {}) => {
    const id = newId();
    await handle.db.insert(schema.customers).values({ id, givenName: 'Sam', familyName: 'Client', email: `client-${id.slice(-8)}@example.com`, ...over });
    return (await handle.db.query.customers.findFirst({ where: eq(schema.customers.id, id) }))!;
  };
  const consent = async (c: { id: string; email: string | null }, at = new Date(NOW.getTime() - 30 * 24 * HOUR)) => {
    await handle.db.insert(schema.consentEvents).values({ id: newId(), customerId: c.id, emailLower: (c.email ?? '').toLowerCase(), kind: 'granted', basis: 'express', method: 'in_person_device', wording: 'Yes please', wordingHash: 'h', occurredAt: at });
  };
  const booking = async (customerId: string, over: Partial<typeof schema.bookings.$inferInsert> = {}) => {
    const id = newId();
    await handle.db.insert(schema.bookings).values({ id, squareBookingId: `sq-${id}`, customerId, serviceName: 'Skin fade', startAt: new Date(NOW.getTime() - 6 * HOUR), status: 'ACCEPTED', completionSource: 'payment', completedAt: new Date(NOW.getTime() - 5 * HOUR), ...over });
    return id;
  };
  const message = async (over: Partial<typeof schema.emailMessages.$inferInsert> & { toEmail: string }) => {
    const id = newId();
    await handle.db.insert(schema.emailMessages).values({
      id,
      subject: 'Looking after your cut',
      bodyMarkdown: 'Hi {{first_name}}, a few tips for your cut.',
      bodyHtml: '',
      bodyText: '',
      purpose: 'custom',
      messageClass: 'transactional_factual',
      origin: 'manual',
      dedupeKey: dedupeKeys.manual(id),
      status: 'approved',
      approvedBy: ownerId,
      approvedAt: NOW,
      ...over,
    });
    return id;
  };
  const get = async (id: string) => (await handle.db.query.emailMessages.findFirst({ where: eq(m().id, id) }))!;
  const send = (id: string, willRetry = true) => handleEmailSend(ctx, fakeRun({ willRetry }), { emailMessageId: id }, deps);

  beforeAll(async () => {
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: t.url,
      APP_URL: 'https://studio.example',
      APP_SECRET: 'test-secret-test-secret-test-secret-0123',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: '/tmp/unused-email-test',
      EMAIL_PROVIDER: 'postmark',
      POSTMARK_SERVER_TOKEN: 'fake-server-token',
      EMAIL_FROM: 'hello@studio.example',
      GOOGLE_MAPS_API_KEY: 'fake-maps-key',
    });
    ctx = {
      env,
      db: handle.db,
      store: {} as WorkerContext['store'],
      queue: {
        enqueue: async (type: JobType, payload: Record<string, unknown>) => {
          queue.push({ type, payload });
          return newId();
        },
      } as unknown as WorkerContext['queue'],
      ai: {} as WorkerContext['ai'],
      logger: pino({ level: 'silent' }),
      workerId: 'test-worker',
      fontsDir: '',
      tmpRoot: '/tmp',
    };
    await handle.db.insert(schema.users).values({ id: ownerId, email: 'owner@studio.example', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    await handle.db.insert(schema.integrationConnections).values({ id: newId(), provider: 'postmark', status: 'connected', displayName: 'Fake server', capabilities: { deliveryType: 'live', webhooksConfigured: true } });
    await saveSettings();
  }, 60_000);

  afterAll(async () => {
    await drop?.();
  }, 60_000);

  beforeEach(() => {
    fake = new FakeEmailProvider();
    deps = { provider: fake, now: () => NOW };
    queue.length = 0;
  });

  describe('email.send', () => {
    it('sends once even when the job runs twice, and keeps only token-free copies', async () => {
      const c = await customer();
      const id = await message({ toEmail: c.email!, customerId: c.id });
      await send(id);
      await send(id);
      expect(fake.sends).toHaveLength(1);
      const row = await get(id);
      expect(row).toMatchObject({ status: 'sent', providerMessageId: fake.sends[0] ? fake.accepted.get(id) : 'missing', stream: 'transactional', isSandbox: false });
      expect(row.submittedAt).not.toBeNull();
      expect(fake.sends[0]?.text).toContain('1 Upper Heidelberg Rd, Ivanhoe VIC 3079');
      const audit = await handle.db.query.auditLog.findFirst({ where: and(eq(schema.auditLog.action, 'email.message.sent'), eq(schema.auditLog.entityId, id)) });
      expect(audit).toBeTruthy();
    });

    it('after an unknown outcome looks the message up first: found → sent, not found → owner check, never a second send', async () => {
      const c = await customer();
      const a = await message({ toEmail: c.email!, customerId: c.id });
      fake.sendResults.push({ ok: false, kind: 'unknown_outcome', code: 'network', message: 'timeout' });
      await expect(send(a)).rejects.toThrow(/did not confirm/);
      expect((await get(a)).status).toBe('sending');
      fake.accepted.set(a, 'pm-accepted');
      await send(a);
      expect(fake.finds).toHaveLength(1);
      expect(fake.sends).toHaveLength(1);
      expect(await get(a)).toMatchObject({ status: 'sent', providerMessageId: 'pm-accepted' });

      const b = await message({ toEmail: c.email!, customerId: c.id });
      fake.sendResults.push({ ok: false, kind: 'unknown_outcome', code: 'network', message: 'timeout' });
      await expect(send(b)).rejects.toThrow();
      await send(b);
      expect(fake.sends).toHaveLength(2);
      expect(await get(b)).toMatchObject({ status: 'failed', ownerAction: 'check_before_retry' });
      await send(b);
      expect(fake.sends).toHaveLength(2);
    });

    it('re-queues on 429 and sends on the retry', async () => {
      const c = await customer();
      const id = await message({ toEmail: c.email!, customerId: c.id });
      fake.sendResults.push({ ok: false, kind: 'transient', code: '429', message: 'Rate limited' });
      await expect(send(id)).rejects.toThrow(/busy/);
      expect(await get(id)).toMatchObject({ status: 'queued', submittedAt: null });
      await send(id);
      expect(await get(id)).toMatchObject({ status: 'sent' });
      expect(fake.sends).toHaveLength(2);
    });

    it('suppresses the address on 406 and records approval pending on 412', async () => {
      const c = await customer();
      const id = await message({ toEmail: c.email!, customerId: c.id });
      fake.sendResults.push({ ok: false, kind: 'inactive_recipient', code: '406', message: 'Inactive recipient' });
      await send(id);
      expect((await get(id)).status).toBe('suppressed');
      const sup = await handle.db.query.emailSuppressions.findFirst({ where: eq(schema.emailSuppressions.emailLower, c.email!.toLowerCase()) });
      expect(sup).toMatchObject({ reason: 'provider_inactive', scope: 'all', source: 'send_error' });
      // Nothing more is sent to it.
      const again = await message({ toEmail: c.email!, customerId: c.id });
      await send(again);
      expect(await get(again)).toMatchObject({ status: 'suppressed' });
      expect(fake.sends).toHaveLength(1);

      const d = await customer();
      const pending = await message({ toEmail: d.email!, customerId: d.id });
      fake.sendResults.push({ ok: false, kind: 'pending_approval', code: '412', message: 'Account pending approval' });
      await send(pending);
      expect((await get(pending)).status).toBe('failed');
      const conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'postmark') });
      expect(conn?.capabilities['approved']).toBe(false);
    });

    it('blocks marketing without consent and treats Square’s email opt-out as an unsubscribe', async () => {
      const c = await customer();
      const id = await message({ toEmail: c.email!, customerId: c.id, messageClass: 'campaign', purpose: 'custom', bodyMarkdown: 'Hi {{first_name}}, new hours from next week.' });
      await send(id);
      expect(await get(id)).toMatchObject({ status: 'failed' });
      expect((await get(id)).statusMessage).toMatch(/No marketing permission/);

      const s = await customer({ squareEmailUnsubscribed: true });
      await consent(s);
      const blocked = await message({ toEmail: s.email!, customerId: s.id, messageClass: 'campaign', bodyMarkdown: 'Hi {{first_name}}, new hours.' });
      await send(blocked);
      expect(await get(blocked)).toMatchObject({ status: 'suppressed' });

      const ok = await customer();
      await consent(ok);
      const fine = await message({ toEmail: ok.email!, customerId: ok.id, messageClass: 'campaign', bodyMarkdown: 'Hi {{first_name}}, new hours.' });
      await send(fine);
      const row = await get(fine);
      expect(row).toMatchObject({ status: 'sent', stream: 'broadcast' });
      expect(row.unsubscribeTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.bodyHtml).toContain('[unsubscribe link]');
      expect(row.bodyHtml).not.toMatch(/\/u\/[A-Za-z0-9_-]{43}/);
      expect(fake.sends.at(-1)?.html).toMatch(/https:\/\/studio\.example\/u\/[A-Za-z0-9_-]{43}/);
      expect(fake.sends).toHaveLength(1);
    });
  });

  describe('automation sweep', () => {
    it('creates one request and message per completed booking even when two sweeps run at once', async () => {
      const c = await customer();
      await consent(c);
      const b = await booking(c.id);
      await Promise.all([handleEmailSweep(ctx, fakeRun(), {}, deps), handleEmailSweep(ctx, fakeRun(), {}, deps)]);
      const requests = await handle.db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.bookingId, b));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ status: 'pending_approval', origin: 'automation', completionEvidence: 'payment', dedupeKey: `review:${b}` });
      const review = await handle.db.select().from(m()).where(eq(m().dedupeKey, `review:${b}`));
      expect(review).toHaveLength(1);
      expect(review[0]).toMatchObject({ status: 'draft', messageClass: 'review_request', origin: 'automation' });
      const follow = await handle.db.select().from(m()).where(eq(m().dedupeKey, `follow_up:${b}`));
      expect(follow).toHaveLength(1);
      expect(follow[0]).toMatchObject({ status: 'approved', approvedBy: null, origin: 'automation', messageClass: 'transactional_factual' });
      // Never sent before the delay and the window: scheduled after completion + 3 h.
      expect(follow[0]!.scheduledFor!.getTime()).toBeGreaterThanOrEqual(NOW.getTime() - 5 * HOUR + 3 * HOUR);
    });

    it('ignores bookings completed before the switch was turned on, and the clock alone is never evidence', async () => {
      const c = await customer();
      await consent(c);
      const before = await booking(c.id, { completedAt: new Date(NOW.getTime() - 72 * HOUR) });
      const timeOnly = await booking(c.id, { completionSource: 'none', completedAt: null, startAt: new Date(NOW.getTime() - 4 * HOUR) });
      await handleEmailSweep(ctx, fakeRun(), {}, deps);
      expect(await handle.db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.bookingId, before))).toHaveLength(0);
      expect(await handle.db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.bookingId, timeOnly))).toHaveLength(0);
    });

    it('records a skipped request with the reason when the client has no permission', async () => {
      const c = await customer();
      const b = await booking(c.id);
      await handleEmailSweep(ctx, fakeRun(), {}, deps);
      const [r] = await handle.db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.bookingId, b));
      expect(r).toMatchObject({ status: 'skipped', skipReason: 'no_consent', emailMessageId: null });
    });

    it('cancels the request and message when the booking is cancelled after they were created', async () => {
      const c = await customer();
      await consent(c);
      const b = await booking(c.id);
      await handleEmailSweep(ctx, fakeRun(), {}, deps);
      await handle.db.update(schema.bookings).set({ status: 'CANCELLED_BY_CUSTOMER' }).where(eq(schema.bookings.id, b));
      await handleEmailSweep(ctx, fakeRun(), {}, deps);
      const [r] = await handle.db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.bookingId, b));
      expect(r).toMatchObject({ status: 'cancelled', skipReason: 'booking_cancelled' });
      expect((await handle.db.select().from(m()).where(eq(m().dedupeKey, `review:${b}`)))[0]?.status).toBe('cancelled');
      expect((await handle.db.select().from(m()).where(eq(m().dedupeKey, `follow_up:${b}`)))[0]?.status).toBe('cancelled');
    });

    it('records Square’s opt-out once as a withdrawn ledger event (never a grant)', async () => {
      const c = await customer({ squareEmailUnsubscribed: true });
      await handleEmailSweep(ctx, fakeRun(), {}, deps);
      await handleEmailSweep(ctx, fakeRun(), {}, deps);
      const events = await handle.db.select().from(schema.consentEvents).where(eq(schema.consentEvents.customerId, c.id));
      expect(events).toEqual([expect.objectContaining({ kind: 'withdrawn', method: 'square_preference' })]);
    });
  });

  describe('daily limits in Melbourne time', () => {
    it('sends 10 of 12 automated follow-ups today and moves 2 to 9:00 am tomorrow; one automated email per client per day', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const c = await customer();
        const b = await booking(c.id);
        ids.push(await message({ toEmail: c.email!, customerId: c.id, bookingId: b, origin: 'automation', approvedBy: null, purpose: 'follow_up', dedupeKey: dedupeKeys.followUp(b) }));
      }
      // Earlier tests sent other follow-ups "today"? None were automation follow-ups, so the cap starts at 0.
      for (const id of ids) await send(id);
      const rows = await Promise.all(ids.map(get));
      expect(rows.filter((r) => r.status === 'sent')).toHaveLength(10);
      const deferred = rows.filter((r) => r.status === 'approved');
      expect(deferred).toHaveLength(2);
      // 9:00 am AEDT on Tuesday 17 November 2026 = 22:00 UTC on the 16th.
      for (const r of deferred) expect(r.scheduledFor?.toISOString()).toBe('2026-11-16T22:00:00.000Z');

      const c = rows[0]!;
      const second = await message({ toEmail: c.toEmail, customerId: c.customerId, origin: 'automation', approvedBy: null, purpose: 'review_request', messageClass: 'transactional_factual', dedupeKey: `test:${newId()}` });
      await send(second);
      expect((await get(second)).statusMessage).toMatch(/already got an automated email today/);
    });
  });

  describe('dispatch and campaigns', () => {
    it('hands due messages on, skips paused campaigns and waits while the provider is not ready', async () => {
      const c = await customer();
      const due = await message({ toEmail: c.email!, customerId: c.id });
      const later = await message({ toEmail: c.email!, customerId: c.id, scheduledFor: new Date(NOW.getTime() + 24 * HOUR) });
      const campaignId = newId();
      await handle.db.insert(schema.emailCampaigns).values({ id: campaignId, name: 'Paused', subject: 's', bodyMarkdown: 'b', status: 'paused' });
      const paused = await message({ toEmail: c.email!, customerId: c.id, campaignId, origin: 'campaign' });
      await handleEmailDispatch(ctx, fakeRun(), {}, { provider: null, now: () => NOW });
      expect((await get(due)).status).toBe('approved');
      await handleEmailDispatch(ctx, fakeRun(), {}, deps);
      expect((await get(due)).status).toBe('queued');
      expect((await get(later)).status).toBe('approved');
      expect((await get(paused)).status).toBe('approved');
      expect(queue.filter((q) => q.type === 'email.send').map((q) => q.payload['emailMessageId'])).toContain(due);
      expect(queue.filter((q) => q.type === 'email.send').map((q) => q.payload['emailMessageId'])).not.toContain(paused);
    });

    it('expands a campaign once (running it again adds nothing) and only to clients with permission', async () => {
      const yes = await customer();
      await consent(yes);
      await customer();
      const campaignId = newId();
      await handle.db.insert(schema.emailCampaigns).values({ id: campaignId, name: 'Holiday hours', subject: 'Holiday hours', bodyMarkdown: 'Hi {{first_name}}, our holiday hours.', status: 'approved', approvedBy: ownerId, approvedAt: NOW });
      await handleEmailCampaignExpand(ctx, fakeRun(), { campaignId }, deps);
      const first = await handle.db.select().from(m()).where(eq(m().campaignId, campaignId));
      await handleEmailCampaignExpand(ctx, fakeRun(), { campaignId }, deps);
      const second = await handle.db.select().from(m()).where(eq(m().campaignId, campaignId));
      expect(second).toHaveLength(first.length);
      expect(second.map((r) => r.customerId)).toContain(yes.id);
      expect(second.every((r) => r.status === 'approved' && r.origin === 'campaign')).toBe(true);
      const camp = await handle.db.query.emailCampaigns.findFirst({ where: eq(schema.emailCampaigns.id, campaignId) });
      expect(camp?.status).toBe('sending');
    });
  });

  describe('Postmark webhooks', () => {
    const store = async (payload: Record<string, unknown>) => {
      const id = newId();
      await handle.db.insert(schema.webhookEvents).values({ id, provider: 'postmark', externalEventId: `test:${id}`, eventType: String(payload['RecordType']), payload, signatureValid: true });
      return id;
    };
    const process = (id: string) => handleWebhookProcess(ctx, fakeRun(), { webhookEventId: id }, webhookLookupFor([emailModule]));

    it('a spam complaint on a campaign of 42 pauses it, suppresses the address and withdraws consent; re-processing changes nothing', async () => {
      const c = await customer();
      await consent(c);
      const campaignId = newId();
      await handle.db.insert(schema.emailCampaigns).values({ id: campaignId, name: 'Big', subject: 's', bodyMarkdown: 'b', status: 'sending', sentCount: 42 });
      const pmId = `pm-${newId()}`;
      await message({ toEmail: c.email!, customerId: c.id, campaignId, origin: 'campaign', messageClass: 'campaign', status: 'sent', providerMessageId: pmId, sentAt: NOW });
      const pending = await message({ toEmail: c.email!, customerId: c.id, messageClass: 'campaign', status: 'approved' });
      const ev = await store({ RecordType: 'SpamComplaint', ID: 7, MessageID: pmId, Email: c.email, MessageStream: 'broadcast', BouncedAt: NOW.toISOString() });
      await process(ev);
      const camp = await handle.db.query.emailCampaigns.findFirst({ where: eq(schema.emailCampaigns.id, campaignId) });
      expect(camp).toMatchObject({ status: 'paused', complaintCount: 1 });
      expect(camp?.pausedReason).toMatch(/1 spam complaint out of 42 sent/);
      expect((await get(pending)).status).toBe('suppressed');
      const sup = await handle.db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.emailLower, c.email!.toLowerCase()));
      expect(sup).toEqual([expect.objectContaining({ reason: 'spam_complaint', scope: 'all' })]);
      expect(queue.filter((q) => q.type === 'email.suppression.push')).toHaveLength(1);
      // Processing the same delivery again (a crash before it was marked processed) adds nothing.
      await handle.db.update(schema.webhookEvents).set({ processedAt: null }).where(eq(schema.webhookEvents.id, ev));
      await process(ev);
      expect(await handle.db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.emailLower, c.email!.toLowerCase()))).toHaveLength(1);
      const withdrawn = await handle.db.select().from(schema.consentEvents).where(and(eq(schema.consentEvents.emailLower, c.email!.toLowerCase()), eq(schema.consentEvents.kind, 'withdrawn')));
      expect(withdrawn).toHaveLength(1);
      expect((await handle.db.query.emailCampaigns.findFirst({ where: eq(schema.emailCampaigns.id, campaignId) }))?.complaintCount).toBe(1);
    });

    it('delivery and unsubscribe events update the message and suppress marketing; reactivation never lifts the app’s suppression', async () => {
      const c = await customer();
      await consent(c);
      const pmId = `pm-${newId()}`;
      const sent = await message({ toEmail: c.email!, customerId: c.id, messageClass: 'campaign', status: 'sent', providerMessageId: pmId, sentAt: NOW });
      const factual = await message({ toEmail: c.email!, customerId: c.id, status: 'approved' });
      await process(await store({ RecordType: 'Delivery', MessageID: pmId, Recipient: c.email, DeliveredAt: NOW.toISOString() }));
      expect(await get(sent)).toMatchObject({ status: 'delivered' });
      await process(await store({ RecordType: 'SubscriptionChange', MessageID: pmId, Recipient: c.email, ChangedAt: NOW.toISOString(), SuppressSending: true, SuppressionReason: 'ManualSuppression' }));
      await process(await store({ RecordType: 'SubscriptionChange', MessageID: pmId, Recipient: c.email, ChangedAt: new Date(NOW.getTime() + HOUR).toISOString(), SuppressSending: false }));
      const sups = await handle.db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.emailLower, c.email!.toLowerCase()));
      expect(sups).toEqual([expect.objectContaining({ reason: 'unsubscribe', scope: 'marketing', liftedAt: null })]);
      // A factual message still goes; marketing does not.
      expect((await get(factual)).status).toBe('approved');
      const mk = await message({ toEmail: c.email!, customerId: c.id, messageClass: 'campaign', bodyMarkdown: 'Hi {{first_name}}.' });
      await send(mk);
      expect((await get(mk)).status).toBe('suppressed');
    });

    it('pushes a suppression to Postmark once', async () => {
      const id = newId();
      await handle.db.insert(schema.emailSuppressions).values({ id, emailLower: 'push@example.com', scope: 'all', reason: 'hard_bounce', source: 'postmark_webhook' });
      await handleEmailSuppressionPush(ctx, fakeRun(), { suppressionId: id }, deps);
      await handleEmailSuppressionPush(ctx, fakeRun(), { suppressionId: id }, deps);
      expect(fake.suppressed).toEqual([
        { email: 'push@example.com', stream: 'broadcast' },
        { email: 'push@example.com', stream: 'transactional' },
      ]);
    });
  });

  describe('read-only checks', () => {
    it('records the Postmark check (test server, webhooks, DNS hints) without sending', async () => {
      fake.checkResult = { ...fake.checkResult, deliveryType: 'sandbox', webhooks: { configured: false }, state: 'needs_attention', message: 'Add the webhook' };
      await handleEmailProviderCheck(ctx, fakeRun(), { reason: 'manual' }, deps, { resolveTxt: async () => [['v=DMARC1; p=none']], resolveCname: async () => [] });
      const conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'postmark') });
      expect(conn).toMatchObject({ status: 'connected', lastError: 'Add the webhook' });
      expect(conn?.capabilities).toMatchObject({ deliveryType: 'sandbox', webhooksConfigured: false, dmarcFound: true, returnPathFound: false });
      expect(fake.sends).toHaveLength(0);
      // Restore for later tests.
      await handle.db.update(schema.integrationConnections).set({ capabilities: { deliveryType: 'live', webhooksConfigured: true }, lastError: null }).where(eq(schema.integrationConnections.provider, 'postmark'));
    });

    it('keeps only the latest Places snapshot and shows a 404 as an error', async () => {
      await handle.db.insert(schema.integrationConnections).values({ id: newId(), provider: 'google_places', status: 'not_configured', config: { placeId: 'ChIJ-fake-place-id', confirmed: false } });
      let rating = 4.8;
      let status = 200;
      ctx.fetch = fakeFetch((call) => {
        expect(call.headers['x-goog-api-key']).toBe('fake-maps-key');
        if (status !== 200) return json(status, { error: { status: 'NOT_FOUND' } });
        return json(200, { displayName: { text: 'Ivanhoe Studio' }, formattedAddress: '1 Upper Heidelberg Rd, Ivanhoe VIC 3079', rating, userRatingCount: 123, googleMapsLinks: { writeAReviewUri: 'https://search.google.com/local/writereview?placeid=x' } });
      });
      await handleReviewsPlacesSync(ctx, fakeRun(), { reason: 'connect' }, () => NOW);
      let conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_places') });
      expect(conn?.config['candidate']).toEqual({ displayName: 'Ivanhoe Studio', formattedAddress: '1 Upper Heidelberg Rd, Ivanhoe VIC 3079' });
      await handle.db.update(schema.integrationConnections).set({ config: { placeId: 'ChIJ-fake-place-id', confirmed: true } }).where(eq(schema.integrationConnections.provider, 'google_places'));
      rating = 4.9;
      await handleReviewsPlacesSync(ctx, fakeRun(), { reason: 'manual' }, () => NOW);
      conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_places') });
      expect(conn?.capabilities).toEqual({ rating: 4.9, userRatingCount: 123, writeAReviewUri: 'https://search.google.com/local/writereview?placeid=x', readReviewsUri: null, fetchedAt: NOW.toISOString() });
      status = 404;
      await handleReviewsPlacesSync(ctx, fakeRun(), { reason: 'manual' }, () => NOW);
      conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_places') });
      expect(conn).toMatchObject({ status: 'error', lastError: 'Google no longer recognises this Place ID; look it up again.' });
      delete ctx.fetch;
    });
  });
});
