/**
 * TikTok posting through Zernio on a real database and real ffmpeg, with a SYNTHETIC export
 * (scripts/make-sample-footage.sh) and local fakes of Zernio (test/fakes/zernio-server.ts) and Meta's Graph API.
 * Covers publishing design §11.2 cases 7–11 and the WP10 acceptance list in docs/design/stage-bc-plan.md: consent
 * and the exact create body, crash recovery without a second create, `/retry`, webhooks as hints only, a partial post,
 * 207, drafts, 409, 402, 400, a changed account id and the read-only check. No real Zernio or Meta endpoint is ever
 * called. Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { execa } from 'execa';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { CancelledError, NonRetryableError, newId, type JobType, type TiktokInteractions, type ZernioConsent } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { LocalDiskStore, storageKeys } from '@studio/storage';
import { createAiProviders } from '@studio/ai';
import type { WorkerContext } from '../src/context.js';
import type { TrackedRun } from '../src/lib/job-tracker.js';
import { encryptCredential } from '../src/lib/credentials.js';
import { handlePublishPrepare } from '../src/handlers/publish-prepare.js';
import { handlePublishTarget } from '../src/handlers/publish-target.js';
import { handlePublishPoll } from '../src/handlers/publish-poll.js';
import { handlePublishDispatch } from '../src/handlers/publish-dispatch.js';
import { handleSocialCheck } from '../src/handlers/social-check.js';
import { handleWebhookProcess, webhookLookupFor } from '../src/handlers/webhook-process.js';
import { publishingModule } from '../src/modules/publishing/index.js';
import { refreshPostStatus } from '../src/publishing/post-status.js';
import { ZERNIO_CHOOSE_AGAIN_MESSAGE } from '../src/publishing/errors.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { FAKE_TIKTOK_ACCOUNT_ID, startFakeZernioServer, type FakeZernioServer } from './fakes/zernio-server.js';
import { startFakeGraphServer, type FakeGraphServer } from './fakes/graph-server.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SAMPLES = path.join(REPO, 'data', 'samples');
const skip = !testDatabaseUrl();

interface Queued {
  type: JobType;
  payload: Record<string, unknown>;
  options: { singletonKey?: string; startAfter?: Date; trackingJobId?: string };
}

function makeRun(jobId: string, willRetry = true): TrackedRun {
  const controller = new AbortController();
  return {
    jobId,
    signal: controller.signal,
    willRetry,
    progress: async () => {},
    message: async () => {},
    checkCancelled: () => {
      if (controller.signal.aborted) throw new CancelledError();
    },
    cancelledByOwner: async () => false,
  };
}

/** A small hand-written plan (10 s, no music): the music rule allows the standard file everywhere. */
function plan() {
  const seg = (id: string, inSec: number, outSec: number, role: string) => ({ id, assetId: 'a1', inSec, outSec, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role, keepOriginalSound: false });
  return {
    version: 1,
    styleId: 'clean_promo',
    title: 'Fade',
    description: '',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 10,
    segments: [seg('s1', 0, 5, 'cutting'), seg('s2', 6, 11, 'result')],
    textOverlays: [],
    captions: [],
    audio: { music: null, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'natural',
  };
}

describe.skipIf(skip)('TikTok via Zernio with a fake Zernio API (WP10)', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let root: string;
  let ctx: WorkerContext;
  let zernio: FakeZernioServer;
  let graph: FakeGraphServer;
  let exportBytes = 0;
  const queue: Queued[] = [];
  const userId = newId();
  const projectId = newId();
  const editId = newId();
  const v1 = newId();
  let zernioConnId = '';
  let tiktokAccountId = '';
  let igAccountId = '';

  const target = async (id: string) => (await handle.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, id) }))!;
  const post = async (id: string) => (await handle.db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, id) }))!;
  const account = async () => (await handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, tiktokAccountId) }))!;
  const conn = async () => (await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, zernioConnId) }))!;
  const creates = () => zernio.calls.filter((c) => c.endpoint === 'create');

  async function runJob(job: Queued): Promise<void> {
    const run = makeRun(job.options.trackingJobId ?? newId());
    const p = job.payload as never;
    switch (job.type) {
      case 'publish.prepare':
        return handlePublishPrepare(ctx, run, p);
      case 'publish.target':
        return handlePublishTarget(ctx, run, p);
      case 'publish.poll':
        return handlePublishPoll(ctx, run, p);
      case 'social.check':
        return handleSocialCheck(ctx, run, p);
      default:
        return;
    }
  }

  /** Runs queued jobs of the given types once each, in order (startAfter ignored), until none is left. */
  async function drain(types: JobType[] = ['publish.prepare', 'publish.target', 'publish.poll'], max = 40): Promise<string[]> {
    const ran: string[] = [];
    for (let i = 0; i < max; i++) {
      const idx = queue.findIndex((j) => types.includes(j.type));
      if (idx < 0) return ran;
      const [job] = queue.splice(idx, 1);
      if (!job) return ran;
      ran.push(job.type);
      try {
        await runJob(job);
      } catch (err) {
        if (err instanceof NonRetryableError || err instanceof CancelledError) continue;
        throw err;
      }
    }
    return ran;
  }

  /** Runs exactly one queued job of a type (the next poll, say). */
  async function runNext(type: JobType): Promise<Queued | null> {
    const idx = queue.findIndex((j) => j.type === type);
    if (idx < 0) return null;
    const [job] = queue.splice(idx, 1);
    await runJob(job!);
    return job!;
  }

  const interactions: TiktokInteractions = { allowComment: true, allowDuet: false, allowStitch: false };

  /** An approved post (as the approve route leaves it, consent included) with its targets, then `publish.prepare` queued. */
  async function createPost(input: {
    targets: Array<{ platform: 'instagram' | 'tiktok'; method: 'manual' | 'instagram_api' | 'zernio'; delivery?: 'publish' | 'draft'; isVerification?: boolean; consent?: boolean }>;
    caption?: string;
  }): Promise<{ postId: string; targetIds: string[] }> {
    const postId = newId();
    const caption = input.caption ?? `Skin fade, start to finish ${postId.slice(-6)}`;
    await handle.db.insert(schema.publishPosts).values({ id: postId, projectId, editVersionId: v1, createdBy: userId, caption, coverTimeSec: 2.5, mode: 'now', status: 'approved', approvedBy: userId, approvedAt: new Date() });
    const targetIds: string[] = [];
    for (const t of input.targets) {
      const id = newId();
      targetIds.push(id);
      const delivery = t.delivery ?? 'publish';
      const acct = t.method === 'zernio' ? await account() : null;
      const consent: ZernioConsent | null =
        t.method === 'zernio' && t.consent !== false && acct
          ? { tiktokPublic: true, at: new Date().toISOString(), userId, binding: { caption, coverTimeSec: 2.5, variant: 'standard', delivery, accountRowId: acct.id, handle: acct.username, interactions } }
          : null;
      await handle.db.insert(schema.publishTargets).values({
        id,
        postId,
        platform: t.platform,
        accountId: t.method === 'zernio' ? tiktokAccountId : t.method === 'instagram_api' ? igAccountId : null,
        idempotencyKey: `pt_${id}`,
        method: t.method,
        delivery,
        mediaVariant: 'standard',
        isVerification: t.isVerification ?? false,
        providerState: consent ? { consent } : {},
      });
    }
    queue.push({ type: 'publish.prepare', payload: { postId, projectId }, options: { singletonKey: `publish-prepare:${postId}`, trackingJobId: newId() } });
    return { postId, targetIds };
  }

  beforeAll(async () => {
    if (!existsSync(path.join(SAMPLES, 'sample_a_portrait_sdr.mp4'))) await execa('bash', [path.join(REPO, 'scripts', 'make-sample-footage.sh'), SAMPLES]);
    zernio = await startFakeZernioServer();
    graph = await startFakeGraphServer();
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    root = await mkdtemp(path.join(os.tmpdir(), 'sa-zernio-'));
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: t.url,
      APP_SECRET: 'test-secret-0123456789-0123456789-0123456789',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: path.join(root, 'storage'),
      WORKER_TMP_DIR: path.join(root, 'tmp'),
      AI_PROVIDER: 'none',
      TRANSCRIPTION_PROVIDER: 'none',
      TIKTOK_PUBLISH_PROVIDER: 'zernio',
      ZERNIO_API_BASE_URL: zernio.apiBase,
      META_APP_ID: 'fake-app',
      META_APP_SECRET: 'fake-app-secret',
      META_LOGIN_CONFIG_ID: 'fake-config',
      META_GRAPH_BASE_URL: graph.url,
      META_RUPLOAD_BASE_URL: graph.url,
    });
    const store = new LocalDiskStore({ rootDir: env.STORAGE_LOCAL_ROOT, appUrl: env.APP_URL, secret: env.APP_SECRET });
    const logger = pino({ level: 'silent' });
    ctx = {
      env,
      db: handle.db,
      store,
      queue: {
        enqueue: async (type: JobType, payload: Record<string, unknown>, options: Queued['options'] = {}) => {
          queue.push({ type, payload, options });
          return newId();
        },
      } as unknown as WorkerContext['queue'],
      ai: createAiProviders(env, logger),
      logger,
      workerId: 'test-worker',
      fontsDir: path.join(REPO, 'assets', 'fonts'),
      tmpRoot: env.WORKER_TMP_DIR,
    };
    await handle.db.insert(schema.users).values({ id: userId, email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    await handle.db.insert(schema.projects).values({ id: projectId, ownerId: userId, title: 'Synthetic Zernio project' });
    const gen = newId();
    await handle.db.insert(schema.generations).values({ id: gen, projectId, requestedBy: userId, settings: { durationSec: 10, styles: ['clean_promo'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null } });
    await handle.db.insert(schema.edits).values({ id: editId, projectId, generationId: gen, styleId: 'clean_promo', slot: 0, currentVersionId: v1 });
    // The synthetic clip stands in for the full-quality export (1080×1920 H.264/AAC, 12 s).
    const exportKey = storageKeys.editExport(projectId, editId, 1);
    const sample = path.join(SAMPLES, 'sample_a_portrait_sdr.mp4');
    await store.putFile(exportKey, sample);
    exportBytes = (await stat(sample)).size;
    await handle.db.insert(schema.editVersions).values({ id: v1, editId, versionNo: 1, origin: 'initial', status: 'preview_ready', plan: plan() as never, exportStatus: 'ready', exportKey, exportByteSize: exportBytes });
    // The Zernio connection as POST /api/integrations/zernio stores it (key encrypted at rest).
    zernioConnId = newId();
    await handle.db.insert(schema.integrationConnections).values({ id: zernioConnId, provider: 'zernio', status: 'connected', accessTokenEncrypted: encryptCredential(env, zernio.scenario.key), config: { keyHint: zernio.scenario.key.slice(-4) } });
    // Instagram, verified and switched on, for the two-destination case.
    const metaConnId = newId();
    await handle.db.insert(schema.integrationConnections).values({ id: metaConnId, provider: 'meta', status: 'connected', accessTokenEncrypted: encryptCredential(env, graph.scenario.token) });
    igAccountId = newId();
    await handle.db.insert(schema.socialAccounts).values({ id: igAccountId, platform: 'instagram', externalId: graph.scenario.igUserId, username: graph.scenario.username, provider: 'meta_graph', connectionId: metaConnId, status: 'connected', directPublishEnabled: true, capabilities: { verifiedDirectAt: new Date().toISOString(), resumableMaxBytes: 104857600 } });
  }, 120_000);

  afterAll(async () => {
    await zernio?.close();
    await graph?.close();
    await drop?.();
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    queue.length = 0;
  });

  describe('social.check (read-only)', () => {
    it('checks the key, lists the TikTok accounts with their lane, and never posts', async () => {
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'connect' });
      const c = await conn();
      expect(c).toMatchObject({ status: 'connected', lastError: null, displayName: '@ivanhoe_studio_test' });
      const candidates = c.config['candidates'] as Array<Record<string, unknown>>;
      expect(candidates).toEqual([expect.objectContaining({ id: FAKE_TIKTOK_ACCOUNT_ID, username: 'ivanhoe_studio_test', integrationLane: 'business', canPost: true, problem: null })]);
      for (const call of zernio.calls) expect(call.headers.authorization).toBe(`Bearer ${zernio.scenario.key}`);
      expect(zernio.count('create') + zernio.count('presign') + zernio.count('upload') + zernio.count('retry')).toBe(0);
      expect(zernio.calls.map((x) => x.endpoint)).toEqual(['verify', 'accounts', 'health']);
    });

    it('records lane, permission and creator-info seeds for the chosen account', async () => {
      // What POST /api/integrations/zernio/account stores for the chosen candidate.
      tiktokAccountId = newId();
      await handle.db.insert(schema.socialAccounts).values({ id: tiktokAccountId, platform: 'tiktok', externalId: FAKE_TIKTOK_ACCOUNT_ID, username: 'ivanhoe_studio_test', provider: 'zernio', connectionId: zernioConnId, status: 'connected' });
      zernio.calls.length = 0;
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      const a = await account();
      expect(a.status).toBe('connected');
      expect(a.capabilities).toMatchObject({ businessApiLane: true, integrationLane: 'business', canPost: true, allowCommentEnabled: true, allowCommentDefault: true, allowDuetEnabled: true, allowDuetDefault: false, allowStitchEnabled: false, privacyPublicAllowed: true, maxVideoDurationSec: 600, canPostMore: true });
      const ci = zernio.calls.find((x) => x.endpoint === 'creator_info');
      expect(ci?.query).toEqual({ mediaType: 'video' });
      expect(zernio.count('create')).toBe(0);
    });

    it('a developer-lane account, a refused key, a key without a group and a vanished account id are reported plainly', async () => {
      zernio.scenario.health[FAKE_TIKTOK_ACCOUNT_ID] = { status: 'healthy', integrationLane: 'developer', tokenStatus: { valid: true }, permissions: { canPost: true } };
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect(await account()).toMatchObject({ status: 'needs_reauth', lastError: 'Reconnect TikTok inside Zernio to move it to the Business connection.' });
      delete zernio.scenario.health[FAKE_TIKTOK_ACCOUNT_ID];

      zernio.scenario.failOnce.verify = { status: 401, body: { error: 'Invalid API key', type: 'authentication_error', code: 'invalid_credentials' } };
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect(await conn()).toMatchObject({ status: 'needs_reauth', lastError: "Zernio didn't accept this key. Paste a new Zernio API key in Settings → Integrations." });

      zernio.scenario.failOnce.accounts = { status: 403, body: { error: 'Forbidden', type: 'permission_error', code: 'insufficient_permissions', required_group: 'accounts' } };
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect(await conn()).toMatchObject({ status: 'error', lastError: "This Zernio key can't use accounts. Create a key with Accounts and Publishing switched on." });

      const saved = zernio.scenario.accounts;
      zernio.scenario.accounts = [{ ...saved[0], _id: 'a-new-id-after-reconnect' }];
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect(await account()).toMatchObject({ status: 'needs_reauth', lastError: ZERNIO_CHOOSE_AGAIN_MESSAGE });
      zernio.scenario.accounts = saved;
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect(await account()).toMatchObject({ status: 'connected', lastError: null });
      expect(await conn()).toMatchObject({ status: 'connected', lastError: null });
      expect(zernio.count('create')).toBe(0);
    });

    it('a 429 on an account\'s health is rate limiting, not a reconnect: the check stops to run again and records no problem', async () => {
      expect(await account()).toMatchObject({ status: 'connected', lastError: null });
      zernio.scenario.failOnce.health = { status: 429, body: { error: 'Rate limit exceeded. Please retry after 12 seconds.', details: { currentCount: 61, limit: 60, retryAfterSeconds: 12 } }, headers: { 'retry-after': '12' } };
      await expect(handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' })).rejects.toMatchObject({ httpStatus: 429 });
      expect(await account()).toMatchObject({ status: 'connected', lastError: null });
      expect(await conn()).toMatchObject({ status: 'connected', lastError: null });
      const candidates = (await conn()).config['candidates'] as Array<Record<string, unknown>>;
      expect(candidates.every((c) => c['problem'] === null)).toBe(true);
      // A 404 on the stored id is about the account itself, so it is still reported plainly.
      zernio.scenario.failOnce.health = { status: 404, body: { error: 'Account not found', type: 'invalid_request_error', code: 'not_found' } };
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect((await account()).status).toBe('needs_reauth');
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect(await account()).toMatchObject({ status: 'connected', lastError: null });
      expect(zernio.count('create')).toBe(0);
    });
  });

  describe('publishing', () => {
    beforeEach(() => {
      zernio.reset();
    });

    it('8. happy path: consent, health and creator info, presign, PUT, the exact create body, polls, published, then the link', async () => {
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const [tid] = targetIds as [string];
      await drain(['publish.prepare', 'publish.target']);
      const t = await target(tid);
      expect(t).toMatchObject({ status: 'processing', externalPostId: expect.any(String) });
      expect(t.submittedAt).not.toBeNull();
      expect(zernio.calls.map((c) => c.endpoint)).toEqual(['health', 'accounts', 'creator_info', 'presign', 'upload', 'create']);
      const upload = zernio.calls.find((c) => c.endpoint === 'upload')!;
      expect(upload.headers.authorization).toBeUndefined();
      expect(upload.headers['content-type']).toBe('video/mp4');
      expect(upload.headers['content-length']).toBe(String(exportBytes));
      expect(upload.headers['transfer-encoding']).toBeUndefined();
      expect(upload.bytes).toBe(exportBytes);
      const presign = zernio.calls.find((c) => c.endpoint === 'presign')!;
      expect(presign.body).toEqual({ filename: `${tid}.mp4`, contentType: 'video/mp4', size: exportBytes });
      const create = creates()[0]!;
      expect(zernio.invalidBodies).toEqual([]);
      expect(create.headers['idempotency-key']).toBe(tid);
      const body = create.body as Record<string, unknown>;
      expect(body).toEqual({
        content: (await post(postId)).caption,
        mediaItems: [{ type: 'video', url: expect.stringMatching(/^https:\/\/media\.zernio\.example\//) }],
        platforms: [{ platform: 'tiktok', accountId: FAKE_TIKTOK_ACCOUNT_ID }],
        tiktokSettings: { privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: false, allow_stitch: false, content_preview_confirmed: true, express_consent_given: true, video_cover_timestamp_ms: 2500 },
        publishNow: true,
        metadata: { studioTargetId: tid },
      });
      expect(JSON.stringify(body)).not.toContain('isDraft');
      // Nothing is learned from or recorded as used before TikTok confirms.
      expect(await handle.db.query.feedbackEvents.findMany({ where: and(eq(schema.feedbackEvents.editVersionId, v1), eq(schema.feedbackEvents.type, 'publish')) })).toHaveLength(0);

      await runNext('publish.poll');
      expect((await target(tid)).status).toBe('processing');
      zernio.setPost(t.externalPostId!, { status: 'published', entry: { status: 'published', publishedAt: new Date().toISOString(), platformPostUrl: null } });
      await runNext('publish.poll');
      let done = await target(tid);
      expect(done).toMatchObject({ status: 'published', publishedUrl: null, statusMessage: 'Published. The TikTok link appears in a few minutes.' });
      expect((await post(postId)).status).toBe('complete');
      expect(await handle.db.query.feedbackEvents.findMany({ where: and(eq(schema.feedbackEvents.editVersionId, v1), eq(schema.feedbackEvents.type, 'publish')) })).toHaveLength(1);
      zernio.setPost(t.externalPostId!, { entry: { platformPostUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7311111111111111111' } });
      await runNext('publish.poll');
      done = await target(tid);
      expect(done.publishedUrl).toBe('https://www.tiktok.com/@ivanhoe_studio_test/video/7311111111111111111');
      expect(queue.filter((j) => j.type === 'publish.poll')).toHaveLength(0);
      expect(creates()).toHaveLength(1);
    }, 60_000);

    it('sends nothing without the consent tick, or when the post changed after approval', async () => {
      const a = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true, consent: false }] });
      await drain(['publish.prepare', 'publish.target']);
      expect(await target(a.targetIds[0]!)).toMatchObject({ status: 'failed', submittedAt: null });
      expect((await target(a.targetIds[0]!)).statusMessage).toMatch(/consent tick/);
      const b = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      await handle.db.update(schema.publishPosts).set({ caption: 'Changed after approval' }).where(eq(schema.publishPosts.id, b.postId));
      await drain(['publish.prepare', 'publish.target']);
      expect((await target(b.targetIds[0]!)).status).toBe('failed');
      expect(zernio.count('presign') + zernio.count('create')).toBe(0);
    }, 60_000);

    it('a 207 with "scheduled" stays queued, then publishes', async () => {
      zernio.scenario.createStatus = 207;
      zernio.scenario.createPostStatus = 'scheduled';
      zernio.scenario.createEntry = { status: 'pending' };
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      await drain(['publish.prepare', 'publish.target']);
      const t = await target(targetIds[0]!);
      expect(t).toMatchObject({ status: 'queued', statusMessage: 'Zernio hit a temporary problem and will retry by itself.' });
      await runNext('publish.poll');
      expect((await target(t.id)).status).toBe('queued');
      zernio.setPost(t.externalPostId!, { status: 'published', entry: { status: 'published', platformPostUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7322222222222222222' } });
      await runNext('publish.poll');
      expect(await target(t.id)).toMatchObject({ status: 'published', publishedUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7322222222222222222' });
      expect(creates()).toHaveLength(1);
    }, 60_000);

    it('a delivered draft becomes "finish in the TikTok app" with isDraft, with the echoed tiktokSettings.draft, or with neither', async () => {
      const markers: Array<Record<string, unknown>> = [{ isDraft: true }, { tiktokSettings: { draft: true } }, {}];
      for (const psd of markers) {
        zernio.reset();
        zernio.scenario.createPostStatus = 'published';
        zernio.scenario.createEntry = { status: 'published', platformPostUrl: null, platformSpecificData: psd };
        const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', delivery: 'draft', isVerification: true }] });
        await drain(['publish.prepare', 'publish.target']);
        expect(await target(targetIds[0]!)).toMatchObject({ status: 'manual_step_required', manualStep: 'finish_in_tiktok_app' });
        const body = creates()[0]!.body as { tiktokSettings: Record<string, unknown>; publishNow: boolean };
        expect(body.tiktokSettings['draft']).toBe(true);
        expect(body.publishNow).toBe(true);
        expect(zernio.invalidBodies).toEqual([]);
      }
    }, 90_000);

    it('a 409 duplicate is adopted when its metadata is ours, and refused plainly when it is not', async () => {
      const mine = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const existing = zernio.addPost({ status: 'publishing', metadata: { studioTargetId: mine.targetIds[0] }, platforms: [{ platform: 'tiktok', accountId: FAKE_TIKTOK_ACCOUNT_ID, status: 'processing' }] });
      zernio.scenario.failOnce.create = { status: 409, body: { error: 'Duplicate content detected', type: 'invalid_request_error', code: 'duplicate_content', details: { existingPostId: existing } } };
      await drain(['publish.prepare', 'publish.target']);
      expect(await target(mine.targetIds[0]!)).toMatchObject({ status: 'processing', externalPostId: existing });

      const other = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const foreign = zernio.addPost({ status: 'published', metadata: { studioTargetId: 'someone-else' }, platforms: [{ platform: 'tiktok', accountId: FAKE_TIKTOK_ACCOUNT_ID, status: 'published' }] });
      zernio.scenario.failOnce.create = { status: 409, body: { error: 'Duplicate content detected', details: { existingPostId: foreign } } };
      await drain(['publish.prepare', 'publish.target']);
      const t = await target(other.targetIds[0]!);
      expect(t).toMatchObject({ status: 'failed', externalPostId: null, submittedAt: null });
      expect(t.statusMessage).toMatch(/already went to @ivanhoe_studio_test in the last 24 hours/);
      expect(t.providerState.retryable).toBe(false);
    }, 60_000);

    it('any 402 is a billing problem on the connection, whatever its code', async () => {
      for (const code of ['PAYMENT_REQUIRED', 'payment_required', undefined]) {
        zernio.reset();
        zernio.scenario.failOnce.create = { status: 402, body: { error: 'Payment required', ...(code ? { code } : {}) } };
        const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
        await drain(['publish.prepare', 'publish.target']);
        expect(await target(targetIds[0]!)).toMatchObject({ status: 'failed', submittedAt: null });
        expect(await conn()).toMatchObject({ status: 'error', lastError: 'Zernio refused for a billing reason. Check your Zernio billing page, then try again.' });
      }
      await handle.db.update(schema.integrationConnections).set({ status: 'connected', lastError: null }).where(eq(schema.integrationConnections.id, zernioConnId));
    }, 90_000);

    it('a 409 ads_connection_required fails (retryable) and queues an account check', async () => {
      zernio.scenario.failOnce.create = { status: 409, body: { error: 'The account is inactive', type: 'invalid_request_error', code: 'ads_connection_required' } };
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      await drain(['publish.prepare', 'publish.target']);
      const t = await target(targetIds[0]!);
      expect(t).toMatchObject({ status: 'failed', submittedAt: null });
      expect(t.providerState.retryable).toBe(true);
      expect(queue.some((j) => j.type === 'social.check')).toBe(true);
    }, 60_000);

    it('a 400 clears submitted_at and the upload; the owner\'s Retry uploads again before one create with the same key', async () => {
      zernio.scenario.failOnce.create = { status: 400, body: { error: 'Media URL expired', type: 'invalid_request_error', code: 'validation_error' } };
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      let t = await target(tid);
      expect(t).toMatchObject({ status: 'failed', submittedAt: null, externalPostId: null });
      expect(t.providerState['zernioMediaUrl']).toBeNull();
      expect(t.statusMessage).toMatch(/Zernio said: Media URL expired/);
      expect(t.providerState.retryable).toBe(true);
      // The owner presses Retry (what POST /api/publish-targets/[id]/retry does).
      await handle.db.update(schema.publishTargets).set({ status: 'queued' }).where(eq(schema.publishTargets.id, tid));
      queue.push({ type: 'publish.target', payload: { targetId: tid, postId: t.postId, projectId }, options: { trackingJobId: newId() } });
      await drain(['publish.target']);
      t = await target(tid);
      expect(t.status).toBe('processing');
      expect(zernio.count('presign')).toBe(2);
      expect(zernio.count('upload')).toBe(2);
      const cs = creates();
      expect(cs).toHaveLength(2);
      expect(cs[1]!.headers['idempotency-key']).toBe(cs[0]!.headers['idempotency-key']);
      const order = zernio.calls.map((c) => c.endpoint);
      expect(order.lastIndexOf('upload')).toBeLessThan(order.lastIndexOf('create'));
    }, 60_000);

    it('a stored account id missing from the account list makes the account need re-choosing; nothing is sent', async () => {
      // Zernio still answers the stored id's health, but no longer lists it (a reconnect gave the account a new id).
      zernio.scenario.accounts = [{ ...zernio.scenario.accounts[0], _id: 'different-id' }];
      zernio.scenario.health[FAKE_TIKTOK_ACCOUNT_ID] = { status: 'healthy', integrationLane: 'business', tokenStatus: { valid: true }, permissions: { canPost: true } };
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      await drain(['publish.prepare', 'publish.target']);
      expect(await target(targetIds[0]!)).toMatchObject({ status: 'manual_step_required', manualStep: 'reconnect_account', submittedAt: null });
      expect(await account()).toMatchObject({ status: 'needs_reauth', lastError: ZERNIO_CHOOSE_AGAIN_MESSAGE });
      expect(zernio.count('create') + zernio.count('presign')).toBe(0);
      await handle.db.update(schema.socialAccounts).set({ status: 'connected', lastError: null }).where(eq(schema.socialAccounts.id, tiktokAccountId));
    }, 60_000);

    it('an account in a Zernio cooldown waits instead of calling', async () => {
      zernio.scenario.accounts = [{ ...zernio.scenario.accounts[0], rateLimitedUntil: new Date(Date.now() + 20 * 60_000).toISOString() }];
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      await drain(['publish.prepare', 'publish.target']);
      expect(await target(targetIds[0]!)).toMatchObject({ status: 'queued', submittedAt: null });
      const again = queue.find((j) => j.type === 'publish.target');
      expect(again?.options.startAfter?.getTime()).toBeGreaterThan(Date.now() + 19 * 60_000);
      expect(zernio.count('create')).toBe(0);
    }, 60_000);

    it('9. a crash between the create and saving the post id: the metadata lookup adopts the post; never a second create', async () => {
      zernio.scenario.dropAfterCreate = true;
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      let t = await target(tid);
      expect(t).toMatchObject({ status: 'processing', externalPostId: null });
      expect(t.submittedAt).not.toBeNull();
      expect(creates()).toHaveLength(1);
      // A second publish.target for the same target (a queue retry) never creates again.
      await handle.db.update(schema.publishTargets).set({ status: 'queued' }).where(eq(schema.publishTargets.id, tid));
      queue.push({ type: 'publish.target', payload: { targetId: tid, postId: t.postId, projectId }, options: { trackingJobId: newId() } });
      await runNext('publish.target');
      expect(creates()).toHaveLength(1);
      await runNext('publish.poll');
      t = await target(tid);
      const created = [...zernio.posts.values()].find((p) => (p['metadata'] as Record<string, unknown>)['studioTargetId'] === tid)!;
      expect(t.externalPostId).toBe(created['_id']);
      const list = zernio.calls.find((c) => c.endpoint === 'list_posts')!;
      expect(Object.keys(list.query).sort()).toEqual(['accountId', 'fields', 'updatedSince']);
      expect(list.query['fields']).toBe('metadata,status,platforms');
      expect(creates()).toHaveLength(1);
    }, 60_000);

    it('9b. when the lookup finds nothing: "check before retry", and "try again" sends one create with the same key', async () => {
      zernio.scenario.dropAfterCreate = true;
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      for (const [id, p] of zernio.posts) if ((p['metadata'] as Record<string, unknown>)['studioTargetId'] === tid) zernio.posts.delete(id);
      for (let i = 0; i < 4; i++) await runNext('publish.poll');
      let t = await target(tid);
      expect(t).toMatchObject({ status: 'manual_step_required', manualStep: 'check_before_retry' });
      expect(zernio.count('list_posts')).toBe(4);
      expect(creates()).toHaveLength(1);
      // The owner chose "It's not there – try again" (what the resolve route writes).
      await handle.db.update(schema.publishTargets).set({ status: 'queued', manualStep: null, submittedAt: null }).where(eq(schema.publishTargets.id, tid));
      queue.push({ type: 'publish.target', payload: { targetId: tid, postId: t.postId, projectId }, options: { trackingJobId: newId() } });
      await runNext('publish.target');
      const cs = creates();
      expect(cs).toHaveLength(2);
      expect(cs[1]!.headers['idempotency-key']).toBe(tid);
      expect(cs[0]!.headers['idempotency-key']).toBe(tid);
      t = await target(tid);
      expect(t.externalPostId).toBeTruthy();
    }, 60_000);

    it('10. a failed Zernio post: Retry calls /v1/posts/{id}/retry and never creates a new post', async () => {
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      const id = (await target(tid)).externalPostId!;
      zernio.setPost(id, { status: 'failed', entry: { status: 'failed', errorMessage: 'Upstream timeout', errorCategory: 'network', errorSource: 'platform' } });
      await runNext('publish.poll');
      let t = await target(tid);
      expect(t).toMatchObject({ status: 'failed' });
      expect(t.statusMessage).toMatch(/TikTok said: Upstream timeout/);
      expect(t.providerState.retryable).toBe(true);
      await handle.db.update(schema.publishTargets).set({ status: 'queued' }).where(eq(schema.publishTargets.id, tid));
      queue.push({ type: 'publish.target', payload: { targetId: tid, postId: t.postId, projectId }, options: { trackingJobId: newId() } });
      await runNext('publish.target');
      expect(zernio.count('retry')).toBe(1);
      expect(zernio.calls.find((c) => c.endpoint === 'retry')?.path).toBe(`/api/v1/posts/${id}/retry`);
      expect(creates()).toHaveLength(1);
      t = await target(tid);
      expect(t.status).toBe('processing');
      zernio.setPost(id, { status: 'published', entry: { status: 'published', platformPostUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7333333333333333333' } });
      await drain(['publish.poll']);
      expect((await target(tid)).status).toBe('published');
    }, 60_000);

    it('7. two destinations: a failed Instagram target never undoes the published TikTok one; partial, then complete', async () => {
      graph.scenario.failOnce = { create: { status: 400, code: 100, subcode: 2207026, message: 'The video format is not supported' } };
      graph.scenario.statusSequence = ['FINISHED'];
      graph.scenario.copyright = { status: 'complete', matches_found: false };
      zernio.scenario.createPostStatus = 'published';
      zernio.scenario.createEntry = { status: 'published', platformPostUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7344444444444444444' };
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }, { platform: 'tiktok', method: 'zernio', isVerification: true }] });
      await drain();
      const [ig, tt] = [await target(targetIds[0]!), await target(targetIds[1]!)];
      expect(ig.status).toBe('failed');
      expect(tt).toMatchObject({ status: 'published', publishedUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7344444444444444444' });
      expect((await post(postId)).status).toBe('partial');
      await handle.db.update(schema.publishTargets).set({ status: 'queued' }).where(eq(schema.publishTargets.id, ig.id));
      queue.push({ type: 'publish.target', payload: { targetId: ig.id, postId, projectId }, options: { trackingJobId: newId() } });
      await drain();
      expect((await target(ig.id)).status).toBe('published');
      expect(await target(tt.id)).toMatchObject({ status: 'published', publishedUrl: tt.publishedUrl, externalPostId: tt.externalPostId });
      expect((await post(postId)).status).toBe('complete');
      expect(creates()).toHaveLength(1);
    }, 120_000);

    it('11. webhooks only trigger a read: matched by metadata first, read by the stored id; a forged event changes nothing', async () => {
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      queue.length = 0;
      const stored = (await target(tid)).externalPostId!;
      const lookup = webhookLookupFor([publishingModule]);
      const store = async (payload: Record<string, unknown>, externalEventId: string) => {
        const id = newId();
        await handle.db.insert(schema.webhookEvents).values({ id, provider: 'zernio', externalEventId, eventType: String(payload['event']), payload, signatureValid: true });
        await handleWebhookProcess(ctx, makeRun(newId()), { webhookEventId: id }, lookup);
        return id;
      };
      // The event names a different post id than ours, but its metadata is our target: matched, and the poll reads OUR id.
      const evId = await store({ id: 'evt_1', event: 'post.platform.published', postId: 'some-other-id', studioTargetId: tid, platform: 'tiktok', accountId: FAKE_TIKTOK_ACCOUNT_ID }, 'evt_1');
      expect((await handle.db.query.webhookEvents.findFirst({ where: eq(schema.webhookEvents.id, evId) }))?.processedAt).not.toBeNull();
      expect(queue.filter((j) => j.type === 'publish.poll')).toHaveLength(1);
      // The event itself changed nothing.
      expect((await target(tid)).status).toBe('processing');
      zernio.calls.length = 0;
      await runNext('publish.poll');
      expect(zernio.calls.find((c) => c.endpoint === 'get_post')?.path).toBe(`/api/v1/posts/${stored}`);
      // A forged event for an unknown post: no poll, no change.
      queue.length = 0;
      await store({ id: 'evt_forged', event: 'post.published', postId: 'not-ours', studioTargetId: null, platform: 'tiktok', accountId: null }, 'unverified:abc');
      expect(queue).toHaveLength(0);
      expect((await target(tid)).status).toBe('processing');
      // account.disconnected only queues the read-only check.
      await store({ id: 'evt_acct', event: 'account.disconnected', postId: null, studioTargetId: null, platform: null, accountId: FAKE_TIKTOK_ACCOUNT_ID }, 'evt_acct');
      expect(queue.map((j) => j.type)).toEqual(['social.check']);
    }, 60_000);

    it('reports a reversal: a published target Zernio later reports failed follows Zernio and is audited', async () => {
      zernio.scenario.createPostStatus = 'published';
      zernio.scenario.createEntry = { status: 'published', platformPostUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7355555555555555555' };
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      expect((await target(tid)).status).toBe('published');
      zernio.setPost((await target(tid)).externalPostId!, { status: 'failed', entry: { status: 'failed', errorMessage: 'Publish never completed', errorSource: 'platform' } });
      queue.push({ type: 'publish.poll', payload: { targetId: tid, postId, projectId, pollNo: 0 }, options: { trackingJobId: newId() } });
      await runNext('publish.poll');
      expect((await target(tid)).status).toBe('failed');
      const audit = await handle.db.query.auditLog.findMany({ where: and(eq(schema.auditLog.entityId, tid), eq(schema.auditLog.action, 'publish.target.reconciled')) });
      expect(audit).toHaveLength(1);
      await refreshPostStatus(handle.db, postId);
    }, 60_000);

    it('does nothing at Zernio while the server flag is off', async () => {
      const off = { ...ctx, env: { ...ctx.env, TIKTOK_PUBLISH_PROVIDER: 'none' as const } };
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      await handlePublishPrepare(off, makeRun(newId()), { postId, projectId });
      queue.length = 0;
      await handlePublishTarget(off, makeRun(newId()), { targetId: targetIds[0]!, postId, projectId });
      const t = await target(targetIds[0]!);
      expect(t.status).toBe('failed');
      expect(t.statusMessage).toMatch(/switched off on this server/);
      await handleSocialCheck(off, makeRun(newId()), { connectionId: zernioConnId, reason: 'manual' });
      expect(zernio.calls).toHaveLength(0);
    }, 60_000);

    it('the end of the 50-hour window: a processing or held (queued) target gets a last read at 50 h, then "check before retry"', async () => {
      const setSubmitted = async (id: string, hoursAgo: number) => {
        await handle.db.update(schema.publishTargets).set({ submittedAt: new Date(Date.now() - hoursAgo * 3600_000) }).where(eq(schema.publishTargets.id, id));
      };
      const polls = () => queue.filter((j) => j.type === 'publish.poll');
      for (const held of [false, true]) {
        zernio.reset();
        queue.length = 0;
        if (held) {
          zernio.scenario.createStatus = 207;
          zernio.scenario.createPostStatus = 'scheduled';
          zernio.scenario.createEntry = { status: 'pending' };
        }
        const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
        const tid = targetIds[0]!;
        await drain(['publish.prepare', 'publish.target']);
        expect(await target(tid)).toMatchObject({ status: held ? 'queued' : 'processing', externalPostId: expect.any(String) });
        // Part-way through the last hour (49.5 h): one more read is scheduled, at the window's end itself.
        await setSubmitted(tid, 49.5);
        const before = Date.now();
        await runNext('publish.poll');
        expect((await target(tid)).status).toBe(held ? 'queued' : 'processing');
        const last = polls();
        expect(last).toHaveLength(1);
        const wait = last[0]!.options.startAfter!.getTime() - before;
        expect(wait).toBeGreaterThan(29 * 60_000);
        expect(wait).toBeLessThan(31 * 60_000);
        // That read, at (just past) 50 h: Zernio still has not finished, so the owner checks TikTok.
        await setSubmitted(tid, 50 + 1 / 60);
        await runNext('publish.poll');
        expect(await target(tid)).toMatchObject({ status: 'manual_step_required', manualStep: 'check_before_retry' });
        expect(polls()).toHaveLength(0);
        expect(creates()).toHaveLength(1);
      }
    }, 90_000);

    it('the crash-recovery lookup follows pagination.nextCursor with the same filters until it finds the post', async () => {
      zernio.posts.clear();
      zernio.scenario.listPageSize = 1;
      for (let i = 0; i < 3; i++) zernio.addPost({ status: 'published', metadata: { studioTargetId: `someone-else-${i}` }, platforms: [{ platform: 'tiktok', accountId: FAKE_TIKTOK_ACCOUNT_ID, status: 'published' }], updatedAt: new Date().toISOString() });
      zernio.scenario.dropAfterCreate = true;
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      expect(await target(tid)).toMatchObject({ status: 'processing', externalPostId: null });
      await runNext('publish.poll');
      const created = [...zernio.posts.values()].find((p) => (p['metadata'] as Record<string, unknown>)['studioTargetId'] === tid)!;
      expect((await target(tid)).externalPostId).toBe(created['_id']);
      const lists = zernio.calls.filter((c) => c.endpoint === 'list_posts');
      expect(lists).toHaveLength(4);
      expect(lists[0]!.query['cursor']).toBeUndefined();
      for (const l of lists.slice(1)) {
        expect(l.query['cursor']).toBeTruthy();
        expect({ ...l.query, cursor: undefined }).toEqual({ ...lists[0]!.query, cursor: undefined });
      }
      expect(creates()).toHaveLength(1);
    }, 60_000);

    it('webhook hints never use up a lookup, and a genuine late event still adopts the post at "check before retry" (account must match)', async () => {
      zernio.scenario.dropAfterCreate = true;
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const tid = targetIds[0]!;
      await drain(['publish.prepare', 'publish.target']);
      const [zid, created] = [...zernio.posts.entries()].find(([, p]) => (p['metadata'] as Record<string, unknown>)['studioTargetId'] === tid)!;
      zernio.posts.delete(zid);
      const lookup = webhookLookupFor([publishingModule]);
      const deliver = async (payload: Record<string, unknown>) => {
        const id = newId();
        await handle.db.insert(schema.webhookEvents).values({ id, provider: 'zernio', externalEventId: `unverified:${id}`, eventType: String(payload['event']), payload, signatureValid: false });
        await handleWebhookProcess(ctx, makeRun(newId()), { webhookEventId: id }, lookup);
      };
      const hintPolls = () => queue.filter((j) => j.type === 'publish.poll' && j.payload['hint'] === true);
      const runHint = async () => {
        const idx = queue.findIndex((j) => j.type === 'publish.poll' && j.payload['hint'] === true);
        const [job] = queue.splice(idx, 1);
        await runJob(job!);
      };
      // Unverified hints while the post cannot be found: each reads, none uses up a lookup or schedules one.
      for (let i = 0; i < 3; i++) {
        await deliver({ id: `evt_h${i}`, event: 'post.platform.published', postId: null, studioTargetId: tid, platform: 'tiktok', accountId: null });
        expect(hintPolls()).toHaveLength(1);
        await runHint();
        expect(hintPolls()).toHaveLength(0);
      }
      let t = await target(tid);
      expect(t).toMatchObject({ status: 'processing', externalPostId: null });
      expect(Number(t.providerState['zernioLookupAttempt'] ?? 0)).toBe(0);
      expect(queue.filter((j) => j.type === 'publish.poll')).toHaveLength(1);
      // The four scheduled lookups still run in full before the owner is asked to check.
      for (let i = 0; i < 4; i++) await runNext('publish.poll');
      t = await target(tid);
      expect(t).toMatchObject({ status: 'manual_step_required', manualStep: 'check_before_retry', externalPostId: null });
      // A late event naming the post, whose TikTok entry carries no account: read back, but not adopted.
      const platforms = created['platforms'] as Array<Record<string, unknown>>;
      zernio.posts.set(zid, { ...created, platforms: platforms.map((p) => ({ ...p, accountId: undefined })) });
      await deliver({ id: 'evt_noacct', event: 'post.platform.published', postId: zid, studioTargetId: tid, platform: 'tiktok', accountId: null });
      await runHint();
      expect(await target(tid)).toMatchObject({ status: 'manual_step_required', manualStep: 'check_before_retry', externalPostId: null });
      // The genuine event: metadata and account match, so the post is adopted and read again; nothing is sent twice.
      zernio.posts.set(zid, created);
      zernio.setPost(zid, { status: 'published', entry: { status: 'published', platformPostUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7366666666666666666' } });
      await deliver({ id: 'evt_late', event: 'post.platform.published', postId: zid, studioTargetId: tid, platform: 'tiktok', accountId: FAKE_TIKTOK_ACCOUNT_ID });
      await runHint();
      expect(await target(tid)).toMatchObject({ status: 'published', manualStep: null, externalPostId: zid, publishedUrl: 'https://www.tiktok.com/@ivanhoe_studio_test/video/7366666666666666666' });
      expect(creates()).toHaveLength(1);
    }, 60_000);
  });

  describe('publish.dispatch safety net (only for targets with no live read)', () => {
    const stale = () => new Date(Date.now() - 70 * 60_000);
    const queuePollRow = async (targetId: string, postId: string) => {
      await handle.db.insert(schema.jobs).values({ id: newId(), type: 'publish.poll', projectId, refId: targetId, payload: { targetId, postId, projectId, pollNo: 9 }, status: 'queued' });
    };

    it('leaves a Zernio target with a post id alone while its next hourly read is queued; catches it when no read is left', async () => {
      const a = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const b = await createPost({ targets: [{ platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const [postId, live, lost] = [a.postId, a.targetIds[0]!, b.targetIds[0]!];
      for (const [i, id] of [live, lost].entries()) {
        await handle.db.update(schema.publishTargets).set({ status: 'processing', submittedAt: new Date(Date.now() - 8 * 3600_000), externalPostId: `zp-${i}-${id.slice(-6)}`, updatedAt: stale() }).where(eq(schema.publishTargets.id, id));
      }
      await queuePollRow(live, postId);
      await handlePublishDispatch(ctx, makeRun(newId()), {}, new Date());
      expect(await target(live)).toMatchObject({ status: 'processing' });
      expect(await target(lost)).toMatchObject({ status: 'failed' });
      expect((await target(lost)).statusMessage).toMatch(/Publishing stopped part-way/);
    }, 60_000);

    it('keeps the plain net for Instagram and for a Zernio target without a post id, even with a read queued', async () => {
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }, { platform: 'tiktok', method: 'zernio', isVerification: true }] });
      const [ig, unknown] = targetIds as [string, string];
      await handle.db.update(schema.publishTargets).set({ status: 'processing', externalContainerId: 'c-1', updatedAt: stale() }).where(eq(schema.publishTargets.id, ig));
      await handle.db.update(schema.publishTargets).set({ status: 'processing', submittedAt: new Date(Date.now() - 2 * 3600_000), updatedAt: stale() }).where(eq(schema.publishTargets.id, unknown));
      await queuePollRow(ig, postId);
      await queuePollRow(unknown, postId);
      await handlePublishDispatch(ctx, makeRun(newId()), {}, new Date());
      expect(await target(ig)).toMatchObject({ status: 'failed' });
      expect(await target(unknown)).toMatchObject({ status: 'manual_step_required', manualStep: 'check_before_retry' });
    }, 60_000);
  });
});
