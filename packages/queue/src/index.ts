import { PgBoss, type Job } from 'pg-boss';
import type { Logger } from 'pino';
import { ALL_JOB_TYPES, BUSINESS_TIMEZONE, JOB_PAYLOAD_SCHEMAS, type JobPayload, type JobType } from '@studio/core';
import { BUSINESS_PROFILE_QUEUE_SETTINGS } from './settings/business_profile.js';
import { EMAIL_QUEUE_SETTINGS } from './settings/email.js';
import { MUSIC_QUEUE_SETTINGS } from './settings/music.js';
import { PREFERENCES_QUEUE_SETTINGS } from './settings/preferences.js';
import { PUBLISHING_QUEUE_SETTINGS } from './settings/publishing.js';
import { SHARED_QUEUE_SETTINGS } from './settings/shared.js';
import { SQUARE_QUEUE_SETTINGS } from './settings/square.js';
import { STUDIO_QUEUE_SETTINGS } from './settings/studio.js';
import { TRENDS_QUEUE_SETTINGS } from './settings/trends.js';
import type { QueueSetting } from './settings/types.js';
import { WEBSITE_QUEUE_SETTINGS } from './settings/website.js';

export type { QueueSetting, QueueSettingsMap } from './settings/types.js';
export { QUEUE_HEARTBEAT_SECONDS } from './settings/studio.js';

export const QUEUE_SCHEMA = 'pgboss';

/** How often the worker's pg-boss supervisor looks for lapsed heartbeats and expired attempts, in seconds. */
export const QUEUE_SUPERVISE_INTERVAL_SECONDS = 30;
/** Default pg-boss connection pool size per role, used when QUEUE_POOL_MAX is not set. */
export const DEFAULT_QUEUE_POOL_MAX = { producer: 3, worker: 6 } as const;

const ALL_QUEUE_SETTINGS: Record<string, QueueSetting> = {
  ...STUDIO_QUEUE_SETTINGS,
  ...SHARED_QUEUE_SETTINGS,
  ...MUSIC_QUEUE_SETTINGS,
  ...PREFERENCES_QUEUE_SETTINGS,
  ...TRENDS_QUEUE_SETTINGS,
  ...PUBLISHING_QUEUE_SETTINGS,
  ...SQUARE_QUEUE_SETTINGS,
  ...EMAIL_QUEUE_SETTINGS,
  ...WEBSITE_QUEUE_SETTINGS,
  ...BUSINESS_PROFILE_QUEUE_SETTINGS,
};

/** Job types registered in @studio/core that have no queue settings (must be empty; checked by tests and at start). */
export function jobTypesWithoutQueueSettings(): JobType[] {
  return ALL_JOB_TYPES.filter((type) => !ALL_QUEUE_SETTINGS[type]);
}

/**
 * Per-job-type durability settings, aggregated from one file per module (`./settings/<module>.ts`).
 * - expireInSeconds: hard ceiling for one attempt (a stuck render is failed and retried).
 * - heartbeatSeconds: a worker that dies stops heart-beating; the worker's pg-boss supervisor (every
 *   QUEUE_SUPERVISE_INTERVAL_SECONDS) fails the attempt and retries it, which is what gives us restart recovery.
 * - policy: `standard` unless a module asks for `stately`.
 */
export const QUEUE_SETTINGS = ALL_QUEUE_SETTINGS as Record<JobType, QueueSetting>;

/** The pg-boss policy a job type's queue is created with. */
export function queuePolicyFor(type: JobType): 'standard' | 'stately' {
  return QUEUE_SETTINGS[type]?.policy ?? 'standard';
}

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
  /** Prevents duplicates while a job with the same key is queued/active (how strictly depends on the queue policy). */
  singletonKey?: string;
  priority?: number;
  /** Run no earlier than this many seconds from now (one-off delays and debounces). */
  startAfterSeconds?: number;
  /** Run no earlier than this instant. Wins over `startAfterSeconds` when both are given. */
  startAfter?: Date;
  /** Our own jobs-table id, stored so handlers can find the mirror row. */
  trackingJobId?: string;
}

/** Options for a cron schedule. */
export interface ScheduleOptions {
  /**
   * Distinguishes several schedules on one queue (for example a daily and a weekly sync). pg-boss keeps one
   * schedule per (queue, key); scheduling the same key again replaces it.
   */
  key?: string;
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
    const missing = jobTypesWithoutQueueSettings();
    if (missing.length) throw new Error(`No queue settings for: ${missing.join(', ')}`);
    await this.boss.start();
    for (const type of ALL_JOB_TYPES) {
      const { policy, ...settings } = QUEUE_SETTINGS[type];
      // createQueue leaves an existing queue untouched, so the worker also brings stored settings up to date
      // (for example the shorter heartbeat) on databases created by an earlier version. The policy can only be
      // chosen when a queue is first created.
      await this.boss.createQueue(type, { ...settings, policy: policy ?? 'standard' });
      if (this.options.role === 'worker') await this.boss.updateQueue(type, { ...settings });
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
    const body = options.trackingJobId ? { ...(data as object), trackingJobId: options.trackingJobId } : (data as object);
    const startAfter = options.startAfter ?? (options.startAfterSeconds ? options.startAfterSeconds : undefined);
    return this.boss.send(type, body, {
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(startAfter !== undefined ? { startAfter } : {}),
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

  /**
   * Cron schedule in Melbourne time. Several schedules may share one queue when each has its own `key`; without a
   * key pg-boss keeps a single schedule per queue.
   */
  async schedule(type: JobType, cron: string, payload: object, options: ScheduleOptions = {}): Promise<void> {
    await this.boss.schedule(type, cron, payload, { tz: BUSINESS_TIMEZONE, ...(options.key ? { key: options.key } : {}) });
  }
}

export function createQueue(options: QueueOptions): JobQueue {
  return new JobQueue(options);
}
