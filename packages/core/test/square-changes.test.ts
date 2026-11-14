import { describe, expect, it } from 'vitest';
import {
  BookingChangeRequestSchema,
  FINAL_BOOKING_CHANGE_STATUSES,
  JOB_PAYLOAD_SCHEMAS,
  SELF_TEST_STEPS,
  bookingActions,
  bookingChangeIdempotencyKey,
  bookingChangeStatusWords,
  isFinalChangeStatus,
  nearestSlots,
  parseSquareCapabilities,
  parseSquareConfig,
  selfTestAllowed,
  selfTestChangeId,
  squareNotificationSentence,
  squareScopes,
  tier1Status,
  writeGateReason,
  type SquareTier1Status,
} from '../src/index.js';

const HOUR = 3600_000;
const service = { itemId: 'I1', itemName: 'Skin fade', variationId: 'V1', variationName: 'Regular', version: '7', durationMinutes: 45, price: null, availableForBooking: true, teamMemberIds: ['TM1'], archived: false, noShowFeeSeen: null };
const profile = { bookingEnabled: true, bookingPolicy: 'ACCEPT_ALL', allowUserCancel: true, supportSellerLevelWrites: true, cancellationWindowSeconds: null, cancellationFee: null, cancellationPolicy: null, minLeadSeconds: null, maxLeadSeconds: null };

/** A fully ticked checklist (Tier 1 switched on through the test-only override). */
function ready(over: { caps?: Record<string, unknown>; scopes?: string[]; confirmed?: boolean; available?: boolean } = {}): SquareTier1Status {
  const config = parseSquareConfig({
    environment: 'sandbox',
    snapshot: { fetchedAt: '2026-11-14T00:00:00Z', merchantName: 'Studio', locations: [], businessProfile: profile, teamMembers: [], services: [service] },
    serviceConfirmations: over.confirmed === false ? {} : { V1: { version: '7', confirmedBy: 'u', confirmedAt: 'x' } },
  });
  return tier1Status({
    config,
    capabilities: parseSquareCapabilities({ sellerLevelWrites: true, writesEnabled: true, selfTestStatus: 'passed', selfTestEnvironment: 'sandbox', selfTestMerchantId: 'M1', ...over.caps }),
    scopes: over.scopes ?? squareScopes('write'),
    environment: 'sandbox',
    merchantId: 'M1',
    available: over.available ?? true,
  });
}

describe('tier1Status with the test-only switch', () => {
  it('is ready only when every line is ticked and nothing is paused', () => {
    expect(ready()).toMatchObject({ available: true, ready: true });
    expect(ready({ available: false }).ready).toBe(false);
    expect(ready({ caps: { writesSuspendedReason: 'plan' } }).ready).toBe(false);
    expect(ready({ caps: { writesEnabled: false } }).ready).toBe(false);
  });
});

describe('writeGateReason (the gate both the web app and the worker apply)', () => {
  it('refuses on Tier 1 off, a pause, the plan flag, missing permissions, no bookable service, no self-test and the switch', () => {
    expect(writeGateReason({ tier1: ready(), selfTest: false })).toBeNull();
    expect(writeGateReason({ tier1: ready({ available: false }), selfTest: false })).toMatch(/aren’t available yet/);
    expect(writeGateReason({ tier1: ready({ caps: { writesSuspendedReason: 'plan' } }), selfTest: false })).toMatch(/^Paused: .*plan/);
    expect(writeGateReason({ tier1: ready({ caps: { sellerLevelWrites: false } }), selfTest: false })).toMatch(/plan doesn’t allow/);
    expect(writeGateReason({ tier1: ready({ scopes: squareScopes('read') }), selfTest: false })).toMatch(/permission/);
    expect(writeGateReason({ tier1: ready({ confirmed: false }), selfTest: false })).toMatch(/No service is confirmed/);
    expect(writeGateReason({ tier1: ready({ caps: { selfTestStatus: 'failed' } }), selfTest: false })).toMatch(/self-test/);
    expect(writeGateReason({ tier1: ready({ caps: { writesEnabled: false } }), selfTest: false })).toMatch(/switched off/);
  });
  it('lets the self-test run with lines 1–3 ticked, before it has passed and with the switch off', () => {
    const before = ready({ caps: { selfTestStatus: 'none', writesEnabled: false } });
    expect(writeGateReason({ tier1: before, selfTest: true })).toBeNull();
    expect(selfTestAllowed(before)).toBe(true);
    expect(writeGateReason({ tier1: before, selfTest: false })).not.toBeNull();
    expect(selfTestAllowed(ready({ available: false }))).toBe(false);
    expect(selfTestAllowed(ready({ scopes: squareScopes('read') }))).toBe(false);
  });
});

