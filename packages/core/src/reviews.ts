import { z } from 'zod';
import { isGenuinelyCompleted } from './completion.js';
import { bookingBlock, validateReviewLinkShape } from './email.js';
import { isMelbourneDate } from './time.js';

/**
 * Review requests (email design §3.6, §3.8, §4.3). Uniform requests only: eligibility takes no satisfaction, spend,
 * rating, feedback, notes or staff input (Google policy and the ACCC; memo §7). A request is evidence of what the
 * app sent and whether the link was opened; it is never matched to a review.
 */

export const REVIEW_REQUEST_STATUSES = ['pending_approval', 'scheduled', 'sent', 'skipped', 'failed', 'cancelled'] as const;
export type ReviewRequestStatus = (typeof REVIEW_REQUEST_STATUSES)[number];

/** Why a client was not asked. Fixed list; there is deliberately no "client unhappy" reason. */
export const REVIEW_SKIP_REASONS = [
  'no_email',
  'opted_out',
  'recently_asked',
  'no_review_link',
  'no_consent',
  'unsubscribed',
  'suppressed',
  'booking_cancelled',
  'booking_no_show',
  'not_completed',
  'asked_in_person',
  'wrong_client_details',
  'other',
] as const;
export type ReviewSkipReason = (typeof REVIEW_SKIP_REASONS)[number];
/** The reasons the owner may pick when skipping by hand. */
export const OWNER_SKIP_REASONS = ['asked_in_person', 'wrong_client_details', 'other'] as const;

/** Plain words for each skip reason. */
export const REVIEW_SKIP_LABELS: Record<ReviewSkipReason, string> = {
  no_email: 'No email address',
  opted_out: 'Asked not to get review requests',
  recently_asked: 'Already asked recently',
  no_review_link: 'No review link saved',
  no_consent: 'No email permission recorded',
  unsubscribed: 'Unsubscribed',
  suppressed: 'Bounced or spam complaint',
  booking_cancelled: 'Appointment cancelled',
  booking_no_show: 'Marked as a no-show',
  not_completed: 'Appointment not completed',
  asked_in_person: 'Asked in person',
  wrong_client_details: 'Wrong client details',
  other: 'Other',
};

/** Validated review link: the app never builds Google URLs, it only accepts what the owner pastes (memo §7). */
export function validateReviewLink(url: string): { valid: boolean; message: string | null } {
  const v = url.trim();
  if (!v) return { valid: false, message: 'Paste the link from Google Business Profile → Read reviews → Get more reviews.' };
  if (v.length > 500) return { valid: false, message: 'That link is too long.' };
  if (!validateReviewLinkShape(v)) return { valid: false, message: "That doesn't look like a Google review link. It should start with https:// and come from Google (for example g.page or search.google.com)." };
  return { valid: true, message: null };
}

/** The evidence that the appointment went ahead: a stored booking completion or the owner's attestation. */
export type CompletionEvidence =
  | { kind: 'booking'; booking: { status: string; completionSource: string; completedAt: Date | null } }
  | { kind: 'attestation'; visitDate: string; attestedBy: string };

/**
 * Everything eligibility may look at. Pinned by {@link REVIEW_ELIGIBILITY_INPUT_KEYS} and a unit test: no rating,
 * spend, feedback, notes, staff or satisfaction field may ever be added (that would be review gating).
 */
export interface ReviewEligibilityInput {
  evidence: CompletionEvidence;
  /** Automation only: when the switch was turned on and how far back completions count. Null for manual requests. */
  automation: { enabledAt: Date | null; maxAgeDays: number } | null;
  customer: { deleted: boolean; email: string | null; reviewRequestsOptOut: boolean } | null;
  /** When a review request was last actually sent to this client (null = never). */
  lastRequestSentAt: Date | null;
  minDaysBetweenRequests: number;
  reviewLink: string;
  /** The email gate's consent and suppression answer for the client's address (null = may send). */
  marketingBlock: 'no_consent' | 'unsubscribed' | 'suppressed' | null;
  now: Date;
}

