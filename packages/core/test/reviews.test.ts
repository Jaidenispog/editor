import { describe, expect, it } from 'vitest';
import { REVIEW_ELIGIBILITY_INPUT_KEYS, reviewEligibility, reviewRequestBadgeLabel, sentBeforeBookingChanged, validateReviewLink, type ReviewEligibilityInput } from '../src/reviews.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const NOW = new Date('2026-11-16T00:00:00Z');
const DAY = 86_400_000;
const input = (over: Partial<ReviewEligibilityInput> = {}): ReviewEligibilityInput => ({
  evidence: { kind: 'booking', booking: { status: 'ACCEPTED', completionSource: 'payment', completedAt: new Date(NOW.getTime() - DAY), squareEnvironment: 'production' } },
  automation: { enabledAt: new Date(NOW.getTime() - 3 * DAY), maxAgeDays: 7 },
  customer: { deleted: false, email: 'client@example.com', reviewRequestsOptOut: false },
  lastRequestSentAt: null,
  minDaysBetweenRequests: 365,
  reviewLink: 'https://g.page/r/abc/review',
  marketingBlock: null,
  now: NOW,
  ...over,
});
const reason = (over: Partial<ReviewEligibilityInput>) => {
  const r = reviewEligibility(input(over));
  return r.eligible ? 'eligible' : r.skipReason;
};

describe('reviewEligibility', () => {
  it('pins its inputs: no rating, spend, feedback, notes, staff or satisfaction field (no gating)', () => {
    expect([...REVIEW_ELIGIBILITY_INPUT_KEYS].sort()).toEqual(['automation', 'customer', 'evidence', 'lastRequestSentAt', 'marketingBlock', 'minDaysBetweenRequests', 'now', 'reviewLink']);
    for (const k of REVIEW_ELIGIBILITY_INPUT_KEYS) expect(k).not.toMatch(/rating|spend|feedback|note|staff|satisf|happy|score|star/i);
    expect(() => reviewEligibility({ ...input(), rating: 5 } as unknown as ReviewEligibilityInput)).toThrow(/does not accept "rating"/);
  });

  it('needs genuine completion: square_status, none, cancelled and no-show are rejected', () => {
    expect(reason({})).toBe('eligible');
    expect(reason({ evidence: { kind: 'booking', booking: { status: 'ACCEPTED', completionSource: 'square_status', completedAt: NOW, squareEnvironment: 'production' } } })).toBe('not_completed');
    expect(reason({ evidence: { kind: 'booking', booking: { status: 'ACCEPTED', completionSource: 'none', completedAt: null, squareEnvironment: 'production' } } })).toBe('not_completed');
    // A sandbox (test) booking never earns a real review request, even with a stored payment match.
    expect(reason({ evidence: { kind: 'booking', booking: { status: 'ACCEPTED', completionSource: 'payment', completedAt: NOW, squareEnvironment: 'sandbox' } } })).toBe('not_completed');
    expect(reason({ evidence: { kind: 'booking', booking: { status: 'CANCELLED_BY_CUSTOMER', completionSource: 'payment', completedAt: NOW, squareEnvironment: 'production' } } })).toBe('booking_cancelled');
    expect(reason({ evidence: { kind: 'booking', booking: { status: 'NO_SHOW', completionSource: 'owner_marked', completedAt: NOW, squareEnvironment: 'production' } } })).toBe('booking_no_show');
  });

  it('honours enabledAt and maxAgeDays at their boundaries (automation only)', () => {
    const at = (ms: number) => ({ kind: 'booking' as const, booking: { status: 'ACCEPTED', completionSource: 'payment', completedAt: new Date(ms), squareEnvironment: 'production' } });
    const enabledAt = new Date(NOW.getTime() - 3 * DAY);
    expect(reason({ evidence: at(enabledAt.getTime()), automation: { enabledAt, maxAgeDays: 7 } })).toBe('eligible');
    expect(reason({ evidence: at(enabledAt.getTime() - 1), automation: { enabledAt, maxAgeDays: 7 } })).toBe('not_completed');
    const old = new Date(NOW.getTime() - 30 * DAY);
    expect(reason({ evidence: at(NOW.getTime() - 7 * DAY), automation: { enabledAt: old, maxAgeDays: 7 } })).toBe('eligible');
    expect(reason({ evidence: at(NOW.getTime() - 7 * DAY - 1), automation: { enabledAt: old, maxAgeDays: 7 } })).toBe('not_completed');
    // A manual request with the owner's attestation needs no booking.
    expect(reason({ evidence: { kind: 'attestation', visitDate: '2026-11-15', attestedBy: 'owner' }, automation: null })).toBe('eligible');
    expect(reason({ evidence: { kind: 'attestation', visitDate: '15/11/2026', attestedBy: 'owner' }, automation: null })).toBe('not_completed');
  });

  it('checks the client, the frequency rule, the link and the gate in order', () => {
    expect(reason({ customer: null })).toBe('no_email');
    expect(reason({ customer: { deleted: false, email: '', reviewRequestsOptOut: false } })).toBe('no_email');
    expect(reason({ customer: { deleted: false, email: 'a@example.com', reviewRequestsOptOut: true } })).toBe('opted_out');
    expect(reason({ lastRequestSentAt: new Date(NOW.getTime() - 100 * DAY) })).toBe('recently_asked');
    expect(reason({ lastRequestSentAt: new Date(NOW.getTime() - 366 * DAY) })).toBe('eligible');
    expect(reason({ reviewLink: '' })).toBe('no_review_link');
    expect(reason({ marketingBlock: 'no_consent' })).toBe('no_consent');
    expect(reason({ marketingBlock: 'unsubscribed' })).toBe('unsubscribed');
  });
});

