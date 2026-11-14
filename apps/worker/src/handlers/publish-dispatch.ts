import { and, eq, inArray, isNull, lte, lt, ne, or } from 'drizzle-orm';
import { manualStepMessage, melbourneScheduleLabel, type JobPayload, type TargetPlatform } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { enqueueTracked } from '../lib/jobs.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { refreshPostStatus, toManualStep, updateTarget } from '../publishing/post-status.js';

/** A `processing` target untouched for this long has lost its job (its attempts ran out or the worker died). */
export const STALLED_TARGET_MINUTES = 60;

/** True when a job of this type for this target is still queued or running (its tracking row). */
async function hasActiveJob(ctx: WorkerContext, type: string, refId: string): Promise<boolean> {
  const row = await ctx.db.query.jobs.findFirst({ columns: { id: true }, where: and(eq(schema.jobs.type, type), eq(schema.jobs.refId, refId), inArray(schema.jobs.status, ['queued', 'running'])) });
  return Boolean(row);
}

/**
 * `publish.dispatch` (every minute, Melbourne cron): hands due automated targets whose file is ready to
 * `publish.target`, turns due manual targets into the owner's turn, tells the owner when a due post is still waiting
 * for its video, and settles targets whose job was lost. Never calls a platform itself. The queue's singleton key
 * and the target's conditional claim stop a target from being sent twice when a job is already waiting.
 */
export async function handlePublishDispatch(ctx: WorkerContext, run: TrackedRun, _payload: JobPayload<'publish.dispatch'>, now: Date = new Date()): Promise<void> {
  const t = schema.publishTargets;
  const p = schema.publishPosts;
  const due = or(eq(p.mode, 'now'), eq(p.mode, 'draft_handoff'), and(eq(p.mode, 'scheduled'), lte(p.scheduledFor, now)));
  const rows = await ctx.db
    .select({ target: t, post: p })
    .from(t)
    .innerJoin(p, eq(t.postId, p.id))
    .where(and(eq(t.status, 'queued'), isNull(t.submittedAt), inArray(p.status, ['approved', 'in_progress', 'partial', 'failed']), due));
  const touched = new Set<string>();
  let handed = 0;
  for (const { target, post } of rows) {
    if (!target.mediaKey) {
      if (post.mode === 'scheduled' && post.scheduledFor) {
        await updateTarget(ctx.db, target.id, ['queued'], { statusMessage: `Will post as soon as the video is ready (was due ${melbourneScheduleLabel(post.scheduledFor)})` });
        touched.add(post.id);
      }
      continue;
    }
    if (target.method === 'manual') {
      await toManualStep(ctx.db, target.id, ['queued'], 'post_in_app', `Due now. ${manualStepMessage('post_in_app', target.platform as TargetPlatform)}`);
      touched.add(post.id);
      continue;
    }
    // A target waiting out the posting limit already has a delayed job; leave it until well after that time.
    const next = Date.parse(String(target.providerState['nextAttemptAt'] ?? ''));
    if (Number.isFinite(next) && next + 5 * 60_000 > now.getTime()) continue;
    // Scheduled targets are handed on when due; "now" targets only as a catch-up when their job has gone missing.
    if (post.mode !== 'scheduled' && target.updatedAt.getTime() > now.getTime() - 5 * 60_000) continue;
    if (await hasActiveJob(ctx, 'publish.target', target.id)) continue;
    await enqueueTracked(ctx, 'publish.target', { targetId: target.id, postId: post.id, projectId: post.projectId }, { singletonKey: `publish-target:${target.id}` });
    handed++;
  }

  // Safety net: a processing target nobody has touched for an hour lost its job.
  const stalled = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.status, 'processing'), lt(t.updatedAt, new Date(now.getTime() - STALLED_TARGET_MINUTES * 60_000)), ne(t.method, 'manual')));
  for (const s of stalled) {
    if (s.submittedAt && !s.externalPostId) {
      await toManualStep(ctx.db, s.id, ['processing'], 'check_before_retry', manualStepMessage('check_before_retry', s.platform as TargetPlatform));
    } else {
      await updateTarget(ctx.db, s.id, ['processing'], { status: 'failed', statusMessage: 'Publishing stopped part-way. Press Retry: it checks the platform first, so nothing is posted twice.', providerState: { retryable: true } });
    }
    touched.add(s.postId);
  }
  for (const id of touched) await refreshPostStatus(ctx.db, id);
  if (handed || touched.size) await run.message(`Handed on ${handed} post${handed === 1 ? '' : 's'}; updated ${touched.size}`);
}
