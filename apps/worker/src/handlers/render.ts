import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { AppError, CancelledError, VERTICAL_1080, VERTICAL_PREVIEW, type AssetProbe } from '@studio/core';
import { schema } from '@studio/db';
import { storageKeys } from '@studio/storage';
import { probeMedia, renderEditPlan } from '@studio/media';
import type { WorkerContext } from '../context.js';
import { friendlyFailure, type TrackedRun } from '../lib/job-tracker.js';
import { createJobTempDir, removeTempDir } from '../lib/temp.js';
import { loadSettings } from '../lib/plan-context.js';

/**
 * Renders one edit version. Previews use the small SDR proxies (fast); exports use the originals at 1080×1920.
 * Idempotent: the storage key for a version is fixed, so a retry simply overwrites the earlier file.
 */
export async function handleRender(ctx: WorkerContext, run: TrackedRun, payload: { editVersionId: string; projectId: string }, quality: 'preview' | 'export'): Promise<void> {
  const version = await ctx.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, payload.editVersionId) });
  if (!version) throw new AppError('NOT_FOUND', 'This version no longer exists');
  if (!version.plan) throw new AppError('PROCESSING_FAILED', 'This version has no edit plan to render');
  const edit = await ctx.db.query.edits.findFirst({ where: eq(schema.edits.id, version.editId) });
  if (!edit) throw new AppError('NOT_FOUND', 'The edit no longer exists');
  const settings = await loadSettings(ctx);
  const plan = version.plan;

  const setVersion = (values: Partial<typeof schema.editVersions.$inferInsert>) =>
    ctx.db.update(schema.editVersions).set({ ...values, updatedAt: new Date() }).where(eq(schema.editVersions.id, version.id));

  if (quality === 'preview') await setVersion({ status: 'rendering_preview', statusMessage: 'Rendering preview' });
  else await setVersion({ exportStatus: 'rendering', exportMessage: 'Rendering full-quality video' });

  const tmp = await createJobTempDir(ctx.tmpRoot, run.jobId);
  try {
    await run.progress(0.03, quality === 'preview' ? 'Fetching clips' : 'Fetching original clips');
    const assetIds = Array.from(new Set(plan.segments.map((s) => s.assetId)));
    const rows = await ctx.db.query.mediaAssets.findMany({ where: and(inArray(schema.mediaAssets.id, assetIds), eq(schema.mediaAssets.projectId, payload.projectId)) });
    const assets: Record<string, { path: string; probe: AssetProbe }> = {};
    for (const [i, id] of assetIds.entries()) {
      run.checkCancelled();
      const row = rows.find((r) => r.id === id);
      if (!row || row.deletedAt) throw new AppError('UNSUPPORTED', 'A clip used by this edit has been removed. Generate again to rebuild it.');
      const key = quality === 'preview' ? row.proxyKey : row.originalKey;
      if (!key) throw new AppError('PROCESSING_FAILED', 'A clip used by this edit has not finished processing.');
      const local = path.join(tmp, `${quality}-${i}.${key.split('.').pop() ?? 'mp4'}`);
      await ctx.store.downloadToFile(key, local);
      const probe = await probeMedia(local, ctx.env.FFPROBE_PATH);
      assets[id] = { path: local, probe };
      await run.progress(0.03 + 0.12 * ((i + 1) / assetIds.length), 'Fetching clips');
    }

    let music: { path: string; durationSec: number } | null = null;
    if (plan.audio.music) {
      const track = await ctx.db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, plan.audio.music.trackId) });
      if (!track || track.deletedAt || !track.durationSec) throw new AppError('UNSUPPORTED', 'The music track for this edit is no longer available.');
      const local = path.join(tmp, `music.${track.storageKey.split('.').pop() ?? 'bin'}`);
      await ctx.store.downloadToFile(track.storageKey, local);
      music = { path: local, durationSec: track.durationSec };
    }

    const transcripts: Record<string, { startSec: number; endSec: number; text: string }[]> = {};
    for (const row of rows) if (row.analysis?.transcript?.segments.length) transcripts[row.id] = row.analysis.transcript.segments;

    const outputPath = path.join(tmp, `${quality}.mp4`);
    await run.progress(0.16, quality === 'preview' ? 'Rendering preview' : 'Rendering full-quality video');
    const result = await renderEditPlan(
      {
        plan,
        assets,
        music,
        transcripts,
        quality,
        output: quality === 'preview' ? VERTICAL_PREVIEW : VERTICAL_1080,
        brand: {
          accentColour: settings.brand.accentColour,
          videoTextStyle: settings.brand.videoTextStyle,
          fontHeadline: settings.brand.fontHeadline,
          fontBody: settings.brand.fontBody,
          socialHandle: settings.brand.socialHandle,
        },
        fontsDir: ctx.fontsDir,
        tmpDir: tmp,
        ffmpegPath: ctx.env.FFMPEG_PATH,
        threads: ctx.env.FFMPEG_THREADS,
        signal: run.signal,
        onProgress: (f) => void run.progress(0.16 + 0.74 * f),
      },
      outputPath,
    );
    run.checkCancelled();
    await run.progress(0.92, 'Saving');
    const key = quality === 'preview' ? storageKeys.editPreview(payload.projectId, edit.id, version.versionNo) : storageKeys.editExport(payload.projectId, edit.id, version.versionNo);
    await ctx.store.putFile(key, outputPath, { contentType: 'video/mp4' });
    if (quality === 'preview') {
      await setVersion({ status: 'preview_ready', statusMessage: 'Preview ready', previewKey: key, previewDurationSec: result.durationSec });
      await refreshGenerationStatus(ctx, edit.generationId, payload.projectId);
    } else {
      await setVersion({ exportStatus: 'ready', exportMessage: 'Ready to download', exportKey: key, exportByteSize: result.byteSize });
    }
    await run.progress(1, quality === 'preview' ? 'Preview ready' : 'Export ready');
  } catch (err) {
    if (err instanceof CancelledError) {
      if (quality === 'preview') await setVersion({ status: 'cancelled', statusMessage: 'Preview cancelled' });
      else await setVersion({ exportStatus: 'none', exportMessage: 'Export cancelled' });
    } else {
      const message = friendlyFailure(err);
      if (quality === 'preview') await setVersion({ status: 'failed', statusMessage: message });
      else await setVersion({ exportStatus: 'failed', exportMessage: message });
      if (quality === 'preview') await refreshGenerationStatus(ctx, edit.generationId, payload.projectId);
    }
    throw err;
  } finally {
    await removeTempDir(tmp);
  }
}

/** Marks the generation complete/partial once every edit's current version has settled. */
export async function refreshGenerationStatus(ctx: WorkerContext, generationId: string, projectId: string): Promise<void> {
  const edits = await ctx.db.query.edits.findMany({ where: eq(schema.edits.generationId, generationId) });
  const ids = edits.map((e) => e.currentVersionId).filter((v): v is string => Boolean(v));
  const versions = ids.length ? await ctx.db.query.editVersions.findMany({ where: inArray(schema.editVersions.id, ids) }) : [];
  const settled = versions.every((v) => v.status === 'preview_ready' || v.status === 'failed' || v.status === 'cancelled');
  if (!settled || versions.length === 0) return;
  const ready = versions.filter((v) => v.status === 'preview_ready').length;
  const status = ready === versions.length ? 'complete' : ready === 0 ? 'failed' : 'partial';
  await ctx.db
    .update(schema.generations)
    .set({ status, statusMessage: status === 'complete' ? `${ready} previews ready` : status === 'partial' ? `${ready} of ${versions.length} previews ready` : 'No previews could be rendered', updatedAt: new Date() })
    .where(eq(schema.generations.id, generationId));
  await ctx.db.update(schema.projects).set({ status: ready > 0 ? 'complete' : 'ready', updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
}
