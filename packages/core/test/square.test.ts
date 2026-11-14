import { describe, expect, it } from 'vitest';
import {
  SQUARE_TIER1_AVAILABLE,
  availabilityRange,
  bookingEndAt,
  bookingWindows,
  classifyVariation,
  deriveAttendance,
  deriveCompletion,
  isGenuinelyCompleted,
  isRfc3339Instant,
  mapBookingStatus,
  mapSquareError,
  matchPayments,
  noShowFeeFrom,
  parseSquareCapabilities,
  parseSquareConfig,
  squareIntegrationState,
  squareScopes,
  syncRange,
  tier1Status,
  type MatchBooking,
  type MatchPayment,
  type SquareServiceSnapshot,
} from '../src/index.js';

const HOUR = 3600_000;
const MIN = 60_000;

describe('squareScopes', () => {
  it('asks for exactly the read permissions, and adds the two write permissions only for changes', () => {
    expect(squareScopes('read')).toEqual([
      'APPOINTMENTS_READ',
      'APPOINTMENTS_ALL_READ',
      'APPOINTMENTS_BUSINESS_SETTINGS_READ',
      'CUSTOMERS_READ',
      'ITEMS_READ',
      'MERCHANT_PROFILE_READ',
      'PAYMENTS_READ',
      'ORDERS_READ',
    ]);
    expect(squareScopes('write').slice(-2)).toEqual(['APPOINTMENTS_WRITE', 'APPOINTMENTS_ALL_WRITE']);
    expect(squareScopes('read')).not.toContain('CUSTOMERS_WRITE');
  });
});

describe('squareIntegrationState', () => {
  const now = new Date('2026-11-14T01:00:00Z');
  const connected = {
    status: 'connected',
    externalAccountId: 'M1',
    scopes: squareScopes('read'),
    config: { environment: 'sandbox', snapshot: null },
    capabilities: {},
    lastSyncAt: new Date(now.getTime() - 3 * MIN),
    lastError: null,
  };
  const state = (over: Partial<Parameters<typeof squareIntegrationState>[0]> = {}) =>
    squareIntegrationState({ envPresent: true, webhookKeyPresent: true, environment: 'sandbox', connection: connected, now, ...over });

  it('covers every card state', () => {
    expect(state({ envPresent: false })).toMatchObject({ state: 'not_configured', liveMode: null });
    expect(state({ connection: null })).toMatchObject({ state: 'not_connected', liveMode: 'sandbox' });
    expect(state({ connection: { ...connected, status: 'disconnected' } }).state).toBe('not_connected');
    expect(state()).toMatchObject({ state: 'connected', liveMode: 'sandbox', stale: false, needsLocation: false, webhooks: 'waiting' });
    expect(state({ connection: { ...connected, status: 'needs_reauth' } })).toMatchObject({ state: 'needs_reauth', reauthReason: 'token' });
    expect(state({ connection: { ...connected, status: 'needs_reauth', capabilities: { readScopesOk: false } } }).reauthReason).toBe('scopes');
    expect(state({ connection: { ...connected, status: 'error', lastError: 'x' } }).state).toBe('error');
  });

  it('asks to reconnect after the server switched environment, and labels live', () => {
    expect(state({ environment: 'production' })).toMatchObject({ state: 'needs_reauth', reauthReason: 'env_changed', liveMode: 'live' });
  });

  it('flags a stale sync, a missing location choice and quiet webhooks', () => {
    expect(state({ connection: { ...connected, lastSyncAt: new Date(now.getTime() - 31 * MIN) } }).stale).toBe(true);
    expect(state({ connection: { ...connected, lastSyncAt: null } }).stale).toBe(true);
    const locations = [
      { id: 'L1', name: 'A', timezone: 'Australia/Melbourne', status: 'ACTIVE', bookingSiteUrl: null },
      { id: 'L2', name: 'B', timezone: 'Australia/Melbourne', status: 'ACTIVE', bookingSiteUrl: null },
    ];
    const snapshot = { fetchedAt: now.toISOString(), merchantName: 'X', locations, businessProfile: null, teamMembers: [], services: [] };
    expect(state({ connection: { ...connected, config: { environment: 'sandbox', snapshot } } }).needsLocation).toBe(true);
    expect(state({ connection: { ...connected, config: { environment: 'sandbox', snapshot, locationId: 'L2' } } }).needsLocation).toBe(false);
    expect(state({ webhookKeyPresent: false }).webhooks).toBe('off');
    expect(state({ connection: { ...connected, config: { environment: 'sandbox', lastWebhookAt: new Date(now.getTime() - 4 * 24 * HOUR).toISOString() } } }).webhooks).toBe('quiet');
    expect(state({ connection: { ...connected, config: { environment: 'sandbox', lastWebhookAt: new Date(now.getTime() - HOUR).toISOString() } } }).webhooks).toBe('ok');
  });

  it('reads damaged config and capabilities as empty defaults', () => {
    expect(parseSquareConfig({ environment: 'production', snapshot: 'nonsense' })).toMatchObject({ environment: 'production', snapshot: null, locationId: null });
    expect(parseSquareConfig(null).environment).toBe('sandbox');
    expect(parseSquareCapabilities({ writesSuspendedReason: 'nope', selfTestStatus: 7 })).toMatchObject({ writesSuspendedReason: '', selfTestStatus: 'none', writesEnabled: false });
  });
});

