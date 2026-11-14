import type { JobPayload } from '@studio/core';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { failSquareJob, openSquare } from '../square/client.js';
import { runSquareSync } from '../square/sync.js';

/**
 * `square.sync`: copies bookings, customers and services from Square (design §6). Completes without calling Square
 * when it is not connected or set to the other environment. Never writes to Square.
 */
export async function handleSquareSync(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.sync'>): Promise<void> {
  const s = await openSquare(ctx, run);
  if ('skip' in s) {
    await run.progress(1, s.skip);
    return;
  }
  try {
    const r = await runSquareSync(ctx, run, s, payload.reason);
    const changed = r.bookings.inserted + r.bookings.updated;
    await run.progress(1, `Synced with Square: ${changed} booking${changed === 1 ? '' : 's'} added or changed${r.missing ? `, ${r.missing} no longer in Square` : ''}.`);
  } catch (err) {
    await failSquareJob(ctx, run, err, 'Square sync failed');
  }
}
