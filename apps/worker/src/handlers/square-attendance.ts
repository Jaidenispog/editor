import type { JobPayload } from '@studio/core';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { runAttendance } from '../square/attendance.js';
import { failSquareJob, openSquare } from '../square/client.js';

/**
 * `square.attendance`: matches Square payments to finished bookings and stores the attendance estimate and genuine
 * completion (design §4.7). Read-only towards Square; safe to run again.
 */
export async function handleSquareAttendance(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.attendance'>): Promise<void> {
  try {
    const s = await openSquare(ctx, run);
    if ('skip' in s) {
      await run.progress(1, s.skip);
      return;
    }
    const r = await runAttendance(ctx, run, s, {
      squareCustomerId: payload.squareCustomerId,
      from: payload.fromIso ? new Date(payload.fromIso) : undefined,
      to: payload.toIso ? new Date(payload.toIso) : undefined,
    });
    await run.progress(1, `Checked ${r.candidates} finished booking${r.candidates === 1 ? '' : 's'} against ${r.payments} Square payment${r.payments === 1 ? '' : 's'}.`);
  } catch (err) {
    await failSquareJob(ctx, run, err, 'Payment check failed');
  }
}
