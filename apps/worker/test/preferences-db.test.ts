/**
 * Saved preferences, reference videos and brand on a real database and real ffmpeg, with SYNTHETIC footage
 * (scripts/make-sample-footage.sh) and a fake on-screen text estimator (no AI service is called):
 * - reference ingest stores a profile, deletes the original, proxy and frames, keeps the thumbnail, and the asset
 *   never reaches footage, style support or planner input; a retry is a no-op;
 * - `preferences.recompute` writes only its subtree, so an owner's settings change made meanwhile is not lost, and a
 *   reset while it runs is honoured;
 * - the export uses the brand snapshot of its preview (logo included) even after Settings → Branding changed.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { execa } from 'execa';
import { eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { DEFAULT_SETTINGS, newId, type AppSettings, type EditPlan, type JobType, type PlanFacts } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { LocalDiskStore, storageKeys } from '@studio/storage';
import { createAiProviders, type OnScreenTextEstimator } from '@studio/ai';
import { runFfmpeg, runFfmpegToBuffer } from '@studio/media';
import type { WorkerContext } from '../src/context.js';
import type { TrackedRun } from '../src/lib/job-tracker.js';
import { handleIngestAsset, refreshProjectReadiness } from '../src/handlers/ingest.js';
import { handleReferenceAnalyse } from '../src/handlers/reference.js';
import { handlePreferencesRecompute } from '../src/handlers/preferences.js';
import { buildPlannerInput } from '../src/handlers/generate.js';
import { handleRender } from '../src/handlers/render.js';
import { loadProjectFootage, loadSettings } from '../src/lib/plan-context.js';
import { LOGO_MISSING_NOTE } from '../src/modules/preferences/brand.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeRun } from './helpers/fakes.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SAMPLES = path.join(REPO, 'data', 'samples');
const skip = !testDatabaseUrl();

function runWith(onProgress: (message: string | undefined) => Promise<void>): TrackedRun {
  const run = fakeRun();
  return { ...run, progress: async (_f, message) => onProgress(message) };
}

function facts(durationSec: number): PlanFacts {
  return {
    styleId: 'clean_promo',
    durationSec,
    segmentCount: 8,
    avgShotSec: 1.85,
    medianShotSec: 1.8,
    textOverlayCount: 2,
    textPer10Sec: 1,
    transitionCount: 3,
    flashyTransitionCount: 0,
    colourPreset: 'clean',
    hasMusic: false,
    musicTrackId: null,
    musicVolume: null,
    musicStartSec: null,
    originalSound: false,
    beatAligned: false,
  };
}

function plainPlan(assetId: string): EditPlan {
  const seg = (id: string, inSec: number, outSec: number) => ({
    id,
    assetId,
    inSec,
    outSec,
    speed: 1,
    framing: { mode: 'centre' as const, focusX: 0.5, focusY: 0.5 },
    zoom: null,
    transitionIn: null,
    role: 'result' as const,
    keepOriginalSound: false,
  });
  return {
    version: 1,
    styleId: 'clean_promo',
    title: 'Clean promo',
    description: 'Synthetic plan',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 5,
    segments: [seg('s1', 0, 2.5), seg('s2', 3, 5.5)],
    textOverlays: [],
    captions: [],
    audio: { music: null, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'clean',
  };
}

describe.skipIf(skip)('preferences, reference videos and brand (database-backed)', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let root: string;
  let ctx: WorkerContext;
  const enqueued: Array<{ type: JobType; payload: Record<string, unknown> }> = [];
  const estimatorCalls: number[] = [];
  const userId = newId();
  const projectId = newId();
  const clipId = newId();
  const referenceId = newId();
  const resolve = (key: string) => (ctx.store as LocalDiskStore).resolvePath(key);
  const asset = async (id: string) => (await handle.db.query.mediaAssets.findFirst({ where: eq(schema.mediaAssets.id, id) }))!;
  const storedSettings = async () => (await handle.db.query.settings.findFirst({ where: eq(schema.settings.id, 'default') }))!.data as AppSettings;

  beforeAll(async () => {
    if (!existsSync(path.join(SAMPLES, 'sample_c_noaudio_scenes.mp4'))) await execa('bash', [path.join(REPO, 'scripts', 'make-sample-footage.sh'), SAMPLES]);
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    root = await mkdtemp(path.join(os.tmpdir(), 'sa-prefs-'));
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
    // A labelled fake: the real estimator needs an Anthropic key, and no AI service is ever called in tests.
    const textEstimator: OnScreenTextEstimator = {
      name: 'fake-text-estimate',
      model: 'fake-model',
      estimateOnScreenText: async (frames) => {
        estimatorCalls.push(frames.length);
        return {
          measurement: { framesChecked: frames.length, framesWithText: 2 },
          usage: { provider: 'anthropic', model: 'fake-model', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 5, estimatedCostUsdCents: 0.01 },
        };
      },
    };
    ctx = {
      env,
      db: handle.db,
      store,
      queue: {
        enqueue: async (type: JobType, payload: Record<string, unknown>) => {
          enqueued.push({ type, payload });
          return newId();
        },
      } as unknown as WorkerContext['queue'],
      ai: { ...createAiProviders(env, logger), textEstimator },
      logger,
      workerId: 'test-worker',
      fontsDir: path.join(REPO, 'assets', 'fonts'),
      tmpRoot: env.WORKER_TMP_DIR,
    };
    await handle.db.insert(schema.users).values({ id: userId, email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    await handle.db.insert(schema.projects).values({ id: projectId, ownerId: userId, title: 'Synthetic preferences project' });
    await handle.db.insert(schema.settings).values({ id: 'default', data: DEFAULT_SETTINGS });

    const clipKey = storageKeys.assetOriginal(projectId, clipId, 'mp4');
    await store.putFile(clipKey, path.join(SAMPLES, 'sample_c_noaudio_scenes.mp4'));
    await handle.db.insert(schema.mediaAssets).values({ id: clipId, projectId, kind: 'video', originalFilename: 'clip.mp4', mimeType: 'video/mp4', byteSize: 1, originalKey: clipKey, status: 'uploaded', clipLabel: 'result' });
    await handleIngestAsset(ctx, fakeRun(), { assetId: clipId, projectId });

    const refKey = storageKeys.assetOriginal(projectId, referenceId, 'mp4');
    await store.putFile(refKey, path.join(SAMPLES, 'sample_a_portrait_sdr.mp4'));
    await handle.db.insert(schema.mediaAssets).values({ id: referenceId, projectId, kind: 'reference_video', originalFilename: 'liked-reel.mp4', mimeType: 'video/mp4', byteSize: 1, sortOrder: 5, originalKey: refKey, status: 'uploaded' });
    await handle.db.insert(schema.uploadSessions).values({
      id: newId(),
      projectId,
      userId,
      kind: 'reference_video',
      originalFilename: 'liked-reel.mp4',
      mimeType: 'video/mp4',
      totalBytes: 1,
      partSizeBytes: 1,
      partCount: 1,
      targetKey: refKey,
      status: 'completed',
      assetId: referenceId,
      driverState: { referenceOptions: { useVision: true } },
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await handleIngestAsset(ctx, fakeRun(), { assetId: referenceId, projectId });
    await refreshProjectReadiness(ctx, projectId);
  }, 600_000);

  afterAll(async () => {
    await drop();
    await rm(root, { recursive: true, force: true });
  });

  it('measures a reference video, stores the profile and deletes the original, proxy and frames', async () => {
    const queued = enqueued.find((e) => e.type === 'reference.analyse');
    expect(queued?.payload).toEqual({ assetId: referenceId, projectId, useVision: true });
    const before = await asset(referenceId);
    expect(before.status).toBe('processing');
    expect(before.statusMessage).toBe('Measuring style');
    expect(before.analysis?.sampledFrames.length).toBe(8);
    expect(before.analysis?.labelling.source).toBe('heuristic');
    const frameKeys = before.analysis!.sampledFrames.map((f) => f.storageKey);
    expect(existsSync(resolve(before.originalKey))).toBe(true);

    await handleReferenceAnalyse(ctx, fakeRun(), { assetId: referenceId, projectId, useVision: true });
    const after = await asset(referenceId);
    expect(after.status).toBe('ready');
    const profile = after.referenceProfile!;
    expect(profile.assetId).toBe(referenceId);
    expect(profile.durationSec).toBeCloseTo(12, 0);
    expect(profile.shotCount).toBeGreaterThan(0);
    expect(profile.text).toEqual({ density: 'light', framesChecked: 8, framesWithText: 2, source: 'vision_model' });
    expect(profile.suggestions.map((s) => s.field)).toContain('defaultDurationSec');
    expect(profile.originalsDeletedAt).not.toBeNull();
    expect(estimatorCalls).toEqual([8]);
    const usage = await handle.db.query.aiUsage.findMany();
    expect(usage.map((u) => u.purpose)).toEqual(['reference:text']);
    // Only the numbers, the thumbnail and the file name remain.
    expect(existsSync(resolve(after.originalKey))).toBe(false);
    expect(existsSync(resolve(storageKeys.assetProxy(projectId, referenceId)))).toBe(false);
    for (const key of frameKeys) expect(existsSync(resolve(key))).toBe(false);
    expect(after.proxyKey).toBeNull();
    expect(after.analysis?.sampledFrames).toEqual([]);
    expect(existsSync(resolve(after.thumbnailKey!))).toBe(true);
  }, 300_000);

  it('never treats a reference as footage: not in loaded footage, style support or planner input', async () => {
    const footage = (await loadProjectFootage(ctx, projectId))!;
    expect(footage.assets.map((a) => a.id)).toEqual([clipId]);
    const project = await handle.db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    expect(JSON.stringify(project?.styleSupport)).not.toContain(referenceId);
    const input = buildPlannerInput({
      styleId: 'clean_promo',
      settings: { durationSec: 10, styles: ['clean_promo'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
      footage,
      music: null,
      appSettings: await loadSettings(ctx),
      attempt: 0,
    });
    expect(JSON.stringify(input)).not.toContain(referenceId);
  });

  it('treats a retry after deletion as a no-op', async () => {
    const before = await asset(referenceId);
    await handleReferenceAnalyse(ctx, fakeRun(), { assetId: referenceId, projectId, useVision: true });
    await handleIngestAsset(ctx, fakeRun(), { assetId: referenceId, projectId });
    const after = await asset(referenceId);
    expect(after.referenceProfile).toEqual(before.referenceProfile);
    expect(after.status).toBe('ready');
    expect(estimatorCalls).toEqual([8]);
  });

  it('refuses a reference shorter than 3 seconds with a plain message', async () => {
    const id = newId();
    const key = storageKeys.assetOriginal(projectId, id, 'mp4');
    await ctx.store.putFile(key, path.join(SAMPLES, 'sample_d_tiny.mp4'));
    await handle.db.insert(schema.mediaAssets).values({ id, projectId, kind: 'reference_video', originalFilename: 'tiny.mp4', mimeType: 'video/mp4', byteSize: 1, originalKey: key, status: 'uploaded' });
    await expect(handleIngestAsset(ctx, fakeRun(), { assetId: id, projectId })).rejects.toThrow(/shorter than 3 seconds/);
    const a = await asset(id);
    expect(a.status).toBe('failed');
    expect(a.statusMessage).toBe('The video is shorter than 3 seconds, too short to measure.');
  }, 120_000);

  it('recomputes learned preferences without losing an owner change saved meanwhile', async () => {
    const now = Date.now();
    for (const [i, d] of [19.5, 20, 20.5].entries()) {
      await handle.db.insert(schema.feedbackEvents).values({ id: newId(), userId, projectId, editId: `e${i}`, editVersionId: `v${i}`, styleId: 'clean_promo', type: 'favourite', data: { planFacts: facts(d) }, createdAt: new Date(now - 1000 * (10 - i)) });
    }
    const run = runWith(async (message) => {
      if (message !== 'Reading your recent choices') return;
      // The owner saves Settings (whole object, like the web app) between the job's read and its write.
      const current = await storedSettings();
      await handle.db
        .update(schema.settings)
        .set({ data: { ...current, brand: { ...current.brand, tagline: 'Fades done properly' }, preferences: { ...current.preferences, musicVolume: 0.6 } } })
        .where(eq(schema.settings.id, 'default'));
    });
    await handlePreferencesRecompute(ctx, run, { reason: 'feedback' });
    const saved = await storedSettings();
    expect(saved.brand.tagline).toBe('Fades done properly');
    expect(saved.preferences.musicVolume).toBe(0.6);
    expect(saved.preferences.learned.fields.defaultDurationSec?.value).toBe(20);
    expect(saved.preferences.learned.eventsConsidered).toBe(3);
    expect(saved.preferences.styleAffinity).toEqual({ clean_promo: 9 });
    // Learned values are used by the planners unless pinned.
    const input = buildPlannerInput({
      styleId: 'clean_promo',
      settings: { durationSec: 10, styles: ['clean_promo'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
      footage: (await loadProjectFootage(ctx, projectId))!,
      music: null,
      appSettings: await loadSettings(ctx),
      attempt: 0,
    });
    expect(input.preferences.defaultDurationSec).toBe(20);
  });

  it('honours a reset made while the recompute runs', async () => {
    let reset = false;
    const run = runWith(async (message) => {
      if (message !== 'Reading your recent choices' || reset) return;
      reset = true;
      const current = await storedSettings();
      const learning = { ...current.preferences.learning, resetAt: new Date().toISOString() };
      await handle.db.update(schema.settings).set({ data: { ...current, preferences: { ...current.preferences, learning } } }).where(eq(schema.settings.id, 'default'));
    });
    await handlePreferencesRecompute(ctx, run, { reason: 'feedback' });
    const saved = await storedSettings();
    expect(reset).toBe(true);
    expect(saved.preferences.learned.eventsConsidered).toBe(0);
    expect(saved.preferences.learned.fields).toEqual({});
  });

  it('exports with the brand snapshot of its preview, logo included, after the branding changed', async () => {
    const logoFile = path.join(root, 'logo.png');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=300x300:d=1', '-frames:v', '1', logoFile]);
    await ctx.store.putFile(storageKeys.brandLogo('png'), logoFile, { contentType: 'image/png' });
    const current = await storedSettings();
    await handle.db
      .update(schema.settings)
      .set({ data: { ...current, brand: { ...current.brand, logoStorageKey: storageKeys.brandLogo('png'), logoPlacement: 'corner', logoCorner: 'top_left', logoOpacity: 1, accentColour: '#112233' } } })
      .where(eq(schema.settings.id, 'default'));
    const generationId = newId();
    const editId = newId();
    const versionId = newId();
    await handle.db.insert(schema.generations).values({ id: generationId, projectId, requestedBy: userId, settings: { durationSec: 5, styles: ['clean_promo'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null } });
    await handle.db.insert(schema.edits).values({ id: editId, projectId, generationId, styleId: 'clean_promo', slot: 0, currentVersionId: versionId });
    await handle.db.insert(schema.editVersions).values({ id: versionId, editId, versionNo: 1, origin: 'initial', status: 'planned', plan: plainPlan(clipId) });
    await handleRender(ctx, fakeRun(), { editVersionId: versionId, projectId }, 'preview');
    const previewed = (await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) }))!;
    expect(previewed.status).toBe('preview_ready');
    expect(previewed.renderBrand?.accentColour).toBe('#112233');
    expect(previewed.renderBrand?.logo).toMatchObject({ placement: 'corner', corner: 'top_left', opacity: 1 });
    expect(previewed.renderBrand!.logo!.storageKey).toMatch(/^brand\/render-logos\/[0-9a-f]{64}\.png$/);

    // The owner turns the logo off, replaces the file with a black one and changes the accent colour.
    const blackFile = path.join(root, 'black.png');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=300x300:d=1', '-frames:v', '1', blackFile]);
    await ctx.store.putFile(storageKeys.brandLogo('png'), blackFile, { contentType: 'image/png' });
    const later = await storedSettings();
    await handle.db.update(schema.settings).set({ data: { ...later, brand: { ...later.brand, logoPlacement: 'off', accentColour: '#AA0000' } } }).where(eq(schema.settings.id, 'default'));

    await handleRender(ctx, fakeRun(), { editVersionId: versionId, projectId, variant: 'standard' }, 'export');
    const exported = (await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) }))!;
    expect(exported.exportStatus).toBe('ready');
    expect(exported.exportMessage).toBe('Ready to download');
    // The white corner mark of the preview is in the export, at (132, 282)–(282, 432).
    const frame = await runFfmpegToBuffer(['-ss', '1', '-i', resolve(exported.exportKey!), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    let sum = 0;
    let n = 0;
    for (let y = 290; y < 425; y++) for (let x = 140; x < 275; x++, n++) sum += frame[y * 1080 + x] ?? 0;
    expect(sum / n).toBeGreaterThan(200);
    let outside = 0;
    for (let y = 290; y < 425; y++) for (let x = 300; x < 435; x++) outside += frame[y * 1080 + x] ?? 0;
    expect(outside / n).toBeLessThan(120);

    // A missing logo file renders without it and says so.
    await ctx.store.delete(exported.renderBrand!.logo!.storageKey);
    await handleRender(ctx, fakeRun(), { editVersionId: versionId, projectId, variant: 'standard' }, 'export');
    const again = (await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) }))!;
    expect(again.exportStatus).toBe('ready');
    expect(again.exportMessage).toBe(`Ready to download · ${LOGO_MISSING_NOTE}`);
  }, 600_000);
});
