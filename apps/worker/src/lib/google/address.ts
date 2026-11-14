import { googleApiUrl } from '@studio/config';
import type { WorkerContext } from '../../context.js';

/** The context a Google client needs: HTTP and logs, plus the settings when the caller has them (handlers always do). */
export type GoogleCtx = Pick<WorkerContext, 'fetch' | 'logger'> & Partial<Pick<WorkerContext, 'env'>>;

/**
 * The address to call for a Google API URL: Google's own, or the same path on the local fake that stands in for every
 * Google host when NODE_ENV=test and GOOGLE_API_BASE_URL is set (the Stage C website browser test). Callers without
 * settings (unit tests with an injected fake fetch) always get Google's own address.
 */
export function googleUrl(ctx: GoogleCtx, url: string): string {
  return googleApiUrl(ctx.env, url);
}
