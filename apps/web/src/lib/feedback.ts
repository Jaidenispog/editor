import 'server-only';
import { PREFERENCES_RECOMPUTE_DELAY_SEC, PREFERENCES_RECOMPUTE_KEY, feedbackEventData, newId, type FeedbackEventInput } from '@studio/core';
import { schema, type Database } from '@studio/db';
import { createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';

export type { FeedbackEventInput } from '@studio/core';

/** The database or an open transaction (anything that can insert). */
type Executor = Pick<Database, 'insert'>;

/**
 * Inserts one `feedback_events` row with a plan-facts snapshot inside the caller's transaction, so the event exists
 * only if the owner's action (favourite, download, revise, regenerate, dismiss, publish) is saved too. Returns the
 * new event id. Call {@link scheduleRecompute} after the transaction commits.
 */
export async function recordFeedback(tx: Executor, event: FeedbackEventInput): Promise<string> {
  const id = newId();
  await tx.insert(schema.feedbackEvents).values({
    id,
    userId: event.userId,
    projectId: event.projectId,
    editId: event.editId,
    editVersionId: event.editVersionId,
    styleId: event.styleId,
    type: event.type,
    data: feedbackEventData(event),
  });
  return id;
}

/**
 * Queues a debounced `preferences.recompute` (10 s, one at a time). A failure to queue is logged and never fails the
 * owner's action: the nightly recompute catches up.
 */
export async function scheduleRecompute(reason: 'feedback' | 'reset' | 'settings' = 'feedback'): Promise<void> {
  try {
    await createTrackedJob({
      type: 'preferences.recompute',
      payload: { reason },
      singletonKey: PREFERENCES_RECOMPUTE_KEY,
      startAfterSeconds: reason === 'feedback' ? PREFERENCES_RECOMPUTE_DELAY_SEC : 0,
    });
  } catch (err) {
    getLogger().warn({ err, reason }, 'could not queue a preferences recompute; the nightly run will catch up');
  }
}

/** Records one feedback event outside any other write, then schedules the recompute. Never throws. */
export async function recordFeedbackNow(db: Executor, event: FeedbackEventInput): Promise<void> {
  try {
    await recordFeedback(db, event);
  } catch (err) {
    getLogger().warn({ err, type: event.type, editVersionId: event.editVersionId }, 'could not record feedback');
    return;
  }
  await scheduleRecompute();
}
