import { and, eq, inArray } from 'drizzle-orm';
import { CancelledError, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { stopOutcome, type TrackedRun } from '../lib/job-tracker.js';
import { changeOutcomeMessage, runBookingChange, type BookingChangeOptions } from '../square/change.js';

/**
 * `square.booking_change` (design §6.3): runs one owner-approved create, reschedule or cancel through the
 * booking-change routine, the only code that writes to Square. When the run is stopped before anything was sent, the
 * change is withdrawn; once it was sent, a stop on the last attempt leaves it `unknown` for the next sync to settle.
 */
export async function handleSquareBookingChange(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.booking_change'>, opts: BookingChangeOptions = {}): Promise<void> {
  try {
    const row = await runBookingChange(ctx, run, payload.changeId, opts);
    await run.progress(1, row ? changeOutcomeMessage(row) : 'This booking change no longer exists.');
  } catch (err) {
    if (err instanceof CancelledError && (await stopOutcome(run)) !== 'resume') {
      const t = schema.squareBookingChanges;
      const now = new Date();
      // Stopped while checking: nothing was sent. Stopped after sending: Square may have it (the sync settles it).
      await ctx.db.update(t).set({ status: 'cancelled', statusMessage: 'Stopped before anything was sent to Square.', finishedAt: now, updatedAt: now }).where(and(eq(t.id, payload.changeId), inArray(t.status, ['queued', 'checking'])));
      await ctx.db
        .update(t)
        .set({ status: 'unknown', statusMessage: 'Stopped after sending to Square. Square may or may not have made this change; Studio Assistant checks at the next sync.', finishedAt: now, updatedAt: now })
        .where(and(eq(t.id, payload.changeId), eq(t.status, 'submitted')));
    }
    throw err;
  }
}
