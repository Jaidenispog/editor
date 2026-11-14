import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DEFAULT_RESUMABLE_MAX_BYTES,
  checkMediaForPlatform,
  manualStepMessage,
  melbourneScheduleLabel,
  methodVariantRefusal,
  type ExportVariant,
  type JobPayload,
  type TargetPlatform,
} from '@studio/core';
import { schema } from '@studio/db';
import { storageKeys } from '@studio/storage';
import { extractFrames, probeMedia } from '@studio/media';
import type { WorkerContext } from '../context.js';
import { enqueueTracked } from '../lib/jobs.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { createJobTempDir, removeTempDir } from '../lib/temp.js';
import { postIsLive } from './publish-target.js';
import { liveEligibility, refreshPostStatus, toManualStep, updateTarget, type PostRow, type TargetRow } from '../publishing/post-status.js';

type Version = typeof schema.editVersions.$inferSelect;

/** The stored file of a version's variant once it is ready, or its export state. */
function fileFor(version: Version, variant: ExportVariant): { key: string; byteSize: number | null } | { state: 'none' | 'queued' | 'rendering' | 'failed'; message: string } {
  if (variant === 'standard') {
    if (version.exportStatus === 'ready' && version.exportKey) return { key: version.exportKey, byteSize: version.exportByteSize };
    return { state: version.exportStatus === 'ready' ? 'none' : version.exportStatus, message: version.exportMessage };
  }
  const v = version.variantExports.no_music;
  if (v?.status === 'ready' && v.key) return { key: v.key, byteSize: v.byteSize };
  return { state: v?.status === 'ready' ? 'none' : (v?.status ?? 'none'), message: v?.message ?? '' };
}

/** Claims and queues the full-quality render of one variant (same claim rules and singleton key as the Studio's export button). */
async function requestExport(ctx: WorkerContext, version: Version, projectId: string, variant: ExportVariant): Promise<void> {
  if (variant === 'standard') {
    const claimed = await ctx.db
      .update(schema.editVersions)
      .set({ exportStatus: 'queued', exportMessage: 'Waiting to export (for publishing)', updatedAt: new Date() })
      .where(and(eq(schema.editVersions.id, version.id), inArray(schema.editVersions.exportStatus, ['none', 'failed'])))
      .returning({ id: schema.editVersions.id });
    if (claimed.length === 0) return;
  } else {
    const queued = JSON.stringify({ no_music: { status: 'queued', key: null, byteSize: null, message: 'Waiting to make the music-free version (for publishing)', updatedAt: new Date().toISOString() } });
    const claimed = await ctx.db
      .update(schema.editVersions)
      .set({ variantExports: sql`${schema.editVersions.variantExports} || ${queued}::jsonb`, updatedAt: new Date() })
      .where(and(eq(schema.editVersions.id, version.id), sql`coalesce(${schema.editVersions.variantExports}->'no_music'->>'status', 'none') not in ('queued', 'rendering', 'ready')`))
      .returning({ id: schema.editVersions.id });
    if (claimed.length === 0) return;
  }
  await enqueueTracked(ctx, 'render.export', { editVersionId: version.id, projectId, variant }, { singletonKey: `export:${version.id}:${variant}` });
}

function scheduledMessage(post: PostRow): string {
  return post.scheduledFor ? `Scheduled for ${melbourneScheduleLabel(post.scheduledFor)}` : 'Queued';
}

/** True when the post should go out now (mode `now` / `draft_handoff`, or a schedule that is due). */
export function isDue(post: Pick<PostRow, 'mode' | 'scheduledFor'>, now: Date = new Date()): boolean {
  return post.mode !== 'scheduled' || (post.scheduledFor !== null && post.scheduledFor.getTime() <= now.getTime());
}

/**
 * `publish.prepare`: makes sure every waiting target's exact file exists (queuing the export or the music-free
 * export when missing; the render handler's export-ready hook runs this job again), checks the file against the
 * platform's limits, cuts the cover from the export, and hands each target on: manual targets become the owner's
 * turn when due, automated ones get a `publish.target` job when due. Re-checks the music licence first.
 */
