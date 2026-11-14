import { createWebsiteCopywriter, type WebsiteCopywriter } from '@studio/ai';
import { testOnlyWebsiteFixture, type Env } from '@studio/config';
import type { WorkerContext } from '../context.js';
import { DEFAULT_FETCH_POLICY, type FetchPolicy } from './fetcher.js';

/**
 * What the website handlers need beyond the worker context. Production uses {@link defaultWebsiteDeps}; tests pass
 * their own (a local fixture server policy, a fake copywriter, a fake clock). The only environment setting that
 * touches the crawler's SSRF guard is the test-only WEBSITE_FIXTURE_BASE_URL ({@link websiteFetchPolicy}): ignored
 * unless NODE_ENV=test, and even then it adds one exact host name on 127.0.0.1 and nothing else.
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

/**
 * The crawler and WordPress transport policy for this process: {@link DEFAULT_FETCH_POLICY} (no loopback, no private
 * addresses, real DNS, ports 80/443), plus, only under NODE_ENV=test with WEBSITE_FIXTURE_BASE_URL set (the Stage C
 * website browser test), the one fixture host name served on 127.0.0.1 at its port. Loopback in general and every
 * other private address stay refused, so another local address is still never contacted.
 */
export function websiteFetchPolicy(env: Pick<Env, 'NODE_ENV' | 'WEBSITE_FIXTURE_BASE_URL'>): FetchPolicy {
  const fixture = testOnlyWebsiteFixture(env);
  return fixture ? { ...DEFAULT_FETCH_POLICY, fixture } : DEFAULT_FETCH_POLICY;
}

/** The production dependencies: the strict crawler policy and the configured copywriter. */
export function defaultWebsiteDeps(ctx: Pick<WorkerContext, 'env' | 'logger'>): WebsiteDeps {
  return {
    fetchPolicy: websiteFetchPolicy(ctx.env),
    copywriter: createWebsiteCopywriter(ctx.env, { logger: ctx.logger }),
    now: () => new Date(),
  };
}
