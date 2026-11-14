/**
 * Google Business Profile reviews and Performance on a real database (TEST_DATABASE_URL) against an in-memory fake of
 * Google answering through the injected fetch (plan WP9 acceptance tests). Nothing on the internet is contacted.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@studio/config';
import { NonRetryableError, newId, type JobType } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import type { WorkerContext } from '../src/context.js';
import { handleReviewsGbpSync } from '../src/handlers/reviews-gbp.js';
import { handleSearchSync } from '../src/handlers/search-sync.js';
import { handleWebsiteConnectionCheck } from '../src/handlers/website-connection-check.js';
import { encryptCredential } from '../src/lib/credentials.js';
import { UNRECOGNISED_RESPONSE_MESSAGE } from '../src/lib/google/business-profile.js';
import type { WebsiteDeps } from '../src/website/deps.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeRun } from './helpers/fakes.js';
import { fakeBusinessProfile } from './fakes/google-business-profile.js';

const logger = pino({ level: 'silent' });
const skip = !testDatabaseUrl();
const NOW = new Date('2026-11-14T03:00:00Z');

describe.skipIf(skip)('Business Profile module on a real database with a fake Google', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let tmpRoot: string;
  let ctx: WorkerContext;
  const google = fakeBusinessProfile();
  const enqueued: Array<{ type: JobType; payload: unknown }> = [];
  const deps = { fetchPolicy: {} as WebsiteDeps['fetchPolicy'], copywriter: null, now: () => NOW } satisfies WebsiteDeps;

  const conn = async () => (await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_business_profile') }))!;
  const storedReviews = () => handle.db.select().from(schema.reviews).where(eq(schema.reviews.provider, 'google_business_profile')).orderBy(asc(schema.reviews.externalReviewId));
  const reviewCalls = () => google.fetch.calls.filter((c) => c.url.includes('/reviews')).length;

  beforeAll(async () => {
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-gbp-'));
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: t.url,
      APP_SECRET: 'test-secret-test-secret-test-secret-0123',
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      WORKER_TMP_DIR: tmpRoot,
    });
    ctx = {
      env,
      db: handle.db,
      store: {} as WorkerContext['store'],
      queue: {
        enqueue: async (type: JobType, payload: unknown) => {
          enqueued.push({ type, payload });
          return newId();
        },
      } as unknown as WorkerContext['queue'],
      ai: {} as WorkerContext['ai'],
      logger,
      workerId: 'test-worker',
      fontsDir: '',
      tmpRoot,
      fetch: google.fetch,
    };
    await handle.db.insert(schema.integrationConnections).values({
      id: newId(),
      provider: 'google_business_profile',
      status: 'connected',
      accessTokenEncrypted: encryptCredential(env, 'expired'),
      refreshTokenEncrypted: encryptCredential(env, 'refresh-1'),
      tokenExpiresAt: new Date(Date.now() - 60_000),
      scopes: ['https://www.googleapis.com/auth/business.manage'],
    });
  }, 120_000);

  afterAll(async () => {
    await drop?.();
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    enqueued.length = 0;
    google.fetch.calls.length = 0;
  });

  describe('reviews', () => {
    it('quota 0 (Google has not approved access) is "waiting for Google approval", not an error, and the job ends without a retry', async () => {
      google.state.quotaZero = true;
      const result = await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'connect' });
      expect(result.outcome).toBe('awaiting_approval');
      const row = await conn();
      expect(row.status).toBe('connected');
      expect(row.lastError).toBeNull();
      expect(row.capabilities['apiAccess']).toBe('awaiting_approval');
      expect(await storedReviews()).toHaveLength(0);
      expect(enqueued).toHaveLength(0);
      // No location is known yet, so the Performance probe has nothing to check and calls nobody.
      expect(await handleWebsiteConnectionCheck(ctx, fakeRun(), { provider: 'business_profile_performance', reason: 'manual' }, deps)).toBeUndefined();
      google.state.quotaZero = false;
    });

    it('once approved: discovery picks the only location, a first sync reads every page, then queues the Performance probe', async () => {
      google.state.reviews = [
        { reviewId: 'r1', starRating: 'FIVE', comment: 'Great fade', displayName: 'Sam', createTime: '2026-10-01T01:00:00Z', updateTime: '2026-10-01T01:00:00Z', reply: 'Thanks Sam', reviewReplyState: 'REPLY_PUBLISHED' },
        { reviewId: 'r2', starRating: 'FOUR', isAnonymous: true, createTime: '2026-10-05T01:00:00Z', updateTime: '2026-10-05T01:00:00Z' },
        { reviewId: 'r3', starRating: 'TWO', comment: 'Waited a while', displayName: 'Lee', createTime: '2026-10-09T01:00:00Z', updateTime: '2026-10-09T01:00:00Z', policyViolation: { type: 'SPAM' } },
      ];
      const result = await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'connect' });
      expect(result).toMatchObject({ outcome: 'synced', full: true, stored: 3, pages: 2 });
      const row = await conn();
      expect(row.config).toMatchObject({ account: 'accounts/111', location: 'locations/222', locationTitle: 'Ivanhoe Barber Co' });
      expect(row.capabilities).toMatchObject({ apiAccess: 'available', totalReviewCount: 3, averageRating: 4.5 });
      const rows = await storedReviews();
      expect(rows.map((r) => [r.externalReviewId, r.rating, r.reviewerName, r.replyText])).toEqual([
        ['r1', 5, 'Sam', 'Thanks Sam'],
        ['r2', 4, 'Anonymous', null],
        ['r3', 2, 'Lee', null],
      ]);
      expect(rows[0]?.raw).toMatchObject({ location: 'locations/222', reviewReplyState: 'REPLY_PUBLISHED' });
      expect(rows[2]?.raw).toMatchObject({ policyViolation: { type: 'SPAM' } });
      expect(enqueued).toEqual([{ type: 'website.connection_check', payload: { provider: 'business_profile_performance', reason: 'connect' } }]);
      // Read-only: every call to Google was a GET (apart from the token refresh).
      expect(google.fetch.calls.filter((c) => !c.url.includes('oauth2')).every((c) => c.method === 'GET')).toBe(true);
    });

    it('a daily sync is incremental: it stops at the stored updateTime watermark', async () => {
      google.state.reviews.push({ reviewId: 'r4', starRating: 'FIVE', comment: 'New one', displayName: 'Ash', createTime: '2026-11-10T01:00:00Z', updateTime: '2026-11-10T01:00:00Z' });
      const edited = google.state.reviews.find((r) => r.reviewId === 'r3')!;
      edited.reply = 'Sorry about the wait';
      edited.updateTime = '2026-11-11T01:00:00Z';
      const result = await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'daily' });
      expect(result).toMatchObject({ outcome: 'synced', full: false, stored: 2 });
      // Page 1 (r3, r4) plus page 2, where r1/r2 sit at or before the watermark: no page 3.
      expect(reviewCalls()).toBe(2);
      const rows = await storedReviews();
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.externalReviewId === 'r3')?.replyText).toBe('Sorry about the wait');
      expect(enqueued).toHaveLength(0);
      // A second run with nothing new reads one page and changes nothing.
      google.fetch.calls.length = 0;
      expect((await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'daily' })).stored).toBe(0);
      expect(reviewCalls()).toBe(1);
    });

    it("the weekly full sync picks up a review Google's page-2 issue left out of the incremental syncs", async () => {
      google.state.reviews.push({ reviewId: 'r0', starRating: 'THREE', comment: 'Old one', displayName: 'Kim', createTime: '2026-09-01T01:00:00Z', updateTime: '2026-09-01T01:00:00Z', hidden: true });
      await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'daily' });
      // Now Google lists it again, but it is older than the watermark: an incremental sync stops before reaching it.
      google.state.reviews.find((r) => r.reviewId === 'r0')!.hidden = false;
      await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'daily' });
      expect((await storedReviews()).some((r) => r.externalReviewId === 'r0')).toBe(false);
      const full = await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'weekly_full' });
      expect(full).toMatchObject({ outcome: 'synced', full: true, pages: 3, stored: 5 });
      expect((await storedReviews()).map((r) => r.externalReviewId)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    });

    it('several locations wait for the owner to choose; no reviews are read until then', async () => {
      google.state.locations.push({ name: 'locations/333', title: 'Second shop' });
      await handle.db.update(schema.integrationConnections).set({ config: {} }).where(eq(schema.integrationConnections.provider, 'google_business_profile'));
      const result = await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'daily' });
      expect(result.outcome).toBe('choose_location');
      expect(reviewCalls()).toBe(0);
      const row = await conn();
      expect(row.config['location']).toBeNull();
      expect((row.config['locations'] as unknown[]).length).toBe(2);
      // Restore the one-location set-up for the Performance tests.
      google.state.locations.pop();
      await handleReviewsGbpSync(ctx, fakeRun(), { reason: 'daily' });
      expect((await conn()).config['location']).toBe('locations/222');
    });
  });

  describe('Performance', () => {
    it('the probe records "waiting for Google approval" on quota 0 without touching the reviews status, then "available" and queues the first sync', async () => {
      google.state.performanceQuotaZero = true;
      await handleWebsiteConnectionCheck(ctx, fakeRun(), { provider: 'business_profile_performance', reason: 'connect' }, deps);
      let row = await conn();
      expect(row.capabilities['performanceApi']).toBe('awaiting_approval');
      expect(row.status).toBe('connected');
      expect(row.capabilities['apiAccess']).toBe('available');
      expect(enqueued).toHaveLength(0);
      // While waiting, the daily sync does nothing at all.
      google.fetch.calls.length = 0;
      await handleSearchSync(ctx, fakeRun(), { source: 'business_profile', reason: 'daily' }, deps, async () => {});
      expect(google.fetch.calls).toHaveLength(0);
      google.state.performanceQuotaZero = false;
      await handleWebsiteConnectionCheck(ctx, fakeRun(), { provider: 'business_profile_performance', reason: 'daily' }, deps);
      row = await conn();
      expect(row.capabilities['performanceApi']).toBe('available');
      expect(enqueued).toEqual([{ type: 'search.sync', payload: { source: 'business_profile', reason: 'connect' } }]);
    });

    it('stores a missing value as NULL (never 0), keeps thresholds, and a re-run gives identical rows', async () => {
      google.state.daily = {
        CALL_CLICKS: { '2026-11-01': '3', '2026-11-02': undefined, '2026-11-03': 0 },
        WEBSITE_CLICKS: { '2026-11-01': 7 },
        BUSINESS_IMPRESSIONS_MOBILE_MAPS: { '2026-11-02': '120' },
      };
      google.state.keywords = [
        { searchKeyword: 'barber ivanhoe', insightsValue: { value: '42' } },
        { searchKeyword: 'beard trim near me', insightsValue: { threshold: '15' } },
      ];
      await handleSearchSync(ctx, fakeRun(), { source: 'business_profile', reason: 'connect' }, deps, async () => {});
      const m = schema.searchMetrics;
      const metrics = await handle.db.select().from(m).where(and(eq(m.source, 'business_profile'), eq(m.kind, 'metric')));
      const byKey = Object.fromEntries(metrics.map((r) => [`${r.key}|${r.periodStart}`, r.value]));
      expect(byKey).toEqual({
        'CALL_CLICKS|2026-11-01': 3,
        'CALL_CLICKS|2026-11-02': null,
        'CALL_CLICKS|2026-11-03': 0,
        'WEBSITE_CLICKS|2026-11-01': 7,
        'BUSINESS_IMPRESSIONS_MOBILE_MAPS|2026-11-02': 120,
      });
      expect(metrics.every((r) => r.property === 'locations/222' && r.granularity === 'day')).toBe(true);
      const keywords = await handle.db.select().from(m).where(and(eq(m.source, 'business_profile'), eq(m.kind, 'keyword')));
      // Six complete months, each listing the same two keywords in this fake.
      expect(keywords).toHaveLength(12);
      expect(keywords.find((k) => k.key === 'beard trim near me')).toMatchObject({ value: null, valueThreshold: 15, granularity: 'month' });
      expect(keywords.find((k) => k.key === 'barber ivanhoe')).toMatchObject({ value: 42, valueThreshold: null });
      const snapshot = (await handle.db.select().from(m).where(eq(m.source, 'business_profile'))).map((r) => `${r.periodStart}|${r.kind}|${r.key}|${r.value}|${r.valueThreshold}`).sort();
      await handleSearchSync(ctx, fakeRun(), { source: 'business_profile', reason: 'connect' }, deps, async () => {});
      const again = (await handle.db.select().from(m).where(eq(m.source, 'business_profile'))).map((r) => `${r.periodStart}|${r.kind}|${r.key}|${r.value}|${r.valueThreshold}`).sort();
      expect(again).toEqual(snapshot);
      expect((await conn()).capabilities['performanceSyncedAt']).toBe(NOW.toISOString());
    });

    it('an unknown response shape fails with a plain message and stores nothing new', async () => {
      google.state.performanceShape = 'weird';
      const before = await handle.db.select().from(schema.searchMetrics);
      const err = await handleSearchSync(ctx, fakeRun(), { source: 'business_profile', reason: 'daily' }, deps, async () => {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((err as Error).message).toBe(UNRECOGNISED_RESPONSE_MESSAGE);
      expect((await conn()).capabilities).toMatchObject({ performanceApi: 'error', performanceMessage: UNRECOGNISED_RESPONSE_MESSAGE });
      expect(await handle.db.select().from(schema.searchMetrics)).toHaveLength(before.length);
      google.state.performanceShape = 'ok';
    });
  });

  it('invalid_grant marks the shared connection needs_reauth and stops without retrying', async () => {
    google.state.grant = 'invalid';
    await handle.db.update(schema.integrationConnections).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.integrationConnections.provider, 'google_business_profile'));
    await expect(handleReviewsGbpSync(ctx, fakeRun(), { reason: 'manual' })).rejects.toBeInstanceOf(NonRetryableError);
    const row = await conn();
    expect(row.status).toBe('needs_reauth');
    expect(row.lastError).toMatch(/sign in again/);
    // Performance uses the same row: it stops quietly, without calling Google.
    google.fetch.calls.length = 0;
    await handleSearchSync(ctx, fakeRun(), { source: 'business_profile', reason: 'daily' }, deps, async () => {});
    await handleWebsiteConnectionCheck(ctx, fakeRun(), { provider: 'business_profile_performance', reason: 'manual' }, deps);
    expect(google.fetch.calls).toHaveLength(0);
    google.state.grant = 'ok';
  });
});
