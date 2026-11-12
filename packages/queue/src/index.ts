import { PgBoss, type Job } from 'pg-boss';
import type { Logger } from 'pino';
import { ALL_JOB_TYPES, JOB_PAYLOAD_SCHEMAS, JOB_TYPES, type JobPayload, type JobType } from '@studio/core';

export const QUEUE_SCHEMA = 'pgboss';

/**
 * Per-job-type durability settings.
 * - expireInSeconds: hard ceiling for one attempt (a stuck render is failed and retried).
 * - heartbeatSeconds: a worker that dies stops heart-beating; pg-boss fails the attempt and retries it,
 *   which is what gives us restart recovery without a supervisor.
 */
export const QUEUE_SETTINGS: Record<JobType, { retryLimit: number; retryDelay: number; retryBackoff: boolean; expireInSeconds: number; heartbeatSeconds: number }> = {
  [JOB_TYPES.INGEST_ASSET]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 60 * 60, heartbeatSeconds: 60 },
  [JOB_TYPES.GENERATE_EDITS]: { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 30 * 60, heartbeatSeconds: 60 },
  [JOB_TYPES.REVISE_EDIT]: { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 20 * 60, heartbeatSeconds: 60 },
  [JOB_TYPES.RENDER_PREVIEW]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 45 * 60, heartbeatSeconds: 60 },
  [JOB_TYPES.RENDER_EXPORT]: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 2 * 60 * 60, heartbeatSeconds: 60 },
  [JOB_TYPES.ANALYSE_MUSIC]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 20 * 60, heartbeatSeconds: 60 },
  [JOB_TYPES.CLEANUP]: { retryLimit: 1, retryDelay: 60, retryBackoff: false, expireInSeconds: 20 * 60, heartbeatSeconds: 60 },
};

export interface QueueOptions {
  connectionString: string;
  logger?: Logger;
  /** Role of this process. The web app only sends; the worker also supervises and runs maintenance. */
  role: 'producer' | 'worker';
}

export interface EnqueueOptions {
  /** Prevents duplicates while a job with the same key is queued/active. */
  singletonKey?: string;
  priority?: number;
  startAfterSeconds?: number;
  /** Our own jobs-table id, stored so handlers can find the mirror row. */
  trackingJobId?: string;
}

export type JobHandler<T extends JobType> = (job: { id: string; data: JobPayload<T> & { trackingJobId?: string }; signal: AbortSignal; retryCount: number }) => Promise<void>;

export class JobQueue {
  private readonly boss: PgBoss;
  private started = false;
  constructor(private readonly options: QueueOptions) {
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: QUEUE_SCHEMA,
      application_name: `studio-${options.role}`,
      max: options.role === 'worker' ? 6 : 3,
      // Only the worker runs maintenance/supervision; the web app is a plain producer.
      supervise: options.role === 'worker',
      migrate: true,
      createSchema: true,
    });
    this.boss.on('error', (err: Error) => options.logger?.error({ err }, 'pg-boss error'));
  }

  get raw(): PgBoss {
    return this.boss;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    for (const type of ALL_JOB_TYPES) {
      await this.boss.createQueue(type, { ...QUEUE_SETTINGS[type], policy: 'standard' });
    }
    this.started = true;
  }

  async stop(graceful = true): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful, timeout: 30_000 });
    this.started = false;
  }

  async enqueue<T extends JobType>(type: T, payload: JobPayload<T>, options: EnqueueOptions = {}): Promise<string | null> {
    const schema = JOB_PAYLOAD_SCHEMAS[type];
    const data = schema.parse(payload) as JobPayload<T>;
    const body = options.trackingJobId ? { ...data, trackingJobId: options.trackingJobId } : data;
    return this.boss.send(type, body, {
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  async cancel(type: JobType, bossJobId: string): Promise<void> {
    await this.boss.cancel(type, bossJobId);
  }

  async getBossJob(type: JobType, bossJobId: string) {
    return this.boss.getJobById(type, bossJobId);
  }

  /** Registers a handler. pg-boss hands us batches; we process one job at a time per batch for clear progress. */
  async work<T extends JobType>(type: T, handler: JobHandler<T>, concurrency = 1): Promise<void> {
    await this.boss.work<JobPayload<T> & { trackingJobId?: string }>(
      type,
      { batchSize: 1, localConcurrency: concurrency, includeMetadata: true },
      async (jobs: Job<JobPayload<T> & { trackingJobId?: string }>[]) => {
        for (const job of jobs) {
          await handler({ id: job.id, data: job.data, signal: job.signal, retryCount: job.retryCount });
        }
      },
    );
  }

  /** Cron schedule (used for temp-file cleanup). */
  async schedule(type: JobType, cron: string, payload: object): Promise<void> {
    await this.boss.schedule(type, cron, payload, { tz: 'Australia/Melbourne' });
  }
}

export function createQueue(options: QueueOptions): JobQueue {
  return new JobQueue(options);
}
