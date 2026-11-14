import { z } from 'zod';
import {
  type SquareCapabilities,
  type SquareEnvironmentName,
  type SquareServiceLabel,
  type SquareTier1Status,
} from './square.js';
import { formatDateTime, melbourneZoneLabel } from './time.js';

/**
 * Square booking changes (Tier 1, WP6b; design `docs/design/square-appointments.md` §4.5–4.6, §5.3, §6.3). Every
 * change is one owner-approved `square_booking_changes` row processed by `square.booking_change`, the only code that
 * writes to Square. Nothing here talks to Square or the database: these are the contracts and pure rules shared by
 * the web app (which records the owner's approval) and the worker (which re-checks everything just before sending).
 */

/** What a change does in Square. */
export const BOOKING_CHANGE_KINDS = ['create', 'reschedule', 'cancel'] as const;
export const BookingChangeKindSchema = z.enum(BOOKING_CHANGE_KINDS);
export type BookingChangeKind = z.infer<typeof BookingChangeKindSchema>;

/**
 * Where a change is up to:
 * - `queued`: approved, waiting for the worker (the owner may still cancel it);
 * - `checking`: the worker is re-checking the plan, service, booking and time;
 * - `submitted`: sent to Square (the non-repeatable marker `submitted_at` is set), no answer recorded yet;
 * - `confirmed`: Square confirmed it (the only state shown as "done");
 * - `slot_unavailable`: the time was taken; nothing was sent;
 * - `changed_in_square`: the booking changed in Square since the owner looked; nothing was sent;
 * - `not_allowed`: the plan, permissions, service or switch do not allow it (or Square refused for that reason);
 * - `rejected`: Square refused the request (its message is stored verbatim);
 * - `unknown`: sent, but Square's answer never arrived; the next sync settles it;
 * - `failed`: Square could not be reached while checking (after the retries); nothing was sent;
 * - `cancelled`: the owner withdrew it before the worker started, or Square was disconnected.
 */
export const BOOKING_CHANGE_STATUSES = [
  'queued',
  'checking',
  'submitted',
  'confirmed',
  'slot_unavailable',
  'changed_in_square',
  'not_allowed',
  'rejected',
  'unknown',
  'failed',
  'cancelled',
] as const;
export type BookingChangeStatus = (typeof BOOKING_CHANGE_STATUSES)[number];

/** Statuses after which the worker never touches the row again (`unknown` is only settled by a later sync). */
export const FINAL_BOOKING_CHANGE_STATUSES: readonly BookingChangeStatus[] = ['confirmed', 'slot_unavailable', 'changed_in_square', 'not_allowed', 'rejected', 'unknown', 'failed', 'cancelled'];

/** True for a status the worker is finished with. */
export function isFinalChangeStatus(status: string): boolean {
  return (FINAL_BOOKING_CHANGE_STATUSES as readonly string[]).includes(status);
}

/** Square's limit for a seller note (CreateBooking `seller_note`). */
export const SQUARE_SELLER_NOTE_MAX = 4096;
/** A slot from an availability search may be used for a change only while the search is this fresh. */
export const SQUARE_SLOT_FRESH_MS = 5 * 60_000;
/** The self-test books at least this far ahead, so a real client is never offered the test time at short notice. */
export const SQUARE_SELF_TEST_MIN_LEAD_MS = 48 * 3600_000;
/** At most this many alternative times are kept when the time was taken. */
export const SQUARE_FRESH_SLOTS_MAX = 20;
/** An `unknown` change that a sync cannot find in Square after this long is reported as probably not made. */
export const SQUARE_UNKNOWN_GIVE_UP_MS = 24 * 3600_000;

/**
 * What the owner approved (`square_booking_changes.request`). For a create or reschedule, the segment fields are
 * copied from the slot Square returned, so the request the worker sends is fixed at approval and identical on every
 * retry (same idempotency key, same body).
 */
