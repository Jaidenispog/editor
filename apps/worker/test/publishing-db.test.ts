/**
 * Publishing on a real database and real ffmpeg, with SYNTHETIC footage (scripts/make-sample-footage.sh) and a local
 * fake of Meta's Graph and rupload hosts (test/fakes/graph-server.ts). Covers publishing design §11.2 cases 1–6,
 * 7 (with a manual TikTok target; Zernio is WP10), 12–17 and the read-only social.check. No real platform is ever
 * called. Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { execa } from 'execa';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { CancelledError, MusicLicenceSchema, NonRetryableError, newId, type JobType, type MusicLicence } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { JobQueue, queuePolicyFor } from '@studio/queue';
import { LocalDiskStore, storageKeys } from '@studio/storage';
import { probeMedia } from '@studio/media';
import { createAiProviders } from '@studio/ai';
import type { WorkerContext } from '../src/context.js';
import { JobInterruptedError, type TrackedRun } from '../src/lib/job-tracker.js';
import { encryptCredential } from '../src/lib/credentials.js';
import { handleIngestAsset, refreshProjectReadiness } from '../src/handlers/ingest.js';
import { handleGenerateEdits } from '../src/handlers/generate.js';
import { handleRender } from '../src/handlers/render.js';
import { handleAnalyseMusic } from '../src/handlers/music.js';
import { handlePublishPrepare } from '../src/handlers/publish-prepare.js';
import { claimTarget, handlePublishTarget } from '../src/handlers/publish-target.js';
import { handlePublishPoll } from '../src/handlers/publish-poll.js';
import { handlePublishDispatch } from '../src/handlers/publish-dispatch.js';
import { DISCOVERY_EMPTY_MESSAGE, WRONG_TOKEN_MESSAGE, handleSocialCheck } from '../src/handlers/social-check.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { startFakeGraphServer, type FakeGraphServer } from './fakes/graph-server.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SAMPLES = path.join(REPO, 'data', 'samples');
const skip = !testDatabaseUrl();

interface Queued {
  type: JobType;
  payload: Record<string, unknown>;
  options: { singletonKey?: string; startAfter?: Date; trackingJobId?: string };
}

function makeRun(jobId: string, controller = new AbortController(), willRetry = true): TrackedRun {
  return {
    jobId,
    signal: controller.signal,
    willRetry,
    progress: async () => {},
    message: async () => {},
    checkCancelled: () => {
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new CancelledError();
    },
    cancelledByOwner: async () => false,
  };
}

describe.skipIf(skip)('publishing on synthetic footage with a fake Graph API', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let url: string;
  let root: string;
  let ctx: WorkerContext;
  let fake: FakeGraphServer;
  const queue: Queued[] = [];
  const userId = newId();
  const projectId = newId();
  const trackId = newId();
  const generationId = newId();
  const editId = newId();
  const v1 = newId();
  let metaConnId = '';
  let igAccountId = '';
  let licence: MusicLicence;

  const resolve = (key: string) => (ctx.store as LocalDiskStore).resolvePath(key);
  const target = async (id: string) => (await handle.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, id) }))!;
  const post = async (id: string) => (await handle.db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, id) }))!;

  /** Runs one queued job like the worker would (a thrown transient error puts it back once, like a pg-boss retry). */
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
      case 'render.export':
        return handleRender(ctx, run, p, 'export');
      default:
        return;
    }
  }

  /** Runs queued jobs (ignoring startAfter) until none is left of the given types. */
  async function drain(types: JobType[] = ['publish.prepare', 'publish.target', 'publish.poll', 'render.export'], max = 60): Promise<string[]> {
    const ran: string[] = [];
    const retries = new Map<string, number>();
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
        const key = job.options.trackingJobId ?? '';
        const n = (retries.get(key) ?? 0) + 1;
        retries.set(key, n);
        if (n <= 3) queue.push(job);
      }
    }
    throw new Error(`drain did not settle: ${ran.join(', ')}`);
  }

  /** An approved post (as the web app's approve route leaves it) with its targets, then `publish.prepare` queued. */
  async function createPost(input: {
    targets: Array<{ platform: 'instagram' | 'tiktok'; method: 'manual' | 'instagram_api'; variant?: 'standard' | 'no_music'; isVerification?: boolean }>;
    mode?: 'now' | 'scheduled' | 'draft_handoff';
    scheduledFor?: Date | null;
    caption?: string;
  }): Promise<{ postId: string; targetIds: string[] }> {
    const postId = newId();
    await handle.db.insert(schema.publishPosts).values({
      id: postId,
      projectId,
      editVersionId: v1,
      createdBy: userId,
      caption: input.caption ?? `Skin fade, start to finish ${postId.slice(-6)}`,
      coverTimeSec: 1,
      mode: input.mode ?? 'now',
      scheduledFor: input.scheduledFor ?? null,
      status: 'approved',
      approvedBy: userId,
      approvedAt: new Date(),
    });
    const targetIds: string[] = [];
    for (const t of input.targets) {
      const id = newId();
      targetIds.push(id);
      await handle.db.insert(schema.publishTargets).values({
        id,
        postId,
        platform: t.platform,
        accountId: t.method === 'instagram_api' ? igAccountId : null,
        idempotencyKey: `pt_${id}`,
        method: t.method,
        mediaVariant: t.variant ?? 'standard',
        isVerification: t.isVerification ?? false,
      });
    }
    queue.push({ type: 'publish.prepare', payload: { postId, projectId }, options: { singletonKey: `publish-prepare:${postId}`, trackingJobId: newId() } });
    return { postId, targetIds };
  }

  beforeAll(async () => {
    if (!existsSync(path.join(SAMPLES, 'sample_music_120bpm.mp3'))) await execa('bash', [path.join(REPO, 'scripts', 'make-sample-footage.sh'), SAMPLES]);
    fake = await startFakeGraphServer();
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    url = t.url;
    root = await mkdtemp(path.join(os.tmpdir(), 'sa-publish-'));
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: t.url,
      APP_SECRET: 'test-secret-0123456789-0123456789-0123456789',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: path.join(root, 'storage'),
      WORKER_TMP_DIR: path.join(root, 'tmp'),
      AI_PROVIDER: 'none',
      TRANSCRIPTION_PROVIDER: 'none',
      AI_VISION_MAX_FRAMES_PER_CLIP: '4',
      META_APP_ID: 'fake-app',
      META_APP_SECRET: 'fake-app-secret',
      META_LOGIN_CONFIG_ID: 'fake-config',
      META_GRAPH_BASE_URL: fake.url,
      META_RUPLOAD_BASE_URL: fake.url,
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
    await handle.db.insert(schema.projects).values({ id: projectId, ownerId: userId, title: 'Synthetic publishing project' });
    const clips: Array<[string, 'cutting' | 'result']> = [
      ['sample_a_portrait_sdr.mp4', 'cutting'],
      ['sample_c_noaudio_scenes.mp4', 'result'],
    ];
    for (const [i, [file, label]] of clips.entries()) {
      const id = newId();
      const originalKey = storageKeys.assetOriginal(projectId, id, 'mp4');
      await store.putFile(originalKey, path.join(SAMPLES, file));
      await handle.db.insert(schema.mediaAssets).values({ id, projectId, kind: 'video', originalFilename: file, mimeType: 'video/mp4', byteSize: 1, sortOrder: i, originalKey, status: 'uploaded' });
      await handleIngestAsset(ctx, makeRun(newId()), { assetId: id, projectId });
      await handle.db.update(schema.mediaAssets).set({ clipLabel: label }).where(eq(schema.mediaAssets.id, id));
    }
    await refreshProjectReadiness(ctx, projectId);
    const source = path.join(SAMPLES, 'sample_music_120bpm.mp3');
    const storageKey = storageKeys.musicOriginal(trackId, 'mp3');
    await ctx.store.putFile(storageKey, source, { contentType: 'audio/mpeg' });
    licence = MusicLicenceSchema.parse({ kind: 'owner_upload', permitted: { promotionalUse: true, instagram: true, tiktok: true }, confirmedByOwnerAt: new Date().toISOString() });
    await handle.db.insert(schema.musicTracks).values({ id: trackId, title: 'Synthetic click track', storageKey, mimeType: 'audio/mpeg', byteSize: (await stat(source)).size, licence });
    await handleAnalyseMusic(ctx, makeRun(newId()), { trackId });
    await handle.db.insert(schema.generations).values({
      id: generationId,
      projectId,
      requestedBy: userId,
      settings: { durationSec: 12, styles: ['beat_montage'], musicTrackId: trackId, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
    });
    await handle.db.insert(schema.edits).values({ id: editId, projectId, generationId, styleId: 'beat_montage', slot: 0, currentVersionId: v1 });
    await handle.db.insert(schema.editVersions).values({ id: v1, editId, versionNo: 1, origin: 'initial', status: 'planning' });
    await handleGenerateEdits(ctx, makeRun(newId()), { generationId, projectId });
    await handleRender(ctx, makeRun(newId()), { editVersionId: v1, projectId }, 'preview');
    await handleRender(ctx, makeRun(newId()), { editVersionId: v1, projectId, variant: 'standard' }, 'export');
    // The memo §5 export preset is AAC at 128 kbps and Instagram's Reels spec allows at most 128 kbps, but the Stage A
    // renderer still writes 192 kbps (packages/media/src/render/command.ts, not this package's file; the change is
    // requested from the integrator). Until then the fixture export's sound is re-encoded at 128 kbps, video untouched.
    const exported = (await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, v1) }))!;
    const src = resolve(exported.exportKey!);
    const fixed = path.join(root, 'export-128k.mp4');
    await execa('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', fixed]);
    await ctx.store.putFile(exported.exportKey!, fixed, { contentType: 'video/mp4' });
    await handle.db.update(schema.editVersions).set({ exportByteSize: (await stat(fixed)).size }).where(eq(schema.editVersions.id, v1));
    queue.length = 0;
    // The Meta connection as the web callback stores it (token encrypted at rest).
    metaConnId = newId();
    await handle.db.insert(schema.integrationConnections).values({ id: metaConnId, provider: 'meta', status: 'connected', accessTokenEncrypted: encryptCredential(env, fake.scenario.token) });
  }, 600_000);

  afterAll(async () => {
    await fake?.close();
    await drop?.();
    if (root) await rm(root, { recursive: true, force: true });
  });

  describe('social.check (read-only)', () => {
    it('discovers the account, records quota and token facts, and never posts', async () => {
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: null, reason: 'connect' });
      const conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, metaConnId) });
      expect(conn).toMatchObject({ status: 'connected', lastError: null, displayName: '@ivanhoe_studio_test' });
      expect(conn?.scopes).toEqual(['instagram_basic', 'instagram_content_publish']);
      expect(conn?.tokenExpiresAt).toBeNull();
      const acct = await handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.externalId, fake.scenario.igUserId) });
      expect(acct).toMatchObject({ platform: 'instagram', provider: 'meta_graph', connectionId: metaConnId, status: 'connected', directPublishEnabled: false, accessTokenEncrypted: null });
      expect(acct?.capabilities).toMatchObject({ quotaUsage: 0, quotaTotal: 50, graphVersion: 'v26.0', resumableMaxBytes: 104857600 });
      expect(acct?.capabilities['verifiedDirectAt']).toBeUndefined();
      igAccountId = acct!.id;
      expect(fake.count('create') + fake.count('publish') + fake.count('upload')).toBe(0);
      // Every Graph call carried appsecret_proof except debug_token (app token), and the token never went into a header.
      for (const c of fake.calls.filter((c) => c.endpoint !== 'debug_token')) expect(c.query['appsecret_proof']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('falls back to the granular-scope target ids, then to the account ID the owner enters', async () => {
      fake.scenario.assignedAccounts = [];
      fake.scenario.granularTargets = [fake.scenario.igUserId];
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: metaConnId, reason: 'manual' });
      expect((await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, metaConnId) }))?.status).toBe('connected');
      fake.scenario.granularTargets = [];
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: metaConnId, reason: 'manual' });
      let conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, metaConnId) });
      expect(conn).toMatchObject({ status: 'error', lastError: DISCOVERY_EMPTY_MESSAGE });
      await handle.db.update(schema.integrationConnections).set({ config: { pendingIgUserId: fake.scenario.igUserId } }).where(eq(schema.integrationConnections.id, metaConnId));
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: metaConnId, reason: 'manual' });
      conn = await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, metaConnId) });
      expect(conn?.status).toBe('connected');
      expect(conn?.config['pendingIgUserId']).toBeUndefined();
      fake.scenario.assignedAccounts = [{ id: fake.scenario.igUserId, username: fake.scenario.username }];
    });

    it('reports a wrong token type and an invalid token plainly', async () => {
      fake.scenario.tokenType = 'USER';
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: metaConnId, reason: 'manual' });
      expect(await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, metaConnId) })).toMatchObject({ status: 'error', lastError: WRONG_TOKEN_MESSAGE });
      fake.scenario.tokenType = 'SYSTEM_USER';
      fake.scenario.tokenValid = false;
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: metaConnId, reason: 'manual' });
      expect((await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, metaConnId) }))?.status).toBe('needs_reauth');
      expect((await handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, igAccountId) }))?.status).toBe('needs_reauth');
      fake.scenario.tokenValid = true;
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: metaConnId, reason: 'manual' });
      expect((await handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, igAccountId) }))?.status).toBe('connected');
      expect(fake.count('create') + fake.count('publish')).toBe(0);
      // The owner confirmed a verification post earlier and switched direct publishing on (what the API records).
      await handle.db
        .update(schema.socialAccounts)
        .set({ capabilities: { ...(await handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, igAccountId) }))!.capabilities, verifiedDirectAt: new Date().toISOString() }, directPublishEnabled: true })
        .where(eq(schema.socialAccounts.id, igAccountId));
    });
  });

  describe('Instagram direct publishing', () => {
    it('1. happy path: export, cover, container, upload, polls, copyright check, publish, permalink; effects only when published', async () => {
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      const [tid] = targetIds as [string];
      // (A missing export is queued by prepare and the export-ready hook prepares again: case 14 covers that path.)
      await drain(['publish.prepare']);
      const prepared = await target(tid);
      expect(prepared.mediaKey).toBe(storageKeys.editExport(projectId, editId, 1));
      expect((await post(postId)).coverKey).toBe(storageKeys.publishCover(postId));
      expect(await ctx.store.exists(storageKeys.publishCover(postId))).toBe(true);
      // Nothing is recorded as used or learned from before the platform confirms the post.
      const feedbackBefore = await handle.db.query.feedbackEvents.findMany({ where: and(eq(schema.feedbackEvents.editVersionId, v1), eq(schema.feedbackEvents.type, 'publish')) });
      expect(feedbackBefore).toHaveLength(0);
      expect(await handle.db.query.musicUsage.findMany({ where: and(eq(schema.musicUsage.editVersionId, v1), eq(schema.musicUsage.purpose, 'publish')) })).toHaveLength(0);

      await drain();
      const done = await target(tid);
      expect(done.status).toBe('published');
      expect(done.publishedUrl).toMatch(/^https:\/\/www\.instagram\.com\/reel\/R\d+\/$/);
      expect(done.submittedAt).not.toBeNull();
      expect(done.externalPostId).toBe(fake.published[0]?.mediaId);
      expect((await post(postId)).status).toBe('complete');
      const container = fake.containers.get(done.externalContainerId!)!;
      const fileSize = (await stat(resolve(done.mediaKey!))).size;
      expect(container.uploadedBytes).toBe(fileSize);
      expect(container.thumbOffset).toBe('1000');
      expect(container.caption).toBe((await post(postId)).caption);
      expect(fake.count('status')).toBeGreaterThanOrEqual(3);
      expect(fake.count('copyright')).toBe(1);
      expect(fake.count('publish')).toBe(1);
      const feedback = await handle.db.query.feedbackEvents.findMany({ where: and(eq(schema.feedbackEvents.editVersionId, v1), eq(schema.feedbackEvents.type, 'publish')) });
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.data).toMatchObject({ platform: 'instagram', method: 'instagram_api', variant: 'standard' });
      expect(feedback[0]?.data['planFacts']).toBeTruthy();
      const usage = await handle.db.query.musicUsage.findMany({ where: and(eq(schema.musicUsage.editVersionId, v1), eq(schema.musicUsage.purpose, 'publish')) });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ platform: 'instagram', trackId });
      const audit = await handle.db.query.auditLog.findMany({ where: eq(schema.auditLog.entityId, tid) });
      expect(audit.map((a) => a.action).sort()).toEqual(['publish.target.published', 'publish.target.submitted']);
      expect(JSON.stringify(audit)).not.toContain(fake.scenario.token);
    }, 300_000);

    it('2. a crash after media_publish never publishes twice; the media id is recovered from the account media list', async () => {
      const publishedBefore = fake.published.length;
      fake.scenario.dropAfterPublish = true;
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      await drain();
      const t = await target(targetIds[0]!);
      expect(t.status).toBe('published');
      expect(fake.published.length).toBe(publishedBefore + 1);
      expect(t.externalPostId).toBe(fake.published[fake.published.length - 1]?.mediaId);
      expect(t.publishedUrl).toMatch(/instagram\.com\/reel\//);
      expect(fake.calls.filter((c) => c.endpoint === 'publish' && c.form['creation_id'] === t.externalContainerId)).toHaveLength(1);
      expect(fake.count('media_list')).toBeGreaterThanOrEqual(1);
      expect((await post(postId)).status).toBe('complete');
    }, 120_000);

    it("3. a container ERROR fails with Instagram's message, and Retry makes a new container", async () => {
      fake.scenario.statusSequence = ['IN_PROGRESS', 'ERROR'];
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      await drain();
      const failed = await target(targetIds[0]!);
      expect(failed.status).toBe('failed');
      expect(failed.statusMessage).toContain(fake.scenario.errorStatus);
      const firstContainer = failed.externalContainerId!;
      fake.reset();
      // The owner's Retry (API): back to queued with the same idempotency key, then publish.target.
      await handle.db.update(schema.publishTargets).set({ status: 'queued' }).where(eq(schema.publishTargets.id, failed.id));
      queue.push({ type: 'publish.target', payload: { targetId: failed.id, postId: failed.postId, projectId }, options: { trackingJobId: newId() } });
      await drain();
      const t = await target(failed.id);
      expect(t.status).toBe('published');
      expect(t.externalContainerId).not.toBe(firstContainer);
      expect(t.idempotencyKey).toBe(`pt_${failed.id}`);
    }, 120_000);

    it('4. a copyright match never publishes; posting without music renders the music-free file and publishes that', async () => {
      fake.scenario.copyright = { status: 'complete', matches_found: true };
      const publishCalls = fake.count('publish');
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      await drain();
      const t = await target(targetIds[0]!);
      expect(t).toMatchObject({ status: 'manual_step_required', manualStep: 'review_copyright_match' });
      expect(fake.count('publish')).toBe(publishCalls);
      // The owner chooses "Post without music" (API): variant no_music, container cleared, prepared again.
      fake.scenario.copyright = { status: 'complete', matches_found: false };
      await handle.db
        .update(schema.publishTargets)
        .set({ status: 'queued', manualStep: null, mediaVariant: 'no_music', mediaKey: null, externalContainerId: null, providerState: {} })
        .where(eq(schema.publishTargets.id, t.id));
      queue.push({ type: 'publish.prepare', payload: { postId: t.postId, projectId }, options: { trackingJobId: newId() } });
      await drain();
      const after = await target(t.id);
      expect(after.status).toBe('published');
      expect(after.mediaKey).toBe(storageKeys.editExportVariant(projectId, editId, 1, 'no_music'));
      const container = fake.containers.get(after.externalContainerId!)!;
      expect(container.uploadedBytes).toBe((await stat(resolve(after.mediaKey!))).size);
      const probe = await probeMedia(resolve(after.mediaKey!));
      expect(probe.audio).toBeNull();
    }, 300_000);

    it('5. the posting limit puts the target back in the queue for an hour and creates no container', async () => {
      fake.scenario.quotaUsage = 50;
      const containersBefore = fake.containers.size;
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      await drain(['publish.prepare']);
      const job = queue.find((j) => j.type === 'publish.target');
      queue.splice(queue.indexOf(job!), 1);
      await runJob(job!);
      const t = await target(targetIds[0]!);
      expect(t.status).toBe('queued');
      expect(t.statusMessage).toMatch(/daily posting limit is reached; trying again at/);
      expect(fake.containers.size).toBe(containersBefore);
      const requeued = queue.find((j) => j.type === 'publish.target' && j.payload['targetId'] === t.id);
      expect(requeued?.options.singletonKey).toBe(`publish-target:${t.id}`);
      expect(requeued!.options.startAfter!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
      // The dispatcher leaves it alone while the delayed job waits.
      await handlePublishDispatch(ctx, makeRun(newId()), {}, new Date(Date.now() + 10 * 60_000));
      expect(queue.filter((j) => j.type === 'publish.target' && j.payload['targetId'] === t.id)).toHaveLength(1);
      fake.reset();
      await drain();
      expect((await target(t.id)).status).toBe('published');
    }, 120_000);

    it('6. error 190 marks the account for reconnecting and the target as "reconnect"', async () => {
      fake.scenario.failOnce = { create: { status: 400, code: 190, message: 'Error validating access token: Session has expired' } };
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      await drain();
      const t = await target(targetIds[0]!);
      expect(t).toMatchObject({ status: 'manual_step_required', manualStep: 'reconnect_account' });
      expect((await handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, igAccountId) }))?.status).toBe('needs_reauth');
      expect((await handle.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, metaConnId) }))?.status).toBe('needs_reauth');
      // Reconnected (the next read-only check restores both).
      await handleSocialCheck(ctx, makeRun(newId()), { connectionId: metaConnId, reason: 'manual' });
      expect((await handle.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, igAccountId) }))?.status).toBe('connected');
    }, 120_000);

    it('7. a failed Instagram target never undoes a published TikTok one; the post is partial, then complete after Retry', async () => {
      fake.scenario.failOnce = { create: { status: 400, code: 100, subcode: 2207026, message: 'The video format is not supported' } };
      const { postId, targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }, { platform: 'tiktok', method: 'manual', variant: 'standard' }] });
      await drain();
      const [ig, tt] = [await target(targetIds[0]!), await target(targetIds[1]!)];
      expect(ig.status).toBe('failed');
      expect(ig.statusMessage).toMatch(/couldn't use this video file/);
      expect(ig.providerState.retryable).toBe(false);
      expect(tt).toMatchObject({ status: 'manual_step_required', manualStep: 'post_in_app' });
      expect(tt.mediaKey).toBeTruthy();
      // The owner taps "I've posted it" on TikTok (what the confirm route writes).
      await handle.db.update(schema.publishTargets).set({ status: 'published', manualStep: null, confirmedBy: userId, confirmedAt: new Date(), publishedAt: new Date() }).where(eq(schema.publishTargets.id, tt.id));
      const { refreshPostStatus } = await import('../src/publishing/post-status.js');
      await refreshPostStatus(handle.db, postId);
      expect((await post(postId)).status).toBe('partial');
      await handle.db.update(schema.publishTargets).set({ status: 'queued' }).where(eq(schema.publishTargets.id, ig.id));
      queue.push({ type: 'publish.target', payload: { targetId: ig.id, postId, projectId }, options: { trackingJobId: newId() } });
      await drain();
      expect((await target(ig.id)).status).toBe('published');
      expect(await target(tt.id)).toMatchObject({ status: 'published', confirmedBy: userId });
      expect((await post(postId)).status).toBe('complete');
    }, 120_000);
  });

  describe('scheduling, licences and recovery', () => {
    it('12. a scheduled post is handed on only once due; a cancelled one makes no external call', async () => {
      const due = new Date(Date.now() + 2 * 60_000);
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }], mode: 'scheduled', scheduledFor: due });
      await drain(['publish.prepare']);
      const t = await target(targetIds[0]!);
      expect(t.status).toBe('queued');
      expect(t.mediaKey).toBeTruthy();
      expect(t.statusMessage).toMatch(/^Scheduled for .* (AEDT|AEST)$/);
      expect(queue.filter((j) => j.type === 'publish.target')).toHaveLength(0);
      await handlePublishDispatch(ctx, makeRun(newId()), {}, new Date());
      expect(queue.filter((j) => j.type === 'publish.target')).toHaveLength(0);
      await handlePublishDispatch(ctx, makeRun(newId()), {}, new Date(due.getTime() + 60_000));
      expect(queue.filter((j) => j.type === 'publish.target' && j.payload['targetId'] === t.id)).toHaveLength(1);
      await drain();
      expect((await target(t.id)).status).toBe('published');

      const callsBefore = fake.calls.length;
      const second = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }], mode: 'scheduled', scheduledFor: due });
      await drain(['publish.prepare']);
      // Cancelled before it was due (the cancel route: every target without submitted_at).
      await handle.db.update(schema.publishTargets).set({ status: 'cancelled' }).where(eq(schema.publishTargets.postId, second.postId));
      await handlePublishDispatch(ctx, makeRun(newId()), {}, new Date(due.getTime() + 60_000));
      expect(queue.filter((j) => j.type === 'publish.target')).toHaveLength(0);
      expect(fake.calls.length).toBe(callsBefore);
    }, 120_000);

    it('12b. a due manual target becomes the owner\'s turn', async () => {
      const due = new Date(Date.now() + 2 * 60_000);
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'manual' }], mode: 'scheduled', scheduledFor: due });
      await drain(['publish.prepare']);
      expect((await target(targetIds[0]!)).status).toBe('queued');
      await handlePublishDispatch(ctx, makeRun(newId()), {}, new Date(due.getTime() + 60_000));
      expect(await target(targetIds[0]!)).toMatchObject({ status: 'manual_step_required', manualStep: 'post_in_app' });
    });

    it('13. a licence changed after approval stops the post with no external call', async () => {
      await handle.db.update(schema.musicTracks).set({ licence: { ...licence, permitted: { ...licence.permitted, instagram: false } } }).where(eq(schema.musicTracks.id, trackId));
      const callsBefore = fake.calls.length;
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }, { platform: 'tiktok', method: 'manual' }] });
      await drain();
      expect(await target(targetIds[0]!)).toMatchObject({ status: 'manual_step_required', manualStep: 'music_licence_changed' });
      // TikTok is still covered, so its manual target goes ahead.
      expect(await target(targetIds[1]!)).toMatchObject({ status: 'manual_step_required', manualStep: 'post_in_app' });
      expect(fake.calls.length).toBe(callsBefore);
      // Changed again while a target is already claimed: the worker's own re-check stops it before any call.
      const second = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api', variant: 'standard' }] });
      await handle.db.update(schema.musicTracks).set({ licence }).where(eq(schema.musicTracks.id, trackId));
      await drain(['publish.prepare']);
      await handle.db.update(schema.musicTracks).set({ licence: { ...licence, confirmedByOwnerAt: null } }).where(eq(schema.musicTracks.id, trackId));
      const before2 = fake.calls.length;
      await drain();
      expect(await target(second.targetIds[0]!)).toMatchObject({ status: 'manual_step_required', manualStep: 'music_licence_changed' });
      expect(fake.calls.filter((c) => c.endpoint === 'create').length).toBe(fake.calls.slice(0, before2).filter((c) => c.endpoint === 'create').length);
      await handle.db.update(schema.musicTracks).set({ licence }).where(eq(schema.musicTracks.id, trackId));
    }, 120_000);

    it('14. a Meta Sound Collection track never goes to TikTok with its music: TikTok gets the music-free file', async () => {
      const meta = MusicLicenceSchema.parse({ kind: 'meta_sound_collection', permitted: { promotionalUse: true, instagram: true, facebook: true, tiktok: true }, confirmedByOwnerAt: new Date().toISOString() });
      await handle.db.update(schema.musicTracks).set({ licence: meta }).where(eq(schema.musicTracks.id, trackId));
      const { targetIds } = await createPost({ targets: [{ platform: 'tiktok', method: 'manual', variant: 'standard' }] });
      await drain();
      // The standard file is refused for TikTok at prepare time (the API refuses it earlier too).
      expect(await target(targetIds[0]!)).toMatchObject({ status: 'manual_step_required', manualStep: 'music_licence_changed' });
      const ok = await createPost({ targets: [{ platform: 'tiktok', method: 'manual', variant: 'no_music' }] });
      await drain();
      const t = await target(ok.targetIds[0]!);
      expect(t).toMatchObject({ status: 'manual_step_required', manualStep: 'post_in_app' });
      expect(t.mediaKey).toBe(storageKeys.editExportVariant(projectId, editId, 1, 'no_music'));
      const probe = await probeMedia(resolve(t.mediaKey!));
      expect(probe.audio).toBeNull();
      await handle.db.update(schema.musicTracks).set({ licence }).where(eq(schema.musicTracks.id, trackId));
    }, 300_000);

    it('15. a run interrupted during the upload resumes on the same container and publishes once', async () => {
      fake.reset({ hangUpload: true });
      queue.length = 0;
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      await drain(['publish.prepare']);
      const job = queue.find((j) => j.type === 'publish.target' && j.payload['targetId'] === targetIds[0])!;
      queue.splice(queue.indexOf(job), 1);
      const jobId = job.options.trackingJobId!;
      const controller = new AbortController();
      const from = fake.calls.length;
      const running = handlePublishTarget(ctx, makeRun(jobId, controller), job.payload as never);
      const started = Date.now();
      while (!fake.calls.slice(from).some((c) => c.endpoint === 'upload' && c.bytes > 0) && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 50));
      controller.abort(new JobInterruptedError('worker killed'));
      await expect(running).rejects.toBeInstanceOf(JobInterruptedError);
      const mid = await target(targetIds[0]!);
      expect(mid.status).toBe('processing');
      expect(mid.providerState.uploadDone).toBe(false);
      const container = mid.externalContainerId!;
      // The queue runs the same job again after the restart.
      fake.scenario.hangUpload = false;
      await handlePublishTarget(ctx, makeRun(jobId), job.payload as never);
      await drain();
      const t = await target(mid.id);
      expect(t.status).toBe('published');
      expect(t.externalContainerId).toBe(container);
      expect(fake.calls.filter((c) => c.endpoint === 'upload' && c.path.endsWith(container))).toHaveLength(2);
      expect(fake.calls.filter((c) => c.endpoint === 'publish' && c.form['creation_id'] === container)).toHaveLength(1);
    }, 120_000);

    it('16. two jobs for the same target: exactly one claims it', async () => {
      fake.reset();
      const { targetIds } = await createPost({ targets: [{ platform: 'instagram', method: 'instagram_api' }] });
      await drain(['publish.prepare']);
      queue.splice(0, queue.length);
      const id = targetIds[0]!;
      const claims = await Promise.all([claimTarget(ctx, id, 'job-a'), claimTarget(ctx, id, 'job-b')]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const winner = claims[0] ? 'job-a' : 'job-b';
      // The same job may claim again after a restart; the other may not.
      expect(await claimTarget(ctx, id, winner)).not.toBeNull();
      expect(await claimTarget(ctx, id, winner === 'job-a' ? 'job-b' : 'job-a')).toBeNull();
      // Two whole handler runs (singleton bypassed on purpose) still create one container and one post.
      await handle.db.update(schema.publishTargets).set({ status: 'queued', providerState: {} }).where(eq(schema.publishTargets.id, id));
      const containersBefore = fake.containers.size;
      const t = await target(id);
      await Promise.all([
        handlePublishTarget(ctx, makeRun('job-c'), { targetId: id, postId: t.postId, projectId }),
        handlePublishTarget(ctx, makeRun('job-d'), { targetId: id, postId: t.postId, projectId }),
      ]);
      await drain();
      expect(fake.containers.size).toBe(containersBefore + 1);
      expect((await target(id)).status).toBe('published');
    }, 120_000);

    it('17. the publish queues are stately on pg-boss 12.38.1: one queued job per singleton key', async () => {
      expect(queuePolicyFor('publish.target')).toBe('stately');
      expect(queuePolicyFor('publish.prepare')).toBe('stately');
      expect(queuePolicyFor('publish.poll')).toBe('stately');
      const q = new JobQueue({ connectionString: url, role: 'producer', logger: pino({ level: 'silent' }), max: 2 });
      await q.start();
      try {
        expect((await q.raw.getQueue('publish.target'))?.policy).toBe('stately');
        const payload = { targetId: 'x', postId: 'y', projectId: null };
        expect(await q.enqueue('publish.target', payload, { singletonKey: 'publish-target:x' })).toBeTruthy();
        expect(await q.enqueue('publish.target', payload, { singletonKey: 'publish-target:x' })).toBeNull();
        expect(await q.enqueue('publish.target', { ...payload, targetId: 'z' }, { singletonKey: 'publish-target:z' })).toBeTruthy();
      } finally {
        await q.stop(false);
      }
    }, 60_000);
  });
});
