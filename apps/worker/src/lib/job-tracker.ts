import { and, eq, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { CancelledError, errorMessage, isAppError, newId, type JobType } from '@studio/core';
import { schema, type Database } from '@studio/db';
import { QUEUE_SETTINGS } from '@studio/queue';

/** How often a running job writes its heartbeat (and checks the owner's cancel flag). */
export const HEARTBEAT_MS = 10_000;
/**
 * A "running" row whose heartbeat is older than this belongs to a worker that died (4.5 missed heartbeats).
 * Kept well under pg-boss's own 60 s heartbeat so the UI says "will resume" before the queue retries the job.
 */
export const STALE_AFTER_MS = 45_000;
const PROGRESS_MIN_INTERVAL_MS = 1_500;

export interface TrackedRun {
  /** Our jobs-table id. */
  jobId: string;
  /** Combined signal: pg-boss expiry/cancel OR the owner's cancel request. */
  signal: AbortSignal;
  progress(fraction: number, message?: string): Promise<void>;
  message(message: string): Promise<void>;
  /** Throws CancelledError when cancellation was requested (call between steps). */
  checkCancelled(): void;
}

export interface TrackedJobInput {
  type: JobType;
  bossJobId: string;
  trackingJobId?: string | undefined;
  projectId?: string | null;
  refId?: string | null;
  payload: Record<string, unknown>;
  retryCount: number;
  bossSignal: AbortSignal;
  workerId: string;
  /** Heartbeat interval override (tests); defaults to HEARTBEAT_MS. */
  heartbeatMs?: number;
}

/**
 * Mirrors a running job into the jobs table (status, attempts, progress, heartbeat) and turns the owner's
 * "cancel" flag into an AbortSignal the handler and FFmpeg honour. Also makes restart recovery possible:
 * a stale heartbeat on a "running" row means the worker died mid-job.
 */
export async function runTracked<T>(
  db: Database,
  logger: Logger,
  input: TrackedJobInput,
  work: (run: TrackedRun) => Promise<T>,
): Promise<T> {
  const jobId = await ensureJobRow(db, input);
  const maxAttempts = QUEUE_SETTINGS[input.type].retryLimit + 1;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, input.bossSignal]);
  const log = logger.child({ jobId, type: input.type, bossJobId: input.bossJobId, attempt: input.retryCount + 1 });

  await db
    .update(schema.jobs)
    .set({
      status: 'running',
      attempts: input.retryCount + 1,
      maxAttempts,
      workerId: input.workerId,
      bossJobId: input.bossJobId,
      startedAt: new Date(),
      finishedAt: null,
      heartbeatAt: new Date(),
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, jobId));

  const checkCancelFlag = async () => {
    const row = await db.query.jobs.findFirst({ columns: { cancelRequested: true, status: true }, where: eq(schema.jobs.id, jobId) });
    if (row?.cancelRequested && !controller.signal.aborted) {
      log.info('cancellation requested by owner');
      controller.abort(new CancelledError('Cancelled by owner'));
    }
  };
  // pg-boss also aborts the job signal after every normal completion, so only an abort while the work is still
  // running is worth a warning; the listener is removed once the work settles.
  const listenerScope = new AbortController();
  input.bossSignal.addEventListener('abort', () => log.warn('queue aborted the job (expired, cancelled or claim lost)'), { once: true, signal: listenerScope.signal });

  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        // A stale-job sweep may have marked this row "queued" while the database was briefly unreachable;
        // the job is still running here, so put the row back. Cancelled or finished rows are left alone.
        await db
          .update(schema.jobs)
          .set({ heartbeatAt: new Date(), updatedAt: new Date(), status: sql`case when ${schema.jobs.status} = 'queued' then 'running' else ${schema.jobs.status} end` })
          .where(eq(schema.jobs.id, jobId));
        await checkCancelFlag();
      } catch (err) {
        log.warn({ err }, 'heartbeat failed');
      }
    })();
  }, input.heartbeatMs ?? HEARTBEAT_MS);

  let lastProgressAt = 0;
  let lastProgress = 0;
  let lastMessage = '';
  const writeProgress = async (fraction: number, message: string | undefined, force: boolean) => {
    const now = Date.now();
    const clamped = Math.min(1, Math.max(0, fraction));
    const msg = message ?? lastMessage;
    if (!force && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS && Math.abs(clamped - lastProgress) < 0.05 && msg === lastMessage) return;
    lastProgressAt = now;
    lastProgress = clamped;
    lastMessage = msg;
    await db
      .update(schema.jobs)
      .set({ progress: clamped, message: msg, heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobs.id, jobId));
  };

  const run: TrackedRun = {
    jobId,
    signal,
    progress: (fraction, message) => writeProgress(fraction, message, false),
    message: (message) => writeProgress(lastProgress, message, true),
    checkCancelled: () => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new CancelledError('Job cancelled');
    },
  };

  try {
    await checkCancelFlag();
    run.checkCancelled();
    const result = await work(run);
    clearInterval(heartbeat);
    listenerScope.abort();
    await db
      .update(schema.jobs)
      .set({ status: 'succeeded', progress: 1, message: lastMessage || 'Done', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobs.id, jobId));
    log.info('job succeeded');
    return result;
  } catch (err) {
    clearInterval(heartbeat);
    listenerScope.abort();
    const cancelled = err instanceof CancelledError || signal.aborted;
    const attemptsLeft = input.retryCount + 1 < maxAttempts;
    const message = errorMessage(err);
    if (cancelled) {
      await db
        .update(schema.jobs)
        .set({ status: 'cancelled', message: 'Cancelled', finishedAt: new Date(), error: message, updatedAt: new Date() })
        .where(eq(schema.jobs.id, jobId));
      log.info('job cancelled');
    } else {
      await db
        .update(schema.jobs)
        .set({
          status: attemptsLeft ? 'queued' : 'failed',
          message: attemptsLeft ? 'Retrying after a problem' : friendlyFailure(err),
          error: message,
          finishedAt: attemptsLeft ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, jobId));
      log.error({ err, attemptsLeft }, 'job failed');
    }
    throw err;
  }
}

