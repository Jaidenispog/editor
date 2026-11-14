import { and, count, eq, max, sql } from 'drizzle-orm';
import { newId, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { loadConnection, recordConnectionCheck } from '../lib/connections.js';
import { MAX_REVIEW_PAGES, discoverLocations, fetchReviewsPage, type ParsedReview } from '../lib/google/business-profile.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { PROVIDER, chosenLocation, handleProfileError, isUsable, mergeConfig, profileAccessToken, type ChosenLocation } from '../modules/business_profile/connection.js';

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
 *    wait for the owner);
 * 3. `reviews.list` newest update first: incremental syncs stop at the first review at or before the stored
 *    `review_updated_at` watermark; `weekly_full` (and the first sync) read every page, which also picks up reviews
 *    Google's known page-2 issue left out earlier;
 * 4. upsert on (provider, external review id), so a re-run gives identical rows.
 * Quota 0 (Google has not approved access) is recorded as "waiting for Google approval" and the job ends normally;
 * the next scheduled run tries again. Reviews are never typed in, edited or replied to.
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
    await mergeConfig(ctx, {
      locations: found.slice(0, 100),
      account: next?.account ?? null,
      location: next?.location ?? null,
      locationTitle: next?.title ?? null,
    });
    if (!found.length) {
      const message = "Google lists no Business Profile locations for this Google account. Sign in with the account that manages the studio's profile.";
      await recordConnectionCheck(ctx.db, PROVIDER, { status: 'error', lastError: message, capabilities: { apiAccess: 'available', apiAccessMessage: message, locationCount: 0 } });
      await run.message('No Business Profile locations found');
      return none('no_locations');
    }
    if (!next) {
      await recordConnectionCheck(ctx.db, PROVIDER, { status: 'connected', lastError: null, capabilities: { apiAccess: 'available', apiAccessMessage: null, locationCount: found.length } });
      await run.message('Choose your location in Reviews → Reviews on Google');
      return none('choose_location');
    }
    newlyChosen = !chosen || chosen.location !== next.location;
    chosen = next;
    if (next.title) {
      await ctx.db.update(schema.integrationConnections).set({ displayName: next.title.slice(0, 120) }).where(eq(schema.integrationConnections.provider, PROVIDER));
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
    await handleProfileError(ctx, err, 'apiAccess');
    await run.message("Waiting for Google's approval of API access");
    return { outcome: 'awaiting_approval', pages, stored, full };
  }

  await recordConnectionCheck(
    ctx.db,
    PROVIDER,
    {
      status: 'connected',
      lastError: null,
      capabilities: {
        apiAccess: 'available',
        apiAccessMessage: null,
        reviewsSyncedAt: syncedAt.toISOString(),
        ...(full ? { reviewsFullSyncAt: syncedAt.toISOString() } : {}),
        ...(averageRating !== null ? { averageRating } : {}),
        ...(totalReviewCount !== null ? { totalReviewCount } : {}),
      },
    },
    syncedAt,
  );
  if (payload.reason === 'connect' || newlyChosen) {
    await enqueueTracked(ctx, 'website.connection_check', { provider: 'business_profile_performance', reason: 'connect' }, { singletonKey: 'website-check:business_profile_performance' });
  }
  await run.progress(1, stored ? `Stored ${stored} Google review${stored === 1 ? '' : 's'}` : 'No new Google reviews');
  return { outcome: 'synced', pages, stored, full };
}

/** Upserts reviews on (provider, external review id); returns how many were written. */
export async function upsertReviews(ctx: Pick<WorkerContext, 'db'>, location: string, reviews: ParsedReview[], syncedAt: Date): Promise<number> {
  // One row per review id (an insert cannot update the same row twice).
  const unique = [...new Map(reviews.map((rev) => [rev.externalReviewId, rev])).values()];
  if (!unique.length) return 0;
  const r = schema.reviews;
  await ctx.db
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
}
