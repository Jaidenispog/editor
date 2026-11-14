/**
 * Music controls on a real database and real ffmpeg, with SYNTHETIC footage and the synthetic 120 BPM track
 * (scripts/make-sample-footage.sh): the Sound panel's fast path (`edits.revise` mode `audio`) and its re-cut path,
 * the music-free export variant, the export clearance gate and the usage ledger, and that private Spotify
 * references never reach the planner. Skipped unless TEST_DATABASE_URL is set.
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
import { AudioPatchSchema, CancelledError, JOB_PAYLOAD_SCHEMAS, MusicLicenceSchema, NonRetryableError, computeTimeline, newId, type JobType } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { LocalDiskStore, storageKeys } from '@studio/storage';
import { probeMedia } from '@studio/media';
import { createAiProviders } from '@studio/ai';
import type { WorkerContext } from '../src/context.js';
import type { TrackedRun } from '../src/lib/job-tracker.js';
import { handleIngestAsset, refreshProjectReadiness } from '../src/handlers/ingest.js';
import { buildPlannerInput, handleGenerateEdits, handleReviseEdit } from '../src/handlers/generate.js';
import { handleRender } from '../src/handlers/render.js';
import { handleAnalyseMusic } from '../src/handlers/music.js';
import { loadMusic, loadProjectFootage, loadSettings } from '../src/lib/plan-context.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SAMPLES = path.join(REPO, 'data', 'samples');
const skip = !testDatabaseUrl();

function fakeRun(): TrackedRun {
  const signal = new AbortController().signal;
  return {
    jobId: newId(),
    signal,
    willRetry: true,
    progress: async () => {},
    message: async () => {},
    checkCancelled: () => {
      if (signal.aborted) throw new CancelledError();
    },
    cancelledByOwner: async () => false,
  };
}

/** Loudest sample of a file's audio in dB (ffmpeg volumedetect); about -91 dB for digital silence. */
async function maxVolumeDb(file: string): Promise<number> {
  const { stderr } = await execa('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { reject: false });
  const m = stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) throw new Error(`no volume reading: ${stderr.slice(-400)}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

describe.skipIf(skip)('music controls on synthetic footage', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let root: string;
  let ctx: WorkerContext;
  const enqueued: Array<{ type: JobType; payload: Record<string, unknown> }> = [];
  const userId = newId();
  const projectId = newId();
  const trackId = newId();
  const generationId = newId();
  const editId = newId();
  const v1 = newId();
  const v2 = newId();
  const v3 = newId();
  const resolve = (key: string) => (ctx.store as LocalDiskStore).resolvePath(key);
  const version = async (id: string) => (await handle.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, id) }))!;

  beforeAll(async () => {
    if (!existsSync(path.join(SAMPLES, 'sample_music_120bpm.mp3'))) await execa('bash', [path.join(REPO, 'scripts', 'make-sample-footage.sh'), SAMPLES]);
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    root = await mkdtemp(path.join(os.tmpdir(), 'sa-music-'));
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
      ai: createAiProviders(env, logger),
      logger,
      workerId: 'test-worker',
      fontsDir: path.join(REPO, 'assets', 'fonts'),
      tmpRoot: env.WORKER_TMP_DIR,
    };
    await handle.db.insert(schema.users).values({ id: userId, email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    await handle.db.insert(schema.projects).values({ id: projectId, ownerId: userId, title: 'Synthetic music project' });
    const clips: Array<[string, string, 'cutting' | 'result']> = [
      ['sample_a_portrait_sdr.mp4', 'video/mp4', 'cutting'],
      ['sample_c_noaudio_scenes.mp4', 'video/mp4', 'result'],
    ];
    for (const [i, [file, mime, label]] of clips.entries()) {
      const id = newId();
      const originalKey = storageKeys.assetOriginal(projectId, id, 'mp4');
      await store.putFile(originalKey, path.join(SAMPLES, file));
      await handle.db.insert(schema.mediaAssets).values({ id, projectId, kind: 'video', originalFilename: file, mimeType: mime, byteSize: 1, sortOrder: i, originalKey, status: 'uploaded' });
      await handleIngestAsset(ctx, fakeRun(), { assetId: id, projectId });
      await handle.db.update(schema.mediaAssets).set({ clipLabel: label }).where(eq(schema.mediaAssets.id, id));
    }
    await refreshProjectReadiness(ctx, projectId);

    const source = path.join(SAMPLES, 'sample_music_120bpm.mp3');
    const storageKey = storageKeys.musicOriginal(trackId, 'mp3');
    await ctx.store.putFile(storageKey, source, { contentType: 'audio/mpeg' });
    await handle.db.insert(schema.musicTracks).values({
      id: trackId,
      title: 'Synthetic click track',
      storageKey,
      mimeType: 'audio/mpeg',
      byteSize: (await stat(source)).size,
      licence: MusicLicenceSchema.parse({ kind: 'owner_upload', permitted: { promotionalUse: true, instagram: true, tiktok: true }, confirmedByOwnerAt: new Date().toISOString() }),
    });
    await handleAnalyseMusic(ctx, fakeRun(), { trackId });

    await handle.db.insert(schema.generations).values({
      id: generationId,
      projectId,
      requestedBy: userId,
      settings: { durationSec: 12, styles: ['beat_montage'], musicTrackId: trackId, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
    });
    await handle.db.insert(schema.edits).values({ id: editId, projectId, generationId, styleId: 'beat_montage', slot: 0, currentVersionId: v1 });
    await handle.db.insert(schema.editVersions).values({ id: v1, editId, versionNo: 1, origin: 'initial', status: 'planning' });
    await handleGenerateEdits(ctx, fakeRun(), { generationId, projectId });
    await handleRender(ctx, fakeRun(), { editVersionId: v1, projectId }, 'preview');
  }, 600_000);

  afterAll(async () => {
    await drop();
    await rm(root, { recursive: true, force: true });
  });

  it('plans the first version with music', async () => {
    const v = await version(v1);
    expect(v.status).toBe('preview_ready');
    expect(v.plan?.audio.music?.trackId).toBe(trackId);
  });

  it('changes the sound on the fast path: new version, same cuts, preview renders', async () => {
    const parent = await version(v1);
    await handle.db.insert(schema.editVersions).values({ id: v2, editId, versionNo: 2, parentVersionId: v1, origin: 'revise', status: 'planning' });
    const audio = AudioPatchSchema.parse({ volume: 0.4, fadeOutSec: 2, startSec: 8.1, originalSound: 'under_music', originalVolume: 0.5 });
    const payload = JOB_PAYLOAD_SCHEMAS['edits.revise'].parse({ editId, projectId, newVersionId: v2, mode: 'audio', audio });
    await handleReviseEdit(ctx, fakeRun(), payload);
    const v = await version(v2);
    expect(v.status).toBe('planned');
    expect(v.planSource).toBe('manual');
    expect(v.statusMessage).toBe('Sound changed · cuts kept');
    expect(v.plan!.segments.map((s) => [s.assetId, s.inSec, s.outSec])).toEqual(parent.plan!.segments.map((s) => [s.assetId, s.inSec, s.outSec]));
    expect(v.plan!.audio.music).toMatchObject({ trackId, volume: 0.4, fadeOutSec: 2 });
    const beats = (await loadMusic(ctx, trackId))!.beatTimesSec;
    const start = v.plan!.audio.music!.startOffsetSec;
    expect(start).toBeGreaterThanOrEqual(8.1 - 0.001);
    expect(beats.some((b) => Math.abs(b - start) < 0.002)).toBe(true);
    expect(v.plan!.audio.originalSound).toEqual({ enabled: true, volume: 0.5 });
    // The parent version is untouched.
    expect((await version(v1)).plan).toEqual(parent.plan);
    expect(enqueued.some((e) => e.type === 'render.preview' && e.payload['editVersionId'] === v2)).toBe(true);
    await handleRender(ctx, fakeRun(), { editVersionId: v2, projectId }, 'preview');
    expect((await version(v2)).status).toBe('preview_ready');
  }, 300_000);

  it('re-cuts to the music when the beat options change', async () => {
    await handle.db.insert(schema.editVersions).values({ id: v3, editId, versionNo: 3, parentVersionId: v1, origin: 'revise', status: 'planning' });
    const payload = JOB_PAYLOAD_SCHEMAS['edits.revise'].parse({ editId, projectId, newVersionId: v3, mode: 'revise', audio: { revealOnBeat: 'on', volume: 0.6 } });
    await handleReviseEdit(ctx, fakeRun(), payload);
    const v = await version(v3);
    expect(v.status).toBe('planned');
    expect(v.statusMessage).toBe('Re-cut to the music');
    expect(v.plan!.audio.music).toMatchObject({ trackId, volume: 0.6 });
  });

  it('exports the standard file and writes one usage-ledger row, even when exported twice', async () => {
    await handleRender(ctx, fakeRun(), JOB_PAYLOAD_SCHEMAS['render.export'].parse({ editVersionId: v1, projectId }), 'export');
    let v = await version(v1);
    expect(v.exportStatus).toBe('ready');
    expect(await maxVolumeDb(resolve(v.exportKey!))).toBeGreaterThan(-40);
    await handleRender(ctx, fakeRun(), { editVersionId: v1, projectId, variant: 'standard' }, 'export');
    v = await version(v1);
    expect(v.exportStatus).toBe('ready');
    const rows = await handle.db.query.musicUsage.findMany({ where: eq(schema.musicUsage.editVersionId, v1) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trackId, purpose: 'export', platform: '' });
    expect(rows[0]!.licenceSnapshot.kind).toBe('owner_upload');
    expect(rows[0]!.clearance.state).toBe('cleared');
  }, 300_000);

  it('renders the music-free variant of the same version without the music', async () => {
    await handleRender(ctx, fakeRun(), { editVersionId: v1, projectId, variant: 'no_music' }, 'export');
    const v = await version(v1);
    const nm = v.variantExports.no_music;
    expect(nm?.status).toBe('ready');
    expect(nm?.key).toBe(storageKeys.editExportVariant(projectId, editId, 1, 'no_music'));
    expect(nm?.key).toMatch(/export-no-music\.mp4$/);
    // The standard export is untouched and no new version was made.
    expect(v.exportStatus).toBe('ready');
    expect(v.exportKey).toBe(storageKeys.editExport(projectId, editId, 1));
    expect((await handle.db.query.editVersions.findMany({ where: eq(schema.editVersions.editId, editId) })).length).toBe(3);
    const probe = await probeMedia(resolve(nm!.key!));
    expect(probe.video).toMatchObject({ displayWidth: 1080, displayHeight: 1920 });
    expect(Math.abs(probe.durationSec - computeTimeline(v.plan!).totalDurationSec)).toBeLessThan(0.25);
    // The plan keeps no clip sound here (music was on), so without the music the file has no sound stream at all.
    expect(v.plan!.audio.originalSound.enabled).toBe(false);
    expect(v.plan!.segments.some((s) => s.keepOriginalSound)).toBe(false);
    expect(probe.audio).toBeNull();
    // The music-free file writes no ledger row.
    expect(await handle.db.query.musicUsage.findMany({ where: eq(schema.musicUsage.editVersionId, v1) })).toHaveLength(1);
  }, 300_000);

  it('refuses to export music whose licence is no longer cleared, without retrying, and still makes the music-free file', async () => {
    const track = await handle.db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, trackId) });
    await handle.db.update(schema.musicTracks).set({ licence: { ...track!.licence, confirmedByOwnerAt: null } }).where(eq(schema.musicTracks.id, trackId));
    // Fails with a NonRetryableError (so the queue does not retry it), the export marked failed and the reason shown.
    await expect(handleRender(ctx, fakeRun(), { editVersionId: v2, projectId, variant: 'standard' }, 'export')).rejects.toBeInstanceOf(NonRetryableError);
    const v = await version(v2);
    expect(v.exportStatus).toBe('failed');
    expect(v.exportMessage).toMatch(/isn't cleared for business use: The licence has not been confirmed by the owner\. Make a music-free version/);
    expect(v.exportKey).toBeNull();
    const audit = await handle.db.query.auditLog.findMany({ where: and(eq(schema.auditLog.action, 'music.export_blocked'), eq(schema.auditLog.entityId, v2)) });
    expect(audit).toHaveLength(1);
    expect(await handle.db.query.musicUsage.findMany({ where: eq(schema.musicUsage.editVersionId, v2) })).toHaveLength(0);

    await handleRender(ctx, fakeRun(), { editVersionId: v2, projectId, variant: 'no_music' }, 'export');
    const after = await version(v2);
    expect(after.variantExports.no_music?.status).toBe('ready');
    // v2 keeps the clip sound under the music, so its music-free file still has the shop sound.
    expect(await maxVolumeDb(resolve(after.variantExports.no_music!.key!))).toBeGreaterThan(-60);
  }, 300_000);

  it('never puts private Spotify references into the planner input', async () => {
    await handle.db.insert(schema.musicReferences).values({ id: newId(), url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', itemType: 'track', externalId: '4uLU6hMCjMI75M1A2tKUQC', notes: 'vibe for fade videos' });
    const footage = (await loadProjectFootage(ctx, projectId))!;
    const generation = await handle.db.query.generations.findFirst({ where: eq(schema.generations.id, generationId) });
    const input = buildPlannerInput({ styleId: 'beat_montage', settings: generation!.settings, footage, music: await loadMusic(ctx, trackId), appSettings: await loadSettings(ctx), attempt: 0 });
    const text = JSON.stringify(input);
    expect(text).not.toContain('open.spotify.com');
    expect(text).not.toContain('vibe for fade videos');
  });
});