describe('bookingActions', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const future = new Date(now.getTime() + 24 * HOUR);
  const base = { tier1Ready: true, owner: true, status: 'ACCEPTED', startAt: future, missingFromSquare: false, serviceLabel: 'bookable' as const, now };
  it('offers Move and Cancel only to the owner, for accepted future bookings, while Tier 1 is ready', () => {
    expect(bookingActions(base)).toEqual({ move: { allowed: true, reason: null }, cancel: { allowed: true, reason: null } });
    expect(bookingActions({ ...base, owner: false }).cancel).toEqual({ allowed: false, reason: 'Only the owner can change bookings.' });
    expect(bookingActions({ ...base, tier1Ready: false }).move.allowed).toBe(false);
    expect(bookingActions({ ...base, status: 'PENDING' }).cancel.reason).toBe('Accept or decline this request in Square.');
    expect(bookingActions({ ...base, status: 'NO_SHOW' }).cancel.allowed).toBe(false);
    expect(bookingActions({ ...base, startAt: new Date(now.getTime() - HOUR) }).move.reason).toMatch(/already started/);
    expect(bookingActions({ ...base, missingFromSquare: true }).cancel.allowed).toBe(false);
  });
  it('keeps Cancel but not Move for a service that is not confirmed bookable', () => {
    const r = bookingActions({ ...base, serviceLabel: 'book_in_square' });
    expect(r.cancel.allowed).toBe(true);
    expect(r.move).toMatchObject({ allowed: false });
    expect(bookingActions({ ...base, serviceLabel: null }).move.allowed).toBe(false);
  });
});

describe('booking change contracts', () => {
  it('uses a stable idempotency key per change (≤ 255 characters, no secrets) and fixed self-test step ids', () => {
    expect(bookingChangeIdempotencyKey('abc')).toBe('sabc_abc');
    expect(bookingChangeIdempotencyKey('x'.repeat(64)).length).toBeLessThanOrEqual(255);
    expect(SELF_TEST_STEPS).toEqual(['create', 'reschedule', 'cancel']);
    expect(selfTestChangeId('t1', 'reschedule')).toBe('t1-reschedule');
  });
  it('validates what the owner approved: exact instants, the seller-note limit', () => {
    expect(BookingChangeRequestSchema.safeParse({ locationId: 'L', startAt: '2026-11-21T10:30:00+11:00' }).success).toBe(true);
    expect(BookingChangeRequestSchema.safeParse({ locationId: 'L', startAt: '2026-11-21 10:30' }).success).toBe(false);
    expect(BookingChangeRequestSchema.safeParse({ locationId: 'L', sellerNote: 'x'.repeat(4097) }).success).toBe(false);
  });
  it('registers the two job payloads', () => {
    expect(JOB_PAYLOAD_SCHEMAS['square.booking_change'].safeParse({ changeId: 'c1' }).success).toBe(true);
    expect(JOB_PAYLOAD_SCHEMAS['square.self_test'].safeParse({}).success).toBe(false);
  });
  it('never calls a change done before Square confirmed it', () => {
    for (const s of ['queued', 'checking', 'submitted']) {
      expect(bookingChangeStatusWords(s).done).toBe(false);
      expect(isFinalChangeStatus(s)).toBe(false);
    }
    expect(bookingChangeStatusWords('confirmed').label).toBe('Done in Square');
    expect(bookingChangeStatusWords('unknown').label).toBe('Couldn’t confirm with Square');
    for (const s of FINAL_BOOKING_CHANGE_STATUSES) expect(isFinalChangeStatus(s)).toBe(true);
    expect(FINAL_BOOKING_CHANGE_STATUSES.filter((s) => bookingChangeStatusWords(s).label.match(/Done|Booked/))).toEqual(['confirmed']);
  });
  it('words the client notification from the owner’s self-test answer (design §4.9)', () => {
    expect(squareNotificationSentence('yes')).toBe('Square will send its usual confirmation.');
    expect(squareNotificationSentence('no')).toMatch(/let the client know yourself/);
    expect(squareNotificationSentence('unknown')).toBe('Square decides whether the client is notified.');
  });
  it('keeps the alternatives nearest to the requested time, in time order', () => {
    const t0 = Date.parse('2026-11-21T00:00:00Z');
    const slots = [5, -1, 2, 30, -10].map((h) => ({ startAt: new Date(t0 + h * HOUR).toISOString() }));
    expect(nearestSlots(slots, new Date(t0).toISOString(), 3).map((s) => (Date.parse(s.startAt) - t0) / HOUR)).toEqual([-1, 2, 5]);
  });
});
