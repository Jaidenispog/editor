import { and, eq, lt } from 'drizzle-orm';
import { errorMessage } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { cleanupStaleTempDirs } from '../lib/temp.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { moduleCleanupTasks, type CleanupTask } from '../modules/index.js';

/**
 * Removes orphaned temp directories and expires abandoned upload sessions (and their staged parts), then runs every
 * module's cleanup task. One module's failing task is logged and does not stop the others; the job fails at the end
 * so the queue retries (every task must be safe to run again).
 */
export async function handleCleanup(ctx: WorkerContext, run: TrackedRun, payload: { olderThanHours: number }, tasks: CleanupTask[] = moduleCleanupTasks()): Promise<void> {
  const olderThanMs = payload.olderThanHours * 3600_000;
  const removedDirs = await cleanupStaleTempDirs(ctx.tmpRoot, olderThanMs);
  await run.progress(0.3, `Removed ${removedDirs} temporary folders`);

  const expired = await ctx.db
    .select()
    .from(schema.uploadSessions)
    .where(and(eq(schema.uploadSessions.status, 'open'), lt(schema.uploadSessions.expiresAt, new Date())));
  for (const session of expired) {
    run.checkCancelled();
    const state = session.driverState as { uploadId?: string } | undefined;
    if (state?.uploadId) {
      await ctx.store.abortMultipart({ uploadId: state.uploadId, key: session.targetKey }).catch((err) => ctx.logger.warn({ err, uploadId: session.id }, 'abort multipart failed'));
    }
    await ctx.db.update(schema.uploadSessions).set({ status: 'expired', updatedAt: new Date() }).where(eq(schema.uploadSessions.id, session.id));
  }
  const summary = [`${removedDirs} folders`, `${expired.length} abandoned uploads`];
  const failed: string[] = [];
  for (const [i, task] of tasks.entries()) {
    run.checkCancelled();
    try {
      const note = await task.run(ctx, run);
      if (note) summary.push(note);
    } catch (err) {
      run.checkCancelled();
      failed.push(task.name);
      ctx.logger.error({ task: task.name, err: errorMessage(err) }, 'cleanup task failed');
    }
    await run.progress(0.5 + 0.5 * ((i + 1) / tasks.length));
  }
  if (failed.length) throw new Error(`Cleanup tasks failed: ${failed.join(', ')}`);
  await run.progress(1, `Cleanup done: ${summary.join(', ')}`);
}
