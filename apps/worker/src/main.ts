import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadEnv } from '@studio/config';
import { createDatabase } from '@studio/db';
import { createBlobStore } from '@studio/storage';
import { createQueue } from '@studio/queue';
import { createAiProviders } from '@studio/ai';
import { CancelledError, JOB_PAYLOAD_SCHEMAS, JOB_TYPES, newId, type JobPayload, type JobType } from '@studio/core';
import { repoRoot, type WorkerContext } from './context.js';
import { recoverStaleJobs, runTracked, type TrackedRun } from './lib/job-tracker.js';
import { refIdFor } from './lib/jobs.js';
import { handleIngestAsset } from './handlers/ingest.js';
import { handleGenerateEdits, handleReviseEdit } from './handlers/generate.js';
import { handleRender } from './handlers/render.js';
import { handleAnalyseMusic } from './handlers/music.js';
import { handleCleanup } from './handlers/cleanup.js';

type Handler<T extends JobType> = (ctx: WorkerContext, run: TrackedRun, payload: JobPayload<T>) => Promise<void>;

/**
 * Local development keeps one .env at the repository root that the web app and the worker share.
 * Values already in the process environment always win (the same rule as apps/web/src/lib/env.ts).
 */
function loadRootEnvFile(): void {
  const file = path.join(repoRoot(), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Relative paths (STORAGE_LOCAL_ROOT, WORKER_TMP_DIR) resolve against the repository root, like the web app. */
export function resolveConfiguredPath(configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot(), configured);
}

export async function startWorker(): Promise<{ ctx: WorkerContext; stop: () => Promise<void> }> {
  loadRootEnvFile();
  const loaded = loadEnv();
  const env = { ...loaded, STORAGE_LOCAL_ROOT: resolveConfiguredPath(loaded.STORAGE_LOCAL_ROOT), WORKER_TMP_DIR: resolveConfiguredPath(loaded.WORKER_TMP_DIR) };
  const logger = pino({ level: env.LOG_LEVEL, base: { service: 'studio-worker' } });
  const dbHandle = createDatabase(env.DATABASE_URL, { max: 8, applicationName: 'studio-worker' });
  const store = createBlobStore(env);
  const queue = createQueue({ connectionString: env.QUEUE_DATABASE_URL ?? env.DATABASE_URL, role: 'worker', logger });
  const ai = createAiProviders(env, logger);
  const tmpRoot = env.WORKER_TMP_DIR;
  await mkdir(tmpRoot, { recursive: true });
  const ctx: WorkerContext = {
    env,
    db: dbHandle.db,
    store,
    queue,
    ai,
    logger,
    workerId: `${os.hostname()}-${process.pid}-${newId().slice(-6)}`,
    fontsDir: path.join(repoRoot(), 'assets', 'fonts'),
    tmpRoot,
  };

  await queue.start();
  const recovered = await recoverStaleJobs(ctx.db, logger, async (type, id) => {
    const job = await queue.getBossJob(type, id);
    return job ? { state: job.state } : null;
  });
  if (recovered) logger.warn({ recovered }, 'recovered jobs left running by a previous worker');

  const register = async <T extends JobType>(type: T, handler: Handler<T>, concurrency: number) => {
    await queue.work(
      type,
      async (job) => {
        const payload = JOB_PAYLOAD_SCHEMAS[type].parse(job.data) as JobPayload<T>;
        const projectId = (payload as { projectId?: string }).projectId ?? null;
        try {
          await runTracked(
            ctx.db,
            logger,
            {
              type,
              bossJobId: job.id,
              trackingJobId: job.data.trackingJobId,
              projectId,
              refId: refIdFor(type, payload as Record<string, unknown>),
              payload: payload as Record<string, unknown>,
              retryCount: job.retryCount,
              bossSignal: job.signal,
              workerId: ctx.workerId,
            },
            (run) => handler(ctx, run, payload),
          );
        } catch (err) {
          // A cancellation is a normal outcome, not a failure the queue should retry.
          if (err instanceof CancelledError) return;
          throw err;
        }
      },
      concurrency,
    );
  };

  const c = env.WORKER_CONCURRENCY;
  await register(JOB_TYPES.INGEST_ASSET, handleIngestAsset, c);
  await register(JOB_TYPES.GENERATE_EDITS, handleGenerateEdits, 1);
  await register(JOB_TYPES.REVISE_EDIT, handleReviseEdit, 1);
  await register(JOB_TYPES.RENDER_PREVIEW, (cx, run, p) => handleRender(cx, run, p, 'preview'), c);
  await register(JOB_TYPES.RENDER_EXPORT, (cx, run, p) => handleRender(cx, run, p, 'export'), 1);
  await register(JOB_TYPES.ANALYSE_MUSIC, handleAnalyseMusic, 1);
  await register(JOB_TYPES.CLEANUP, handleCleanup, 1);
  await queue.schedule(JOB_TYPES.CLEANUP, '17 * * * *', { olderThanHours: 24 });

  logger.info({ workerId: ctx.workerId, concurrency: c, ai: ai.describe(), storage: store.driver, tmpRoot }, 'worker started');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info('worker stopping (waiting for active jobs)');
    try {
      await queue.stop(true);
    } finally {
      await dbHandle.close();
    }
    logger.info('worker stopped');
  };
  return { ctx, stop };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isDirectRun) {
  startWorker()
    .then(({ stop }) => {
      const shutdown = (signal: string) => {
        void stop().then(() => process.exit(0));
        setTimeout(() => process.exit(1), 45_000).unref();
        void signal;
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
