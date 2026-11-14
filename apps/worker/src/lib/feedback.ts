import { feedbackEventData, newId, type FeedbackEventInput } from '@studio/core';
import { schema } from '@studio/db';
import type { DbExecutor } from './audit.js';

/**
 * Inserts one `feedback_events` row with a plan-facts snapshot, inside the caller's transaction (worker twin of
 * apps/web/src/lib/feedback.ts; publishing writes `publish` events from the worker when a post is confirmed).
 * If the transaction rolls back, the event is gone with it. Returns the new event id.
 */
export async function recordFeedback(tx: DbExecutor, event: FeedbackEventInput): Promise<string> {
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
