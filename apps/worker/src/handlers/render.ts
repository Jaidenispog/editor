import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  AppError,
  CancelledError,
  NonRetryableError,
  VERTICAL_1080,
  VERTICAL_PREVIEW,
  missingTrackClearance,
  musicClearanceFor,
  newId,
  normaliseLicence,
  withoutMusic,
  type AssetProbe,
  type EditPlan,
  type ExportVariant,
  type MusicClearance,
} from '@studio/core';
import { schema, type VariantExportState } from '@studio/db';
import { storageKeys } from '@studio/storage';
import { probeMedia, renderEditPlan } from '@studio/media';
import type { WorkerContext } from '../context.js';
import { INTERRUPTED_MESSAGE, friendlyFailure, stopOutcome, type TrackedRun } from '../lib/job-tracker.js';
import { createJobTempDir, removeTempDir } from '../lib/temp.js';
import { loadSettings } from '../lib/plan-context.js';
import { runExportReadyHooks } from '../modules/index.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { brandForExport, brandForPreview } from '../modules/preferences/brand.js';

/** The plain message an export blocked by its music licence shows on the card. */
export function musicBlockedMessage(clearance: MusicClearance): string {
  const reason = (clearance.reasons[0] ?? 'the licence could not be checked.').replace(/\.$/, '');
  return `This version's music isn't cleared for business use: ${reason}. Make a music-free version, or confirm the licence in Settings → Music.`;
}

/**
 * Checks the music of a plan against its track's current licence (the worker's second check after the export
 * route's). No music → `no_music`; a removed track → blocked.
 */
export async function clearanceForPlan(ctx: WorkerContext, plan: EditPlan): Promise<{ clearance: MusicClearance; track: typeof schema.musicTracks.$inferSelect | null }> {
  if (!plan.audio.music) return { clearance: musicClearanceFor(null), track: null };
  const track = await ctx.db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, plan.audio.music.trackId) });
  if (!track || track.deletedAt) return { clearance: missingTrackClearance(), track: null };
  return { clearance: musicClearanceFor(track.licence), track };
}

