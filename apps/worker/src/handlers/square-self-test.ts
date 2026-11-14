import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  CancelledError,
  NonRetryableError,
  availabilityRange,
  formatDateTime,
  melbourneDateOf,
  melbourneZoneLabel,
  selfTestChangeId,
  type BookingChangeKind,
  type JobPayload,
} from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { SquareApiError, isMalformedBooking } from '../square/api.js';
import { runBookingChange, type BookingChangeOptions, type BookingChangeRow } from '../square/change.js';
import { openSquare } from '../square/client.js';

/** The words of each step on the progress line ("Booking… Moving… Cancelling…"). */
const STEP_WORDS: Record<BookingChangeKind, string> = { create: 'Booking', reschedule: 'Moving', cancel: 'Cancelling' };

/**
 * `square.self_test` (design §4.5.1): the owner-approved test that books one appointment, moves it by one free slot
 * and cancels it, each step as an ordinary booking change through the same routine (and the same re-checks). It is
 * never run by a sync, a connect or a schedule. The three step rows are created by the web app when the owner
 * approves (fixed ids), so a test interrupted by a crash resumes at its first unfinished step. Even when the move
 * fails, the cancel is still attempted; a test booking that may be left in Square is reported with its time.
 * The outcome is stored in the connection's capabilities and only counts for this account and environment.
 */
export async function handleSquareSelfTest(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'square.self_test'>, opts: BookingChangeOptions = {}): Promise<void> {
  const t = schema.squareBookingChanges;
  const rows = await ctx.db.select().from(t).where(eq(t.selfTestId, payload.selfTestId));
  const step = (kind: BookingChangeKind) => rows.find((r) => r.id === selfTestChangeId(payload.selfTestId, kind)) ?? null;
  const create = step('create');
  if (!create || !step('reschedule') || !step('cancel')) {
    await run.progress(1, 'This self-test no longer exists.');
    return;
  }
  const results: Partial<Record<BookingChangeKind, BookingChangeRow>> = {};
  const runStep = async (kind: BookingChangeKind, fraction: number) => {
    await run.progress(fraction, `${STEP_WORDS[kind]}…`);
    const r = await runBookingChange(ctx, run, selfTestChangeId(payload.selfTestId, kind), opts);
    if (r) results[kind] = r;
    return r;
  };

  // 1. Book.
  const created = await runStep('create', 0.1);
  if (created?.status !== 'confirmed' || !created.squareBookingId) {
    await withdraw(ctx, payload.selfTestId, ['reschedule', 'cancel'], 'Not run: the test booking wasn’t made.');
    const maybeMade = created?.status === 'unknown' || created?.status === 'submitted';
    return record(ctx, run, payload.selfTestId, created, 'create', maybeMade ? (created?.request.startAt ?? null) : null);
  }
  const bookingId = created.squareBookingId;

  // 2. Move by one free slot (the target is chosen now, from Square's own free times for that booking).
  try {
    await prepareStep(ctx, run, payload.selfTestId, 'reschedule', bookingId);
  } catch (err) {
    if (retryable(run, err)) throw err;
    await withdraw(ctx, payload.selfTestId, ['reschedule'], 'Not run: Square didn’t answer when looking for a free time to move the test booking to.', 'failed');
  }
  const moved = await runStep('reschedule', 0.4);

  // 3. Cancel, whatever happened to the move.
  let cancelled: BookingChangeRow | null = null;
  try {
    await prepareStep(ctx, run, payload.selfTestId, 'cancel', bookingId);
    cancelled = await runStep('cancel', 0.7);
  } catch (err) {
    if (retryable(run, err)) throw err;
    await withdraw(ctx, payload.selfTestId, ['cancel'], 'Not run: Square didn’t answer when reading the test booking.', 'failed');
    cancelled = (await ctx.db.select().from(t).where(eq(t.id, selfTestChangeId(payload.selfTestId, 'cancel'))))[0] ?? null;
  }
  const failedStep: BookingChangeKind | null = moved?.status !== 'confirmed' ? 'reschedule' : cancelled?.status !== 'confirmed' ? 'cancel' : null;
  const leftover = cancelled?.status === 'confirmed' ? null : (moved?.status === 'confirmed' ? moved.request.startAt : created.request.startAt) ?? null;
  return record(ctx, run, payload.selfTestId, failedStep === 'reschedule' ? moved : failedStep === 'cancel' ? cancelled : null, failedStep, leftover);
}

/**
 * Fills a step's request just before it runs (only while it has not started): the move takes the first free time
 * after the current start with the same barber that day (or the nearest one), the cancel takes the booking's
 * current Square version.
 */
