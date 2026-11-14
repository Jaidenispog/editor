/**
 * Stage A acceptance test at the worker level, on SYNTHETIC footage (scripts/make-sample-footage.sh):
 * ingest (incl. rotated HEVC HLG and a silent clip) → manual tags → five planned styles → preview renders →
 * revise one edit without losing the others → full-quality export → cancelled job → job interrupted by a worker
 * shutdown (waits to resume, then finishes) → owner-uploaded music
 * (tempo detection, beat-aligned cuts, stereo soundtrack) → incomplete footage.
 * Requires ffmpeg and TEST_DATABASE_URL. Synthetic footage is not a substitute for real haircut clips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { execa } from 'execa';
import { asc, eq } from 'drizzle-orm';
import { loadEnv } from '@studio/config';
import { CancelledError, JOB_TYPES, MusicLicenceSchema, STYLE_IDS, checkMusicForPlatforms, computeTimeline, newId, type JobType, type StyleId } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { LocalDiskStore, storageKeys } from '@studio/storage';
import { probeMedia, quantiseTimeline } from '@studio/media';
import { createAiProviders } from '@studio/ai';
import type { WorkerContext } from '../src/context.js';
import { INTERRUPTED_MESSAGE, type TrackedRun } from '../src/lib/job-tracker.js';
import { handleIngestAsset, refreshProjectReadiness } from '../src/handlers/ingest.js';
import { handleGenerateEdits, handleReviseEdit } from '../src/handlers/generate.js';
import { handleRender } from '../src/handlers/render.js';
import { handleAnalyseMusic } from '../src/handlers/music.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SAMPLES = path.join(REPO, 'data', 'samples');
const skip = !testDatabaseUrl();

/** A TrackedRun without the queue. `stoppedBy` says who aborts the signal: the owner (cancel) or the queue (shutdown). */
function fakeRun(signal: AbortSignal = new AbortController().signal, stoppedBy: 'owner' | 'queue' = 'owner'): TrackedRun {
  return {
    jobId: newId(),
    signal,
    willRetry: true,
    progress: async () => {},
    message: async () => {},
    checkCancelled: () => {
      if (signal.aborted) throw new CancelledError();
    },
    cancelledByOwner: async () => stoppedBy === 'owner' && signal.aborted,
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
      settings: { durationSec: 12, styles: [...STYLE_IDS], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
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

  it('keeps an export that a worker shutdown interrupted waiting to resume, then finishes it', async () => {
    const versionId = versionByStyle['process_story']!;
    const controller = new AbortController();
    setTimeout(() => controller.abort(new CancelledError('pg-boss shut down while active')), 1500);
    await expect(handleRender(ctx, fakeRun(controller.signal, 'queue'), { editVersionId: versionId, projectId }, 'export')).rejects.toBeInstanceOf(CancelledError);
    const interrupted = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) });
    expect(interrupted?.exportStatus).toBe('rendering');
    expect(interrupted?.exportMessage).toBe(INTERRUPTED_MESSAGE);
    expect(interrupted?.exportKey).toBeNull();

    // The queue's next attempt renders it from scratch.
    await handleRender(ctx, fakeRun(), { editVersionId: versionId, projectId }, 'export');
    const done = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) });
    expect(done?.exportStatus).toBe('ready');
    const probe = await probeMedia((ctx.store as LocalDiskStore).resolvePath(done!.exportKey!));
    expect(probe.video).toMatchObject({ codec: 'h264', displayWidth: 1080, displayHeight: 1920 });
    expect(Math.abs(probe.durationSec - computeTimeline(done!.plan!).totalDurationSec)).toBeLessThan(0.25);
  }, 300_000);

  const musicTrackId = newId();
  const musicGenerationId = newId();
  const musicVersionByStyle: Partial<Record<StyleId, string>> = {};

  it('analyses an owner-uploaded music track and finds its tempo', async () => {
    const source = path.join(SAMPLES, 'sample_music_120bpm.mp3');
    const storageKey = storageKeys.musicOriginal(musicTrackId, 'mp3');
    await ctx.store.putFile(storageKey, source, { contentType: 'audio/mpeg' });
    await handle.db.insert(schema.musicTracks).values({
      id: musicTrackId,
      projectId,
      title: 'Synthetic click track',
      storageKey,
      mimeType: 'audio/mpeg',
      byteSize: (await stat(source)).size,
      licence: MusicLicenceSchema.parse({
        kind: 'owner_upload',
        source: 'Uploaded by owner',
        permitted: { promotionalUse: true, instagram: true, tiktok: true },
        confirmedByOwnerAt: new Date().toISOString(),
      }),
    });
    await handleAnalyseMusic(ctx, fakeRun(), { trackId: musicTrackId });
    const track = await handle.db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, musicTrackId) });
    expect(track?.status).toBe('ready');
    expect(track?.durationSec).toBeGreaterThan(39);
    expect(track?.bpm).toBeGreaterThan(118);
    expect(track?.bpm).toBeLessThan(122);
    expect(track?.beats?.beatTimesSec.length).toBeGreaterThan(60);
    expect(checkMusicForPlatforms(track!.licence, ['instagram', 'tiktok']).ok).toBe(true);
  });

  it('cuts the beat montage on the music beats', async () => {
    const styles: StyleId[] = ['beat_montage', 'before_after'];
    await handle.db.insert(schema.generations).values({
      id: musicGenerationId,
      projectId,
      requestedBy: userId,
      settings: { durationSec: 12, styles, musicTrackId, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: 10 },
    });
    for (const [slot, styleId] of styles.entries()) {
      const editId = newId();
      const versionId = newId();
      musicVersionByStyle[styleId] = versionId;
      await handle.db.insert(schema.edits).values({ id: editId, projectId, generationId: musicGenerationId, styleId, slot, currentVersionId: versionId });
      await handle.db.insert(schema.editVersions).values({ id: versionId, editId, versionNo: 1, origin: 'initial', status: 'planning' });
    }
    await handleGenerateEdits(ctx, fakeRun(), { generationId: musicGenerationId, projectId });

    const track = await handle.db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, musicTrackId) });
    const beats = track!.beats!.beatTimesSec;
    const montage = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, musicVersionByStyle['beat_montage']!) });
    expect(montage?.status).toBe('planned');
    const plan = montage!.plan!;
    expect(plan.audio.music?.trackId).toBe(musicTrackId);
    const offset = plan.audio.music!.startOffsetSec;
    // The owner asked for the music to start at 0:10: playback starts on the first beat at or after it.
    const firstBeatFromTen = beats.find((b) => b >= 10 - 0.001)!;
    expect(Math.abs(offset - firstBeatFromTen)).toBeLessThan(0.002);
    const timeline = computeTimeline(plan);
    // Music beat k plays at output time beats[k] - startOffsetSec.
    const distanceToBeat = (t: number) => Math.min(...beats.map((b) => Math.abs(b - offset - t)));
    const hardCuts = timeline.segments.filter((p) => p.index > 0 && !p.segment.transitionIn);
    expect(hardCuts.length).toBeGreaterThanOrEqual(3);
    for (const cut of hardCuts) expect(distanceToBeat(cut.startSec)).toBeLessThanOrEqual(0.06);
    // The renderer snaps every cut to the frame grid; the cuts must still land on the beat in the file,
    // within half a frame of the plan.
    const fps = plan.output.fps;
    const grid = quantiseTimeline(timeline, fps);
    for (const placed of timeline.segments) {
      const renderedStart = grid[placed.index]!.startFrame / fps;
      expect(Math.abs(renderedStart - placed.startSec)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
      if (placed.index > 0 && !placed.segment.transitionIn) expect(distanceToBeat(renderedStart)).toBeLessThanOrEqual(0.06);
    }
    const total = timeline.totalDurationSec;
    expect(offset + total).toBeLessThanOrEqual(track!.durationSec!);

    const beforeAfter = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, musicVersionByStyle['before_after']!) });
    expect(beforeAfter?.status).toBe('planned');
    expect(beforeAfter!.plan!.audio.music?.trackId).toBe(musicTrackId);
  });

  it('renders the music previews with a stereo soundtrack', async () => {
    for (const styleId of ['beat_montage', 'before_after'] as const) {
      const versionId = musicVersionByStyle[styleId]!;
      await handleRender(ctx, fakeRun(), { editVersionId: versionId, projectId }, 'preview');
      const v = await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) });
      expect(v?.status).toBe('preview_ready');
      const probe = await probeMedia((ctx.store as LocalDiskStore).resolvePath(v!.previewKey!));
      expect(probe.video).toMatchObject({ codec: 'h264', displayWidth: 540, displayHeight: 960 });
      expect(probe.audio).toMatchObject({ codec: 'aac', channels: 2, sampleRate: 48000 });
      const total = computeTimeline(v!.plan!).totalDurationSec;
      expect(Math.abs(probe.durationSec - total)).toBeLessThan(0.25);
      expect(Math.abs((v!.previewDurationSec ?? 0) - total)).toBeLessThan(0.25);
    }
    const gen = await handle.db.query.generations.findFirst({ where: eq(schema.generations.id, musicGenerationId) });
    expect(gen?.status).toBe('complete');
  }, 300_000);

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