/** Merges one variant's state into `edit_versions.variant_exports` without touching other variants. */
async function setVariantState(ctx: WorkerContext, versionId: string, variant: Exclude<ExportVariant, 'standard'>, state: Omit<VariantExportState, 'updatedAt'>): Promise<void> {
  const value = JSON.stringify({ [variant]: { ...state, updatedAt: new Date().toISOString() } });
  await ctx.db
    .update(schema.editVersions)
    .set({ variantExports: sql`${schema.editVersions.variantExports} || ${value}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.editVersions.id, versionId));
}

/**
 * Renders one edit version. Previews use the small SDR proxies (fast); exports use the originals at 1080×1920.
 * Exports come in two variants: `standard` (as planned; its music must be cleared by its licence, and a usage-ledger
 * row is written once it is stored) and `no_music` (the same cuts, text and colour with the music removed, stored next
 * to the standard file; it needs no clearance and writes no ledger row).
 * Idempotent: the storage key for a version and variant is fixed, so a retry simply overwrites the earlier file.
 */
export async function handleRender(
  ctx: WorkerContext,
  run: TrackedRun,
  payload: { editVersionId: string; projectId: string; variant?: ExportVariant | undefined },
  quality: 'preview' | 'export',
): Promise<void> {
  const variant: ExportVariant = quality === 'export' ? (payload.variant ?? 'standard') : 'standard';
  const version = await ctx.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, payload.editVersionId) });
  if (!version) throw new AppError('NOT_FOUND', 'This version no longer exists');
  if (!version.plan) throw new AppError('PROCESSING_FAILED', 'This version has no edit plan to render');
  const edit = await ctx.db.query.edits.findFirst({ where: eq(schema.edits.id, version.editId) });
  if (!edit) throw new AppError('NOT_FOUND', 'The edit no longer exists');
  const settings = await loadSettings(ctx);
  const plan = variant === 'no_music' ? withoutMusic(version.plan) : version.plan;

  const setVersion = (values: Partial<typeof schema.editVersions.$inferInsert>) =>
    ctx.db.update(schema.editVersions).set({ ...values, updatedAt: new Date() }).where(eq(schema.editVersions.id, version.id));
  /** Export progress of this variant: the standard columns, or the variant's entry in `variant_exports`. */
  const setExport = async (status: 'none' | 'rendering' | 'ready' | 'failed', message: string, file?: { key: string; byteSize: number }) => {
    if (variant === 'standard') {
      await setVersion({ exportStatus: status, exportMessage: message, ...(file ? { exportKey: file.key, exportByteSize: file.byteSize } : {}) });
    } else {
      await setVariantState(ctx, version.id, variant, { status: status === 'none' ? 'failed' : status, key: file?.key ?? null, byteSize: file?.byteSize ?? null, message });
    }
  };

  // Defence in depth: the export route already refused music the licence does not clear, but the licence may have
  // changed since. A blocked export is the owner's to fix, not a fault to retry: the job fails without a retry.
  let clearance: MusicClearance | null = null;
  let licencedTrack: Awaited<ReturnType<typeof clearanceForPlan>>['track'] = null;
  if (quality === 'export' && variant === 'standard') {
    const checked = await clearanceForPlan(ctx, plan);
    clearance = checked.clearance;
    licencedTrack = checked.track;
    if (clearance.state === 'blocked') {
      const message = musicBlockedMessage(clearance);
      await setVersion({ exportStatus: 'failed', exportMessage: message });
      await writeWorkerAudit(ctx.db, { userId: null, action: 'music.export_blocked', entityType: 'edit_version', entityId: version.id, data: { reasons: clearance.reasons } }, ctx.logger);
      throw new NonRetryableError('PROCESSING_FAILED', message, { details: { reasons: clearance.reasons } });
    }
  }

  if (quality === 'preview') await setVersion({ status: 'rendering_preview', statusMessage: 'Rendering preview' });
  else await setExport('rendering', variant === 'no_music' ? 'Rendering the music-free version' : 'Rendering full-quality video');

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

    // Brand: previews use the current settings and keep a snapshot; exports reuse their preview's snapshot.
    const prepared = quality === 'preview' ? await brandForPreview(ctx, settings, tmp) : await brandForExport(ctx, version.renderBrand, settings, tmp);
    const brandNote = prepared.note ? ` · ${prepared.note}` : '';

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
        brand: prepared.brand,
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
    const key =
      quality === 'preview'
        ? storageKeys.editPreview(payload.projectId, edit.id, version.versionNo)
        : variant === 'no_music'
          ? storageKeys.editExportVariant(payload.projectId, edit.id, version.versionNo, 'no_music')
          : storageKeys.editExport(payload.projectId, edit.id, version.versionNo);
    await ctx.store.putFile(key, outputPath, { contentType: 'video/mp4' });
    if (quality === 'preview') {
      await setVersion({ status: 'preview_ready', statusMessage: `Preview ready${brandNote}`, previewKey: key, previewDurationSec: result.durationSec, renderBrand: prepared.snapshot });
      await refreshGenerationStatus(ctx, edit.generationId, payload.projectId);
    } else {
      await setExport('ready', `Ready to download${brandNote}`, { key, byteSize: result.byteSize });
      if (clearance && licencedTrack && clearance.state !== 'no_music') {
        // Usage ledger (memo §2): one row per version for its export, with the licence as it was. A second export
        // of the same version adds nothing.
        await ctx.db
          .insert(schema.musicUsage)
          .values({ id: newId(), trackId: licencedTrack.id, editVersionId: version.id, purpose: 'export', platform: '', licenceSnapshot: normaliseLicence(licencedTrack.licence), clearance })
          .onConflictDoNothing();
      }
      await runExportReadyHooks(ctx, { editVersionId: version.id, editId: edit.id, projectId: payload.projectId, variant, storageKey: key, byteSize: result.byteSize });
    }
    await run.progress(1, quality === 'preview' ? 'Preview ready' : 'Export ready');
  } catch (err) {
    const outcome = err instanceof CancelledError ? await stopOutcome(run) : null;
    if (outcome === 'cancelled') {
      if (quality === 'preview') await setVersion({ status: 'cancelled', statusMessage: 'Preview cancelled' });
      else await setExport('none', 'Export cancelled');
    } else if (outcome === 'resume') {
      // The queue renders this version again after a worker restart or time limit.
      if (quality === 'preview') await setVersion({ statusMessage: INTERRUPTED_MESSAGE });
      else if (variant === 'standard') await setVersion({ exportMessage: INTERRUPTED_MESSAGE });
      else await setExport('rendering', INTERRUPTED_MESSAGE);
    } else {
      const message = friendlyFailure(err);
      if (quality === 'preview') await setVersion({ status: 'failed', statusMessage: message });
      else await setExport('failed', message);
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