async function prepareStep(ctx: WorkerContext, run: TrackedRun, selfTestId: string, kind: 'reschedule' | 'cancel', squareBookingId: string): Promise<void> {
  const t = schema.squareBookingChanges;
  const id = selfTestChangeId(selfTestId, kind);
  const row = (await ctx.db.select().from(t).where(eq(t.id, id)).limit(1))[0];
  if (!row || row.status !== 'queued' || row.submittedAt) return;
  const s = await openSquare(ctx, run);
  if ('skip' in s) throw new NonRetryableError('CONFLICT', s.skip);
  const current = await s.api.getBooking(squareBookingId);
  if (isMalformedBooking(current)) {
    // Square still has the test booking but its copy can't be read, so neither its version nor its time is known.
    await withdraw(ctx, selfTestId, [kind], 'Not run: Square’s copy of the test booking couldn’t be read.', 'failed');
    return;
  }
  if (!current) {
    await withdraw(ctx, selfTestId, [kind], 'Not run: Square no longer has the test booking.', 'changed_in_square');
    return;
  }
  const seg = current.segments[0];
  if (kind === 'cancel') {
    await ctx.db.update(t).set({ squareBookingId, request: { ...row.request, expectedVersion: current.version }, updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.status, 'queued')));
    return;
  }
  const range = availabilityRange(melbourneDateOf(new Date(current.startAt)), 1);
  const slots = await s.api.searchAvailabilityForBooking({ startAt: range.start.toISOString(), endAt: range.end.toISOString(), bookingId: squareBookingId });
  const from = Date.parse(current.startAt);
  const same = slots.filter((x) => x.segments[0]?.teamMemberId === seg?.teamMemberId && Date.parse(x.startAt) !== from && Date.parse(x.startAt) > Date.now());
  const target = same.filter((x) => Date.parse(x.startAt) > from).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0] ?? same.sort((a, b) => Math.abs(Date.parse(a.startAt) - from) - Math.abs(Date.parse(b.startAt) - from))[0];
  const tseg = target?.segments[0];
  if (!target || !tseg) {
    await withdraw(ctx, selfTestId, ['reschedule'], 'Not run: Square had no other free time that day with the same barber to move the test booking to.', 'slot_unavailable');
    return;
  }
  await ctx.db
    .update(t)
    .set({
      squareBookingId,
      request: {
        ...row.request,
        startAt: new Date(target.startAt).toISOString(),
        teamMemberId: tseg.teamMemberId,
        serviceVariationId: tseg.serviceVariationId ?? seg?.serviceVariationId ?? undefined,
        serviceVariationVersion: tseg.serviceVariationVersion ?? seg?.serviceVariationVersion ?? null,
        durationMinutes: tseg.durationMinutes || seg?.durationMinutes,
        expectedVersion: current.version,
      },
      updatedAt: new Date(),
    })
    .where(and(eq(t.id, id), eq(t.status, 'queued')));
}

/** Closes steps that will not run, with the reason (only while they have not started). */
async function withdraw(ctx: WorkerContext, selfTestId: string, kinds: BookingChangeKind[], message: string, status: 'cancelled' | 'failed' | 'slot_unavailable' | 'changed_in_square' = 'cancelled'): Promise<void> {
  const t = schema.squareBookingChanges;
  const now = new Date();
  await ctx.db
    .update(t)
    .set({ status, statusMessage: message, finishedAt: now, updatedAt: now })
    .where(and(inArray(t.id, kinds.map((k) => selfTestChangeId(selfTestId, k))), eq(t.status, 'queued')));
}

/** Stores the outcome on the connection (only for the account and environment the test ran on) and audits it. */
async function record(ctx: WorkerContext, run: TrackedRun, selfTestId: string, failedRow: BookingChangeRow | null | undefined, failedStep: BookingChangeKind | null, leftoverAt: string | null): Promise<void> {
  const t = schema.integrationConnections;
  const first = (await ctx.db.select().from(schema.squareBookingChanges).where(eq(schema.squareBookingChanges.id, selfTestChangeId(selfTestId, 'create'))).limit(1))[0];
  const passed = failedStep === null;
  const when = leftoverAt ? new Date(leftoverAt) : null;
  const leftover = when ? ` A test booking may still be in Square for ${formatDateTime(when)} ${melbourneZoneLabel(when)}. Cancel it in Square.` : '';
  const failure = passed ? '' : `${STEP_WORDS[failedStep ?? 'create']} failed: ${failedRow?.statusMessage || 'Square didn’t confirm it.'}${leftover}`;
  const patch = {
    selfTestStatus: passed ? 'passed' : 'failed',
    selfTestId,
    selfTestAt: new Date().toISOString(),
    selfTestEnvironment: first?.environment ?? null,
    selfTestMerchantId: first?.merchantId ?? null,
    selfTestFailure: failure.slice(0, 900),
  };
  await ctx.db
    .update(t)
    .set({ capabilities: sql`${t.capabilities} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(and(eq(t.provider, 'square'), eq(t.externalAccountId, first?.merchantId ?? ''), sql`${t.config}->>'environment' = ${first?.environment ?? ''}`));
  await writeWorkerAudit(
    ctx.db,
    {
      userId: first?.requestedBy ?? null,
      action: passed ? 'integration.square.self_test_passed' : 'integration.square.self_test_failed',
      entityType: 'integration_connection',
      entityId: null,
      data: { selfTestId, environment: first?.environment ?? null, step: failedStep, code: failedRow?.errorCode ?? null, leftover: leftoverAt !== null },
    },
    ctx.logger,
  );
  await run.progress(1, passed ? 'Self-test passed: booked, moved and cancelled in Square.' : failure);
}

/** True when the queue should run the test again for this failure (it resumes at the first unfinished step). */
function retryable(run: Pick<TrackedRun, 'willRetry'>, err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  if (!run.willRetry || err instanceof NonRetryableError) return false;
  return !(err instanceof SquareApiError) || err.kind === 'transient' || err.kind === 'rate_limited';
}
