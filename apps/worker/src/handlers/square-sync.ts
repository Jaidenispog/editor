import type { JobPayload } from '@studio/core';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { failSquareJob, openSquare } from '../square/client.js';
import { SquareConnectionChangedError } from '../square/map.js';
import { runSquareSync } from '../square/sync.js';

/**
 * `square.sync`: copies bookings, customers and services from Square (design §6). Completes without calling Square
 * when it is not connected or set to the other environment. Never writes to Square. Opening the connection (and its
 * token refresh) is inside the error handling, so its failures reach the card like any other.
 */
export async function handleSquareSync(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.sync'>): Promise<void> {
  try {
    const s = await openSquare(ctx, run);
    if ('skip' in s) {
      await run.progress(1, s.skip);
      return;
    }
    const r = await runSquareSync(ctx, run, s, payload.reason);
    const changed = r.bookings.inserted + r.bookings.updated;
    if (r.needsLocation) {
      await run.progress(1, 'Your Square account has more than one location. Choose your studio’s location in Settings → Integrations; bookings are copied once you do.');
      return;
    }
    await run.progress(1, `Synced with Square: ${changed} booking${changed === 1 ? '' : 's'} added or changed${r.missing ? `, ${r.missing} no longer in Square` : ''}.`);
  } catch (err) {
    if (err instanceof SquareConnectionChangedError) {
      await run.progress(1, err.message);
      return;
    }
    await failSquareJob(ctx, run, err, 'Square sync failed');
  }
}
