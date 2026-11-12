/**
 * Stage A acceptance test at the worker level, on SYNTHETIC footage (scripts/make-sample-footage.sh):
 * ingest (incl. rotated HEVC HLG and a silent clip) → manual tags → five planned styles → preview renders →
 * revise one edit without losing the others → full-quality export → interrupted job → incomplete footage.
 * Requires ffmpeg and TEST_DATABASE_URL. Synthetic footage is not a substitute for real haircut clips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { execa } from 'execa';
import { asc, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { CancelledError, JOB_TYPES, STYLE_IDS, computeTimeline, newId, type JobType, type StyleId } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { LocalDiskStore, storageKeys } from '@studio/storage';
import { probeMedia } from '@studio/media';
import { createAiProviders } from '@studio/ai';
import type { WorkerContext } from '../src/context.js';
import type { TrackedRun } from '../src/lib/job-tracker.js';
import { handleIngestAsset, refreshProjectReadiness } from '../src/handlers/ingest.js';
import { handleGenerateEdits, handleReviseEdit } from '../src/handlers/generate.js';
import { handleRender } from '../src/handlers/render.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SAMPLES = path.join(REPO, 'data', 'samples');
const skip = !testDatabaseUrl();

function fakeRun(signal: AbortSignal = new AbortController().signal): TrackedRun {
  return {
    jobId: newId(),
    signal,
    progress: async () => {},
    message: async () => {},
    checkCancelled: () => {
      if (signal.aborted) throw new CancelledError();
    },
  };
}

describe.skipIf(skip)('worker pipeline on synthetic footage', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let root: string;
  let ctx: WorkerContext;
  const enqueued: Array<{ type: JobType; payload: Record<string, unknown> }> = [];
  const userId = newId();
  const projectId = newId();
  const assetIds: Record<string, string> = {};

  beforeAll(async () => {
    if (!existsSync(path.join(SAMPLES, 'sample_b_rotated_hevc_hlg.mov'))) {
      await execa('bash', [path.join(REPO, 'scripts', 'make-sample-footage.sh'), SAMPLES]);
    }
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    root = await mkdtemp(path.join(os.tmpdir(), 'sa-pipeline-'));
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
    });
    const store = new LocalDiskStore({ rootDir: env.STORAGE_LOCAL_ROOT, appUrl: env.APP_URL, secret: env.APP_SECRET });
    const logger = pino({ level: 'silent' });
    const queueStub = {
      enqueue: async (type: JobType, payload: Record<string, unknown>) => {
        enqueued.push({ type, payload });
        return newId();
      },
    };
    ctx = {
      env,
      db: handle.db,
      store,
      queue: queueStub as unknown as WorkerContext['queue'],
      ai: createAiProviders(env, logger),
      logger,
      workerId: 'test-worker',
      fontsDir: path.join(REPO, 'assets', 'fonts'),
      tmpRoot: env.WORKER_TMP_DIR,
    };
    await handle.db.insert(schema.users).values({ id: userId, email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    await handle.db.insert(schema.projects).values({ id: projectId, ownerId: userId, title: 'Synthetic test project' });
    const files: Array<[string, string, string]> = [
      ['a', 'sample_a_portrait_sdr.mp4', 'video/mp4'],
      ['b', 'sample_b_rotated_hevc_hlg.mov', 'video/quicktime'],
      ['c', 'sample_c_noaudio_scenes.mp4', 'video/mp4'],
    ];
    for (const [i, [key, file, mime]] of files.entries()) {
      const id = newId();
      assetIds[key] = id;
      const ext = file.split('.').pop()!;
      const originalKey = storageKeys.assetOriginal(projectId, id, ext);
      await store.putFile(originalKey, path.join(SAMPLES, file));
      await handle.db.insert(schema.mediaAssets).values({
        id,
        projectId,
        kind: 'video',
        originalFilename: file,
        mimeType: mime,
        byteSize: 1,
        sortOrder: i,
        originalKey,
        status: 'uploaded',
      });
    }
  });

  afterAll(async () => {
    await drop();
    await rm(root, { recursive: true, force: true });
  });

  it('ingests every clip, converting HDR and rotation and tolerating missing audio', async () => {
    for (const id of Object.values(assetIds)) {
      await handleIngestAsset(ctx, fakeRun(), { assetId: id, projectId });
    }
    const assets = await handle.db.query.mediaAssets.findMany({ where: eq(schema.mediaAssets.projectId, projectId), orderBy: [asc(schema.mediaAssets.sortOrder)] });
    expect(assets.map((a) => a.status)).toEqual(['ready', 'ready', 'ready']);
    const b = assets.find((a) => a.id === assetIds['b'])!;
    expect(b.probe?.video?.isHdr).toBe(true);
    expect(b.probe?.video?.rotation).toBe(90);
    expect(b.probe?.video?.displayWidth).toBe(1080);
    const proxyPath = (ctx.store as LocalDiskStore).resolvePath(b.proxyKey!);
    const proxyProbe = await probeMedia(proxyPath);
    expect(proxyProbe.video?.displayWidth).toBe(540);
    expect(proxyProbe.video?.displayHeight).toBe(960);
    expect(proxyProbe.video?.isHdr).toBe(false);
    const c = assets.find((a) => a.id === assetIds['c'])!;
    expect(c.analysis?.audio.hasAudio).toBe(false);
    expect(c.analysis?.shots.length).toBeGreaterThanOrEqual(3);
    expect(c.thumbnailKey).toBeTruthy();
    for (const a of assets) {
      expect(a.analysis?.sampledFrames.length).toBeGreaterThan(0);
      expect(a.analysis?.audio.speechLikely).toBe(false);
      expect(a.analysis?.transcript).toBeNull();
    }
    const project = await handle.db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    expect(project?.status).toBe('ready');
    const support = Object.fromEntries((project?.styleSupport ?? []).map((s) => [s.styleId, s.supported]));
    expect(support['beat_montage']).toBe(true);
    expect(support['before_after']).toBe(false);
  });

  it('manual clip tags unlock the label-dependent styles', async () => {
    await handle.db.update(schema.mediaAssets).set({ clipLabel: 'before' }).where(eq(schema.mediaAssets.id, assetIds['b']!));
    await handle.db.update(schema.mediaAssets).set({ clipLabel: 'cutting' }).where(eq(schema.mediaAssets.id, assetIds['a']!));
    await handle.db.update(schema.mediaAssets).set({ clipLabel: 'result' }).where(eq(schema.mediaAssets.id, assetIds['c']!));
    await refreshProjectReadiness(ctx, projectId);
    const project = await handle.db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    expect(project?.styleSupport?.every((s) => s.supported)).toBe(true);
  });

  const generationId = newId();
  const versionByStyle: Record<string, string> = {};

  it('plans five genuinely different edits', async () => {
    await handle.db.insert(schema.generations).values({
      id: generationId,
      projectId,
      requestedBy: userId,
      settings: { durationSec: 12, styles: [...STYLE_IDS], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '' },
    });
    for (const [slot, styleId] of STYLE_IDS.entries()) {
      const editId = newId();
      const versionId = newId();
      versionByStyle[styleId] = versionId;
      await handle.db.insert(schema.edits).values({ id: editId, projectId, generationId, styleId, slot, currentVersionId: versionId });
      await handle.db.insert(schema.editVersions).values({ id: versionId, editId, versionNo: 1, origin: 'initial', status: 'planning' });
    }
    await handleGenerateEdits(ctx, fakeRun(), { generationId, projectId });
    const versions = await handle.db.query.editVersions.findMany();
    expect(versions.filter((v) => v.status === 'planned').length).toBe(5);
    const openings = new Set(versions.map((v) => `${v.plan!.segments[0]!.assetId}:${v.plan!.segments[0]!.inSec.toFixed(1)}:${v.plan!.segments.length}`));
    expect(openings.size).toBeGreaterThanOrEqual(3);
    const orders = new Set(versions.map((v) => v.plan!.segments.map((s) => `${s.assetId.slice(0, 4)}@${s.inSec.toFixed(1)}`).join('>')));
    expect(orders.size).toBe(5);
    for (const v of versions) {
      const total = computeTimeline(v.plan!).totalDurationSec;
      expect(total).toBeGreaterThanOrEqual(12 * 0.8);
      expect(total).toBeLessThanOrEqual(12 * 1.2);
      expect(v.plan!.captions).toEqual([]);
    }
    expect(enqueued.filter((e) => e.type === JOB_TYPES.RENDER_PREVIEW).length).toBe(5);
    const gen = await handle.db.query.generations.findFirst({ where: eq(schema.generations.id, generationId) });
    expect(gen?.status).toBe('rendering');
  });

  it('renders playable previews for every style', async () => {
    for (const styleId of STYLE_IDS) {
      await handleRender(ctx, fakeRun(), { editVersionId: versionByStyle[styleId]!, projectId }, 'preview');
      const v = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionByStyle[styleId]!) });
      expect(v?.status).toBe('preview_ready');
      const probe = await probeMedia((ctx.store as LocalDiskStore).resolvePath(v!.previewKey!));
      expect(probe.video?.codec).toBe('h264');
      expect(probe.video?.displayWidth).toBe(540);
      expect(probe.video?.displayHeight).toBe(960);
      expect(Math.abs(probe.durationSec - computeTimeline(v!.plan!).totalDurationSec)).toBeLessThan(0.25);
    }
    const gen = await handle.db.query.generations.findFirst({ where: eq(schema.generations.id, generationId) });
    expect(gen?.status).toBe('complete');
    expect((await handle.db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }))?.status).toBe('complete');
  }, 300_000);

  it('revises one edit to 15 seconds without touching the other versions', async () => {
    const styleId: StyleId = 'clean_promo';
    const v1 = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionByStyle[styleId]!) });
    const before = await handle.db.query.editVersions.findMany();
    const v2 = newId();
    await handle.db.insert(schema.editVersions).values({ id: v2, editId: v1!.editId, versionNo: 2, parentVersionId: v1!.id, origin: 'revise', instruction: 'Make this 15 seconds and remove the flashy transitions', status: 'planning' });
    await handle.db.update(schema.edits).set({ currentVersionId: v2 }).where(eq(schema.edits.id, v1!.editId));
    await handleReviseEdit(ctx, fakeRun(), { editId: v1!.editId, projectId, newVersionId: v2, mode: 'revise' });
    const revised = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, v2) });
    expect(revised?.status).toBe('planned');
    const total = computeTimeline(revised!.plan!).totalDurationSec;
    expect(total).toBeGreaterThanOrEqual(13);
    expect(total).toBeLessThanOrEqual(17);
    expect(revised!.plan!.segments.every((s) => !s.transitionIn || ['fade', 'dissolve', 'fadeblack', 'fadewhite'].includes(s.transitionIn.type))).toBe(true);
    const after = await handle.db.query.editVersions.findMany();
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!;
      expect(a.plan).toEqual(b.plan);
      expect(a.previewKey).toBe(b.previewKey);
      expect(await ctx.store.exists(a.previewKey!)).toBe(true);
    }
  });

  it('exports a real 1080x1920 MP4 with compatible encoding', async () => {
    const versionId = versionByStyle['beat_montage']!;
    await handleRender(ctx, fakeRun(), { editVersionId: versionId, projectId }, 'export');
    const v = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) });
    expect(v?.exportStatus).toBe('ready');
    const out = (ctx.store as LocalDiskStore).resolvePath(v!.exportKey!);
    const probe = await probeMedia(out);
    expect(probe.video).toMatchObject({ codec: 'h264', displayWidth: 1080, displayHeight: 1920, pixelFormat: 'yuv420p', isHdr: false });
    expect(probe.video?.colour.transfer).toBe('bt709');
    expect(probe.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(v?.exportByteSize).toBeGreaterThan(10_000);
    expect(Math.abs(probe.durationSec - computeTimeline(v!.plan!).totalDurationSec)).toBeLessThan(0.25);
  }, 300_000);

  it('aborts an interrupted render cleanly', async () => {
    const versionId = versionByStyle['process_story']!;
    const controller = new AbortController();
    setTimeout(() => controller.abort(new CancelledError('test abort')), 1500);
    await expect(handleRender(ctx, fakeRun(controller.signal), { editVersionId: versionId, projectId }, 'export')).rejects.toBeInstanceOf(CancelledError);
    const v = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) });
    expect(v?.exportStatus).toBe('none');
    expect(v?.exportKey).toBeNull();
    expect(v?.status).toBe('preview_ready');
  }, 120_000);

  it('explains incomplete footage instead of inventing shots', async () => {
    const tinyProject = newId();
    await handle.db.insert(schema.projects).values({ id: tinyProject, ownerId: userId, title: 'Tiny' });
    const tinyAsset = newId();
    const key = storageKeys.assetOriginal(tinyProject, tinyAsset, 'mp4');
    await ctx.store.putFile(key, path.join(SAMPLES, 'sample_d_tiny.mp4'));
    await handle.db.insert(schema.mediaAssets).values({ id: tinyAsset, projectId: tinyProject, kind: 'video', originalFilename: 'sample_d_tiny.mp4', mimeType: 'video/mp4', byteSize: 1, originalKey: key });
    await handleIngestAsset(ctx, fakeRun(), { assetId: tinyAsset, projectId: tinyProject });
    const project = await handle.db.query.projects.findFirst({ where: eq(schema.projects.id, tinyProject) });
    const unsupported = (project?.styleSupport ?? []).filter((s) => !s.supported);
    expect(unsupported.length).toBe(5);
    expect(unsupported[0]?.reason).toMatch(/usable shots|Needs/);

    const audioAsset = newId();
    const audioKey = storageKeys.assetOriginal(tinyProject, audioAsset, 'mp3');
    await ctx.store.putFile(audioKey, path.join(SAMPLES, 'sample_music_120bpm.mp3'));
    await handle.db.insert(schema.mediaAssets).values({ id: audioAsset, projectId: tinyProject, kind: 'video', originalFilename: 'not-a-video.mp3', mimeType: 'audio/mpeg', byteSize: 1, originalKey: audioKey });
    await expect(handleIngestAsset(ctx, fakeRun(), { assetId: audioAsset, projectId: tinyProject })).rejects.toThrow(/no video track/);
    const failed = await handle.db.query.mediaAssets.findFirst({ where: eq(schema.mediaAssets.id, audioAsset) });
    expect(failed?.status).toBe('failed');
    expect(failed?.statusMessage).toMatch(/no video track/);
  });
});
