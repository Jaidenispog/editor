import { and, eq, or, sql } from 'drizzle-orm';
import type { JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { runInstagramTarget } from '../publishing/instagram.js';
import { refreshPostStatus, updateTarget, type TargetRow } from '../publishing/post-status.js';

/**
 * Claims a target for this job with one conditional update, the authoritative guard against double posting:
 * a `queued` target, a `processing` target waiting to resume at the publish step (after a clean copyright check), or
 * a `processing` target this same job claimed before a crash or restart (pg-boss runs it again with the same
 * tracking id). A second job for the same target gets nothing back and exits.
 */
export async function claimTarget(ctx: WorkerContext, targetId: string, jobId: string): Promise<TargetRow | null> {
  const t = schema.publishTargets;
  const rows = await ctx.db
    .update(t)
    .set({
      status: 'processing',
      manualStep: null,
      attempts: sql`${t.attempts} + 1`,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
      providerState: sql`${t.providerState} || jsonb_build_object('claim', ${jobId}::text, 'resume', case when ${t.providerState}->>'resume' in ('publish', 'publishing') then '"publishing"'::jsonb else 'null'::jsonb end)`,
    })
    .where(
      and(
        eq(t.id, targetId),
        or(
          eq(t.status, 'queued'),
          and(eq(t.status, 'processing'), or(sql`${t.providerState}->>'resume' = 'publish'`, sql`${t.providerState}->>'claim' = ${jobId}`)),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** An approved post that has not been cancelled (a Retry can bring a failed or partial post back to life). */
export function postIsLive(post: { approvedAt: Date | null; status: string }): boolean {
  return post.approvedAt !== null && post.status !== 'draft' && post.status !== 'cancelled';
}

/**
 * `publish.target`: one destination's adapter state machine. Permanent failures are written to the row and the job
 * completes (no pg-boss retry); transient ones are rethrown. Manual targets never come here; Zernio (TikTok) is added
 * by WP10 and, until then, a Zernio target fails with a plain message instead of posting.
 */
export async function handlePublishTarget(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'publish.target'>): Promise<void> {
  const post = await ctx.db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, payload.postId) });
  if (!post || !postIsLive(post)) {
    await run.message('Nothing to do: the post is no longer waiting to go out');
    return;
  }
  const target = await claimTarget(ctx, payload.targetId, run.jobId);
  if (!target) {
    await run.message('Another attempt is already handling this destination');
    return;
  }
  await refreshPostStatus(ctx.db, post.id);
  switch (target.method) {
    case 'instagram_api':
      await runInstagramTarget(ctx, run, target, post);
      return;
    case 'zernio':
      await updateTarget(ctx.db, target.id, ['processing'], {
        status: 'failed',
        statusMessage: "Automatic TikTok posting isn't switched on yet. Post it yourself.",
        providerState: { retryable: false },
      });
      await refreshPostStatus(ctx.db, post.id);
      return;
    default:
      // A manual target is never sent anywhere: put it back to the owner's turn.
      await updateTarget(ctx.db, target.id, ['processing'], { status: 'manual_step_required', manualStep: 'post_in_app', statusMessage: `Post this in the ${target.platform === 'tiktok' ? 'TikTok' : 'Instagram'} app, then tap "I've posted it".` });
      await refreshPostStatus(ctx.db, post.id);
  }
}
