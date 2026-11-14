import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AppError, styleSupportWithManualLabels, type StyleSupport } from '@studio/core';
import { schema, type MediaAsset } from '@studio/db';
import { storageKeys } from '@studio/storage';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { ACTIVE_JOB_STATUSES, cancelJob, createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';
import { getBlobStore } from './storage.js';
import { getAccessibleAsset } from './studio-access.js';
import type { UpdateAssetInput } from './shared/studio-schemas.js';

/**
 * Recomputes which styles the project's analysed clips support, with the owner's tags applied (the same rule
 * the worker uses after analysis), and stores it on the project.
 */
export async function recomputeStyleSupport(projectId: string): Promise<StyleSupport[] | null> {
  const db = getDb();
  const assets = await db.query.mediaAssets.findMany({
    where: and(eq(schema.mediaAssets.projectId, projectId), isNull(schema.mediaAssets.deletedAt), eq(schema.mediaAssets.kind, 'video')),
  });
  const clips = assets
    .filter((a): a is MediaAsset & { analysis: NonNullable<MediaAsset['analysis']> } => a.status === 'ready' && a.analysis !== null)
    .map((a) => ({ analysis: a.analysis, clipLabel: a.clipLabel, manualLabels: a.manualLabels }));
  const styleSupport = styleSupportWithManualLabels(clips);
  await db.update(schema.projects).set({ styleSupport, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  return styleSupport;
}

/** Applies the owner's clip tag, per-shot tags or position, then refreshes style support. */
export async function updateAsset(assetId: string, user: SessionUser, input: UpdateAssetInput): Promise<{ asset: MediaAsset; styleSupport: StyleSupport[] | null }> {
  const { asset } = await getAccessibleAsset(assetId, user);
  let manualLabels = asset.manualLabels;
  if (input.manualLabels !== undefined) {
    const shotIds = new Set(asset.analysis?.shots.map((s) => s.id) ?? []);
    const unknown = Object.keys(input.manualLabels).filter((id) => !shotIds.has(id));
    if (unknown.length) throw new AppError('VALIDATION', 'Some of those shots are not part of this clip. Refresh the page and try again.');
    manualLabels = input.manualLabels;
  }
  const updated = await getDb()
    .update(schema.mediaAssets)
    .set({
      ...(input.clipLabel !== undefined ? { clipLabel: input.clipLabel } : {}),
      ...(input.manualLabels !== undefined ? { manualLabels } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.mediaAssets.id, assetId))
    .returning();
  const row = updated[0];
  if (!row) throw new AppError('NOT_FOUND', 'That clip could not be found.');
  const labelsChanged = input.clipLabel !== undefined || input.manualLabels !== undefined;
  const styleSupport = labelsChanged ? await recomputeStyleSupport(asset.projectId) : null;
  if (labelsChanged) {
    await writeAudit({ userId: user.id, action: 'asset.tagged', entityType: 'media_asset', entityId: assetId, data: { clipLabel: row.clipLabel } });
  }
  return { asset: row, styleSupport };
}

/** Re-queues analysis for a clip that failed (or never started). */
export async function retryAsset(assetId: string, user: SessionUser): Promise<{ jobId: string }> {
  const { asset } = await getAccessibleAsset(assetId, user);
  const db = getDb();
  const active = await db.query.jobs.findFirst({
    where: and(eq(schema.jobs.refId, assetId), eq(schema.jobs.type, 'ingest.asset'), inArray(schema.jobs.status, [...ACTIVE_JOB_STATUSES])),
  });
  if (active) throw new AppError('CONFLICT', 'This clip is already being analysed.');
  if (asset.status === 'ready') throw new AppError('CONFLICT', 'This clip has already been analysed.');
  if (asset.status === 'processing') throw new AppError('CONFLICT', 'This clip is already being analysed.');
  await db
    .update(schema.mediaAssets)
    .set({ status: 'uploaded', statusMessage: 'Waiting to be analysed', updatedAt: new Date() })
    .where(eq(schema.mediaAssets.id, assetId));
  try {
    const job = await createTrackedJob({ type: 'ingest.asset', payload: { assetId, projectId: asset.projectId } });
    return { jobId: job.id };
  } catch (err) {
    await db
      .update(schema.mediaAssets)
      .set({ status: 'failed', statusMessage: 'Analysis could not start. Press Retry to try again.', updatedAt: new Date() })
      .where(eq(schema.mediaAssets.id, assetId));
    throw err;
  }
}

/**
 * Removes a clip: stops its analysis, deletes the original and every derived file (proxy, thumbnail,
 * frames), deletes the row and refreshes style support. Edits already rendered keep their previews.
 */
export async function deleteAsset(assetId: string, user: SessionUser): Promise<{ filesRemoved: number }> {
  const { asset } = await getAccessibleAsset(assetId, user);
  const db = getDb();
  const active = await db.query.jobs.findMany({ where: and(eq(schema.jobs.refId, assetId), inArray(schema.jobs.status, [...ACTIVE_JOB_STATUSES])) });
  for (const job of active) {
    await cancelJob(job.id).catch((err: unknown) => getLogger().warn({ err, jobId: job.id }, 'could not cancel clip job'));
  }
  let filesRemoved = 0;
  try {
    filesRemoved = await getBlobStore().deletePrefix(storageKeys.assetPrefix(asset.projectId, assetId));
  } catch (err) {
    getLogger().error({ err, assetId }, 'failed to remove stored clip files');
    throw new AppError('INTERNAL', 'The clip files could not be removed. Please try removing it again.', { cause: err });
  }
  await db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
  await recomputeStyleSupport(asset.projectId);
  await writeAudit({ userId: user.id, action: 'asset.deleted', entityType: 'media_asset', entityId: assetId, data: { filesRemoved } });
  return { filesRemoved };
}
