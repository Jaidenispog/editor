import { and, eq, lt } from 'drizzle-orm';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { cleanupStaleTempDirs } from '../lib/temp.js';
import type { TrackedRun } from '../lib/job-tracker.js';

/** Removes orphaned temp directories and expires abandoned upload sessions (and their staged parts). */
export async function handleCleanup(ctx: WorkerContext, run: TrackedRun, payload: { olderThanHours: number }): Promise<void> {
  const olderThanMs = payload.olderThanHours * 3600_000;
  const removedDirs = await cleanupStaleTempDirs(ctx.tmpRoot, olderThanMs);
  await run.progress(0.5, `Removed ${removedDirs} temporary folders`);

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
  await run.progress(1, `Cleanup done: ${removedDirs} folders, ${expired.length} abandoned uploads`);
}