export async function handlePublishPrepare(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'publish.prepare'>): Promise<void> {
  const post = await ctx.db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, payload.postId) });
  if (!post || !postIsLive(post)) return;
  const targets = (await ctx.db.query.publishTargets.findMany({ where: eq(schema.publishTargets.postId, post.id) })).filter((t) => t.status === 'queued' && !t.submittedAt);
  if (targets.length === 0) return;
  const version = await ctx.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, post.editVersionId) });
  const edit = version ? await ctx.db.query.edits.findFirst({ where: eq(schema.edits.id, version.editId) }) : null;
  if (!version || !edit || edit.deletedAt) {
    for (const t of targets) await updateTarget(ctx.db, t.id, ['queued'], { status: 'failed', statusMessage: 'This edit was deleted, so there is nothing to post.', providerState: { retryable: false } });
    await refreshPostStatus(ctx.db, post.id);
    return;
  }

  const live = await liveEligibility(ctx.db, version.id, targets.map((t) => t.platform as TargetPlatform));
  const tmp = await createJobTempDir(ctx.tmpRoot, run.jobId);
  try {
    let coverDone = Boolean(post.coverKey);
    const probes = new Map<string, Awaited<ReturnType<typeof probeMedia>>>();
    for (const target of targets) {
      run.checkCancelled();
      const e = live?.eligibility.perPlatform.find((p) => p.platform === target.platform);
      const refusal = !e ? 'This version no longer has a plan.' : methodVariantRefusal(e, target.method, target.mediaVariant);
      if (refusal) {
        await toManualStep(ctx.db, target.id, ['queued'], 'music_licence_changed', manualStepMessage('music_licence_changed', target.platform), { error: refusal.slice(0, 500) });
        continue;
      }
      const file = fileFor(version, target.mediaVariant);
      if (!('key' in file)) {
        if (file.state === 'failed' && target.providerState['exportRequested']) {
          await updateTarget(ctx.db, target.id, ['queued'], { status: 'failed', statusMessage: `The full-quality video could not be made${file.message ? `: ${file.message}` : '.'}`.slice(0, 500), providerState: { retryable: true, exportRequested: false } });
          continue;
        }
        if (file.state === 'none' || file.state === 'failed') await requestExport(ctx, version, edit.projectId, target.mediaVariant);
        const due = isDue(post);
        await updateTarget(ctx.db, target.id, ['queued'], {
          statusMessage: due && post.mode === 'scheduled' && post.scheduledFor
            ? `Will post as soon as the video is ready (was due ${melbourneScheduleLabel(post.scheduledFor)})`
            : target.mediaVariant === 'no_music' ? 'Preparing the full-quality video without music…' : 'Preparing the full-quality video…',
          providerState: { exportRequested: true },
        });
        continue;
      }

      // The file exists: check it against the platform's published limits (ffprobe on a local copy).
      let probe = probes.get(file.key);
      if (!probe) {
        const local = path.join(tmp, `${probes.size}.mp4`);
        await ctx.store.downloadToFile(file.key, local);
        probe = await probeMedia(local, ctx.env.FFPROBE_PATH);
        probes.set(file.key, probe);
        if (!coverDone && post.coverTimeSec !== null) {
          const [frame] = await extractFrames(local, [post.coverTimeSec], path.join(tmp, 'cover'), { probe, longEdge: 1920, ffmpegPath: ctx.env.FFMPEG_PATH, signal: run.signal });
          if (frame) {
            const coverKey = storageKeys.publishCover(post.id);
            await ctx.store.putFile(coverKey, frame.path, { contentType: 'image/jpeg' });
            await ctx.db.update(schema.publishPosts).set({ coverKey, updatedAt: new Date() }).where(eq(schema.publishPosts.id, post.id));
            coverDone = true;
          }
        }
      }
      const byteSize = file.byteSize ?? probe.fileSizeBytes;
      const account = target.accountId ? await ctx.db.query.socialAccounts.findFirst({ columns: { capabilities: true }, where: eq(schema.socialAccounts.id, target.accountId) }) : null;
      const cap = typeof account?.capabilities['resumableMaxBytes'] === 'number' ? account.capabilities['resumableMaxBytes'] : DEFAULT_RESUMABLE_MAX_BYTES;
      const check = checkMediaForPlatform(probe, byteSize, target.platform, { method: target.method, resumableMaxBytes: cap });
      if (check.manualStep) {
        await toManualStep(ctx.db, target.id, ['queued'], check.manualStep, check.issues[0]?.message ?? manualStepMessage(check.manualStep, target.platform), { mediaKey: file.key });
        continue;
      }
      if (!check.ok && target.method !== 'manual') {
        const message = check.issues.map((i) => i.message).join(' ');
        await updateTarget(ctx.db, target.id, ['queued'], { status: 'failed', mediaKey: file.key, statusMessage: message.slice(0, 500), providerState: { retryable: false, mediaIssues: check.issues.map((i) => i.code) } });
        continue;
      }
      const issueNote = check.ok ? '' : ` ${check.issues.map((i) => i.message).join(' ')}`;
      if (target.method === 'manual') {
        if (isDue(post)) {
          await toManualStep(ctx.db, target.id, ['queued'], 'post_in_app', `${manualStepMessage('post_in_app', target.platform)}${issueNote}`.slice(0, 500), { mediaKey: file.key });
        } else {
          await updateTarget(ctx.db, target.id, ['queued'], { mediaKey: file.key, statusMessage: `${scheduledMessage(post)}. You'll post it yourself.${issueNote}`.slice(0, 500) });
        }
        continue;
      }
      await updateTarget(ctx.db, target.id, ['queued'], { mediaKey: file.key, statusMessage: isDue(post) ? 'Queued to post' : scheduledMessage(post) });
      if (isDue(post)) await enqueueTracked(ctx, 'publish.target', { targetId: target.id, postId: post.id, projectId: post.projectId }, { singletonKey: `publish-target:${target.id}` });
    }
  } finally {
    await removeTempDir(tmp);
  }
  await refreshPostStatus(ctx.db, post.id);
}

/** Export-ready hook: posts waiting for this version's file get `publish.prepare` again. Quick and idempotent. */
export async function preparePostsWaitingFor(ctx: WorkerContext, editVersionId: string, variant: string): Promise<number> {
  const rows = await ctx.db
    .selectDistinct({ postId: schema.publishPosts.id, projectId: schema.publishPosts.projectId })
    .from(schema.publishPosts)
    .innerJoin(schema.publishTargets, eq(schema.publishTargets.postId, schema.publishPosts.id))
    .where(
      and(
        eq(schema.publishPosts.editVersionId, editVersionId),
        inArray(schema.publishPosts.status, ['approved', 'in_progress', 'partial', 'failed']),
        eq(schema.publishTargets.status, 'queued'),
        sql`${schema.publishTargets.mediaKey} is null`,
        eq(schema.publishTargets.mediaVariant, variant === 'no_music' ? 'no_music' : 'standard'),
      ),
    );
  for (const r of rows) await enqueueTracked(ctx, 'publish.prepare', { postId: r.postId, projectId: r.projectId }, { singletonKey: `publish-prepare:${r.postId}` });
  return rows.length;
}

export type { TargetRow };
