import type { JobPayload, JobType } from '@studio/core';
import type { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';

/** A job handler: does the work for one attempt, honours `run.signal`, and must be safe to run again. */
export type JobHandlerFn<T extends JobType> = (ctx: WorkerContext, run: TrackedRun, payload: JobPayload<T>) => Promise<void>;

/** One handler registration. Build it with {@link defineHandler} so the payload type matches the job type. */
export interface ModuleJobHandler {
  type: JobType;
  handler: (ctx: WorkerContext, run: TrackedRun, payload: never) => Promise<void>;
  /** Jobs of this type run at the same time in one worker (default 1). */
  concurrency?: number;
}

/** Typed helper for a module's handler list. */
export function defineHandler<T extends JobType>(type: T, handler: JobHandlerFn<T>, concurrency = 1): ModuleJobHandler {
  return { type, handler: handler as ModuleJobHandler['handler'], concurrency };
}

/** A cron schedule in Melbourne time. `key` must be unique per queue (several schedules may share a queue). */
export interface ModuleCron {
  type: JobType;
  cron: string;
  payload: Record<string, unknown>;
  key: string;
}

/** A stored webhook delivery, as `webhook.process` hands it to a module. Payloads are hints, never instructions. */
export type StoredWebhookEvent = typeof schema.webhookEvents.$inferSelect;

/**
 * Handles one webhook delivery for a provider. It must re-fetch from the provider (or apply only restrictive effects,
 * such as suppressions) and be idempotent: the same event may be processed again after a crash.
 */
export type WebhookHandler = (ctx: WorkerContext, run: TrackedRun, event: StoredWebhookEvent) => Promise<void>;

/** Work added to the hourly `maintenance.cleanup` job. Returns a short summary for the job message. */
export interface CleanupTask {
  name: string;
  run: (ctx: WorkerContext, run: TrackedRun) => Promise<string | void>;
}

/** Facts passed to export-ready hooks after a full-quality export was stored. */
export interface ExportReadyEvent {
  editVersionId: string;
  editId: string;
  projectId: string;
  /** `standard`, or a variant such as `no_music` once the music module adds variants. */
  variant: string;
  storageKey: string;
  byteSize: number;
}

/**
 * Runs after an export is ready (for example publishing preparing posts that wait for this file). Must be quick
 * and idempotent; a failure is logged and never fails the export, so every hook needs its own catch-up path.
 */
export type ExportReadyHook = (ctx: WorkerContext, event: ExportReadyEvent) => Promise<void>;

/** Everything one module registers with the worker. Every field is optional. */
export interface WorkerModule {
  name: string;
  handlers?: ModuleJobHandler[];
  crons?: ModuleCron[];
  /** Webhook handlers keyed by `webhook_events.provider` (for example `square`, `postmark`, `zernio`). */
  webhookHandlers?: Record<string, WebhookHandler>;
  cleanupTasks?: CleanupTask[];
  exportReadyHooks?: ExportReadyHook[];
  /** The entity a job of this module is about (for progress on the right card); undefined for other modules' types. */
  refIdFor?: (type: JobType, payload: Record<string, unknown>) => string | null | undefined;
}
