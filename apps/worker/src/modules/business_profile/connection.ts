import { eq, sql } from 'drizzle-orm';
import { AppError, NonRetryableError, type BusinessProfileApiState } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../../context.js';
import { recordConnectionCheck, type ConnectionRow } from '../../lib/connections.js';
import { BusinessProfileError, isAccountName, isLocationName, type DiscoveredLocation } from '../../lib/google/business-profile.js';
import { getGoogleAccessToken } from '../../lib/google/oauth.js';

/**
 * Shared helpers of the Business Profile module: the chosen location, the access token, and how a Google answer
 * changes the one `google_business_profile` row that reviews and Performance share (email design §8.3, website design
 * §7.3). Owner-fixable problems end the job without retrying; quota 0 is "waiting for Google approval", not an error.
 */

export const PROVIDER = 'google_business_profile' as const;

/** The location the owner chose (or discovery chose because it was the only one). */
export interface ChosenLocation {
  account: string;
  location: string;
  title: string;
}

/** The chosen location from the row's config, or null. Values are checked before they ever go into a URL. */
export function chosenLocation(conn: Pick<ConnectionRow, 'config'> | null): ChosenLocation | null {
  const c = conn?.config ?? {};
  if (!isAccountName(c['account']) || !isLocationName(c['location'])) return null;
  return { account: c['account'], location: c['location'], title: typeof c['locationTitle'] === 'string' ? c['locationTitle'] : '' };
}

/** The locations discovery stored (for the owner's choice). */
export function storedLocations(conn: Pick<ConnectionRow, 'config'> | null): DiscoveredLocation[] {
  const list = conn?.config['locations'];
  if (!Array.isArray(list)) return [];
  return list.filter((l): l is DiscoveredLocation => Boolean(l) && isAccountName((l as DiscoveredLocation).account) && isLocationName((l as DiscoveredLocation).name));
}

/** True when the row holds a sign-in this module can use. */
export function isUsable(conn: ConnectionRow | null): conn is ConnectionRow {
  return Boolean(conn && conn.status !== 'disconnected' && conn.status !== 'not_configured' && conn.refreshTokenEncrypted);
}

/**
 * A valid access token, or a NonRetryableError when the sign-in is gone or Google refused it (`invalid_grant` has
 * already marked the shared row `needs_reauth`).
 */
export async function profileAccessToken(ctx: WorkerContext, signal: AbortSignal): Promise<string> {
  try {
    return await getGoogleAccessToken(ctx, PROVIDER, signal);
  } catch (err) {
    if (err instanceof AppError && err.code === 'INTEGRATION_NOT_CONFIGURED') throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', err.message);
    throw err;
  }
}

/** Merges keys into the row's config (only the keys given change). */
export async function mergeConfig(ctx: Pick<WorkerContext, 'db'>, patch: Record<string, unknown>, now: Date = new Date()): Promise<void> {
  const t = schema.integrationConnections;
  await ctx.db
    .update(t)
    .set({ config: sql`${t.config} || ${JSON.stringify(patch)}::jsonb`, updatedAt: now })
    .where(eq(t.provider, PROVIDER));
}

/** Which capability key an API answer is recorded under. */
export type ProfileApi = 'apiAccess' | 'performanceApi';

/**
 * Records a mapped Business Profile failure and decides what the job does:
 * - `awaiting_approval`: recorded, the job ends normally (no retry until the next scheduled run);
 * - `transient`: nothing recorded, rethrown so pg-boss retries;
 * - anything else (owner-fixable): recorded with a plain message, then a NonRetryableError.
 * Performance problems never change the row's status (reviews may still work), except a refused sign-in.
 */
export async function handleProfileError(ctx: Pick<WorkerContext, 'db'>, err: unknown, api: ProfileApi): Promise<'awaiting_approval'> {
  if (!(err instanceof BusinessProfileError)) throw err;
  const messageKey = api === 'apiAccess' ? 'apiAccessMessage' : 'performanceMessage';
  if (err.kind === 'transient') throw err;
  if (err.kind === 'awaiting_approval') {
    await recordConnectionCheck(ctx.db, PROVIDER, {
      status: 'connected',
      capabilities: { [api]: 'awaiting_approval' satisfies BusinessProfileApiState, [messageKey]: null },
      ...(api === 'apiAccess' ? { lastError: null } : {}),
    });
    return 'awaiting_approval';
  }
  if (err.kind === 'reauth') {
    await recordConnectionCheck(ctx.db, PROVIDER, { status: 'needs_reauth', lastError: err.message });
    throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', err.message);
  }
  const state: BusinessProfileApiState = err.kind === 'api_disabled' ? 'api_disabled' : 'error';
  if (api === 'apiAccess') {
    if (err.kind === 'not_found') {
      await mergeConfig(ctx, { location: null, account: null, locationTitle: null });
      await recordConnectionCheck(ctx.db, PROVIDER, { status: 'connected', lastError: err.message, capabilities: { apiAccess: 'available', apiAccessMessage: err.message } });
    } else {
      await recordConnectionCheck(ctx.db, PROVIDER, { status: 'error', lastError: err.message, capabilities: { apiAccess: state, apiAccessMessage: err.message } });
    }
  } else {
    // The reviews side may still work: only the Performance capability changes.
    const t = schema.integrationConnections;
    await ctx.db
      .update(t)
      .set({ capabilities: sql`${t.capabilities} || ${JSON.stringify({ performanceApi: state, performanceMessage: err.message })}::jsonb`, updatedAt: new Date() })
      .where(eq(t.provider, PROVIDER));
  }
  throw new NonRetryableError(err.kind === 'unrecognised' ? 'PROCESSING_FAILED' : 'INTEGRATION_NOT_CONFIGURED', err.message);
}
