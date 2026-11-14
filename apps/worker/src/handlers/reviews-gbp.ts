import { and, count, eq, max, sql } from 'drizzle-orm';
import { newId, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { loadConnection } from '../lib/connections.js';
import { MAX_REVIEW_PAGES, discoverLocations, fetchReviewsPage, type DiscoveredLocation, type ParsedReview } from '../lib/google/business-profile.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import {
  PERFORMANCE_STATE_CLEARED,
  PROVIDER,
  ProfileStoppedError,
  chosenLocation,
  handleProfileError,
  isUsable,
  profileAccessToken,
  recordProfileCheck,
  signedInRow,
  whileSignedIn,
  type ChosenLocation,
} from '../modules/business_profile/connection.js';

/** What a sync did, for tests and the job message. */
export interface GbpSyncOutcome {
  outcome: 'not_connected' | 'awaiting_approval' | 'choose_location' | 'no_locations' | 'synced';
  pages: number;
  stored: number;
  full: boolean;
}

/**
 * `reviews.gbp.sync` (email design §6, §8.3), read-only:
 * 1. a valid token (refreshed under the row lock; `invalid_grant` → `needs_reauth`, no retry);
 * 2. location discovery on `connect`, or while no location is chosen (one location is chosen automatically, several
 *    wait for the owner; a location the owner chose meanwhile is kept);
 * 3. `reviews.list` newest update first: incremental syncs stop at the first review at or before the stored
 *    `review_updated_at` watermark; `weekly_full` (and the first sync) read every page, which also picks up reviews
 *    Google's known page-2 issue left out earlier;
 * 4. upsert on (provider, external review id), so a re-run gives identical rows.
 * Quota 0 (Google has not approved access) is recorded as "waiting for Google approval" and the job ends normally;
 * the next scheduled run tries again. Reviews are never typed in, edited or replied to. When the owner disconnects
 * (or chooses another location) while the sync runs, it stops before the next page is stored and never switches the
 * row back to connected.
 */
export async function handleReviewsGbpSync(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'reviews.gbp.sync'>, now: () => Date = () => new Date()): Promise<GbpSyncOutcome> {
  const none = (outcome: GbpSyncOutcome['outcome']): GbpSyncOutcome => ({ outcome, pages: 0, stored: 0, full: false });
  const conn = await loadConnection(ctx.db, PROVIDER);
  if (!isUsable(conn) || conn.status === 'needs_reauth') {
    await run.message(conn?.status === 'needs_reauth' ? 'Google needs you to sign in again' : 'Google Business Profile is not connected');
    return none('not_connected');
  }
  const token = await profileAccessToken(ctx, run.signal);
  run.checkCancelled();

  let chosen = chosenLocation(conn);
  let newlyChosen = false;
  if (payload.reason === 'connect' || !chosen) {
    await run.progress(0.1, 'Finding your Business Profile locations…');
    let found;
    try {
      found = await discoverLocations(ctx, token, run.signal);
    } catch (err) {
      await handleProfileError(ctx, err, 'apiAccess');
      await run.message("Waiting for Google's approval of API access");
      return none('awaiting_approval');
    }
    const keep = chosen && found.some((l) => l.name === chosen?.location && l.account === chosen.account) ? chosen : null;
    const only = found.length === 1 ? found[0] : undefined;
    const next: ChosenLocation | null = keep ?? (only ? { account: only.account, location: only.name, title: only.title } : null);
    const stored = await storeDiscovery(ctx, found, next);
    if (!found.length) {
      const message = "Google lists no Business Profile locations for this Google account. Sign in with the account that manages the studio's profile.";
      await recordProfileCheck(ctx, { status: 'error', lastError: message, capabilities: { apiAccess: 'available', apiAccessMessage: message, locationCount: 0 } });
      await run.message('No Business Profile locations found');
      return none('no_locations');
    }
    if (stored === 'disconnected') {
      await run.message('Google Business Profile was disconnected; stopped.');
      return none('not_connected');
    }
    if (!stored) {
      await recordProfileCheck(ctx, { status: 'connected', lastError: null, capabilities: { apiAccess: 'available', apiAccessMessage: null, locationCount: found.length } });
      await run.message('Choose your location in Reviews → Reviews on Google');
      return none('choose_location');
    }
    newlyChosen = !chosen || chosen.location !== stored.location;
    chosen = stored;
    if (stored.title) {
      await ctx.db.update(schema.integrationConnections).set({ displayName: stored.title.slice(0, 120) }).where(signedInRow());
    }
  }
  const location = chosen;
  if (!location) return none('choose_location');

  const r = schema.reviews;
  const inLocation = and(eq(r.provider, PROVIDER), sql`${r.raw}->>'location' = ${location.location}`);
  const [stats] = await ctx.db.select({ n: count(), watermark: max(r.reviewUpdatedAt) }).from(r).where(inLocation);
  const full = payload.reason === 'weekly_full' || payload.reason === 'connect' || (stats?.n ?? 0) === 0 || !stats?.watermark;
  const watermark = full ? null : (stats?.watermark ?? null);

  let next: string | null = null;
  let pages = 0;
  let stored = 0;
  let averageRating: number | null = null;
  let totalReviewCount: number | null = null;
  const syncedAt = now();
  try {
    do {
      run.checkCancelled();
      await run.progress(Math.min(0.2 + pages * 0.05, 0.9), `Reading Google reviews (page ${pages + 1})`);
      const page = await fetchReviewsPage(ctx, token, location.account, location.location, next, run.signal);
      if (pages === 0) {
        averageRating = page.averageRating;
        totalReviewCount = page.totalReviewCount;
      }
      pages++;
      const fresh = watermark ? page.reviews.filter((rev) => rev.updatedAt.getTime() > watermark.getTime()) : page.reviews;
      stored += await upsertReviews(ctx, location.location, fresh, syncedAt);
      // Newest update first: once a page reaches the watermark, everything after it is already stored.
      if (watermark && fresh.length < page.reviews.length) break;
      next = page.nextPageToken;
    } while (next && pages < MAX_REVIEW_PAGES);
  } catch (err) {
    if (err instanceof ProfileStoppedError) {
      await run.message(err.message);
      return { outcome: 'not_connected', pages, stored, full };
    }
    await handleProfileError(ctx, err, 'apiAccess');
    await run.message("Waiting for Google's approval of API access");
    return { outcome: 'awaiting_approval', pages, stored, full };
  }

  const recorded = await recordProfileCheck(
    ctx,
    {
      status: 'connected',
      lastError: null,
      capabilities: {
        apiAccess: 'available',
        apiAccessMessage: null,
        reviewsSyncedAt: syncedAt.toISOString(),
        ...(full ? { reviewsFullSyncAt: syncedAt.toISOString() } : {}),
        // Google's own totals belong to this location; a total Google did not send is cleared, never kept from before.
        reviewStatsLocation: location.location,
        averageRating,
        totalReviewCount,
      },
    },
    syncedAt,
  );
  if (!recorded) {
    await run.message('Google Business Profile was disconnected; stopped.');
    return { outcome: 'not_connected', pages, stored, full };
  }
  if (payload.reason === 'connect' || newlyChosen) {
    await enqueueTracked(ctx, 'website.connection_check', { provider: 'business_profile_performance', reason: 'connect' }, { singletonKey: 'website-check:business_profile_performance' });
  }
  await run.progress(1, stored ? `Stored ${stored} Google review${stored === 1 ? '' : 's'}` : 'No new Google reviews');
  return { outcome: 'synced', pages, stored, full };
}

