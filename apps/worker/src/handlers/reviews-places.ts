import { eq, sql } from 'drizzle-orm';
import type { JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { recordConnectionCheck } from '../lib/connections.js';
import { PLACES_FIELDS_CONNECT, PLACES_FIELDS_DAILY, PlacesError, fetchPlaceDetails } from '../lib/google/places.js';
import type { TrackedRun } from '../lib/job-tracker.js';

/**
 * `reviews.places.sync` (daily at 5:41 am Melbourne time, on connect and on the owner's refresh): reads the Google
 * rating and review count for the saved Place ID and overwrites the latest snapshot on the `google_places` row (no
 * history is kept). On connect it also reads the place's name and address so the owner can confirm it is theirs.
 * Read-only; never writes anything to Google.
 */
export async function handleReviewsPlacesSync(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'reviews.places.sync'>, now: () => Date = () => new Date()): Promise<void> {
  const key = ctx.env.GOOGLE_MAPS_API_KEY;
  const conn = await ctx.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'google_places') });
  const placeId = typeof conn?.config['placeId'] === 'string' ? (conn.config['placeId'] as string) : null;
  if (!key || !conn || !placeId) {
    await run.progress(1, key ? 'No Place ID saved' : 'Google rating is not set up (GOOGLE_MAPS_API_KEY)');
    return;
  }
  const confirmed = conn.config['confirmed'] === true;
  if (payload.reason === 'daily' && !confirmed) {
    await run.progress(1, 'Waiting for the owner to confirm the place');
    return;
  }
  const connect = payload.reason === 'connect' || !confirmed;
  try {
    const snap = await fetchPlaceDetails(ctx, key, placeId, connect ? PLACES_FIELDS_CONNECT : PLACES_FIELDS_DAILY, run.signal);
    const fetchedAt = now().toISOString();
    await ctx.db
      .update(schema.integrationConnections)
      .set({
        status: 'connected',
        lastError: null,
        lastSyncAt: now(),
        // Only the latest snapshot: replaced, never appended (memo §7 caching rules).
        capabilities: { rating: snap.rating, userRatingCount: snap.userRatingCount, writeAReviewUri: snap.writeAReviewUri, readReviewsUri: snap.readReviewsUri, fetchedAt },
        ...(connect ? { config: sql`${schema.integrationConnections.config} || ${JSON.stringify({ candidate: { displayName: snap.displayName, formattedAddress: snap.formattedAddress } })}::jsonb` } : {}),
        ...(snap.displayName ? { displayName: snap.displayName } : {}),
        updatedAt: now(),
      })
      .where(eq(schema.integrationConnections.id, conn.id));
    await run.progress(1, snap.rating !== null ? `Rating ${snap.rating} from ${snap.userRatingCount ?? 0} reviews` : 'Google has no rating for this place yet');
  } catch (err) {
    if (!(err instanceof PlacesError)) throw err;
    await recordConnectionCheck(ctx.db, 'google_places', { status: 'error', lastError: err.message });
    if (err.transient) throw err;
    await run.progress(1, err.message);
  }
}
