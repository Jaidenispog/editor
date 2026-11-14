import { and, eq, inArray } from 'drizzle-orm';
import { CancelledError, NonRetryableError, availabilityRange, effectiveLocationId, type JobPayload } from '@studio/core';
import { schema, type SquareAvailabilitySlot } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { SquareApiError } from '../square/api.js';
import { failSquareJob, openSquare } from '../square/client.js';

/** Shown when Square could not answer an availability search. */
export const AVAILABILITY_FAILED_MESSAGE = 'Square didn’t answer. Try again.';

/**
 * `square.availability`: one free-times search for the finder (design §4.4). Square needs at least 24 hours per
 * search, so a single 23-hour day is widened and the extra slots are dropped afterwards. Slots are Square's exact
 * instants. Read-only.
 */
export async function handleSquareAvailability(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.availability'>): Promise<void> {
  const t = schema.squareAvailabilitySearches;
  const search = await ctx.db.query.squareAvailabilitySearches.findFirst({ where: eq(t.id, payload.searchId) });
  if (!search || search.status === 'done' || search.status === 'failed') {
    await run.progress(1, 'Nothing to do for this search.');
    return;
  }
  const fail = async (message: string) => {
    await ctx.db.update(t).set({ status: 'failed', error: message }).where(eq(t.id, search.id));
  };
  await ctx.db.update(t).set({ status: 'running' }).where(and(eq(t.id, search.id), inArray(t.status, ['queued', 'running'])));
  let s: Awaited<ReturnType<typeof openSquare>>;
  try {
    s = await openSquare(ctx, run);
  } catch (err) {
    // A refused token refresh, a decryption or database failure: the search must not stay "running" for ever, and the
    // card shows the error on the final attempt (failSquareJob).
    if (err instanceof CancelledError) throw err;
    const forGood = !run.willRetry || err instanceof NonRetryableError || (err instanceof SquareApiError && err.kind !== 'transient' && err.kind !== 'rate_limited');
    if (forGood) await fail(err instanceof NonRetryableError && err.code === 'UNAUTHORISED' ? 'Square needs you to reconnect.' : AVAILABILITY_FAILED_MESSAGE);
    return failSquareJob(ctx, run, err, 'Availability search failed');
  }
  if ('skip' in s) {
    await fail(s.skip);
    await run.progress(1, s.skip);
    return;
  }
  if (search.environment !== s.environment) {
    await fail('This search was made for the other Square environment.');
    return;
  }
  const locationId = effectiveLocationId(s.config);
  if (!locationId) {
    await fail('Choose your Square location in Settings → Integrations first.');
    return;
  }
  try {
    const range = availabilityRange(search.params.fromDate, search.params.days);
    const found = await s.api.searchAvailability({
      startAt: range.start.toISOString(),
      endAt: range.end.toISOString(),
      locationId,
      serviceVariationId: search.params.serviceVariationId,
      teamMemberId: search.params.teamMemberId,
    });
    const slots: SquareAvailabilitySlot[] = [];
    for (const a of found) {
      const at = Date.parse(a.startAt);
      if (at < range.filterStart.getTime() || at >= range.filterEnd.getTime()) continue;
      const seg = a.segments[0];
      if (!seg) continue;
      slots.push({ startAt: new Date(at).toISOString(), teamMemberId: seg.teamMemberId, durationMinutes: seg.durationMinutes, serviceVariationId: seg.serviceVariationId ?? search.params.serviceVariationId, serviceVariationVersion: seg.serviceVariationVersion });
    }
    slots.sort((a, b) => a.startAt.localeCompare(b.startAt));
    await ctx.db.update(t).set({ status: 'done', slots, fetchedAt: new Date(), error: null }).where(eq(t.id, search.id));
    await run.progress(1, `Found ${slots.length} free time${slots.length === 1 ? '' : 's'}.`);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    if (err instanceof SquareApiError && err.kind === 'reauth') {
      await fail('Square needs you to reconnect.');
      return failSquareJob(ctx, run, err, 'Availability search failed');
    }
    const transient = err instanceof SquareApiError ? err.kind === 'transient' || err.kind === 'rate_limited' : !(err instanceof NonRetryableError);
    if (!transient || !run.willRetry) await fail(err instanceof SquareApiError && err.kind === 'invalid' ? err.message : AVAILABILITY_FAILED_MESSAGE);
    if (transient) throw err;
    throw err instanceof NonRetryableError ? err : new NonRetryableError('PROCESSING_FAILED', err instanceof Error ? err.message : AVAILABILITY_FAILED_MESSAGE);
  }
}
