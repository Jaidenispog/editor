import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ASSET_ANALYSIS_VERSION,
  AppError,
  CancelledError,
  REFERENCE_MIN_DURATION_SEC,
  REFERENCE_TEXT_FRAMES,
  ReferenceStyleProfileSchema,
  describeReferenceProfile,
  effectivePreferences,
  profileReference,
  type AssetAnalysis,
  type ReferenceAnalysePayload,
  type SampledFrame,
} from '@studio/core';
import { schema, type MediaAsset, type Project } from '@studio/db';
import { storageKeys } from '@studio/storage';
import { analyseAudio, assembleShots, detectScenes, extractFrames, makeProxy, makeThumbnail, measureLook, measureQuality, probeMedia } from '@studio/media';
import type { WorkerContext } from '../context.js';
import { INTERRUPTED_MESSAGE, stopOutcome, type TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { loadSettings, recordAiUsage } from '../lib/plan-context.js';
import { createJobTempDir, removeTempDir } from '../lib/temp.js';

/**
 * Reference videos (preferences design §4.3): measured for style only, never used as footage. The ingest branch
 * makes the proxy, thumbnail and shot list (no vision labelling, no transcription), samples a few frames only when the
 * owner ticked the on-screen text estimate, and hands over to `reference.analyse`, which measures the look, stores the
 * profile and deletes the original, proxy and frames. Only the numbers, the thumbnail and the file name remain.
 */

/** Whether the owner ticked "Also estimate how much on-screen text it has" for this upload. */
export async function referenceUsesVision(ctx: WorkerContext, assetId: string): Promise<boolean> {
  const upload = await ctx.db.query.uploadSessions.findFirst({ where: eq(schema.uploadSessions.assetId, assetId) });
  const options = upload?.driverState?.['referenceOptions'];
  return Boolean(options && typeof options === 'object' && (options as Record<string, unknown>)['useVision'] === true);
}

/** Ingest step for `kind = 'reference_video'` (called from `ingest.asset`). Idempotent: keys are fixed per asset. */
export async function ingestReferenceAsset(ctx: WorkerContext, run: TrackedRun, asset: MediaAsset, project: Project): Promise<void> {
  const setAsset = (values: Partial<typeof schema.mediaAssets.$inferInsert>) =>
    ctx.db.update(schema.mediaAssets).set({ ...values, updatedAt: new Date() }).where(eq(schema.mediaAssets.id, asset.id));
  if (asset.referenceProfile) {
    // Already measured (a retry after the originals were deleted): nothing left to do.
    await setAsset({ status: 'ready' });
    return;
  }
  await setAsset({ status: 'processing', statusMessage: 'Checking the file' });
  const tmp = await createJobTempDir(ctx.tmpRoot, run.jobId);
  const ffmpegPath = ctx.env.FFMPEG_PATH;
  try {
    const originalPath = path.join(tmp, `original.${asset.originalKey.split('.').pop() ?? 'bin'}`);
    await ctx.store.downloadToFile(asset.originalKey, originalPath);
    const probe = await probeMedia(originalPath, ctx.env.FFPROBE_PATH);
    if (!probe.video) throw new AppError('UNSUPPORTED', 'This file has no video.');
    if (probe.durationSec < REFERENCE_MIN_DURATION_SEC) throw new AppError('UNSUPPORTED', 'The video is shorter than 3 seconds, too short to measure.');
    await setAsset({ probe, statusMessage: 'Processing' });
    await run.progress(0.05, 'Processing');

    const proxyPath = path.join(tmp, 'proxy.mp4');
    await makeProxy(originalPath, proxyPath, { probe, maxHeight: 960, ffmpegPath, signal: run.signal, onProgress: (f) => void run.progress(0.05 + 0.4 * f, 'Processing') });
    run.checkCancelled();
    const proxyKey = storageKeys.assetProxy(project.id, asset.id);
    await ctx.store.putFile(proxyKey, proxyPath, { contentType: 'video/mp4' });
    const proxyProbe = await probeMedia(proxyPath, ctx.env.FFPROBE_PATH);
    const thumbPath = path.join(tmp, 'thumb.jpg');
    await makeThumbnail(proxyPath, thumbPath, { probe: proxyProbe, timeSec: Math.min(probe.durationSec * 0.25, Math.max(0, probe.durationSec - 0.1)), width: 540, ffmpegPath });
    const thumbnailKey = storageKeys.assetThumbnail(project.id, asset.id);
    await ctx.store.putFile(thumbnailKey, thumbPath, { contentType: 'image/jpeg' });
    await setAsset({ proxyKey, thumbnailKey, statusMessage: 'Measuring style' });
    await run.progress(0.5, 'Measuring style');

    const scenes = await detectScenes(proxyPath, { probe: proxyProbe, ffmpegPath, signal: run.signal });
    const qualities = await measureQuality(proxyPath, scenes, { probe: proxyProbe, ffmpegPath, signal: run.signal });
    const shots = assembleShots(asset.id, scenes, qualities);
    const audio = await analyseAudio(proxyPath, { probe: proxyProbe, ffmpegPath, signal: run.signal });
    run.checkCancelled();

    // Frames for the text estimate only with the owner's tick and a configured AI provider.
    const useVision = Boolean(ctx.ai.textEstimator) && (await referenceUsesVision(ctx, asset.id));
    const sampledFrames: SampledFrame[] = [];
    if (useVision) {
      const times = Array.from({ length: REFERENCE_TEXT_FRAMES }, (_, i) => ((i + 0.5) / REFERENCE_TEXT_FRAMES) * probe.durationSec);
      const frames = await extractFrames(proxyPath, times, path.join(tmp, 'frames'), { probe: proxyProbe, longEdge: 768, ffmpegPath, signal: run.signal });
      for (const frame of frames) {
        const key = storageKeys.assetFrame(project.id, asset.id, Math.round(frame.timeSec * 1000));
        await ctx.store.putFile(key, frame.path, { contentType: 'image/jpeg' });
        sampledFrames.push({ timeSec: frame.timeSec, storageKey: key, width: frame.width, height: frame.height, shotId: null });
      }
    }

    const analysis: AssetAnalysis = {
      version: ASSET_ANALYSIS_VERSION,
      assetId: asset.id,
      probe,
      shots,
      sampledFrames,
      audio,
      transcript: null,
      labelling: { source: 'heuristic', model: null, note: 'Reference video: measured for style only, never used in edits.' },
      completedAt: new Date().toISOString(),
    };
    await setAsset({ analysis, statusMessage: 'Measuring style' });
    await enqueueTracked(ctx, 'reference.analyse', { assetId: asset.id, projectId: project.id, useVision }, { singletonKey: `reference:${asset.id}` });
    await run.progress(1, 'Measuring style');
  } catch (err) {
    await markReferenceStopped(ctx, run, asset.id, err);
    throw err;
  } finally {
    await removeTempDir(tmp);
  }
}

async function markReferenceStopped(ctx: WorkerContext, run: TrackedRun, assetId: string, err: unknown): Promise<void> {
  const set = (values: Partial<typeof schema.mediaAssets.$inferInsert>) => ctx.db.update(schema.mediaAssets).set({ ...values, updatedAt: new Date() }).where(eq(schema.mediaAssets.id, assetId));
  const outcome = err instanceof CancelledError ? await stopOutcome(run) : null;
  if (outcome === 'cancelled') await set({ status: 'failed', statusMessage: 'Measuring cancelled. Press Retry to measure it again.' });
  else if (outcome === 'resume') await set({ status: 'processing', statusMessage: INTERRUPTED_MESSAGE });
  else if (err instanceof AppError && (err.code === 'UNSUPPORTED' || err.code === 'VALIDATION')) await set({ status: 'failed', statusMessage: err.message });
  else await set({ status: 'failed', statusMessage: 'Measuring failed. Try again.' });
}

/** Deletes the original, proxy and frames of a measured reference (tolerant of files that are already gone). */
async function deleteReferenceOriginals(ctx: WorkerContext, asset: MediaAsset): Promise<void> {
  const tolerant = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      ctx.logger.warn({ err, assetId: asset.id }, 'could not delete a reference file; it may already be gone');
    }
  };
  await tolerant(() => ctx.store.delete(asset.originalKey));
  await tolerant(() => ctx.store.delete(storageKeys.assetProxy(asset.projectId, asset.id)));
  await tolerant(() => ctx.store.deletePrefix(`${storageKeys.assetPrefix(asset.projectId, asset.id)}/frames/`));
}

