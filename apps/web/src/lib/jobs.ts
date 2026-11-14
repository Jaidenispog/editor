import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppError, JOB_PAYLOAD_SCHEMAS, newId, type JobPayload, type JobType } from '@studio/core';
import { schema, type JobRow } from '@studio/db';
import { QUEUE_SETTINGS } from '@studio/queue';
import { getDb } from './db.js';
import { getLogger } from './logger.js';
import { getQueue } from './queue.js';
import type { JobDto } from './shared/dto.js';

/** Statuses that mean a job is still waiting or working. */
export const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const;

/** The entity a job works on, matching the worker's convention so progress lands on the right card. */
export function defaultRefId(type: JobType, payload: Record<string, unknown>): string | null {
  const p = payload as Record<string, unknown>;
  const pick = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  switch (type) {
    case 'ingest.asset':
      return pick('assetId');
    case 'edits.generate':
      return pick('generationId');
    case 'edits.revise':
      return pick('newVersionId');
    case 'render.preview':
    case 'render.export':
      return pick('editVersionId');
    case 'music.analyse':
      return pick('trackId');
    default:
      return null;
  }
}

/**
 * Creates the jobs-table mirror row (status queued) and then the durable pg-boss job that carries its id.
 * If the queue cannot be reached the row is marked failed and a plain error is thrown, so nothing is left
 * looking "queued" forever.
 */