/** The only keys eligibility accepts (runtime pin; extra keys throw). */
export const REVIEW_ELIGIBILITY_INPUT_KEYS = ['evidence', 'automation', 'customer', 'lastRequestSentAt', 'minDaysBetweenRequests', 'reviewLink', 'marketingBlock', 'now'] as const;
type PinnedKeys = (typeof REVIEW_ELIGIBILITY_INPUT_KEYS)[number];
// Compile-time pin: both directions must be `never`, so the interface and the list cannot drift apart.
type _NoExtraKeys = Exclude<keyof ReviewEligibilityInput, PinnedKeys> extends never ? true : never;
type _NoMissingKeys = Exclude<PinnedKeys, keyof ReviewEligibilityInput> extends never ? true : never;
const _pinned: [_NoExtraKeys, _NoMissingKeys] = [true, true];
void _pinned;

export type ReviewEligibility = { eligible: true } | { eligible: false; skipReason: ReviewSkipReason };

const DAY_MS = 24 * 3600_000;

/** Review eligibility, checked in the design's order (§3.6). The start time passing is never evidence. */
export function reviewEligibility(input: ReviewEligibilityInput): ReviewEligibility {
  for (const key of Object.keys(input)) {
    if (!(REVIEW_ELIGIBILITY_INPUT_KEYS as readonly string[]).includes(key)) throw new Error(`reviewEligibility does not accept "${key}" (requests must be uniform)`);
  }
  const { evidence, now } = input;
  // 1. Evidence.
  let completedAt: Date | null = null;
  if (evidence.kind === 'booking') {
    const block = bookingBlock(evidence.booking);
    if (block === 'booking_cancelled') return { eligible: false, skipReason: 'booking_cancelled' };
    if (block === 'booking_no_show') return { eligible: false, skipReason: 'booking_no_show' };
    if (!isGenuinelyCompleted(evidence.booking)) return { eligible: false, skipReason: 'not_completed' };
    completedAt = evidence.booking.completedAt;
  } else if (!evidence.attestedBy || !isMelbourneDate(evidence.visitDate)) {
    return { eligible: false, skipReason: 'not_completed' };
  }
  // 2. Automation: only completions after the switch was turned on, and recent ones (no back-catalogue blast).
  if (input.automation) {
    if (!completedAt || !input.automation.enabledAt) return { eligible: false, skipReason: 'not_completed' };
    if (completedAt.getTime() < input.automation.enabledAt.getTime()) return { eligible: false, skipReason: 'not_completed' };
    if (completedAt.getTime() < now.getTime() - input.automation.maxAgeDays * DAY_MS) return { eligible: false, skipReason: 'not_completed' };
  }
  // 3–6.
  if (!input.customer || input.customer.deleted || !input.customer.email?.trim()) return { eligible: false, skipReason: 'no_email' };
  if (input.customer.reviewRequestsOptOut) return { eligible: false, skipReason: 'opted_out' };
  if (input.lastRequestSentAt && input.lastRequestSentAt.getTime() > now.getTime() - input.minDaysBetweenRequests * DAY_MS) return { eligible: false, skipReason: 'recently_asked' };
  if (!validateReviewLink(input.reviewLink).valid) return { eligible: false, skipReason: 'no_review_link' };
  // 7. The send gate's consent and suppression answer.
  if (input.marketingBlock) return { eligible: false, skipReason: input.marketingBlock };
  return { eligible: true };
}

/** Request schemas for the review routes (design §7.4). */
export const CreateReviewRequestSchema = z.object({
  customerId: z.string().min(1),
  visitDate: z.string().refine(isMelbourneDate, 'Use a date like 2026-11-14.'),
  attest: z.literal(true),
});
export const SkipReviewRequestSchema = z
  .object({ reason: z.enum(OWNER_SKIP_REASONS), note: z.string().trim().max(500).optional() })
  .refine((v) => v.reason !== 'other' || Boolean(v.note && v.note.length >= 3), { message: 'Add a short note when the reason is "Other".', path: ['note'] });
export const ReviewLinkSchema = z.object({ url: z.string().trim().max(500) });
export const PlaceIdSchema = z.object({ placeId: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/, 'That Place ID looks wrong. Copy it from Google’s Place ID Finder.') });
export const ConfirmPlaceSchema = z.object({ confirm: z.boolean() });
