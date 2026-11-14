import { describe, expect, it } from 'vitest';
import { autoPauseReason, classifyAudience, evaluateSendPolicy, foldConsent, spreadByDailyCap, type SendPolicyInput } from '../src/email.js';

/** Monday 16 November 2026, 11:00 am Melbourne (AEDT). */
const NOW = new Date('2026-11-16T00:00:00Z');
const DAY = 86_400_000;
const completed = { status: 'ACCEPTED', completionSource: 'payment', completedAt: new Date(NOW.getTime() - 4 * 3600_000), squareEnvironment: 'production' };

const input = (over: Partial<SendPolicyInput> = {}): SendPolicyInput => ({
  messageClass: 'campaign',
  origin: 'manual',
  toEmail: 'client@example.com',
  ownerEmail: 'owner@studio.example',
  customer: { deleted: false, reviewOptOut: false, squareEmailUnsubscribed: null },
  consent: { status: 'express', since: '2026-10-01T00:00:00.000Z', consentEventId: 'c1' },
  suppressions: [],
  identity: { businessName: 'Ivanhoe Studio', addressLine: '1 Upper Heidelberg Rd', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', phone: '03 9000 0000', email: 'hello@studio.example' },
  provider: { ready: true, webhooksConfigured: true, webhooksAttested: false, sandbox: false },
  booking: null,
  reviewLink: 'https://g.page/r/abc/review',
  recentlyAsked: false,
  minDaysBetweenRequests: 365,
  lint: { errors: [] },
  automationEnabled: null,
  approvedByPerson: true,
  counters: { automationSentToday: 0, automationCap: null, commercialSentToday: 0, commercialCap: 50, customerAutomatedToday: 0 },
  window: { start: '09:00', end: '19:00' },
  now: NOW,
  ...over,
});
const codes = (d: ReturnType<typeof evaluateSendPolicy>) => d.reasons.map((r) => r.code);

describe('evaluateSendPolicy: one case per reason code', () => {
  it('sends when everything is in order, with the consent basis', () => {
    const d = evaluateSendPolicy(input());
    expect(d).toMatchObject({ decision: 'send', reasons: [], sandbox: false, consentBasis: { status: 'express', consentEventId: 'c1' } });
  });

  it.each<[string, Partial<SendPolicyInput>, string, string]>([
    ['provider_not_ready', { provider: { ready: false, webhooksConfigured: null, webhooksAttested: false, sandbox: false } }, 'provider_not_ready', 'hold'],
    ['webhooks_missing', { provider: { ready: true, webhooksConfigured: false, webhooksAttested: false, sandbox: false } }, 'webhooks_missing', 'hold'],
    ['business_identity_missing', { identity: { businessName: 'S', addressLine: '', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', phone: '', email: '' } }, 'business_identity_missing', 'failed'],
    ['invalid_address', { toEmail: 'not-an-address' }, 'invalid_address', 'failed'],
    ['suppressed_all', { suppressions: [{ scope: 'all', reason: 'hard_bounce' }] }, 'suppressed_all', 'suppressed'],
    ['unsubscribed', { suppressions: [{ scope: 'marketing', reason: 'unsubscribe' }] }, 'unsubscribed', 'suppressed'],
    ['unsubscribed (Square)', { customer: { deleted: false, reviewOptOut: false, squareEmailUnsubscribed: true } }, 'unsubscribed', 'suppressed'],
    ['no_consent', { consent: { status: 'none' } }, 'no_consent', 'failed'],
    ['review_opt_out', { messageClass: 'review_request', customer: { deleted: false, reviewOptOut: true, squareEmailUnsubscribed: null } }, 'review_opt_out', 'cancelled'],
    ['review_link_missing', { messageClass: 'review_request', reviewLink: '' }, 'review_link_missing', 'failed'],
    ['review_link_invalid', { messageClass: 'review_request', reviewLink: 'https://g.page.evil.example/r/x' }, 'review_link_invalid', 'failed'],
    ['booking_not_completed', { booking: { status: 'ACCEPTED', completionSource: 'none', completedAt: null, squareEnvironment: 'production' } }, 'booking_not_completed', 'cancelled'],
    ['booking_cancelled', { booking: { ...completed, status: 'CANCELLED_BY_SELLER' } }, 'booking_cancelled', 'cancelled'],
    ['booking_no_show', { booking: { ...completed, status: 'NO_SHOW' } }, 'booking_no_show', 'cancelled'],
    ['recently_asked', { messageClass: 'review_request', recentlyAsked: true }, 'recently_asked', 'cancelled'],
    ['lint_errors', { lint: { errors: [{ code: 'x', message: 'Fix this.' }] } }, 'lint_errors', 'failed'],
    ['automation_off', { origin: 'automation', approvedByPerson: false, automationEnabled: false }, 'automation_off', 'cancelled'],
  ])('blocks: %s', (_name, over, code, outcome) => {
    const d = evaluateSendPolicy(input(over));
    expect(d.decision).toBe('block');
    expect(codes(d)).toContain(code);
    expect(d.outcome).toBe(outcome);
  });

  it('the start time passing is never evidence (square_status rejected)', () => {
    expect(codes(evaluateSendPolicy(input({ booking: { status: 'ACCEPTED', completionSource: 'square_status', completedAt: NOW, squareEnvironment: 'production' } })))).toContain('booking_not_completed');
  });

  it('accepts the owner’s attestation that the webhook exists only when Postmark could not tell', () => {
    expect(evaluateSendPolicy(input({ provider: { ready: true, webhooksConfigured: null, webhooksAttested: true, sandbox: false } })).decision).toBe('send');
    expect(evaluateSendPolicy(input({ provider: { ready: true, webhooksConfigured: false, webhooksAttested: true, sandbox: false } })).decision).toBe('block');
    // Factual emails do not need the webhooks.
    expect(evaluateSendPolicy(input({ messageClass: 'transactional_factual', consent: { status: 'none' }, provider: { ready: true, webhooksConfigured: false, webhooksAttested: false, sandbox: false } })).decision).toBe('send');
  });

  it('defers outside the window, at the daily limits, and for a second automated email to a client on one day', () => {
    const night = new Date('2026-11-16T10:00:00Z'); // 9 pm Melbourne
    const out = evaluateSendPolicy(input({ origin: 'automation', approvedByPerson: false, automationEnabled: true, now: night }));
    expect(out).toMatchObject({ decision: 'defer', deferUntil: new Date('2026-11-16T22:00:00Z') });
    expect(codes(out)).toEqual(['outside_window']);
    // Manual sends are not held to the window.
    expect(evaluateSendPolicy(input({ now: night })).decision).toBe('send');
    const cap = evaluateSendPolicy(input({ origin: 'automation', approvedByPerson: false, automationEnabled: true, counters: { automationSentToday: 10, automationCap: 10, commercialSentToday: 0, commercialCap: 50, customerAutomatedToday: 0 } }));
    expect(cap).toMatchObject({ decision: 'defer', deferUntil: new Date('2026-11-16T22:00:00Z') });
    expect(codes(cap)).toEqual(['daily_cap']);
    const global = evaluateSendPolicy(input({ counters: { automationSentToday: 0, automationCap: null, commercialSentToday: 50, commercialCap: 50, customerAutomatedToday: 0 } }));
    expect(codes(global)).toEqual(['daily_cap']);
    const perClient = evaluateSendPolicy(input({ origin: 'automation', approvedByPerson: false, automationEnabled: true, counters: { automationSentToday: 0, automationCap: 10, commercialSentToday: 0, commercialCap: 50, customerAutomatedToday: 1 } }));
    expect(codes(perClient)).toEqual(['customer_daily_limit']);
  });

  it('allows a preview only to the owner’s own address, skipping consent', () => {
    expect(evaluateSendPolicy(input({ origin: 'preview', toEmail: 'Owner@Studio.example', consent: { status: 'none' } }))).toMatchObject({ decision: 'send', consentBasis: { status: 'preview' } });
    expect(codes(evaluateSendPolicy(input({ origin: 'preview', toEmail: 'client@example.com' })))).toContain('preview_not_owner');
  });

  it('labels a sandbox server', () => {
    const d = evaluateSendPolicy(input({ provider: { ready: true, webhooksConfigured: true, webhooksAttested: false, sandbox: true } }));
    expect(d).toMatchObject({ decision: 'send', sandbox: true });
    expect(codes(d)).toEqual(['sandbox']);
  });
});

describe('foldConsent', () => {
  const ev = (id: string, kind: 'granted' | 'withdrawn', iso: string) => ({ id, kind, method: kind === 'granted' ? 'in_person_device' : 'unsubscribe_page', occurredAt: new Date(iso) });
  it('grant, then unsubscribe, then grant again', () => {
    expect(foldConsent([ev('a', 'granted', '2026-01-01T00:00:00Z')], [], { allowInferred: false, now: NOW })).toMatchObject({ status: 'express', consentEventId: 'a' });
    expect(foldConsent([ev('a', 'granted', '2026-01-01T00:00:00Z'), ev('b', 'withdrawn', '2026-02-01T00:00:00Z')], [], { allowInferred: false, now: NOW }).status).toBe('withdrawn');
    expect(foldConsent([ev('a', 'granted', '2026-01-01T00:00:00Z'), ev('b', 'withdrawn', '2026-02-01T00:00:00Z'), ev('c', 'granted', '2026-03-01T00:00:00Z')], [], { allowInferred: false, now: NOW })).toMatchObject({ status: 'express', consentEventId: 'c' });
  });
  it('a tie goes to the withdrawal; an active marketing suppression counts as one', () => {
    expect(foldConsent([ev('a', 'granted', '2026-01-01T00:00:00Z'), ev('b', 'withdrawn', '2026-01-01T00:00:00Z')], [], { allowInferred: false, now: NOW }).status).toBe('withdrawn');
    expect(foldConsent([ev('a', 'granted', '2026-01-01T00:00:00Z')], [{ scope: 'marketing', reason: 'unsubscribe', createdAt: new Date('2026-02-01T00:00:00Z'), liftedAt: null }], { allowInferred: false, now: NOW }).status).toBe('withdrawn');
    expect(foldConsent([ev('a', 'granted', '2026-01-01T00:00:00Z')], [{ scope: 'marketing', reason: 'unsubscribe', createdAt: new Date('2026-02-01T00:00:00Z'), liftedAt: new Date('2026-02-02T00:00:00Z') }], { allowInferred: false, now: NOW }).status).toBe('express');
  });
  it('inferred consent is off by default, needs 2 completed visits in 12 months, lapses, and never follows a withdrawal', () => {
    const visits = [new Date(NOW.getTime() - 30 * DAY), new Date(NOW.getTime() - 200 * DAY)];
    expect(foldConsent([], [], { allowInferred: false, completedVisits: visits, now: NOW }).status).toBe('none');
    expect(foldConsent([], [], { allowInferred: true, completedVisits: visits, now: NOW })).toMatchObject({ status: 'inferred', visits12m: 2 });
    expect(foldConsent([], [], { allowInferred: true, completedVisits: [visits[0]!], now: NOW }).status).toBe('none');
    expect(foldConsent([], [], { allowInferred: true, completedVisits: [new Date(NOW.getTime() - 370 * DAY), new Date(NOW.getTime() - 400 * DAY)], now: NOW }).status).toBe('none');
    expect(foldConsent([ev('w', 'withdrawn', '2025-01-01T00:00:00Z')], [], { allowInferred: true, completedVisits: visits, now: NOW }).status).toBe('withdrawn');
  });
});

describe('campaign helpers', () => {
  it('pauses on complaints over 0.1% or bounces over 5%', () => {
    expect(autoPauseReason({ sentCount: 42, bounceCount: 0, complaintCount: 1 })).toMatch(/1 spam complaint out of 42 sent/);
    expect(autoPauseReason({ sentCount: 100, bounceCount: 6, complaintCount: 0 })).toMatch(/6 bounces out of 100/);
    expect(autoPauseReason({ sentCount: 100, bounceCount: 5, complaintCount: 0 })).toBeNull();
    expect(autoPauseReason({ sentCount: 0, bounceCount: 0, complaintCount: 0 })).toBeNull();
  });
  it('spreads sends by the daily limit over Melbourne days', () => {
    const { times, schedule } = spreadByDailyCap(72, 30, NOW, { start: '09:00', end: '19:00' });
    expect(schedule).toEqual([
      { date: '2026-11-16', count: 30 },
      { date: '2026-11-17', count: 30 },
      { date: '2026-11-18', count: 12 },
    ]);
    expect(times[30]?.toISOString()).toBe('2026-11-16T22:00:00.000Z');
  });
  it('classifies the audience with a reason for every left-out client', () => {
    const base = { customerId: 'c', deleted: false, email: 'a@example.com', consent: { status: 'express' as const, since: '', consentEventId: 'x' }, activeSuppressions: [], squareEmailUnsubscribed: null, lastCompletedVisitAt: new Date(NOW.getTime() - 10 * DAY) };
    expect(classifyAudience(base, { lastVisitWithinDays: null }, NOW)).toEqual({ included: true });
    expect(classifyAudience({ ...base, consent: { status: 'none' } }, { lastVisitWithinDays: null }, NOW)).toEqual({ included: false, reason: 'no_permission' });
    expect(classifyAudience({ ...base, activeSuppressions: [{ scope: 'all' }] }, { lastVisitWithinDays: null }, NOW)).toEqual({ included: false, reason: 'suppressed' });
    expect(classifyAudience({ ...base, squareEmailUnsubscribed: true }, { lastVisitWithinDays: null }, NOW)).toEqual({ included: false, reason: 'unsubscribed' });
    expect(classifyAudience({ ...base, email: null }, { lastVisitWithinDays: null }, NOW)).toEqual({ included: false, reason: 'no_email' });
    expect(classifyAudience({ ...base, deleted: true }, { lastVisitWithinDays: null }, NOW)).toEqual({ included: false, reason: 'deleted' });
    expect(classifyAudience({ ...base, lastCompletedVisitAt: new Date(NOW.getTime() - 100 * DAY) }, { lastVisitWithinDays: 90 }, NOW)).toEqual({ included: false, reason: 'no_recent_visit' });
  });
});
