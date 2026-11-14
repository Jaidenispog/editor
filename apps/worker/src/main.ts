import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadEnv } from '@studio/config';
import { DEFAULT_DB_POOL_MAX, createDatabase, hasWorkerHeartbeatsTable, probeDatabase, pruneWorkerHeartbeats } from '@studio/db';
import { createBlobStore } from '@studio/storage';
import { createQueue } from '@studio/queue';
import { createAiProviders } from '@studio/ai';
import { ALL_JOB_TYPES, CancelledError, JOB_PAYLOAD_SCHEMAS, JOB_TYPES, NonRetryableError, newId, type JobPayload, type JobType } from '@studio/core';
import { repoRoot, type WorkerContext } from './context.js';
import { recoverStaleJobs, runTracked, type TrackedRun } from './lib/job-tracker.js';
import { refIdFor } from './lib/jobs.js';
import { StartupAbortedError, StartupConfigError, connectionSecrets, databaseTarget, describeFatalStartupError, redact, waitForDatabase, type Sleep } from './lib/startup.js';
import { startWorkerHeartbeat } from './lib/worker-heartbeat.js';
import { handleIngestAsset } from './handlers/ingest.js';
import { handleGenerateEdits, handleReviseEdit } from './handlers/generate.js';
import { handleRender } from './handlers/render.js';
import { handleAnalyseMusic } from './handlers/music.js';
import { handleCleanup } from './handlers/cleanup.js';
import { handleGoogleDisconnect } from './handlers/google-disconnect.js';
import { handleWebhookProcess } from './handlers/webhook-process.js';
import { WORKER_MODULES, defineHandler, moduleCrons, moduleHandlers, type ModuleJobHandler, type WorkerModule } from './modules/index.js';

type Handler<T extends JobType> = (ctx: WorkerContext, run: TrackedRun, payload: JobPayload<T>) => Promise<void>;

/** Stage A handlers and the shared Stage B/C ones (webhook dispatch, Google disconnect). */
export function coreHandlers(concurrency: number): ModuleJobHandler[] {
  return [
    defineHandler(JOB_TYPES.INGEST_ASSET, handleIngestAsset, concurrency),
    defineHandler(JOB_TYPES.GENERATE_EDITS, handleGenerateEdits, 1),
    defineHandler(JOB_TYPES.REVISE_EDIT, handleReviseEdit, 1),
    defineHandler(JOB_TYPES.RENDER_PREVIEW, (cx, run, p) => handleRender(cx, run, p, 'preview'), concurrency),
    defineHandler(JOB_TYPES.RENDER_EXPORT, (cx, run, p) => handleRender(cx, run, p, 'export'), 1),
    defineHandler(JOB_TYPES.ANALYSE_MUSIC, handleAnalyseMusic, 1),
    defineHandler(JOB_TYPES.CLEANUP, (cx, run, p) => handleCleanup(cx, run, p), 1),
    defineHandler(JOB_TYPES.WEBHOOK_PROCESS, (cx, run, p) => handleWebhookProcess(cx, run, p), 2),
    defineHandler(JOB_TYPES.GOOGLE_DISCONNECT, handleGoogleDisconnect, 1),
  ];
}

/** Every handler the worker registers: the core ones, then each module's (see src/modules/index.ts). */
export function allHandlers(concurrency: number, modules: readonly WorkerModule[] = WORKER_MODULES): ModuleJobHandler[] {
  return [...coreHandlers(concurrency), ...moduleHandlers(modules)];
}

/**
 * Throws unless every registered job type has exactly one handler and every handler is for a registered type.
 * The worker calls this before it takes any work, so a module that registers a job type without its handler
 * stops the worker from starting instead of leaving jobs queued for ever.
 */
export function assertHandlersCoverJobTypes(handlers: ModuleJobHandler[], jobTypes: readonly string[] = ALL_JOB_TYPES): void {
  const counts = new Map<string, number>();
  for (const h of handlers) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
  const missing = jobTypes.filter((t) => !counts.has(t));
  const doubled = [...counts].filter(([, n]) => n > 1).map(([t]) => t);
  const unknown = [...counts.keys()].filter((t) => !jobTypes.includes(t));
  if (missing.length) throw new Error(`No handler registered for: ${missing.join(', ')}`);
  if (doubled.length) throw new Error(`More than one handler registered for: ${doubled.join(', ')}`);
  if (unknown.length) throw new Error(`Handlers registered for unknown job types: ${unknown.join(', ')}`);
}

/** How often rows left "running" by a dead worker are looked for after start-up. */
const STALE_SWEEP_MS = 30_000;
/** After the queue stops, how long interrupted handlers get to write their state before connections close. */
const SHUTDOWN_SETTLE_MS = 10_000;

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