const service = (over: Partial<SquareServiceSnapshot> = {}): SquareServiceSnapshot => ({
  itemId: 'I1',
  itemName: 'Skin fade',
  variationId: 'V1',
  variationName: 'Regular',
  version: '10',
  durationMinutes: 45,
  price: { amount: '5500', currency: 'AUD' },
  availableForBooking: true,
  teamMemberIds: ['TM1'],
  archived: false,
  noShowFeeSeen: null,
  ...over,
});
const profile = { bookingEnabled: true, bookingPolicy: 'ACCEPT_ALL', allowUserCancel: true, supportSellerLevelWrites: true, cancellationWindowSeconds: null, cancellationFee: null, cancellationPolicy: null, minLeadSeconds: null, maxLeadSeconds: null };

describe('classifyVariation', () => {
  const confirmed = { V1: { version: '10', confirmedBy: 'u1', confirmedAt: '2026-11-14T00:00:00Z' } };
  it('labels each case', () => {
    expect(classifyVariation(service(), profile, confirmed, {}).label).toBe('bookable');
    expect(classifyVariation(service(), profile, {}, {}).label).toBe('needs_confirmation');
    expect(classifyVariation(service({ version: '11' }), profile, confirmed, {}).label).toBe('needs_confirmation');
    expect(classifyVariation(service({ noShowFeeSeen: { amount: '1000', currency: 'AUD' } }), profile, confirmed, {}).label).toBe('book_in_square');
    expect(classifyVariation(service({ noShowFeeSeen: { amount: '0', currency: 'AUD' } }), profile, confirmed, {}).label).toBe('bookable');
    expect(classifyVariation(service(), { ...profile, cancellationFee: { amount: '2000', currency: 'AUD' } }, confirmed, {}).label).toBe('unverified');
    expect(classifyVariation(service({ archived: true }), profile, confirmed, {}).label).toBe('not_bookable');
    expect(classifyVariation(service({ availableForBooking: false }), profile, confirmed, {}).label).toBe('not_bookable');
    expect(classifyVariation(service({ teamMemberIds: [] }), profile, confirmed, {}).label).toBe('not_bookable');
    expect(classifyVariation(service(), profile, confirmed, { V1: { changeId: 'c', code: 'BAD_REQUEST', at: 'x' } }).label).toBe('book_in_square');
  });
  it('reads a passthrough no_show_fee in either casing', () => {
    expect(noShowFeeFrom({ no_show_fee: { amount: 1000, currency: 'AUD' } })).toEqual({ amount: '1000', currency: 'AUD' });
    expect(noShowFeeFrom({ noShowFee: { amount: 500n, currency: 'AUD' } })).toEqual({ amount: '500', currency: 'AUD' });
    expect(noShowFeeFrom({})).toBeNull();
  });
});

describe('tier1Status', () => {
  const base = { config: parseSquareConfig({ environment: 'sandbox' }), scopes: squareScopes('read'), environment: 'sandbox' as const, merchantId: 'M1' };
  it('is never ready while booking changes are switched off in code, and reports each checklist line', () => {
    expect(SQUARE_TIER1_AVAILABLE).toBe(false);
    const t = tier1Status({ ...base, capabilities: parseSquareCapabilities({ sellerLevelWrites: true, writesEnabled: true, selfTestStatus: 'passed', selfTestEnvironment: 'sandbox', selfTestMerchantId: 'M1' }), scopes: squareScopes('write') });
    expect(t).toMatchObject({ available: false, ready: false, checklist: { plan: 'ok', scopes: 'ok', bookableService: 'unknown', selfTest: 'ok', switch: 'ok' } });
    const none = tier1Status({ ...base, capabilities: parseSquareCapabilities({ sellerLevelWrites: false, writesSuspendedReason: 'plan' }) });
    expect(none).toMatchObject({ ready: false, suspendedReason: 'plan', checklist: { plan: 'missing', scopes: 'missing', selfTest: 'unknown', switch: 'missing' } });
    const otherAccount = tier1Status({ ...base, capabilities: parseSquareCapabilities({ selfTestStatus: 'passed', selfTestEnvironment: 'sandbox', selfTestMerchantId: 'OTHER' }) });
    expect(otherAccount.checklist.selfTest).toBe('missing');
  });
});

