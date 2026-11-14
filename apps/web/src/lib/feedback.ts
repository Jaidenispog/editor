import 'server-only';
import { feedbackEventData, newId, type FeedbackEventInput } from '@studio/core';
import { schema, type Database } from '@studio/db';

export type { FeedbackEventInput } from '@studio/core';

/** The database or an open transaction (anything that can insert). */
type Executor = Pick<Database, 'insert'>;

/**
 * Inserts one `feedback_events` row with a plan-facts snapshot inside the caller's transaction, so the event exists
 * only if the owner's action (favourite, download, revise, regenerate, dismiss, publish) is saved too. Returns the
 * new event id. The preferences package (WP2) adds the debounced recompute after commit.
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
