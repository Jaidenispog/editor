import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { Env } from '@studio/config';
import type { Database } from '@studio/db';
import type { BlobStore } from '@studio/storage';
import type { JobQueue } from '@studio/queue';
import type { createAiProviders } from '@studio/ai';

export type AiProviders = ReturnType<typeof createAiProviders>;

export interface WorkerContext {
  env: Env;
  db: Database;
  store: BlobStore;
  queue: JobQueue;
  ai: AiProviders;
  logger: Logger;
  /** Stable per-process id recorded on jobs rows. */
  workerId: string;
  /** Absolute path of the vendored fonts used for video text. */
  fontsDir: string;
  /** Absolute root for per-job temporary directories. */
  tmpRoot: string;
  /**
   * HTTP client for external APIs. Defaults to the global `fetch`; tests inject a fake or point it at a local
   * fake server. Always called through `lib/http.ts`, which adds the run's AbortSignal, a timeout and redaction.
   */
  fetch?: typeof fetch;
}

/** Repository root resolved from this file (apps/worker/src → ../../..). */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
