import { errorMessage, type JobType } from '@studio/core';
import type { WorkerContext } from '../context.js';
import { businessProfileModule } from './business_profile/index.js';
import { emailModule } from './email/index.js';
import { musicModule } from './music/index.js';
import { preferencesModule } from './preferences/index.js';
import { publishingModule } from './publishing/index.js';
import { squareModule } from './square/index.js';
import { trendsModule } from './trends/index.js';
import type { CleanupTask, ExportReadyEvent, ExportReadyHook, ModuleCron, ModuleJobHandler, WebhookHandler, WorkerModule } from './types.js';
import { websiteModule } from './website/index.js';

export * from './types.js';

/**
 * Every Stage B/C module's worker registrations, in a fixed order. Modules edit only their own
 * `./<module>/index.ts`; `main.ts`, `handlers/cleanup.ts`, `handlers/render.ts` and `handlers/webhook-process.ts`
 * read them through the functions below.
 */
export const WORKER_MODULES: readonly WorkerModule[] = [
  musicModule,
  preferencesModule,
  trendsModule,
  publishingModule,
  squareModule,
  emailModule,
  websiteModule,
  businessProfileModule,
];

/** Handlers from every module; throws when two registrations claim the same job type. */
export function moduleHandlers(modules: readonly WorkerModule[] = WORKER_MODULES): ModuleJobHandler[] {
  const seen = new Map<string, string>();
  const out: ModuleJobHandler[] = [];
  for (const m of modules) {
    for (const h of m.handlers ?? []) {
      const other = seen.get(h.type);
      if (other) throw new Error(`Job type ${h.type} has handlers in both the ${other} and ${m.name} modules`);
      seen.set(h.type, m.name);
      out.push(h);
    }
  }
  return out;
}

/** Cron schedules from every module; throws on a repeated (queue, key) pair. */
export function moduleCrons(modules: readonly WorkerModule[] = WORKER_MODULES): ModuleCron[] {
  const seen = new Set<string>();
  const out: ModuleCron[] = [];
  for (const m of modules) {
    for (const c of m.crons ?? []) {
      const id = `${c.type}#${c.key}`;
      if (seen.has(id)) throw new Error(`Schedule key ${c.key} is used twice on ${c.type}`);
      seen.add(id);
      out.push(c);
    }
  }
  return out;
}

/** The webhook handler a module registered for a provider, or null. */
export function webhookHandlerFor(provider: string, modules: readonly WorkerModule[] = WORKER_MODULES): WebhookHandler | null {
  for (const m of modules) {
    const handlers = m.webhookHandlers ?? {};
    if (Object.prototype.hasOwnProperty.call(handlers, provider)) return handlers[provider] ?? null;
  }
  return null;
}

/** Cleanup tasks from every module, run by `maintenance.cleanup` after the Stage A cleanup. */
export function moduleCleanupTasks(modules: readonly WorkerModule[] = WORKER_MODULES): CleanupTask[] {
  return modules.flatMap((m) => m.cleanupTasks ?? []);
}

/** Export-ready hooks from every module, called by the render handler after an export is stored. */
export function exportReadyHooks(modules: readonly WorkerModule[] = WORKER_MODULES): ExportReadyHook[] {
  return modules.flatMap((m) => m.exportReadyHooks ?? []);
}

/**
 * Calls every export-ready hook in module order. A failing hook is logged and does not fail the export (the file is
 * already stored and marked ready); each hook's module has its own catch-up path.
 */
export async function runExportReadyHooks(ctx: WorkerContext, event: ExportReadyEvent, hooks: ExportReadyHook[] = exportReadyHooks()): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(ctx, event);
    } catch (err) {
      ctx.logger.error({ err: errorMessage(err), editVersionId: event.editVersionId, variant: event.variant }, 'export-ready hook failed');
    }
  }
}

/** The first module answer for a job's ref id; undefined when no module owns the type. */
export function moduleRefIdFor(type: JobType, payload: Record<string, unknown>, modules: readonly WorkerModule[] = WORKER_MODULES): string | null | undefined {
  for (const m of modules) {
    const ref = m.refIdFor?.(type, payload);
    if (ref !== undefined) return ref;
  }
  return undefined;
}
