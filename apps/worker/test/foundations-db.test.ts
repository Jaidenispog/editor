import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { newId, type EditPlan } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { JobQueue } from '@studio/queue';
import type { WorkerContext } from '../src/context.js';
import { handleCleanup } from '../src/handlers/cleanup.js';
import { GOOGLE_REVOKE_FAILED_MESSAGE, handleGoogleDisconnect } from '../src/handlers/google-disconnect.js';
import { handleWebhookProcess, unknownProviderError, webhookLookupFor } from '../src/handlers/webhook-process.js';
import { loadConnection, recordConnectionCheck, withConnectionLock } from '../src/lib/connections.js';
import { decryptCredential, encryptCredential } from '../src/lib/credentials.js';
import { recordFeedback } from '../src/lib/feedback.js';
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, getGoogleAccessToken } from '../src/lib/google/oauth.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeFetch, fakeRun, json } from './helpers/fakes.js';

const logger = pino({ level: 'silent' });
const skip = !testDatabaseUrl();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(skip)('Stage B/C foundations on a real database', () => {
  let handle: DatabaseHandle;
  let url: string;
  let drop: () => Promise<void>;
  let tmpRoot: string;
  let ctx: WorkerContext;

  const withFetch = (f: typeof fetch): WorkerContext => ({ ...ctx, fetch: f });

  beforeAll(async () => {
    const t = await createTestDatabase();
    handle = t.handle;
    url = t.url;
    drop = t.drop;
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-foundations-'));
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      APP_SECRET: 'test-secret-test-secret-test-secret-0123',
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      WORKER_TMP_DIR: tmpRoot,
    });
    ctx = {
      env,
      db: handle.db,
      store: {} as WorkerContext['store'],
      queue: {} as WorkerContext['queue'],
      ai: {} as WorkerContext['ai'],
      logger,
      workerId: 'test-worker',
      fontsDir: '',
      tmpRoot,
      fetch: fakeFetch(() => {
        throw new Error('No network access in tests');
      }),
    };
  }, 60_000);

  afterAll(async () => {
    await drop();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function insertGoogleRow(provider: 'google_business_profile' | 'google_search_console', values: Partial<typeof schema.integrationConnections.$inferInsert> = {}) {
    const id = newId();
    await handle.db.delete(schema.integrationConnections).where(eq(schema.integrationConnections.provider, provider));
    await handle.db.insert(schema.integrationConnections).values({
      id,
      provider,
      status: 'connected',
      accessTokenEncrypted: encryptCredential(ctx.env, 'old-access'),
      refreshTokenEncrypted: encryptCredential(ctx.env, 'refresh-1'),
      tokenExpiresAt: new Date(Date.now() - 60_000),
      ...values,
    });
    return id;
  }

  describe('webhook.process dispatcher', () => {
    async function insertEvent(provider: string) {
      const id = newId();
      await handle.db.insert(schema.webhookEvents).values({ id, provider, externalEventId: `evt-${id}`, eventType: 'test.event', payload: { hint: true }, signatureValid: true });
      return id;
    }

    it('marks a provider no module handles as processed, with an error', async () => {
      const id = await insertEvent('mystery');
      await handleWebhookProcess(ctx, fakeRun(), { webhookEventId: id });
      const row = await handle.db.query.webhookEvents.findFirst({ where: eq(schema.webhookEvents.id, id) });
      expect(row?.processedAt).toBeInstanceOf(Date);
      expect(row?.error).toBe(unknownProviderError('mystery'));
    });

    it('calls the registered handler once and skips a processed event', async () => {
      const id = await insertEvent('square');
      const handler = vi.fn(async () => undefined);
      const lookup = webhookLookupFor([{ name: 'square', webhookHandlers: { square: handler } }]);
      await handleWebhookProcess(ctx, fakeRun(), { webhookEventId: id }, lookup);
      await handleWebhookProcess(ctx, fakeRun(), { webhookEventId: id }, lookup);
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0] as unknown[])[2]).toMatchObject({ id, provider: 'square', payload: { hint: true } });
      const row = await handle.db.query.webhookEvents.findFirst({ where: eq(schema.webhookEvents.id, id) });
      expect(row).toMatchObject({ error: null });
      expect(row?.processedAt).toBeInstanceOf(Date);
    });

    it('records a handler failure without marking the event processed, so the retry runs it again', async () => {
      const id = await insertEvent('postmark');
      const lookup = webhookLookupFor([{ name: 'email', webhookHandlers: { postmark: async () => Promise.reject(new Error('Postmark lookup failed for jo@example.com')) } }]);
      await expect(handleWebhookProcess(ctx, fakeRun(), { webhookEventId: id }, lookup)).rejects.toThrow('Postmark lookup failed');
      const row = await handle.db.query.webhookEvents.findFirst({ where: eq(schema.webhookEvents.id, id) });
      expect(row?.processedAt).toBeNull();
      expect(row?.error).toMatch(/Postmark lookup failed for email:[0-9a-f]{12}/);
    });
  });

  describe('connection lock and token refresh', () => {
    it('serialises two lock holders on the same provider', async () => {
      await insertGoogleRow('google_business_profile');
      const events: string[] = [];
      const holder = (name: string) =>
        withConnectionLock(handle.db, 'google_business_profile', async (_tx, conn) => {
          events.push(`${name}:in:${conn ? 'row' : 'none'}`);
          await sleep(150);
          events.push(`${name}:out`);
        });
      await Promise.all([holder('a'), holder('b')]);
      expect(events).toHaveLength(4);
      expect(events[1]).toBe(`${events[0]?.split(':')[0]}:out`);
      expect(events[3]).toBe(`${events[2]?.split(':')[0]}:out`);
    });

    it('refreshes an expiring Google token once when two jobs ask at the same time', async () => {
      await insertGoogleRow('google_search_console');
      const f = fakeFetch(async (call) => {
        expect(call.url).toBe(GOOGLE_TOKEN_URL);
        expect(call.body).toContain('grant_type=refresh_token');
        expect(call.body).toContain('refresh_token=refresh-1');
        await sleep(150);
        return json(200, { access_token: 'fresh-access', expires_in: 3600, scope: 'https://www.googleapis.com/auth/webmasters.readonly', token_type: 'Bearer' });
      });
      const c = withFetch(f);
      const tokens = await Promise.all([getGoogleAccessToken(c, 'google_search_console'), getGoogleAccessToken(c, 'google_search_console')]);
      expect(tokens).toEqual(['fresh-access', 'fresh-access']);
      expect(f.calls).toHaveLength(1);
      const row = await loadConnection(handle.db, 'google_search_console');
      expect(row?.tokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 3000_000);
      expect(decryptCredential(ctx.env, row?.accessTokenEncrypted ?? '')).toBe('fresh-access');
      expect(decryptCredential(ctx.env, row?.refreshTokenEncrypted ?? '')).toBe('refresh-1');
      expect(row?.scopes).toEqual(['https://www.googleapis.com/auth/webmasters.readonly']);
      // A fresh token is used without another call.
      expect(await getGoogleAccessToken(c, 'google_search_console')).toBe('fresh-access');
      expect(f.calls).toHaveLength(1);
    });

    it('marks the connection needs_reauth on invalid_grant', async () => {
      await insertGoogleRow('google_search_console');
      const f = fakeFetch(() => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
      await expect(getGoogleAccessToken(withFetch(f), 'google_search_console')).rejects.toThrow(/Google Search Console needs you to sign in again/);
      const row = await loadConnection(handle.db, 'google_search_console');
      expect(row?.status).toBe('needs_reauth');
      await expect(getGoogleAccessToken(withFetch(f), 'google_search_console')).rejects.toThrow(/sign in again/);
      expect(f.calls).toHaveLength(1);
    });

    it('records a read-only check without losing other capabilities', async () => {
      await insertGoogleRow('google_business_profile', { capabilities: { verifiedAt: '2026-11-01', performanceApi: 'unknown' } });
      const row = await recordConnectionCheck(handle.db, 'google_business_profile', { status: 'connected', capabilities: { performanceApi: 'awaiting_approval' }, lastError: null });
      expect(row?.capabilities).toEqual({ verifiedAt: '2026-11-01', performanceApi: 'awaiting_approval' });
      expect(row?.lastSyncAt).toBeInstanceOf(Date);
      expect(await recordConnectionCheck(handle.db, 'postmark', { status: 'error' })).toBeNull();
    });
  });

  describe('google.disconnect', () => {
    it('revokes, wipes the tokens and audits', async () => {
      const id = await insertGoogleRow('google_business_profile', { status: 'disconnected' });
      const f = fakeFetch(() => new Response('', { status: 200 }));
      await handleGoogleDisconnect(withFetch(f), fakeRun(), { connectionId: id });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ url: GOOGLE_REVOKE_URL, method: 'POST', body: 'token=refresh-1' });
      const row = await loadConnection(handle.db, 'google_business_profile');
      expect(row).toMatchObject({ status: 'disconnected', accessTokenEncrypted: null, refreshTokenEncrypted: null, tokenExpiresAt: null, lastError: null });
      const audit = await handle.db.query.auditLog.findFirst({ where: eq(schema.auditLog.entityId, id) });
      expect(audit).toMatchObject({ action: 'integration.google_business_profile.tokens_revoked', data: { outcome: 'revoked' } });
    });

    it('leaves a connection the owner reconnected in the meantime alone', async () => {
      const id = await insertGoogleRow('google_business_profile', { status: 'connected' });
      const f = fakeFetch(() => new Response('', { status: 200 }));
      await handleGoogleDisconnect(withFetch(f), fakeRun(), { connectionId: id });
      expect(f.calls).toHaveLength(0);
      const row = await loadConnection(handle.db, 'google_business_profile');
      expect(row?.refreshTokenEncrypted).not.toBeNull();
    });

    it('retries a failed revocation, and on the last attempt still wipes the tokens with a plain note', async () => {
      const id = await insertGoogleRow('google_business_profile', { status: 'disconnected' });
      const f = fakeFetch(() => new Response('', { status: 503 }));
      await expect(handleGoogleDisconnect(withFetch(f), fakeRun({ willRetry: true }), { connectionId: id })).rejects.toThrow(/did not confirm/);
      expect((await loadConnection(handle.db, 'google_business_profile'))?.refreshTokenEncrypted).not.toBeNull();
      await handleGoogleDisconnect(withFetch(f), fakeRun({ willRetry: false }), { connectionId: id });
      const row = await loadConnection(handle.db, 'google_business_profile');
      expect(row).toMatchObject({ refreshTokenEncrypted: null, accessTokenEncrypted: null, lastError: GOOGLE_REVOKE_FAILED_MESSAGE });
    });
  });

  describe('recordFeedback', () => {
    const plan: EditPlan = {
      version: 1,
      styleId: 'clean_promo',
      title: 'Fixture',
      description: 'Fixture',
      rationale: '',
      output: { width: 1080, height: 1920, fps: 30 },
      targetDurationSec: 8,
      segments: [{ id: 's1', assetId: 'a1', inSec: 0, outSec: 8, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'result', keepOriginalSound: false }],
      textOverlays: [],
      captions: [],
      audio: { music: null, originalSound: { enabled: true, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
      colourPreset: 'natural',
    };

    it('leaves no row when the caller rolls back, and stores plan facts when it commits', async () => {
      const marker = newId();
      await expect(
        handle.db.transaction(async (tx) => {
          await recordFeedback(tx, { type: 'publish', userId: null, projectId: null, editId: marker, editVersionId: 'v1', styleId: 'clean_promo', plan, data: { platform: 'instagram' } });
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await handle.db.query.feedbackEvents.findMany({ where: eq(schema.feedbackEvents.editId, marker) })).toHaveLength(0);

      await handle.db.transaction(async (tx) => {
        await recordFeedback(tx, { type: 'publish', userId: null, projectId: null, editId: marker, editVersionId: 'v1', styleId: 'clean_promo', plan, data: { platform: 'instagram' } });
      });
      const rows = await handle.db.query.feedbackEvents.findMany({ where: eq(schema.feedbackEvents.editId, marker) });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.data).toMatchObject({ platform: 'instagram', planFacts: { styleId: 'clean_promo', durationSec: 8, originalSound: true, hasMusic: false } });
    });
  });

  describe('maintenance.cleanup', () => {
    it('runs every module task, reports a failing one, and still runs the rest', async () => {
      const ran: string[] = [];
      const tasks = [
        { name: 'a', run: async () => void ran.push('a') },
        {
          name: 'b',
          run: async () => {
            ran.push('b');
            throw new Error('b failed');
          },
        },
        { name: 'c', run: async () => (ran.push('c'), 'c cleaned') },
      ];
      await expect(handleCleanup(ctx, fakeRun(), { olderThanHours: 24 }, tasks)).rejects.toThrow('Cleanup tasks failed: b');
      expect(ran).toEqual(['a', 'b', 'c']);
      const run = fakeRun();
      await handleCleanup(ctx, run, { olderThanHours: 24 }, [tasks[2]!]);
      expect(run.messages.at(-1)).toBe('Cleanup done: 0 folders, 0 abandoned uploads, c cleaned');
    });
  });

  describe('pg-boss 12.38.1 behaviour the designs rely on', () => {
    it('pins singletonKey on standard and stately queues, startAfter dates, and keyed schedules', async () => {
      const queue = new JobQueue({ connectionString: url, role: 'worker', logger, max: 2 });
      await queue.start();
      const boss = queue.raw;
      try {
        await boss.createQueue('test.standard', { policy: 'standard' });
        await boss.createQueue('test.stately', { policy: 'stately' });

        // standard: a singletonKey alone does NOT prevent a second queued job, so database guards stay authoritative.
        expect(await boss.send('test.standard', {}, { singletonKey: 'k' })).toBeTruthy();
        expect(await boss.send('test.standard', {}, { singletonKey: 'k' })).toBeTruthy();

        // stately: one queued job per key; another key is independent; once the first is active a new one may queue.
        expect(await boss.send('test.stately', { n: 1 }, { singletonKey: 'k' })).toBeTruthy();
        expect(await boss.send('test.stately', { n: 2 }, { singletonKey: 'k' })).toBeNull();
        expect(await boss.send('test.stately', { n: 3 }, { singletonKey: 'other' })).toBeTruthy();
        const active = await boss.fetch('test.stately', { batchSize: 5 });
        expect(active).toHaveLength(2);
        expect(await boss.send('test.stately', { n: 4 }, { singletonKey: 'k' })).toBeTruthy();
        expect(await boss.send('test.stately', { n: 5 }, { singletonKey: 'k' })).toBeNull();

        // startAfter as a Date is honoured (the job is not fetchable yet).
        const later = await queue.enqueue('maintenance.cleanup', { olderThanHours: 1 }, { startAfter: new Date(Date.now() + 3600_000) });
        expect(later).toBeTruthy();
        const job = await boss.getJobById('maintenance.cleanup', later ?? '');
        expect(job?.startAfter.getTime()).toBeGreaterThan(Date.now() + 3500_000);
        expect(await boss.fetch('maintenance.cleanup')).toEqual([]);

        // Two keyed schedules on one queue; the same key again replaces its schedule.
        await queue.schedule('maintenance.cleanup', '53 5 * * *', { olderThanHours: 1 }, { key: 'daily' });
        await queue.schedule('maintenance.cleanup', '7 6 * * 1', { olderThanHours: 2 }, { key: 'weekly' });
        await queue.schedule('maintenance.cleanup', '9 6 * * 1', { olderThanHours: 3 }, { key: 'weekly' });
        const schedules = await boss.getSchedules('maintenance.cleanup');
        expect(schedules.map((s) => ({ key: s.key, cron: s.cron, data: s.data, tz: (s.options as { tz?: string }).tz })).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
          { key: 'daily', cron: '53 5 * * *', data: { olderThanHours: 1 }, tz: 'Australia/Melbourne' },
          { key: 'weekly', cron: '9 6 * * 1', data: { olderThanHours: 3 }, tz: 'Australia/Melbourne' },
        ]);
      } finally {
        await queue.stop(false);
      }
    }, 60_000);
  });
});
