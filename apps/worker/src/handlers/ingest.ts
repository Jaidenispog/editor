import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ASSET_ANALYSIS_VERSION,
  AppError,
  CancelledError,
  evaluateStyleSupport,
  type AssetAnalysis,
  type SampledFrame,
  type Shot,
} from '@studio/core';
import { schema } from '@studio/db';
import { storageKeys } from '@studio/storage';
import {
  analyseAudio,
  assembleShots,
  chooseFrameTimes,
  detectScenes,
  extractFrames,
  makeProxy,
  makeThumbnail,
  measureQuality,
  probeMedia,
  runFfmpeg,
} from '@studio/media';
import { HeuristicLabeler, type FrameForLabelling, type VisionLabeler } from '@studio/ai';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { createJobTempDir, removeTempDir } from '../lib/temp.js';
import { applyManualLabels } from '@studio/core';
import { recordAiUsage } from '../lib/plan-context.js';

const MAX_TRANSCRIPTION_SECONDS = 20 * 60;

/**
 * Ingest pipeline for one uploaded clip: probe → proxy → thumbnail → scenes → quality → audio → frames →
 * labelling (vision model or heuristic) → optional transcription → analysis stored on the asset.
 * Idempotent: re-running overwrites the same storage keys and analysis.
 */
export async function handleIngestAsset(ctx: WorkerContext, run: TrackedRun, payload: { assetId: string; projectId: string }): Promise<void> {
  const asset = await ctx.db.query.mediaAssets.findFirst({ where: and(eq(schema.mediaAssets.id, payload.assetId), isNull(schema.mediaAssets.deletedAt)) });
  if (!asset) throw new AppError('NOT_FOUND', 'This clip was removed before it could be processed');
  const project = await ctx.db.query.projects.findFirst({ where: eq(schema.projects.id, payload.projectId) });
  if (!project) throw new AppError('NOT_FOUND', 'The project no longer exists');

  const setAsset = (values: Partial<typeof schema.mediaAssets.$inferInsert>) =>
    ctx.db.update(schema.mediaAssets).set({ ...values, updatedAt: new Date() }).where(eq(schema.mediaAssets.id, asset.id));

  await setAsset({ status: 'processing', statusMessage: 'Checking the file' });
  const tmp = await createJobTempDir(ctx.tmpRoot, run.jobId);
  const ffmpegPath = ctx.env.FFMPEG_PATH;
  try {
    await run.progress(0.02, 'Checking the file');
    const originalPath = path.join(tmp, `original.${asset.originalKey.split('.').pop() ?? 'bin'}`);
    await ctx.store.downloadToFile(asset.originalKey, originalPath);
    const probe = await probeMedia(originalPath, ctx.env.FFPROBE_PATH);
    if (!probe.video) throw new AppError('UNSUPPORTED', 'This file has no video track. Please upload a video clip.');
    if (probe.durationSec < 0.5) throw new AppError('UNSUPPORTED', 'This clip is shorter than half a second and cannot be used.');
    await setAsset({ probe, statusMessage: 'Creating a preview copy' });

    // 1. Proxy (upright, SDR, small) — every analysis step below runs on it for speed and consistency.
    const proxyPath = path.join(tmp, 'proxy.mp4');
    await makeProxy(originalPath, proxyPath, {
      probe,
      maxHeight: 960,
      ffmpegPath,
      signal: run.signal,
      onProgress: (f) => void run.progress(0.05 + 0.3 * f, 'Creating a preview copy'),
    });
    run.checkCancelled();
    const proxyKey = storageKeys.assetProxy(project.id, asset.id);
    await ctx.store.putFile(proxyKey, proxyPath, { contentType: 'video/mp4' });
    const proxyProbe = await probeMedia(proxyPath, ctx.env.FFPROBE_PATH);

    // 2. Thumbnail at a quarter of the way in (first frames are often shaky).
    const thumbPath = path.join(tmp, 'thumb.jpg');
    await makeThumbnail(proxyPath, thumbPath, { probe: proxyProbe, timeSec: Math.min(probe.durationSec * 0.25, Math.max(0, probe.durationSec - 0.1)), width: 540, ffmpegPath });
    const thumbnailKey = storageKeys.assetThumbnail(project.id, asset.id);
    await ctx.store.putFile(thumbnailKey, thumbPath, { contentType: 'image/jpeg' });
    await setAsset({ proxyKey, thumbnailKey, statusMessage: 'Finding the best moments' });
    await run.progress(0.4, 'Finding the best moments');

    // 3. Shots and quality.
    const scenes = await detectScenes(proxyPath, { probe: proxyProbe, ffmpegPath, signal: run.signal });
    const qualities = await measureQuality(proxyPath, scenes, { probe: proxyProbe, ffmpegPath, signal: run.signal });
    let shots: Shot[] = assembleShots(asset.id, scenes, qualities);
    await run.progress(0.55, 'Listening to the audio');

    // 4. Audio.
    const audio = await analyseAudio(proxyPath, { probe: proxyProbe, ffmpegPath, signal: run.signal });
    run.checkCancelled();

    // 5. Sampled frames for the vision model and the UI.
    await run.progress(0.6, ctx.ai.labeler ? 'Identifying shots with AI' : 'Preparing frames');
    const frameTimes = chooseFrameTimes(shots, { maxFrames: ctx.env.AI_VISION_MAX_FRAMES_PER_CLIP });
    const framesDir = path.join(tmp, 'frames');
    const extracted = await extractFrames(
      proxyPath,
      frameTimes.map((f) => f.timeSec),
      framesDir,
      { probe: proxyProbe, longEdge: 768, ffmpegPath, signal: run.signal },
    );
    const sampledFrames: SampledFrame[] = [];
    const framesForLabelling: FrameForLabelling[] = [];
    for (const [i, frame] of extracted.entries()) {
      const shotId = frameTimes[i]?.shotId ?? null;
      const key = storageKeys.assetFrame(project.id, asset.id, Math.round(frame.timeSec * 1000));
      await ctx.store.putFile(key, frame.path, { contentType: 'image/jpeg' });
      sampledFrames.push({ timeSec: frame.timeSec, storageKey: key, width: frame.width, height: frame.height, shotId });
      if (shotId) framesForLabelling.push({ assetId: asset.id, shotId, timeSec: frame.timeSec, jpegPath: frame.path, width: frame.width, height: frame.height });
    }
    run.checkCancelled();

    // 6. Labelling.
    const labeler: VisionLabeler = ctx.ai.labeler ?? new HeuristicLabeler();
    const siblingCount = await ctx.db.$count(schema.mediaAssets, and(eq(schema.mediaAssets.projectId, project.id), isNull(schema.mediaAssets.deletedAt)));
    let labellingNote = '';
    try {
      const labelled = await labeler.labelShots(
        {
          frames: framesForLabelling,
          context: { clipName: asset.originalFilename, clipDurationSec: probe.durationSec, projectNotes: project.notes, clipIndex: asset.sortOrder, clipCount: siblingCount },
        },
        { signal: run.signal },
      );
      await recordAiUsage(ctx, project.id, 'vision_labelling', labelled.usage);
      const byShot = new Map(labelled.results.map((r) => [r.shotId, r]));
      shots = shots.map((shot) => {
        const r = byShot.get(shot.id);
        if (!r) return shot;
        return {
          ...shot,
          label: r.label,
          labelSource: ctx.ai.labeler ? ('vision_model' as const) : ('heuristic' as const),
          confidence: r.confidence,
          description: r.description,
          framing: r.framing,
          focus: r.focus,
          issues: Array.from(new Set([...shot.issues, ...r.issues])),
        };
      });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      // Labelling is best-effort: the clip stays usable (the owner can tag shots by hand).
      ctx.logger.warn({ err, assetId: asset.id }, 'vision labelling failed; keeping heuristic labels');
      labellingNote = 'Automatic shot identification was unavailable for this clip; tag shots by hand if needed.';
    }
    await run.progress(0.8, 'Checking for speech');

    // 7. Transcription only when speech is likely and a provider is configured.
    let transcript: AssetAnalysis['transcript'] = null;
    if (audio.speechLikely && ctx.ai.transcriber && probe.durationSec <= MAX_TRANSCRIPTION_SECONDS) {
      try {
        const speechPath = path.join(tmp, 'speech.m4a');
        await runFfmpeg(['-i', proxyPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', speechPath], { ffmpegPath, signal: run.signal });
        const result = await ctx.ai.transcriber.transcribe(speechPath, { signal: run.signal });
        transcript = { provider: result.provider, language: result.language, segments: result.segments };
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        ctx.logger.warn({ err, assetId: asset.id }, 'transcription failed; continuing without captions');
      }
    }

    const analysis: AssetAnalysis = {
      version: ASSET_ANALYSIS_VERSION,
      assetId: asset.id,
      probe,
      shots,
      sampledFrames,
      audio,
      transcript,
      labelling: {
        source: ctx.ai.labeler ? 'vision_model' : 'heuristic',
        model: ctx.ai.labeler?.model ?? null,
        note: labellingNote,
      },
      completedAt: new Date().toISOString(),
    };
    await setAsset({ analysis, status: 'ready', statusMessage: summariseAnalysis(analysis) });
    await refreshProjectReadiness(ctx, project.id);
    await run.progress(1, 'Clip ready');
  } catch (err) {
    if (err instanceof CancelledError) {
      await setAsset({ status: 'uploaded', statusMessage: 'Processing cancelled' });
    } else {
      await setAsset({ status: 'failed', statusMessage: err instanceof AppError ? err.message : 'This clip could not be processed. Try re-uploading it.' });
      await refreshProjectReadiness(ctx, project.id);
    }
    throw err;
  } finally {
    await removeTempDir(tmp);
  }
}

function summariseAnalysis(a: AssetAnalysis): string {
  const labelled = a.shots.filter((s) => s.label !== 'unknown' && s.label !== 'other').length;
  const parts = [`${a.shots.length} shot${a.shots.length === 1 ? '' : 's'}`];
  if (labelled) parts.push(`${labelled} identified`);
  if (a.transcript?.segments.length) parts.push('speech transcribed');
  else if (a.audio.speechLikely) parts.push('speech detected');
  if (a.probe.video?.isHdr) parts.push('HDR converted');
  return parts.join(' · ');
}

/** Recomputes which styles the project's footage supports and moves the project out of "analysing" when done. */
export async function refreshProjectReadiness(ctx: WorkerContext, projectId: string): Promise<void> {
  const assets = await ctx.db.query.mediaAssets.findMany({
    where: and(eq(schema.mediaAssets.projectId, projectId), isNull(schema.mediaAssets.deletedAt), eq(schema.mediaAssets.kind, 'video')),
  });
  const ready = assets.filter((a) => a.status === 'ready' && a.analysis);
  const analyses = ready.map((a) => applyManualLabels(a.analysis!, { clipLabel: a.clipLabel, manualLabels: a.manualLabels }));
  const styleSupport = analyses.length ? evaluateStyleSupport(analyses) : null;
  const stillProcessing = assets.some((a) => a.status === 'processing' || a.status === 'uploaded');
  const project = await ctx.db.query.projects.findFirst({ columns: { status: true }, where: eq(schema.projects.id, projectId) });
  const nextStatus =
    project && (project.status === 'draft' || project.status === 'analysing' || project.status === 'ready')
      ? stillProcessing
        ? 'analysing'
        : ready.length
          ? 'ready'
          : 'draft'
      : undefined;
  await ctx.db
    .update(schema.projects)
    .set({ styleSupport, ...(nextStatus ? { status: nextStatus } : {}), updatedAt: new Date() })
    .where(eq(schema.projects.id, projectId));
}