describe('mapBookingStatus', () => {
  it('labels the six statuses and passes unknown ones through', () => {
    expect(mapBookingStatus('PENDING').label).toBe('Waiting for acceptance');
    expect(mapBookingStatus('ACCEPTED').label).toBe('Accepted');
    expect(mapBookingStatus('DECLINED').label).toBe('Declined');
    expect(mapBookingStatus('CANCELLED_BY_CUSTOMER').label).toBe('Cancelled by client');
    expect(mapBookingStatus('CANCELLED_BY_SELLER').label).toBe('Cancelled by studio');
    expect(mapBookingStatus('NO_SHOW').label).toBe('No-show (from Square)');
    expect(mapBookingStatus('SOMETHING_NEW').label).toBe('Square status: SOMETHING_NEW');
  });
});

describe('deriveAttendance and completion', () => {
  const now = new Date('2026-11-14T06:00:00Z');
  const ended = new Date(now.getTime() - HOUR);
  const strong = { kind: 'strong' as const, paymentId: 'P1', score: 11, signals: ['customer', 'team_member'], confidence: 'high' as const };
  const weak = { kind: 'weak' as const, paymentId: 'P2', score: 1, signals: ['team_member'], confidence: 'low' as const };
  const b = (over: Partial<Parameters<typeof deriveAttendance>[0]> = {}) => ({ status: 'ACCEPTED', endAt: ended, ownerAttendance: null, missingFromSquareAt: null, match: null, ...over });
  const complete = (over: Partial<Parameters<typeof deriveAttendance>[0]> = {}) => {
    const input = b(over);
    const attendance = deriveAttendance(input, now);
    const c = deriveCompletion({ ...input, attendance }, now);
    return { attendance, ...c, genuine: isGenuinelyCompleted({ status: input.status, completionSource: c.source, completedAt: c.completedAt }) };
  };

  it('future booking is upcoming and not completed', () => {
    expect(complete({ endAt: new Date(now.getTime() + HOUR) })).toMatchObject({ attendance: 'upcoming', completed: false, genuine: false });
  });
  it('time passing with no evidence is never completion', () => {
    expect(complete()).toMatchObject({ attendance: 'awaiting_payment', completed: false, source: 'none', genuine: false });
    expect(complete({ endAt: new Date(now.getTime() - 8 * 24 * HOUR) })).toMatchObject({ attendance: 'no_payment_matched', completed: false });
  });
  it('a strong payment completes it; a weak one only asks', () => {
    expect(complete({ match: strong })).toMatchObject({ attendance: 'payment_matched', completed: true, source: 'payment', genuine: true });
    expect(complete({ match: weak })).toMatchObject({ attendance: 'possible_match', completed: false });
  });
  it('the owner mark wins over the estimate', () => {
    expect(complete({ ownerAttendance: 'attended' })).toMatchObject({ attendance: 'owner_attended', source: 'owner_marked', genuine: true });
    expect(complete({ ownerAttendance: 'not_attended', match: strong })).toMatchObject({ attendance: 'owner_not_attended', completed: false, source: 'none' });
  });
  it('Square NO_SHOW or cancelled wins over the owner mark and a match', () => {
    expect(complete({ status: 'NO_SHOW', ownerAttendance: 'attended' })).toMatchObject({ attendance: 'no_show', completed: false, source: 'none' });
    expect(complete({ status: 'CANCELLED_BY_CUSTOMER', match: strong })).toMatchObject({ attendance: 'cancelled', completed: false });
    expect(complete({ status: 'PENDING' }).attendance).toBe('pending');
    expect(complete({ status: 'DECLINED' }).attendance).toBe('declined');
    expect(complete({ status: 'MYSTERY' }).attendance).toBe('other');
  });
  it('a booking missing from Square is not completed', () => {
    expect(complete({ match: strong, missingFromSquareAt: now })).toMatchObject({ completed: false, source: 'none', completedAt: null });
  });
  it('keeps the first completion time', () => {
    const first = new Date(now.getTime() - 30 * MIN);
    expect(deriveCompletion({ status: 'ACCEPTED', endAt: ended, missingFromSquareAt: null, ownerAttendance: null, attendance: 'payment_matched', completedAt: first }, now).completedAt).toEqual(first);
  });
});

