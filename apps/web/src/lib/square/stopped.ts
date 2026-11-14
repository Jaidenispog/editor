import 'server-only';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { selfTestChangeId, selfTestFailureText, selfTestSummary } from '@studio/core';
import { schema, type Database } from '@studio/db';
import { writeAudit } from '../audit.js';

/**
 * Closes booking changes and self-tests whose job ended without the worker closing them: the owner cancelled the job
 * before the worker picked it up, or the worker died on the last attempt (restart recovery marks the job failed). The
 * worker closes everything it sees stop; these cover the cases it never sees, so nothing shows "waiting" or "checking"
 * for ever and a new change or test is not refused because of a stopped one. Each update only applies while the row is
 * still unfinished and nothing was sent (`submitted_at` is null), so it never overwrites a result the worker wrote.
 */

const NOTHING_SENT = 'Stopped before anything was sent to Square.';
const SENT_UNKNOWN = 'Stopped after sending to Square. Square may or may not have made this change; Studio Assistant checks at the next sync.';

type ChangeRow = typeof schema.squareBookingChanges.$inferSelect;

/** The latest tracked job of a type for an entity, or null. */
async function latestJobStatus(db: Database, type: 'square.booking_change' | 'square.self_test', refId: string): Promise<string | null> {
  const j = schema.jobs;
  const job = (await db.select({ status: j.status }).from(j).where(and(eq(j.type, type), eq(j.refId, refId))).orderBy(desc(j.createdAt)).limit(1))[0];
  return job?.status ?? null;
}

/**
 * A change still `queued`, or `checking` with nothing sent, whose `square.booking_change` job was cancelled or failed:
 * a queued change is withdrawn (`cancelled`); a change the worker had started checking is `cancelled` when the owner
 * stopped the job and `failed` when the job failed. Returns the row as it now stands.
 */
export async function settleStoppedChange(db: Database, row: ChangeRow, now: Date = new Date()): Promise<ChangeRow> {
  if (row.selfTestId || row.submittedAt || (row.status !== 'queued' && row.status !== 'checking')) return row;
  const job = await latestJobStatus(db, 'square.booking_change', row.id);
  if (job !== 'cancelled' && job !== 'failed') return row;
  const t = schema.squareBookingChanges;
  const status = row.status === 'queued' || job === 'cancelled' ? 'cancelled' : 'failed';
  const updated = await db
    .update(t)
    .set({ status, statusMessage: NOTHING_SENT, finishedAt: now, updatedAt: now })
    .where(and(eq(t.id, row.id), eq(t.status, row.status), isNull(t.submittedAt)))
    .returning();
  return updated[0] ?? (await db.select().from(t).where(eq(t.id, row.id)).limit(1))[0] ?? row;
}

/** Withdraws the queued change a cancelled-before-it-started `square.booking_change` job was for (nothing was sent). */
export async function withdrawChangeOfCancelledJob(db: Database, changeId: string, now: Date = new Date()): Promise<void> {
  const t = schema.squareBookingChanges;
  await db.update(t).set({ status: 'cancelled', statusMessage: NOTHING_SENT, finishedAt: now, updatedAt: now }).where(and(eq(t.id, changeId), eq(t.status, 'queued'), isNull(t.submittedAt)));
}

/**
 * A self-test whose `square.self_test` job was cancelled or failed while a step was unfinished: steps not sent are
 * withdrawn, a step sent without an answer becomes `unknown`, and, while the connection still shows this test as
 * running, the outcome is recorded as failed (with the time of a test booking that may still be in Square). With
 * `force`, the job's status is not looked up (the caller knows it was cancelled before it started).
 */
export async function settleStoppedSelfTest(db: Database, selfTestId: string | null, now: Date = new Date(), force = false): Promise<boolean> {
  if (!selfTestId) return false;
  const t = schema.squareBookingChanges;
  const c = schema.integrationConnections;
  const runningHere = and(eq(c.provider, 'square'), sql`${c.capabilities}->>'selfTestStatus' = 'running'`, sql`${c.capabilities}->>'selfTestId' = ${selfTestId}`);
  const rows = await db.select().from(t).where(eq(t.selfTestId, selfTestId));
  const unfinished = rows.some((r) => r.status === 'queued' || r.status === 'checking' || r.status === 'submitted');
  // Also a test whose steps all finished but whose outcome was never recorded (the worker died just before).
  if (!unfinished && !(await db.select({ id: c.id }).from(c).where(runningHere).limit(1)).length) return false;
  if (!force) {
    const job = await latestJobStatus(db, 'square.self_test', selfTestId);
    if (job !== 'cancelled' && job !== 'failed') return false;
  }
  const ids = (['create', 'reschedule', 'cancel'] as const).map((k) => selfTestChangeId(selfTestId, k));
  await db.update(t).set({ status: 'cancelled', statusMessage: NOTHING_SENT, finishedAt: now, updatedAt: now }).where(and(inArray(t.id, ids), inArray(t.status, ['queued', 'checking']), isNull(t.submittedAt)));
  await db.update(t).set({ status: 'unknown', statusMessage: SENT_UNKNOWN, finishedAt: now, updatedAt: now }).where(and(inArray(t.id, ids), eq(t.status, 'submitted')));
  const steps = await db.select().from(t).where(eq(t.selfTestId, selfTestId));
  const summary = selfTestSummary(steps.map((r) => ({ kind: r.kind, status: r.status, statusMessage: r.statusMessage, startAt: r.request.startAt ?? null })));
  const first = steps.find((r) => r.kind === 'create');
  // A test that stopped is never recorded as passed, even when its three steps happened to finish.
  const failure = summary.failedStep ? selfTestFailureText(summary.failedStep, summary.failedMessage, summary.leftoverAt) : 'The self-test stopped before its outcome was recorded. Run it again.';
  const patch = { selfTestStatus: 'failed', selfTestAt: now.toISOString(), selfTestEnvironment: first?.environment ?? null, selfTestMerchantId: first?.merchantId ?? null, selfTestFailure: failure.slice(0, 900) };
  const updated = await db
    .update(c)
    .set({ capabilities: sql`${c.capabilities} || ${JSON.stringify(patch)}::jsonb`, updatedAt: now })
    .where(runningHere)
    .returning({ id: c.id });
  if (updated.length) {
    await writeAudit({
      userId: null,
      action: 'integration.square.self_test_failed',
      entityType: 'integration_connection',
      entityId: updated[0]?.id ?? null,
      data: { selfTestId, environment: first?.environment ?? null, step: summary.failedStep, stopped: true, leftover: summary.leftoverAt.length > 0 },
    });
  }
  return true;
}
