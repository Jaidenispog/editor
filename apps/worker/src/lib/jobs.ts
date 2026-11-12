import { newId, JOB_PAYLOAD_SCHEMAS, type JobPayload, type JobType } from '@studio/core';
import { schema } from '@studio/db';
import { QUEUE_SETTINGS } from '@studio/queue';
import type { WorkerContext } from '../context.js';

/** The entity a job is "about", used by the UI to attach progress to the right card. */
export function refIdFor(type: JobType, payload: Record<string, unknown>): string | null {
  const p = payload as Record<string, string | undefined>;
  switch (type) {
    case 'ingest.asset':
      return p['assetId'] ?? null;
    case 'edits.generate':
      return p['generationId'] ?? null;
    case 'edits.revise':
      return p['newVersionId'] ?? null;
    case 'render.preview':
    case 'render.export':
      return p['editVersionId'] ?? null;
    case 'music.analyse':
      return p['trackId'] ?? null;
    default:
      return null;
  }
}

/** Creates the UI tracking row first, then the durable queue job carrying its id (worker-side twin of the web helper). */
export async function enqueueTracked<T extends JobType>(
  ctx: WorkerContext,
  type: T,
  payload: JobPayload<T>,
  options: { singletonKey?: string; priority?: number } = {},
): Promise<string> {
  const data = JOB_PAYLOAD_SCHEMAS[type].parse(payload) as JobPayload<T> & { projectId?: string };
  const id = newId();
  await ctx.db.insert(schema.jobs).values({
    id,
    type,
    projectId: data.projectId ?? null,
    refId: refIdFor(type, data as Record<string, unknown>),
    payload: data as Record<string, unknown>,
    status: 'queued',
    maxAttempts: QUEUE_SETTINGS[type].retryLimit + 1,
  });
  const bossJobId = await ctx.queue.enqueue(type, data, { ...options, trackingJobId: id });
  if (bossJobId) {
    const { eq } = await import('drizzle-orm');
    await ctx.db.update(schema.jobs).set({ bossJobId }).where(eq(schema.jobs.id, id));
  }
  return id;
}