describe('matchPayments', () => {
  const start = new Date('2026-11-14T00:00:00Z');
  const booking = (over: Partial<MatchBooking> = {}): MatchBooking => ({ id: 'B1', locationId: 'L1', squareCustomerId: 'C1', teamMemberId: 'T1', serviceVariationId: 'V1', startAt: start, endAt: new Date(start.getTime() + 45 * MIN), ...over });
  const payment = (over: Partial<MatchPayment> = {}): MatchPayment => ({
    id: 'P1',
    status: 'COMPLETED',
    locationId: 'L1',
    customerId: 'C1',
    teamMemberId: null,
    orderId: null,
    createdAt: new Date(start.getTime() + 50 * MIN),
    squareProduct: null,
    totalAmount: '5500',
    refundedAmount: null,
    ...over,
  });

  it('strong match: medium with only the customer, high with a second signal', () => {
    expect(matchPayments([booking()], [payment()]).get('B1')).toMatchObject({ kind: 'strong', confidence: 'medium', signals: ['customer'] });
    expect(matchPayments([booking()], [payment({ squareProduct: 'APPOINTMENTS' })]).get('B1')?.confidence).toBe('high');
    expect(matchPayments([booking()], [payment({ teamMemberId: 'T1' })]).get('B1')?.confidence).toBe('high');
    expect(matchPayments([booking()], [payment({ orderId: 'O1' })], { O1: ['V1'] }).get('B1')).toMatchObject({ confidence: 'high', signals: ['customer', 'service'] });
  });
  it('respects the window edges: 30 min before start, 3 h after end', () => {
    expect(matchPayments([booking()], [payment({ createdAt: new Date(start.getTime() - 30 * MIN) })]).get('B1')).toBeDefined();
    expect(matchPayments([booking()], [payment({ createdAt: new Date(start.getTime() - 31 * MIN) })]).get('B1')).toBeUndefined();
    const end = start.getTime() + 45 * MIN;
    expect(matchPayments([booking()], [payment({ createdAt: new Date(end + 3 * HOUR) })]).get('B1')).toBeDefined();
    expect(matchPayments([booking()], [payment({ createdAt: new Date(end + 3 * HOUR + MIN) })]).get('B1')).toBeUndefined();
  });
  it('ignores other locations, unfinished payments and full refunds', () => {
    expect(matchPayments([booking()], [payment({ locationId: 'L2' })]).size).toBe(0);
    expect(matchPayments([booking()], [payment({ status: 'FAILED' })]).size).toBe(0);
    expect(matchPayments([booking()], [payment({ status: 'CANCELED' })]).size).toBe(0);
    expect(matchPayments([booking()], [payment({ refundedAmount: '5500' })]).size).toBe(0);
    expect(matchPayments([booking()], [payment({ refundedAmount: '1000' })]).get('B1')?.kind).toBe('strong');
  });
  it('without the customer it is only a possible match', () => {
    expect(matchPayments([booking()], [payment({ customerId: null, teamMemberId: 'T1' })]).get('B1')).toMatchObject({ kind: 'weak', confidence: 'low' });
    expect(matchPayments([booking()], [payment({ customerId: 'C9' })]).size).toBe(0);
  });
  it('one payment, two bookings for the same client that day: the earliest wins, the other becomes possible', () => {
    const later = booking({ id: 'B2', startAt: new Date(start.getTime() + 30 * MIN), endAt: new Date(start.getTime() + 75 * MIN) });
    const m = matchPayments([later, booking()], [payment()]);
    expect(m.get('B1')?.kind).toBe('strong');
    expect(m.get('B2')?.kind).toBe('weak');
  });
  it('two payments for one booking keep the stronger evidence', () => {
    const m = matchPayments([booking()], [payment({ id: 'P1' }), payment({ id: 'P2', squareProduct: 'APPOINTMENTS' })]);
    expect(m.get('B1')).toMatchObject({ paymentId: 'P2', confidence: 'high' });
  });
});

