/**
 * Genuine completion of an appointment (shared by the Square and email/review modules).
 *
 * The Square module decides completion from Square's booking status, payments and the owner's attendance marks
 * (`deriveCompletion`) and stores the outcome in `bookings.completion_source` / `bookings.completed_at`. Every
 * consumer checks those stored values with this one function, and checks again at send time. The start time
 * passing is never evidence, and `square_status` is never accepted because Square has no "completed" status.
 */

/** Completion sources that count as real evidence that the client attended. */
export const GENUINE_COMPLETION_SOURCES = ['payment', 'owner_marked'] as const;
export type GenuineCompletionSource = (typeof GENUINE_COMPLETION_SOURCES)[number];

/** The stored booking columns this check reads. */
export interface StoredCompletion {
  /** Square's booking status, stored verbatim (e.g. `ACCEPTED`, `NO_SHOW`). */
  status: string;
  /** `bookings.completion_source`: `none`, `payment`, `owner_marked` (or the legacy, never-accepted `square_status`). */
  completionSource: string;
  /** `bookings.completed_at`, set together with the source. */
  completedAt: Date | null;
}

/**
 * True only when Square still shows the booking as `ACCEPTED`, a genuine source (a matched payment or the owner's
 * "Mark as completed") was stored, and the completion time is set.
 */
export function isGenuinelyCompleted(b: StoredCompletion): boolean {
  return b.status === 'ACCEPTED' && (GENUINE_COMPLETION_SOURCES as readonly string[]).includes(b.completionSource) && b.completedAt !== null;
}
