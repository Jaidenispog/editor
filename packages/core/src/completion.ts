/**
 * Genuine completion of an appointment (shared by the Square and email/review modules).
 *
 * The Square module decides completion from Square's booking status, payments and the owner's attendance marks
 * (`deriveCompletion`) and stores the outcome in `bookings.completion_source` / `bookings.completed_at`. Every
 * consumer checks those stored values with this one function, and checks again at send time. The start time
 * passing is never evidence, and `square_status` is never accepted because Square has no "completed" status.
 *
 * Only bookings copied from LIVE Square (`square_environment = 'production'`) can ever count: sandbox bookings are
 * test data, so a test booking marked attended or matched to a test payment never triggers a real email or review
 * request (the Square module stores no completion for them, and every consumer checks the environment again).
 */

/** The only Square environment whose bookings can count as real visits. */
export const GENUINE_COMPLETION_ENVIRONMENT = 'production' as const;

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
  /** `bookings.square_environment`: only `production` (live Square) can count; `sandbox` is test data. */
  squareEnvironment: string;
}

/**
 * True only when the booking came from live Square, Square still shows it as `ACCEPTED`, a genuine source (a matched
 * payment or the owner's "Mark as completed") was stored, and the completion time is set.
 */
export function isGenuinelyCompleted(b: StoredCompletion): boolean {
  return b.squareEnvironment === GENUINE_COMPLETION_ENVIRONMENT && b.status === 'ACCEPTED' && (GENUINE_COMPLETION_SOURCES as readonly string[]).includes(b.completionSource) && b.completedAt !== null;
}
