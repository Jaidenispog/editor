import { and, eq, notInArray, sql } from 'drizzle-orm';
import { AppError, NonRetryableError, type BusinessProfileApiState } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../../context.js';
import { recordConnectionCheck, type ConnectionCheckResult, type ConnectionRow, type DbTransaction } from '../../lib/connections.js';
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

/**
 * The shared row while it is still signed in. Every write a Business Profile job makes to the row is limited to it,
 * so a job still running when the owner disconnects can never switch the row back to connected or write its
 * capabilities and config again.
 */
export function signedInRow() {
  const t = schema.integrationConnections;
  return and(eq(t.provider, PROVIDER), notInArray(t.status, ['disconnected', 'not_configured']));
}

/**
 * The shared row while it is still signed in and still set to `location`. Performance answers belong to one location:
 * a probe or sync that was asked about the old location never records its answer after the owner chose another.
 */
export function signedInAt(location: string) {
  const t = schema.integrationConnections;
  return and(signedInRow(), sql`${t.config}->>'location' = ${location}`);
}

/** Records a check's outcome on the shared row, unless the owner has disconnected it meanwhile. */
export function recordProfileCheck(ctx: Pick<WorkerContext, 'db'>, result: ConnectionCheckResult, now: Date = new Date()): Promise<ConnectionRow | null> {
  return recordConnectionCheck(ctx.db, PROVIDER, result, now, { unlessDisconnected: true });
}

/** Thrown when the owner disconnected the Business Profile, or chose another location, while a job was storing data. */
export class ProfileStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileStoppedError';
  }
}

/**
 * Runs `fn` (a batch of stored reviews or numbers) in a transaction holding the shared row `FOR SHARE`, only while it
 * is still signed in and, when `location` is given, still set to that location. Disconnecting (and choosing a
 * location) updates the row, so it waits for a batch in progress, and every later batch sees the change and stops:
 * data the owner asked to delete is never written back.
 */
export async function whileSignedIn<T>(ctx: Pick<WorkerContext, 'db'>, location: string | null, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    const t = schema.integrationConnections;
    const row = (await tx.select({ status: t.status, config: t.config }).from(t).where(eq(t.provider, PROVIDER)).limit(1).for('share'))[0];
    if (!row || row.status === 'disconnected' || row.status === 'not_configured') throw new ProfileStoppedError('Google Business Profile was disconnected; stopped without storing anything more.');
    if (location !== null && row.config['location'] !== location) throw new ProfileStoppedError('Another Business Profile location was chosen; stopped without storing anything more for the old one.');
    return fn(tx);
  });
}

/** The Performance state that belongs to one location; cleared whenever the chosen location changes. */
export const PERFORMANCE_STATE_CLEARED = { performanceApi: null, performanceMessage: null } as const;

/** Which capability key an API answer is recorded under. */
export type ProfileApi = 'apiAccess' | 'performanceApi';

/**
 * Records a mapped Business Profile failure and decides what the job does:
 * - `awaiting_approval`: recorded, the job ends normally (no retry until the next scheduled run);
 * - `transient`: nothing recorded, rethrown so pg-boss retries;
 * - anything else (owner-fixable): recorded with a plain message, then a NonRetryableError.
 * Performance problems never change the row's status (reviews may still work), except a refused sign-in, and are
 * recorded only while the row is still set to the `location` that was asked about (required for `performanceApi`).
 */
export async function handleProfileError(ctx: Pick<WorkerContext, 'db'>, err: unknown, api: 'apiAccess'): Promise<'awaiting_approval'>;
export async function handleProfileError(ctx: Pick<WorkerContext, 'db'>, err: unknown, api: 'performanceApi', location: string): Promise<'awaiting_approval' | 'location_changed'>;
export async function handleProfileError(ctx: Pick<WorkerContext, 'db'>, err: unknown, api: ProfileApi, location?: string): Promise<'awaiting_approval' | 'location_changed'> {
  if (!(err instanceof BusinessProfileError)) throw err;
  const messageKey = api === 'apiAccess' ? 'apiAccessMessage' : 'performanceMessage';
  if (err.kind === 'transient') throw err;
  if (err.kind === 'awaiting_approval' && api === 'performanceApi') {
    const recorded = await setProfileCapabilities(ctx, { performanceApi: 'awaiting_approval' satisfies BusinessProfileApiState, performanceMessage: null }, location ?? null);
    return recorded ? 'awaiting_approval' : 'location_changed';
  }
  if (err.kind === 'awaiting_approval') {
    await recordProfileCheck(ctx, {
      status: 'connected',
      capabilities: { [api]: 'awaiting_approval' satisfies BusinessProfileApiState, [messageKey]: null },
      ...(api === 'apiAccess' ? { lastError: null } : {}),
    });
    return 'awaiting_approval';
  }
  if (err.kind === 'reauth') {
    await recordProfileCheck(ctx, { status: 'needs_reauth', lastError: err.message });
    throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', err.message);
  }
  const state: BusinessProfileApiState = err.kind === 'api_disabled' ? 'api_disabled' : 'error';
  if (api === 'apiAccess') {
    if (err.kind === 'not_found') {
      // The location is gone: clear it, and the Performance state that belonged to it.
      const t = schema.integrationConnections;
      await ctx.db
        .update(t)
        .set({
          config: sql`${t.config} || ${JSON.stringify({ location: null, account: null, locationTitle: null })}::jsonb`,
          capabilities: sql`${t.capabilities} || ${JSON.stringify(PERFORMANCE_STATE_CLEARED)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(signedInRow());
      await recordProfileCheck(ctx, { status: 'connected', lastError: err.message, capabilities: { apiAccess: 'available', apiAccessMessage: err.message } });
    } else {
      await recordProfileCheck(ctx, { status: 'error', lastError: err.message, capabilities: { apiAccess: state, apiAccessMessage: err.message } });
    }
  } else {
    // The reviews side may still work: only the Performance capability changes, and only for the location asked about.
    // If the owner chose another location meanwhile, this answer is about a location nobody is looking at any more.
    if (!(await setProfileCapabilities(ctx, { performanceApi: state, performanceMessage: err.message }, location ?? null))) return 'location_changed';
  }
  throw new NonRetryableError(err.kind === 'unrecognised' ? 'PROCESSING_FAILED' : 'INTEGRATION_NOT_CONFIGURED', err.message);
}

/**
 * Merges capability keys into the shared row without touching its status or last error, only while it is signed in
 * and (when `location` is given) still set to that location. True when the row was updated.
 */
export async function setProfileCapabilities(ctx: Pick<WorkerContext, 'db'>, caps: Record<string, string | null>, location: string | null, now: Date = new Date()): Promise<boolean> {
  const t = schema.integrationConnections;
  const updated = await ctx.db
    .update(t)
    .set({ capabilities: sql`${t.capabilities} || ${JSON.stringify(caps)}::jsonb`, updatedAt: now })
    .where(location === null ? signedInRow() : signedInAt(location))
    .returning({ id: t.id });
  return updated.length > 0;
}