export const BookingChangeRequestSchema = z.object({
  locationId: z.string().min(1).max(192),
  squareCustomerId: z.string().min(1).max(192).optional(),
  serviceVariationId: z.string().min(1).max(192).optional(),
  /** Square's int64 catalogue version as a string. */
  serviceVariationVersion: z.string().max(40).nullable().optional(),
  teamMemberId: z.string().min(1).max(192).optional(),
  durationMinutes: z.number().int().min(1).max(24 * 60).optional(),
  /** An exact instant Square returned as free (never converted from a local time). */
  startAt: z.string().datetime({ offset: true }).optional(),
  /** The booking's Square version the owner saw (reschedule and cancel). */
  expectedVersion: z.number().int().min(0).optional(),
  sellerNote: z.string().max(SQUARE_SELLER_NOTE_MAX).optional(),
  availabilitySearchId: z.string().min(1).max(64).optional(),
});
export type BookingChangeRequest = z.infer<typeof BookingChangeRequestSchema>;

/** One alternative time found by the re-check (`square_booking_changes.fresh_slots`). */
export interface BookingChangeFreshSlot {
  startAt: string;
  teamMemberId: string;
  durationMinutes: number;
}

/** The idempotency key sent to Square for a change: stable across every retry, never holds a token (≤ 255 chars). */
export function bookingChangeIdempotencyKey(changeId: string): string {
  return `sabc_${changeId}`;
}

/** Plain words for a change's status (the pill uses an existing status word for its colour). */
export function bookingChangeStatusWords(status: string): { label: string; pill: string; done: boolean } {
  switch (status) {
    case 'queued':
      return { label: 'Waiting to start', pill: 'queued', done: false };
    case 'checking':
      return { label: 'Checking the time is still free…', pill: 'checking', done: false };
    case 'submitted':
      return { label: 'Sending to Square…', pill: 'processing', done: false };
    case 'confirmed':
      return { label: 'Done in Square', pill: 'ok', done: true };
    case 'slot_unavailable':
      return { label: 'That time was just taken', pill: 'check_before_retry', done: true };
    case 'changed_in_square':
      return { label: 'The booking changed in Square', pill: 'check_before_retry', done: true };
    case 'not_allowed':
      return { label: 'Not allowed by Square', pill: 'failed', done: true };
    case 'rejected':
      return { label: 'Square refused it', pill: 'failed', done: true };
    case 'unknown':
      return { label: 'Couldn’t confirm with Square', pill: 'check_before_retry', done: true };
    case 'failed':
      return { label: 'Couldn’t check with Square', pill: 'failed', done: true };
    case 'cancelled':
      return { label: 'Withdrawn', pill: 'cancelled', done: true };
    default:
      return { label: status, pill: 'none', done: true };
  }
}

/** What happened, in one plain sentence per kind once Square confirmed it. */
export function confirmedSentence(kind: BookingChangeKind): string {
  return kind === 'create' ? 'Booked in Square.' : kind === 'reschedule' ? 'Moved in Square.' : 'Cancelled in Square.';
}

/**
 * The sentence about client notifications (design §4.9). Whether Square tells the client about a change an app made
 * is not documented, so it comes from the owner's answer after the self-test.
 */
export function squareNotificationSentence(answer: SquareCapabilities['squareNotifiesApiBookings']): string {
  if (answer === 'yes') return 'Square will send its usual confirmation.';
  if (answer === 'no') return 'Square didn’t send a confirmation for the test booking, so let the client know yourself.';
  return 'Square decides whether the client is notified.';
}

/**
 * Why a change cannot be made right now, or null when the checklist allows it (shared by the web app and worker).
 * Line 3 (a bookable service) is about booking a service, so it does not apply to a cancel: a cancel never books
 * anything, and the self-test's clean-up cancel must still be sent after Square refused the move for the only
 * confirmed service (design §4.5.1 step 8).
 */
