import { createWebsiteCopywriter, type WebsiteCopywriter } from '@studio/ai';
import type { WorkerContext } from '../context.js';
import { DEFAULT_FETCH_POLICY, type FetchPolicy } from './fetcher.js';

/**
 * What the website handlers need beyond the worker context. Production uses {@link defaultWebsiteDeps}; tests pass
 * their own (a local fixture server policy, a fake copywriter, a fake clock). There is deliberately no environment
 * variable that loosens the crawler's SSRF guard: only code can build a test policy.
 */
export interface WebsiteDeps {
  fetchPolicy: FetchPolicy;
  /** The AI wording writer, or null when AI is not configured. */
  copywriter: WebsiteCopywriter | null;
  /** Clock for timestamps (tests pin it). */
  now: () => Date;
  /** Fake clock for the crawler's polite spacing (tests only; real time otherwise). */
  crawlerClock?: {
    now: () => number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
}

/** The production dependencies: the strict crawler policy and the configured copywriter. */
export function defaultWebsiteDeps(ctx: Pick<WorkerContext, 'env' | 'logger'>): WebsiteDeps {
  return {
    fetchPolicy: DEFAULT_FETCH_POLICY,
    copywriter: createWebsiteCopywriter(ctx.env, { logger: ctx.logger }),
    now: () => new Date(),
  };
}