export async function createTrackedJob<T extends JobType>(input: {
  type: T;
  payload: JobPayload<T>;
  projectId?: string | null;
  refId?: string | null;
  singletonKey?: string;
  priority?: number;
}): Promise<JobRow> {
  const data = JOB_PAYLOAD_SCHEMAS[input.type].parse(input.payload) as JobPayload<T>;
  const db = getDb();
  const id = newId();
  const inserted = await db
    .insert(schema.jobs)
    .values({
      id,
      type: input.type,
      projectId: input.projectId ?? (data as { projectId?: string }).projectId ?? null,
      refId: input.refId ?? defaultRefId(input.type, data as Record<string, unknown>),
      payload: data as Record<string, unknown>,
      status: 'queued',
      maxAttempts: QUEUE_SETTINGS[input.type].retryLimit + 1,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new AppError('INTERNAL', 'The job could not be recorded.');
  try {
    const queue = await getQueue();
    const bossJobId = await queue.enqueue(input.type, data, {
      trackingJobId: id,
      ...(input.singletonKey ? { singletonKey: input.singletonKey } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    });
    const updated = await db
      .update(schema.jobs)
      .set({ bossJobId, updatedAt: new Date(), ...(bossJobId ? {} : { status: 'cancelled' as const, message: 'An identical job is already waiting', finishedAt: new Date() }) })
      .where(eq(schema.jobs.id, id))
      .returning();
    return updated[0] ?? row;
  } catch (err) {
    getLogger().error({ err, type: input.type, jobId: id }, 'failed to enqueue job');
    await db
      .update(schema.jobs)
      .set({ status: 'failed', error: 'The job queue could not be reached', message: 'Could not start', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobs.id, id));
    throw new AppError('INTERNAL', 'The background worker queue is not reachable right now. Please try again shortly.', { cause: err });
  }
}

/** Loads a job row or throws NOT_FOUND. */
export async function getJob(id: string): Promise<JobRow> {
  const job = await getDb().query.jobs.findFirst({ where: eq(schema.jobs.id, id) });
  if (!job) throw new AppError('NOT_FOUND', 'That job no longer exists.');
  return job;
}

/**
 * Cooperative cancel: sets cancelRequested (the worker's heartbeat turns it into an AbortSignal) and asks
 * pg-boss to cancel. A job that has not started yet is marked cancelled straight away.
 */
export async function cancelJob(id: string): Promise<JobRow> {
  const job = await getJob(id);
  if (job.status === 'cancelled') throw new AppError('CONFLICT', 'This job has already been cancelled.');
  if (job.status !== 'queued' && job.status !== 'running') {
    throw new AppError('CONFLICT', 'This job has already finished, so there is nothing to cancel.');
  }
  const db = getDb();
  const now = new Date();
  const updated = await db
    .update(schema.jobs)
    .set({
      cancelRequested: true,
      updatedAt: now,
      ...(job.status === 'queued' ? { status: 'cancelled' as const, message: 'Cancelled', finishedAt: now } : { message: 'Cancelling…' }),
    })
    .where(eq(schema.jobs.id, id))
    .returning();
  if (job.bossJobId) {
    try {
      const queue = await getQueue();
      await queue.cancel(job.type as JobType, job.bossJobId);
    } catch (err) {
      // The flag alone is enough for a running job; log so a stuck queue is visible.
      getLogger().warn({ err, jobId: id }, 'queue cancel failed; relying on the cancel flag');
    }
  }
  // A running job records its own outcome when the worker notices the cancel; one that never started has nobody
  // to do that, so the clip, version or export it was for would otherwise show "in progress" for ever.
  if (job.status === 'queued') {
    try {
      await settleCancelledQueuedJob(job);
    } catch (err) {
      getLogger().error({ err, jobId: id }, 'could not update the work a cancelled job was for');
    }
  }
  return updated[0] ?? job;
}

/**
 * Records the same end state the worker writes when the owner cancels a running job, for a job cancelled before
 * the worker picked it up. Each update only applies while the item is still waiting, so it never overwrites a
 * result the worker has already written.
 */
export async function settleCancelledQueuedJob(job: Pick<JobRow, 'type' | 'payload'>): Promise<void> {
  const type = job.type as JobType;
  const parsed = JOB_PAYLOAD_SCHEMAS[type]?.safeParse(job.payload);
  if (!parsed?.success) return;
  const payload = parsed.data as Record<string, unknown>;
  const db = getDb();
  const now = new Date();
  const editVersionId = typeof payload['editVersionId'] === 'string' ? payload['editVersionId'] : null;
  switch (type) {
    case 'render.export':
      if (!editVersionId) return;
      await db
        .update(schema.editVersions)
        .set({ exportStatus: 'none', exportMessage: 'Export cancelled', updatedAt: now })
        .where(and(eq(schema.editVersions.id, editVersionId), inArray(schema.editVersions.exportStatus, ['queued', 'rendering'])));
      return;
    case 'render.preview':
      if (!editVersionId) return;
      await db
        .update(schema.editVersions)
        .set({ status: 'cancelled', statusMessage: 'Preview cancelled', updatedAt: now })
        .where(and(eq(schema.editVersions.id, editVersionId), inArray(schema.editVersions.status, ['planned', 'rendering_preview'])));
      return;
    case 'edits.revise':
      await db
        .update(schema.editVersions)
        .set({ status: 'cancelled', statusMessage: 'Cancelled', updatedAt: now })
        .where(and(eq(schema.editVersions.id, String(payload['newVersionId'])), eq(schema.editVersions.status, 'planning')));
      return;
    case 'edits.generate': {
      const generationId = String(payload['generationId']);
      await db
        .update(schema.generations)
        .set({ status: 'cancelled', statusMessage: 'Cancelled', updatedAt: now })
        .where(and(eq(schema.generations.id, generationId), inArray(schema.generations.status, ['queued', 'planning'])));
      const edits = await db.query.edits.findMany({ columns: { id: true }, where: eq(schema.edits.generationId, generationId) });
      if (edits.length) {
        await db
          .update(schema.editVersions)
          .set({ status: 'cancelled', statusMessage: 'Cancelled', updatedAt: now })
          .where(and(inArray(schema.editVersions.editId, edits.map((e) => e.id)), eq(schema.editVersions.status, 'planning')));
      }
      await db
        .update(schema.projects)
        .set({ status: 'ready', updatedAt: now })
        .where(and(eq(schema.projects.id, String(payload['projectId'])), eq(schema.projects.status, 'generating')));
      return;
    }
    case 'ingest.asset':
      await db
        .update(schema.mediaAssets)
        .set({ status: 'failed', statusMessage: CANCELLED_ANALYSIS_MESSAGE, updatedAt: now })
        .where(and(eq(schema.mediaAssets.id, String(payload['assetId'])), inArray(schema.mediaAssets.status, ['uploaded', 'processing'])));
      return;
    case 'music.analyse':
      await db
        .update(schema.musicTracks)
        .set({ status: 'uploaded', statusMessage: 'Analysis cancelled', updatedAt: now })
        .where(and(eq(schema.musicTracks.id, String(payload['trackId'])), inArray(schema.musicTracks.status, ['uploaded', 'processing'])));
      return;
    default:
      return;
  }
}

/** Shown on a clip whose analysis was cancelled; the clip card offers Retry for it. */
export const CANCELLED_ANALYSIS_MESSAGE = 'Analysis cancelled. Press Retry to analyse it again.';

/** Re-queues a failed or cancelled job on the same tracking row (progress and error are reset). */
export async function retryJob(id: string): Promise<JobRow> {
  const job = await getJob(id);
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    throw new AppError('CONFLICT', 'Only failed or cancelled jobs can be retried.');
  }
  const type = job.type as JobType;
  const schemaForType = JOB_PAYLOAD_SCHEMAS[type];
  if (!schemaForType) throw new AppError('UNSUPPORTED', 'This kind of job cannot be retried.');
  const payload = schemaForType.parse(job.payload);
  const db = getDb();
  await db
    .update(schema.jobs)
    .set({
      status: 'queued',
      progress: 0,
      message: 'Queued again',
      error: null,
      attempts: 0,
      cancelRequested: false,
      startedAt: null,
      finishedAt: null,
      heartbeatAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, id));
  try {
    const queue = await getQueue();
    const bossJobId = await queue.enqueue(type, payload as never, { trackingJobId: id });
    const updated = await db.update(schema.jobs).set({ bossJobId, updatedAt: new Date() }).where(eq(schema.jobs.id, id)).returning();
    return updated[0] ?? job;
  } catch (err) {
    getLogger().error({ err, jobId: id }, 'failed to re-enqueue job');
    await db
      .update(schema.jobs)
      .set({ status: 'failed', error: 'The job queue could not be reached', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobs.id, id));
    throw new AppError('INTERNAL', 'The background worker queue is not reachable right now. Please try again shortly.', { cause: err });
  }
}

/** Recent jobs for a project, newest first. */
export async function listProjectJobs(projectId: string, limit = 50): Promise<JobRow[]> {
  return getDb().query.jobs.findMany({ where: eq(schema.jobs.projectId, projectId), orderBy: desc(schema.jobs.createdAt), limit });
}

/** Jobs still queued or running across the app (dashboard), newest first. */
export async function listActiveJobs(limit = 20): Promise<JobRow[]> {
  return getDb().query.jobs.findMany({ where: inArray(schema.jobs.status, [...ACTIVE_JOB_STATUSES]), orderBy: desc(schema.jobs.createdAt), limit });
}

/** Requests cancellation of every active job for a project (used before deleting it). */
export async function cancelProjectJobs(projectId: string): Promise<number> {
  const active = await getDb().query.jobs.findMany({
    where: and(eq(schema.jobs.projectId, projectId), inArray(schema.jobs.status, [...ACTIVE_JOB_STATUSES])),
  });
  let cancelled = 0;
  for (const job of active) {
    try {
      await cancelJob(job.id);
      cancelled++;
    } catch (err) {
      getLogger().warn({ err, jobId: job.id }, 'could not cancel job during project deletion');
    }
  }
  return cancelled;
}

/** Converts a job row to the browser-facing shape (dates as ISO strings, payload omitted). */
export function toJobDto(job: JobRow, projectTitle?: string | null): JobDto {
  return {
    id: job.id,
    type: job.type,
    projectId: job.projectId,
    ...(projectTitle !== undefined ? { projectTitle } : {}),
    refId: job.refId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