export function writeGateReason(input: { tier1: SquareTier1Status; selfTest: boolean; kind?: BookingChangeKind | undefined }): string | null {
  const t = input.tier1;
  if (!t.available) return 'Booking changes from Studio Assistant aren’t available yet. Make changes in Square.';
  if (t.suspendedReason) return suspensionWords(t.suspendedReason);
  if (t.checklist.plan !== 'ok') return 'Your Square Appointments plan doesn’t allow apps to change bookings.';
  if (t.checklist.scopes !== 'ok') return 'Studio Assistant doesn’t have permission to change bookings. Press “Give permission” in Settings → Integrations → Square.';
  if (t.checklist.bookableService !== 'ok' && input.kind !== 'cancel') return 'No service is confirmed as free of no-show fees yet.';
  if (input.selfTest) return null;
  if (t.checklist.selfTest !== 'ok') return 'The self-test hasn’t passed on this Square account yet.';
  if (t.checklist.switch !== 'ok') return 'Booking changes are switched off in Settings → Integrations → Square.';
  return null;
}

/** Plain words for why booking changes were paused. */
export function suspensionWords(reason: string): string {
  switch (reason) {
    case 'plan':
      return 'Paused: Square refused because of your Appointments plan.';
    case 'scopes':
      return 'Paused: Square says Studio Assistant no longer has permission to change bookings. Press “Give permission” again.';
    case 'forbidden':
      return 'Paused: Square refused a change. Check your Square plan and permissions.';
    case 'env_changed':
      return 'Paused: Studio Assistant was switched to the other Square environment.';
    default:
      return 'Paused.';
  }
}

/** True when the self-test may be started: Tier 1 exists and checklist lines 1–3 are ticked (design §4.5.1). */
export function selfTestAllowed(tier1: SquareTier1Status): boolean {
  return tier1.available && tier1.suspendedReason === '' && tier1.checklist.plan === 'ok' && tier1.checklist.scopes === 'ok' && tier1.checklist.bookableService === 'ok';
}

/** An action on one booking, with the reason when it is not offered. */
export interface BookingActionAllowance {
  allowed: boolean;
  reason: string | null;
}

/**
 * Which change buttons a booking gets (design §4.6): Move needs Square's ACCEPTED status, a future start and a
 * bookable service; Cancel needs ACCEPTED and a future start. Owner only, and only while Tier 1 is ready. PENDING
 * requests are accepted or declined in Square; no-shows, deposits and fee-bearing services always stay in Square.
 */
export function bookingActions(input: {
  tier1Ready: boolean;
  owner: boolean;
  status: string;
  startAt: Date;
  missingFromSquare: boolean;
  serviceLabel: SquareServiceLabel | null;
  now: Date;
}): { move: BookingActionAllowance; cancel: BookingActionAllowance } {
  const no = (reason: string): BookingActionAllowance => ({ allowed: false, reason });
  if (!input.owner) return { move: no('Only the owner can change bookings.'), cancel: no('Only the owner can change bookings.') };
  if (!input.tier1Ready) {
    const r = 'Make this change in Square: booking changes from Studio Assistant are not switched on.';
    return { move: no(r), cancel: no(r) };
  }
  if (input.missingFromSquare) return { move: no('Square no longer has this booking.'), cancel: no('Square no longer has this booking.') };
  if (input.status === 'PENDING') return { move: no('Accept or decline this request in Square first.'), cancel: no('Accept or decline this request in Square.') };
  if (input.status !== 'ACCEPTED') return { move: no('Only accepted bookings can be changed.'), cancel: no('Only accepted bookings can be cancelled.') };
  if (input.startAt.getTime() <= input.now.getTime()) return { move: no('This appointment has already started.'), cancel: no('This appointment has already started.') };
  const cancel: BookingActionAllowance = { allowed: true, reason: null };
  if (input.serviceLabel !== 'bookable') {
    return { move: no('Move this booking in Square: its service isn’t confirmed as bookable from Studio Assistant.'), cancel };
  }
  return { move: { allowed: true, reason: null }, cancel };
}

/** The up to {@link SQUARE_FRESH_SLOTS_MAX} slots nearest to the requested time, in time order. */
export function nearestSlots<T extends { startAt: string }>(slots: readonly T[], requestedAt: string, max: number = SQUARE_FRESH_SLOTS_MAX): T[] {
  const target = Date.parse(requestedAt);
  return [...slots]
    .sort((a, b) => Math.abs(Date.parse(a.startAt) - target) - Math.abs(Date.parse(b.startAt) - target))
    .slice(0, max)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
}

