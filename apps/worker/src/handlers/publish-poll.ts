import { eq } from 'drizzle-orm';
import type { JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { runInstagramPoll } from '../publishing/instagram.js';
import { runZernioPoll } from '../publishing/zernio.js';

/**
 * `publish.poll`: reads the platform's own status for one target (Instagram: the container's `status_code`, then the
 * copyright check; Zernio: the post, or after an unclear create a lookup by its metadata) and schedules itself again
 * until the target settles. Only reads; the publish call itself always runs in `publish.target`. Exits quietly when
 * the target has moved on. A Zernio target is also read while queued (held at Zernio), after it was published
 * without a link, and when a webhook hints that Zernio's view changed.
 */
export async function handlePublishPoll(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'publish.poll'>): Promise<void> {
  const target = await ctx.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, payload.targetId) });
  const post = target ? await ctx.db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, target.postId) }) : null;
  if (!target || !post) return;
  if (target.method === 'zernio') return runZernioPoll(ctx, run, target, payload.pollNo);
  if (target.status !== 'processing') return;
  if (target.method === 'instagram_api') await runInstagramPoll(ctx, run, target, post, payload.pollNo);
}