describe('time ranges', () => {
  it('availabilityRange widens a 23-hour DST day to 24 hours and keeps the Melbourne day for filtering', () => {
    const r = availabilityRange('2026-10-04', 1);
    expect(r.filterEnd.getTime() - r.filterStart.getTime()).toBe(23 * HOUR);
    expect(r.end.getTime() - r.start.getTime()).toBe(24 * HOUR);
    const autumn = availabilityRange('2026-04-05', 1);
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * HOUR);
    const normal = availabilityRange('2026-11-14', 7);
    expect(normal.end.getTime() - normal.start.getTime()).toBe(7 * 24 * HOUR);
    expect(normal.start.toISOString()).toBe('2026-11-13T13:00:00.000Z');
    const capped = availabilityRange('2026-11-14', 40);
    expect(Math.round((capped.end.getTime() - capped.start.getTime()) / (24 * HOUR))).toBe(14);
    expect(() => availabilityRange('2026-02-30', 1)).toThrow();
  });
  it('splits sync ranges into windows of at most 31 days', () => {
    const now = new Date('2026-11-14T00:00:00Z');
    const wide = syncRange('connect', now);
    const windows = bookingWindows(wide.start, wide.end);
    expect(windows).toHaveLength(3);
    expect(windows.every((w) => w.end.getTime() - w.start.getTime() <= 31 * 24 * HOUR)).toBe(true);
    expect(windows[0]?.start).toEqual(wide.start);
    expect(windows.at(-1)?.end).toEqual(wide.end);
    expect(bookingWindows(...(Object.values(syncRange('schedule', now)) as [Date, Date]))).toHaveLength(1);
  });
  it('computes booking ends and checks RFC 3339 instants', () => {
    expect(bookingEndAt(new Date('2026-11-14T00:00:00Z'), [{ durationMinutes: 30 }, { durationMinutes: 15, intermissionMinutes: 5 }]).toISOString()).toBe('2026-11-14T00:50:00.000Z');
    expect(isRfc3339Instant('2026-11-14T10:30:00+11:00')).toBe(true);
    expect(isRfc3339Instant('2026-11-14T10:30:00Z')).toBe(true);
    expect(isRfc3339Instant('2026-11-14 10:30')).toBe(false);
  });
});

describe('mapSquareError', () => {
  it('maps each row of the design table', () => {
    expect(mapSquareError({ statusCode: 401, errors: [{ code: 'UNAUTHORIZED' }] }).kind).toBe('reauth');
    expect(mapSquareError({ statusCode: 401, errors: [{ code: 'ACCESS_TOKEN_REVOKED' }] }).kind).toBe('reauth');
    expect(mapSquareError({ statusCode: 401, errors: [{ code: 'ACCESS_TOKEN_EXPIRED' }] }).kind).toBe('reauth');
    expect(mapSquareError({ statusCode: 403, errors: [{ code: 'INSUFFICIENT_SCOPES' }] }, 'read').kind).toBe('reauth');
    expect(mapSquareError({ statusCode: 403, errors: [{ code: 'INSUFFICIENT_SCOPES' }] }, 'write').kind).toBe('not_allowed');
    expect(mapSquareError({ statusCode: 403, errors: [{ code: 'FORBIDDEN' }] }).kind).toBe('not_allowed');
    expect(mapSquareError({ statusCode: 403, errors: [{ code: 'MERCHANT_SUBSCRIPTION_NOT_FOUND' }] }).kind).toBe('not_allowed');
    expect(mapSquareError({ statusCode: 400, errors: [{ code: 'SOMETHING', category: 'MERCHANT_SUBSCRIPTION_ERROR' }] }).kind).toBe('not_allowed');
    expect(mapSquareError({ statusCode: 404, errors: [{ code: 'NOT_FOUND' }] }).kind).toBe('not_found');
    expect(mapSquareError({ statusCode: 409, errors: [{ code: 'CONFLICT' }] }).kind).toBe('conflict');
    expect(mapSquareError({ statusCode: 400, errors: [{ code: 'INVALID_TIME_RANGE', detail: 'Too long' }] })).toEqual({ kind: 'invalid', code: 'INVALID_TIME_RANGE', message: 'Square said: Too long' });
    expect(mapSquareError({ statusCode: 429, errors: [{ code: 'RATE_LIMITED' }] }).kind).toBe('rate_limited');
    expect(mapSquareError({ statusCode: 503, errors: [{ code: 'SERVICE_UNAVAILABLE' }] }).kind).toBe('transient');
    expect(mapSquareError({ statusCode: null, errors: null })).toMatchObject({ kind: 'transient', code: 'NETWORK' });
  });
});