/** The worker package version, recorded with its heartbeat. */
function workerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
}

/** Options for startWorker. */
export interface StartWorkerOptions {
  /** Aborting it (SIGINT/SIGTERM) stops a worker that is still waiting for the database. */
  signal?: AbortSignal;
  /** Test hook for the waits between connection attempts. */
  sleep?: Sleep;
}

/**
 * Boots the worker: loads the environment, waits for the database (a database that is not up yet is retried with
 * capped backoff and one plain log line; configuration problems fail at once), connects storage, the queue and the
 * AI providers, recovers jobs a previous process left running, registers a handler for every job type, schedules
 * hourly cleanup and starts the worker heartbeat the web app reads. Returns the shared context and a graceful `stop`
 * that waits for active jobs before closing connections.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<{ ctx: WorkerContext; stop: () => Promise<void> }> {
  loadRootEnvFile();
  let loaded: ReturnType<typeof loadEnv>;
  try {
    loaded = loadEnv();
  } catch (err) {
    throw new StartupConfigError(err instanceof Error ? err.message : String(err));
  }
  const env = { ...loaded, STORAGE_LOCAL_ROOT: resolveConfiguredPath(loaded.STORAGE_LOCAL_ROOT), WORKER_TMP_DIR: resolveConfiguredPath(loaded.WORKER_TMP_DIR) };
  const logger = pino({ level: env.LOG_LEVEL, base: { service: 'studio-worker' } });
  // Configuration problems fail before anything connects: a mistyped address or a module without its handler.
  const target = databaseTarget(env.DATABASE_URL);
  const queueUrl = env.QUEUE_DATABASE_URL ?? env.DATABASE_URL;
  if (env.QUEUE_DATABASE_URL) databaseTarget(env.QUEUE_DATABASE_URL, 'QUEUE_DATABASE_URL');
  const handlers = allHandlers(env.WORKER_CONCURRENCY);
  try {
    assertHandlersCoverJobTypes(handlers);
  } catch (err) {
    throw new StartupConfigError(err instanceof Error ? err.message : String(err));
  }

  const dbHandle = createDatabase(env.DATABASE_URL, { max: env.DB_POOL_MAX ?? DEFAULT_DB_POOL_MAX.worker, applicationName: 'studio-worker' });
  const store = createBlobStore(env);
  const queue = createQueue({ connectionString: queueUrl, role: 'worker', logger, max: env.QUEUE_POOL_MAX });
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

  // The first connection: the app database, then the queue (which also creates/migrates its schema). Starting the
  // same pg-boss instance again after a failed start is safe (pg-boss documents it).
  try {
    await waitForDatabase({
      target,
      logger,
      signal: options.signal ?? new AbortController().signal,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      attempt: async () => {
        await probeDatabase(env.DATABASE_URL, { applicationName: 'studio-worker' });
        if (env.QUEUE_DATABASE_URL && env.QUEUE_DATABASE_URL !== env.DATABASE_URL) await probeDatabase(env.QUEUE_DATABASE_URL, { applicationName: 'studio-worker' });
        await queue.start();
        // Reachable but not migrated (an update was pulled without `dev.sh migrate`): waiting will not fix that.
        if (!(await hasWorkerHeartbeatsTable(dbHandle.db))) {
          throw new StartupConfigError('The database has not been updated for this version of the app. Run: bash scripts/dev.sh migrate, then start the app again.');
        }
      },
    });
  } catch (err) {
    // The queue never finished starting, so close pg-boss's own pool directly.
    await queue.raw.stop({ graceful: false, timeout: 1_000 }).catch(() => {});
    await dbHandle.close().catch(() => {});
    if (err instanceof StartupAbortedError) throw err;
    throw new StartupConfigError(describeFatalStartupError(err, target));
  }
  const lookupBossJob = async (type: JobType, id: string) => {
    const job = await queue.getBossJob(type, id);
    return job ? { state: job.state } : null;
  };
  const recovered = await recoverStaleJobs(ctx.db, logger, lookupBossJob);
  if (recovered) logger.warn({ recovered }, 'recovered jobs left running by a previous worker');
  // A worker that dies while this one keeps running (or one killed moments before this start-up) leaves rows
  // that only go stale later, so the sweep repeats; pg-boss itself retries the underlying jobs.
  const sweep = setInterval(() => {
    recoverStaleJobs(ctx.db, logger, lookupBossJob)
      .then((n) => {
        if (n) logger.warn({ recovered: n }, 'recovered jobs whose worker stopped heart-beating');
      })
      .catch((err: unknown) => logger.warn({ err }, 'stale job sweep failed'));
  }, STALE_SWEEP_MS);
  sweep.unref();

  const registered: JobType[] = [];
  // Attempts in progress, so a shutdown can let interrupted handlers record their state before the pool closes.
  const inFlight = new Set<Promise<void>>();
  const register = async <T extends JobType>(type: T, handler: Handler<T>, concurrency: number) => {
    await queue.work(
      type,
      async (job) => {
        const payload = JOB_PAYLOAD_SCHEMAS[type].parse(job.data) as JobPayload<T>;
        const projectId = (payload as { projectId?: string }).projectId ?? null;
        const attempt = runTracked(
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
        inFlight.add(attempt);
        try {
          await attempt;
        } catch (err) {
          // The owner's cancellation is a normal outcome, not a failure the queue should retry; neither is a
          // NonRetryableError (runTracked has already marked the row failed with its message). An interruption
          // by the queue (JobInterruptedError) is rethrown so pg-boss records the attempt and retries it.
          if (err instanceof CancelledError || err instanceof NonRetryableError) return;
          throw err;
        } finally {
          inFlight.delete(attempt);
        }
      },
      concurrency,
    );
    registered.push(type);
  };

  const c = env.WORKER_CONCURRENCY;
  for (const h of handlers) await register(h.type, h.handler as Handler<JobType>, h.concurrency ?? 1);
  await queue.schedule(JOB_TYPES.CLEANUP, '17 * * * *', { olderThanHours: 24 });
  for (const cron of moduleCrons()) await queue.schedule(cron.type, cron.cron, cron.payload, { key: cron.key });

  const missing = ALL_JOB_TYPES.filter((type) => !registered.includes(type));
  if (missing.length) throw new Error(`No handler registered for: ${missing.join(', ')}`);
  // Rows left by workers that were killed long ago; the web app only looks at the newest heartbeat anyway.
  await pruneWorkerHeartbeats(ctx.db).catch((err: unknown) => logger.warn({ err }, 'could not prune old worker heartbeats'));
  const heartbeat = await startWorkerHeartbeat(ctx.db, { id: ctx.workerId, hostname: os.hostname(), pid: process.pid, version: workerVersion(), queues: registered }, logger);
  logger.info({ workerId: ctx.workerId, concurrency: c, queues: registered, ai: ai.describe(), storage: store.driver, tmpRoot }, 'worker started');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweep);
    logger.info('worker stopping (waiting for active jobs)');
    try {
      // pg-boss waits up to 30 s for active jobs, then fails them (they are retried later) and aborts them.
      await queue.stop(true);
      if (inFlight.size > 0) {
        logger.info({ active: inFlight.size }, 'letting interrupted jobs record their state');
        await Promise.race([Promise.allSettled([...inFlight]), new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_SETTLE_MS).unref())]);
      }
    } finally {
      // Takes no more work: tell the app straight away instead of letting the heartbeat go stale.
      await heartbeat.stop();
      await dbHandle.close();
    }
    logger.info('worker stopped');
  };
  return { ctx, stop };
}

/**
 * Prints why start-up failed without ever showing the connection string or its password, and returns the exit
 * status: EXIT_CONFIG (78) for configuration problems, which scripts/dev.sh does not restart, 1 for anything else.
 */
export function reportStartupFailure(err: unknown, write: (line: string) => void = (line) => console.error(line)): number {
  const secrets = [...connectionSecrets(process.env.DATABASE_URL), ...connectionSecrets(process.env.QUEUE_DATABASE_URL)];
  if (err instanceof StartupConfigError) {
    write(redact(`The worker could not start: ${err.message.replace(/^The worker could not start: /, '')}`, secrets));
    return err.exitCode;
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  write(redact(`The worker could not start: ${detail}`, secrets));
  return 1;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isDirectRun) {
  // Signals are handled from the very start, so Ctrl+C also works while the worker waits for the database.
  const startup = new AbortController();
  let stopRunning: (() => Promise<void>) | null = null;
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    if (!stopRunning) {
      startup.abort();
      return;
    }
    void stopRunning().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 45_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  startWorker({ signal: startup.signal })
    .then(({ stop }) => {
      stopRunning = stop;
      // A signal that arrived during the last start-up steps.
      if (exiting) {
        exiting = false;
        shutdown();
      }
    })
    .catch((err: unknown) => {
      if (err instanceof StartupAbortedError) {
        console.error('The worker stopped before the database was reachable.');
        process.exit(0);
      }
      process.exit(reportStartupFailure(err));
    });
}
