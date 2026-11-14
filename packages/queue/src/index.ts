import { PgBoss, type Job } from 'pg-boss';
import type { Logger } from 'pino';
import { ALL_JOB_TYPES, JOB_PAYLOAD_SCHEMAS, JOB_TYPES, type JobPayload, type JobType } from '@studio/core';

export const QUEUE_SCHEMA = 'pgboss';

/** Seconds without a heartbeat after which pg-boss fails an attempt (pg-boss refreshes it every half of this). */
export const QUEUE_HEARTBEAT_SECONDS = 30;
/** How often the worker's pg-boss supervisor looks for lapsed heartbeats and expired attempts, in seconds. */
export const QUEUE_SUPERVISE_INTERVAL_SECONDS = 30;
/** Default pg-boss connection pool size per role, used when QUEUE_POOL_MAX is not set. */
export const DEFAULT_QUEUE_POOL_MAX = { producer: 3, worker: 6 } as const;

/**
 * Per-job-type durability settings.
 * - expireInSeconds: hard ceiling for one attempt (a stuck render is failed and retried).
 * - heartbeatSeconds: a worker that dies stops heart-beating; the worker's pg-boss supervisor (every
 *   QUEUE_SUPERVISE_INTERVAL_SECONDS) fails the attempt and retries it, which is what gives us restart recovery.
 *   With 30 s for both, a crashed attempt is picked up again within about a minute plus its retry delay.
 */
export const QUEUE_SETTINGS: Record<JobType, { retryLimit: number; retryDelay: number; retryBackoff: boolean; expireInSeconds: number; heartbeatSeconds: number }> = {
  [JOB_TYPES.INGEST_ASSET]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 60 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.GENERATE_EDITS]: { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 30 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.REVISE_EDIT]: { retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 20 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.RENDER_PREVIEW]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 45 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.RENDER_EXPORT]: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 2 * 60 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.ANALYSE_MUSIC]: { retryLimit: 2, retryDelay: 15, retryBackoff: true, expireInSeconds: 20 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
  [JOB_TYPES.CLEANUP]: { retryLimit: 1, retryDelay: 60, retryBackoff: false, expireInSeconds: 20 * 60, heartbeatSeconds: QUEUE_HEARTBEAT_SECONDS },
};

/** Settings for one JobQueue. */
export interface QueueOptions {
  connectionString: string;
  logger?: Logger;
  /** Role of this process. The web app only sends; the worker also supervises and runs maintenance. */
  role: 'producer' | 'worker';
  /** Largest number of database connections pg-boss may open (QUEUE_POOL_MAX). Defaults to DEFAULT_QUEUE_POOL_MAX for the role. */
  max?: number | undefined;
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

/** Durable job queue over pg-boss: the web app enqueues as a producer, the worker also runs the handlers. */
export class JobQueue {
  private readonly boss: PgBoss;
  private started = false;
  constructor(private readonly options: QueueOptions) {
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: QUEUE_SCHEMA,
      application_name: `studio-${options.role}`,
      max: options.max ?? DEFAULT_QUEUE_POOL_MAX[options.role],
      // Only the worker runs maintenance/supervision; the web app is a plain producer.
      supervise: options.role === 'worker',
      ...(options.role === 'worker' ? { superviseIntervalSeconds: QUEUE_SUPERVISE_INTERVAL_SECONDS } : {}),
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
      // createQueue leaves an existing queue untouched, so the worker also brings stored settings up to date
      // (for example the shorter heartbeat) on databases created by an earlier version.
      await this.boss.createQueue(type, { ...QUEUE_SETTINGS[type], policy: 'standard' });
      if (this.options.role === 'worker') await this.boss.updateQueue(type, { ...QUEUE_SETTINGS[type] });
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