/** The three steps of the self-test, in order. */
export const SELF_TEST_STEPS: readonly BookingChangeKind[] = ['create', 'reschedule', 'cancel'];

/** The self-test's step rows have fixed ids, so a crashed test resumes at the first unfinished step. */
export function selfTestChangeId(selfTestId: string, kind: BookingChangeKind): string {
  return `${selfTestId}-${kind}`;
}

/** True when the stored self-test belongs to this connection (it counts only for the same account and environment). */
export function selfTestIsCurrent(c: SquareCapabilities, environment: SquareEnvironmentName, merchantId: string | null): boolean {
  return c.selfTestEnvironment === environment && c.selfTestMerchantId === merchantId;
}

/** The words of each self-test step ("Booking failed: …", "Moving failed: …", "Cancelling failed: …"). */
export const SELF_TEST_STEP_WORDS: Record<BookingChangeKind, string> = { create: 'Booking', reschedule: 'Moving', cancel: 'Cancelling' };

/** What the self-test summary needs from one step row. */
export interface SelfTestStepFacts {
  kind: BookingChangeKind;
  status: string;
  statusMessage: string;
  /** The step's start time (the booked time for the create, the target time for the move). */
  startAt: string | null;
}

/**
 * The outcome of a self-test from its three step rows (shared by the worker, which records it, and the web app, which
 * closes a test whose job was stopped): the first step that was not confirmed (null when all three were), and every
 * time a test booking may still be in Square. While the cancel is not confirmed, a booking that was made (or may have
 * been made) is still there: at the moved time once the move was confirmed, at either time while the move's outcome is
 * not known, otherwise at the booked time.
 */
export function selfTestSummary(steps: readonly SelfTestStepFacts[]): { failedStep: BookingChangeKind | null; failedMessage: string; leftoverAt: string[] } {
  const of = (kind: BookingChangeKind) => steps.find((s) => s.kind === kind) ?? null;
  const create = of('create');
  const move = of('reschedule');
  const cancel = of('cancel');
  const failed = SELF_TEST_STEPS.map(of).find((s) => s?.status !== 'confirmed');
  const failedStep = failed === undefined ? null : (failed?.kind ?? SELF_TEST_STEPS.find((k) => !of(k)) ?? 'create');
  const maybe = (s: SelfTestStepFacts | null) => s?.status === 'unknown' || s?.status === 'submitted';
  let leftoverAt: Array<string | null | undefined> = [];
  if (cancel?.status !== 'confirmed') {
    if (create?.status === 'confirmed') {
      if (move?.status === 'confirmed') leftoverAt = [move.startAt];
      else if (maybe(move)) leftoverAt = [create.startAt, move?.startAt];
      else leftoverAt = [create.startAt];
    } else if (maybe(create)) leftoverAt = [create?.startAt];
  }
  const times = [...new Set(leftoverAt.filter((x): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x))).map((x) => new Date(x).toISOString()))];
  return { failedStep, failedMessage: failed?.statusMessage ?? '', leftoverAt: times };
}

/** The owner's sentence for a failed self-test, with the time(s) a test booking may still be in Square. */
export function selfTestFailureText(failedStep: BookingChangeKind, message: string, leftoverAt: readonly string[]): string {
  const label = (at: string) => {
    const when = new Date(at);
    return `${formatDateTime(when)} ${melbourneZoneLabel(when)}`;
  };
  const leftover =
    leftoverAt.length === 0
      ? ''
      : leftoverAt.length === 1
        ? ` A test booking may still be in Square for ${label(leftoverAt[0] ?? '')}. Cancel it in Square.`
        : ` A test booking may still be in Square, for ${leftoverAt.map(label).join(' or ')} (the move may or may not have gone through). Cancel it in Square.`;
  return `${SELF_TEST_STEP_WORDS[failedStep]} failed: ${message || 'Square didn’t confirm it.'}${leftover}`;
}