/** Finds the tracking row (created by the web app) or creates one for jobs enqueued internally. */
async function ensureJobRow(db: Database, input: TrackedJobInput): Promise<string> {
  if (input.trackingJobId) {
    const existing = await db.query.jobs.findFirst({ columns: { id: true }, where: eq(schema.jobs.id, input.trackingJobId) });
    if (existing) return existing.id;
  }
  const byBoss = await db.query.jobs.findFirst({ columns: { id: true }, where: eq(schema.jobs.bossJobId, input.bossJobId) });
  if (byBoss) return byBoss.id;
  const id = input.trackingJobId ?? newId();
  await db.insert(schema.jobs).values({
    id,
    type: input.type,
    projectId: input.projectId ?? null,
    refId: input.refId ?? null,
    payload: input.payload,
    status: 'queued',
    bossJobId: input.bossJobId,
    maxAttempts: QUEUE_SETTINGS[input.type].retryLimit + 1,
  });
  return id;
}

/** Plain-language failure text for the UI (technical detail stays in the error column and logs). */
export function friendlyFailure(err: unknown): string {
  if (isAppError(err)) {
    switch (err.code) {
      case 'UNSUPPORTED':
      case 'VALIDATION':
      case 'INTEGRATION_NOT_CONFIGURED':
      case 'PROCESSING_FAILED':
        return err.message;
      case 'RATE_LIMITED':
        return 'The AI service is busy. Please try again in a few minutes.';
      default:
        return 'Something went wrong while processing. Please retry.';
    }
  }
  const m = errorMessage(err);
  if (/ENOSPC/.test(m)) return 'The server ran out of disk space. Free some space and retry.';
  if (/ffmpeg/i.test(m)) return 'The video could not be processed. The file may be damaged or in an unsupported format.';
  return 'Something went wrong while processing. Please retry.';
}

/**
 * Recovery for rows left "running" by a worker that died (run at start-up and then periodically). The queue
 * retries the underlying job once its own heartbeat lapses, so the row goes back to "queued" with a plain
 * message; if the queue already gave up on the job, the row is failed so the owner can retry it.
 */
export async function recoverStaleJobs(db: Database, logger: Logger, lookup: (type: JobType, bossJobId: string) => Promise<{ state: string } | null>, staleAfterMs = STALE_AFTER_MS): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = await db
    .select({ id: schema.jobs.id, type: schema.jobs.type, bossJobId: schema.jobs.bossJobId })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, 'running'), lt(schema.jobs.heartbeatAt, cutoff)));
  let recovered = 0;
  for (const row of stale) {
    let next: 'queued' | 'failed' = 'queued';
    if (row.bossJobId) {
      const boss = await lookup(row.type as JobType, row.bossJobId).catch(() => null);
      if (boss && (boss.state === 'failed' || boss.state === 'cancelled' || boss.state === 'completed')) next = 'failed';
    } else {
      next = 'failed';
    }
    // Only if it is still stale: a retry may have picked the job up since the select above.
    const updated = await db
      .update(schema.jobs)
      .set({
        status: next,
        message: next === 'queued' ? 'Interrupted when the worker stopped unexpectedly; it will resume automatically' : 'The worker stopped before this job could finish. Please retry.',
        finishedAt: next === 'failed' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.jobs.id, row.id), eq(schema.jobs.status, 'running'), lt(schema.jobs.heartbeatAt, cutoff)))
      .returning({ id: schema.jobs.id });
    if (updated.length === 0) continue;
    recovered++;
    logger.warn({ jobId: row.id, next }, 'recovered stale job');
  }
  return recovered;
}