/**
 * `reference.analyse`: measures the look on the proxy, uses the stored shots, optionally estimates on-screen text
 * (≤ 8 frames, only with the owner's tick), stores the profile with suggestions, then deletes the original, proxy and
 * frames. Skips measuring when the profile already exists; deleting is last and tolerant, so a retry is safe.
 */
export async function handleReferenceAnalyse(ctx: WorkerContext, run: TrackedRun, payload: ReferenceAnalysePayload): Promise<void> {
  const asset = await ctx.db.query.mediaAssets.findFirst({ where: and(eq(schema.mediaAssets.id, payload.assetId), isNull(schema.mediaAssets.deletedAt)) });
  if (!asset) throw new AppError('NOT_FOUND', 'This reference video was removed before it could be measured');
  if (asset.kind !== 'reference_video') throw new AppError('VALIDATION', 'Only reference videos are measured for style');
  const set = (values: Partial<typeof schema.mediaAssets.$inferInsert>) => ctx.db.update(schema.mediaAssets).set({ ...values, updatedAt: new Date() }).where(eq(schema.mediaAssets.id, asset.id));

  let profile = asset.referenceProfile ? ReferenceStyleProfileSchema.parse(asset.referenceProfile) : null;
  if (!profile) {
    if (!asset.analysis || !asset.proxyKey) throw new AppError('PROCESSING_FAILED', 'This reference video has not finished processing.');
    const tmp = await createJobTempDir(ctx.tmpRoot, run.jobId);
    try {
      await run.progress(0.1, 'Measuring style');
      const proxyPath = path.join(tmp, 'proxy.mp4');
      await ctx.store.downloadToFile(asset.proxyKey, proxyPath);
      const look = await measureLook(proxyPath, { ffmpegPath: ctx.env.FFMPEG_PATH, signal: run.signal });
      run.checkCancelled();

      let text: { framesChecked: number; framesWithText: number } | null = null;
      if (payload.useVision && ctx.ai.textEstimator && asset.analysis.sampledFrames.length > 0) {
        await run.progress(0.5, 'Estimating on-screen text');
        try {
          const frames = [];
          for (const [i, f] of asset.analysis.sampledFrames.slice(0, REFERENCE_TEXT_FRAMES).entries()) {
            const local = path.join(tmp, `frame-${i}.jpg`);
            await ctx.store.downloadToFile(f.storageKey, local);
            frames.push({ jpegPath: local, width: f.width, height: f.height });
          }
          const estimate = await ctx.ai.textEstimator.estimateOnScreenText(frames, { signal: run.signal });
          await recordAiUsage(ctx, asset.projectId, 'reference:text', estimate.usage);
          text = estimate.measurement;
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          // Never guessed: the profile says "not measured".
          ctx.logger.warn({ err, assetId: asset.id }, 'on-screen text estimate failed; leaving it unmeasured');
        }
      }

      const settings = await loadSettings(ctx);
      profile = profileReference(
        {
          assetId: asset.id,
          sourceFilename: asset.originalFilename,
          durationSec: asset.analysis.probe.durationSec,
          shotDurationsSec: asset.analysis.shots.map((s) => s.endSec - s.startSec),
          look,
          text,
          measuredAt: new Date(),
        },
        effectivePreferences(settings.preferences),
      );
      await set({ referenceProfile: profile, status: 'ready', statusMessage: describeReferenceProfile(profile) });
    } catch (err) {
      await markReferenceStopped(ctx, run, asset.id, err);
      throw err;
    } finally {
      await removeTempDir(tmp);
    }
  }

  if (!profile.originalsDeletedAt) {
    await run.progress(0.9, 'Deleting the original');
    await deleteReferenceOriginals(ctx, asset);
    const done = { ...profile, originalsDeletedAt: new Date().toISOString() };
    const analysis = asset.analysis ? { ...asset.analysis, sampledFrames: [] } : null;
    await set({ referenceProfile: done, proxyKey: null, analysis, status: 'ready', statusMessage: describeReferenceProfile(done) });
  }
  await run.progress(1, 'Reference measured');
}