describe('validateReviewLink', () => {
  it('accepts only https links on Google hosts that the owner pasted', () => {
    expect(validateReviewLink('https://g.page/r/CabcXYZ/review').valid).toBe(true);
    expect(validateReviewLink('https://search.google.com/local/writereview?placeid=abc').valid).toBe(true);
    expect(validateReviewLink('https://maps.app.goo.gl/abc').valid).toBe(true);
    expect(validateReviewLink('http://g.page/r/abc').valid).toBe(false);
    expect(validateReviewLink('https://g.page.evil.example/r/abc').valid).toBe(false);
    expect(validateReviewLink('https://example.com/review').valid).toBe(false);
    expect(validateReviewLink(`https://g.page/${'a'.repeat(500)}`).valid).toBe(false);
    expect(validateReviewLink('').valid).toBe(false);
  });
});

describe('email settings defaults', () => {
  it('keep every automation off, approve-each, with the design defaults', () => {
    expect(DEFAULT_SETTINGS.email.followUp).toEqual({ enabled: false, enabledAt: null, mode: 'approve_each', templateId: null, delayHours: 3, dailyCap: 10 });
    expect(DEFAULT_SETTINGS.reviews).toMatchObject({ minDaysBetweenRequests: 365, maxAgeDays: 7, automation: { enabled: false } });
    expect(DEFAULT_SETTINGS.email).toMatchObject({ allowInferredConsent: false, sendWindow: { start: '09:00', end: '19:00' }, dailyCommercialCap: 50 });
  });
});

describe('reviewRequestBadgeLabel (Appointments badge)', () => {
  it('uses the same status words as the Reviews page, with the skip reason', () => {
    expect(reviewRequestBadgeLabel('pending_approval', null)).toBe('Review request: Waiting for approval');
    expect(reviewRequestBadgeLabel('sent', null)).toBe('Review request: Sent');
    expect(reviewRequestBadgeLabel('skipped', 'no_consent')).toBe('Review request: Skipped — no email permission recorded');
    expect(reviewRequestBadgeLabel('cancelled', 'booking_cancelled')).toBe('Review request: Cancelled');
  });

  it('says "Sent before the booking changed" when a sent request’s booking stopped counting as a visit (design §4.3 step 6)', () => {
    const done = { status: 'ACCEPTED', completionSource: 'payment', completedAt: new Date(NOW.getTime() - DAY), squareEnvironment: 'production' };
    expect(sentBeforeBookingChanged('sent', done)).toBe(false);
    expect(sentBeforeBookingChanged('sent', { ...done, status: 'CANCELLED_BY_CUSTOMER' })).toBe(true);
    expect(sentBeforeBookingChanged('sent', { ...done, status: 'NO_SHOW' })).toBe(true);
    expect(sentBeforeBookingChanged('sent', { ...done, completionSource: 'none', completedAt: null })).toBe(true);
    expect(sentBeforeBookingChanged('scheduled', { ...done, status: 'NO_SHOW' })).toBe(false);
    expect(sentBeforeBookingChanged('sent', null)).toBe(false);
    expect(reviewRequestBadgeLabel('sent', null, { bookingChanged: true })).toBe('Review request: Sent before the booking changed');
    expect(reviewRequestBadgeLabel('cancelled', null, { bookingChanged: true })).toBe('Review request: Cancelled');
  });
});