/**
 * Stores what discovery found. The account and location are set only when the stored location is no longer one of
 * the found ones (or none is chosen), so a location the owner chose while this sync was running is never replaced by
 * this sync's older view. Returns the location now chosen (null when the owner must choose), or `disconnected`.
 */
async function storeDiscovery(ctx: Pick<WorkerContext, 'db'>, found: DiscoveredLocation[], next: ChosenLocation | null): Promise<ChosenLocation | null | 'disconnected'> {
  const t = schema.integrationConnections;
  const names = JSON.stringify(found.map((l) => l.name));
  const choice = JSON.stringify({ account: next?.account ?? null, location: next?.location ?? null, locationTitle: next?.title ?? null });
  const updated = await ctx.db
    .update(t)
    .set({
      config: sql`(${t.config} || ${JSON.stringify({ locations: found.slice(0, 100) })}::jsonb) || (case when ${names}::jsonb ? coalesce(${t.config}->>'location', '') then '{}'::jsonb else ${choice}::jsonb end)`,
      // A location chosen here (or cleared) starts with no Performance state; the old location's never carries over.
      capabilities: sql`case when ${names}::jsonb ? coalesce(${t.config}->>'location', '') then ${t.capabilities} else ${t.capabilities} || ${JSON.stringify(PERFORMANCE_STATE_CLEARED)}::jsonb end`,
      updatedAt: new Date(),
    })
    .where(signedInRow())
    .returning({ config: t.config });
  const row = updated[0];
  if (!row) return 'disconnected';
  return chosenLocation(row);
}

/**
 * Upserts reviews on (provider, external review id); returns how many were written. Only while the row is still
 * signed in with this location: otherwise ProfileStoppedError, and nothing is written (so reviews the owner deleted
 * on disconnect are never written back).
 */
export async function upsertReviews(ctx: Pick<WorkerContext, 'db'>, location: string, reviews: ParsedReview[], syncedAt: Date): Promise<number> {
  // One row per review id (an insert cannot update the same row twice).
  const unique = [...new Map(reviews.map((rev) => [rev.externalReviewId, rev])).values()];
  const r = schema.reviews;
  return whileSignedIn(ctx, location, async (tx) => {
    if (!unique.length) return 0;
    await tx
      .insert(r)
      .values(
        unique.map((rev) => ({
          id: newId(),
          provider: PROVIDER,
          externalReviewId: rev.externalReviewId,
          rating: rev.rating,
          reviewerName: rev.reviewerName,
          comment: rev.comment,
          reviewCreatedAt: rev.createdAt,
          reviewUpdatedAt: rev.updatedAt,
          replyText: rev.replyText,
          raw: { location, reviewReplyState: rev.reviewReplyState, policyViolation: rev.policyViolation, replyUpdatedAt: rev.replyUpdatedAt },
          syncedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [r.provider, r.externalReviewId],
        set: {
          rating: sql`excluded.rating`,
          reviewerName: sql`excluded.reviewer_name`,
          comment: sql`excluded.comment`,
          reviewCreatedAt: sql`excluded.review_created_at`,
          reviewUpdatedAt: sql`excluded.review_updated_at`,
          replyText: sql`excluded.reply_text`,
          raw: sql`excluded.raw`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
    return unique.length;
  });
}
