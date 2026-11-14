import { describe, expect, it } from 'vitest';
import { loadEnv } from '@studio/config';
import { parseSquareCapabilities, parseSquareConfig, squareScopes, tier1Status } from '@studio/core';
import { buildIntegrationStatuses } from '../src/lib/integrations';
import { defaultRefId } from '../src/lib/jobs';
import { JOB_TYPE_LABELS } from '../src/lib/shared/dto';
import { changeTimeLabel, toChangeDto, type BookingChangeRow } from '../src/lib/square/change-dto';
import { enableReason } from '../src/lib/square/status';

/** Square booking changes (WP6b): what the browser sees of a change, labels, the switch rule and the shared status. */

const names = new Map([['TM_SAM', 'Sam']]);
function row(over: Partial<BookingChangeRow> = {}): BookingChangeRow {
  return {
    id: 'chg1',
    kind: 'create',
    environment: 'sandbox',
    merchantId: 'M1',
    bookingId: null,
    squareBookingId: null,
    request: { locationId: 'LOC_1', squareCustomerId: 'CUST_1', startAt: '2026-11-21T23:30:00.000Z', durationMinutes: 45, teamMemberId: 'TM_SAM', serviceVariationId: 'VAR_FADE' },
    idempotencyKey: 'sabc_chg1',
    status: 'queued',
    statusMessage: '',
    httpStatus: null,
    errorCode: null,
    squareResponse: null,
    freshSlots: null,
    selfTestId: null,
    requestedBy: 'u1',
    submittedAt: null,
    finishedAt: null,
    createdAt: new Date('2026-11-14T00:00:00Z'),
    updatedAt: new Date('2026-11-14T00:00:00Z'),
    ...over,
  };
}

describe('toChangeDto', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  it('never shows the idempotency key or Square ids, and says the time with the zone in force that day', () => {
    const dto = toChangeDto(row(), names, now);
    expect(JSON.stringify(dto)).not.toMatch(/sabc_|CUST_1|M1/);
    // 23:30 UTC on 21 Nov is 10:30 am on Sun 22 Nov in Melbourne (AEDT).
    expect(dto.startLabel).toBe('Sun 22 Nov, 10:30–11:15 am AEDT');
    expect(dto).toMatchObject({ status: 'queued', done: false, canWithdraw: true, squareDetail: null, freshSlots: null });
  });
  it('shows Square’s own words only for a refusal, and the alternatives only when the time was taken', () => {
    const refusal = { errors: [{ code: 'INVALID_VALUE', detail: '<b>No</b> fee-protected bookings' }] };
    expect(toChangeDto(row({ status: 'rejected', squareResponse: refusal }), names, now).squareDetail).toBe('<b>No</b> fee-protected bookings');
    expect(toChangeDto(row({ status: 'confirmed', squareResponse: { id: 'BK1' } }), names, now)).toMatchObject({ squareDetail: null, done: true, statusLabel: 'Done in Square', canWithdraw: false });
    const taken = toChangeDto(row({ status: 'slot_unavailable', freshSlots: [{ startAt: '2026-11-22T00:00:00.000Z', teamMemberId: 'TM_SAM', durationMinutes: 45 }] }), names, now);
    expect(taken.freshSlots).toEqual([expect.objectContaining({ startLabel: '11:00 am', endLabel: '11:45 am', teamMemberName: 'Sam', dayLabel: 'Sun 22 Nov' })]);
  });
});

describe('changeTimeLabel', () => {
  it('uses AEST in winter, AEDT in summer, and keeps am/pm on both ends when they differ', () => {
    expect(changeTimeLabel(new Date('2027-06-15T01:30:00Z'), 45, new Date('2027-01-01T00:00:00Z'))).toBe('Tue 15 June, 11:30 am–12:15 pm AEST');
    expect(changeTimeLabel(new Date('2026-12-01T22:00:00Z'), null, new Date('2026-11-01T00:00:00Z'))).toBe('Wed 2 Dec, 9:00 am AEDT');
  });
});

describe('enableReason (the booking-changes switch)', () => {
  const config = parseSquareConfig({
    environment: 'sandbox',
    snapshot: {
      fetchedAt: 'x',
      merchantName: 'S',
      locations: [],
      businessProfile: null,
      teamMembers: [],
      services: [{ itemId: 'I', itemName: 'Fade', variationId: 'V', variationName: '', version: '1', durationMinutes: 45, price: null, availableForBooking: true, teamMemberIds: ['T'], archived: false, noShowFeeSeen: null }],
    },
    serviceConfirmations: { V: { version: '1', confirmedBy: 'u', confirmedAt: 'x' } },
  });
  const t = (caps: Record<string, unknown>) => tier1Status({ config, capabilities: parseSquareCapabilities(caps), scopes: squareScopes('write'), environment: 'sandbox', merchantId: 'M1', available: true });
  it('needs lines 1–4, ignores the switch itself, and lets a pause be cleared once the cause is fixed', () => {
    const ticked = { sellerLevelWrites: true, selfTestStatus: 'passed', selfTestEnvironment: 'sandbox', selfTestMerchantId: 'M1' };
    expect(enableReason(t(ticked))).toBeNull();
    expect(enableReason(t({ ...ticked, writesSuspendedReason: 'plan' }))).toBeNull();
    expect(enableReason(t({ ...ticked, selfTestMerchantId: 'OTHER' }))).toMatch(/self-test/);
    expect(enableReason(t({ ...ticked, sellerLevelWrites: false }))).toMatch(/plan/);
  });
});

describe('Square booking-change jobs and the shared status list', () => {
  it('puts progress on the change or the self-test, with plain labels', () => {
    expect(defaultRefId('square.booking_change', { changeId: 'c1' })).toBe('c1');
    expect(defaultRefId('square.self_test', { selfTestId: 't1' })).toBe('t1');
    expect(JOB_TYPE_LABELS['square.booking_change']).toBe('Making a booking change in Square');
    expect(JOB_TYPE_LABELS['square.self_test']).toBe('Running the Square booking-changes self-test');
  });
  it('counts Square as verified only after a passed self-test on live Square', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40), SQUARE_APPLICATION_ID: 'a', SQUARE_APPLICATION_SECRET: 'b', SQUARE_ENVIRONMENT: 'production' });
    const facts = (environment: string, caps: Record<string, unknown>) => ({
      socialAccounts: [],
      connections: [{ provider: 'square', status: 'connected', displayName: 'Studio', config: { environment, locationId: 'L' }, capabilities: caps, lastSyncAt: new Date(), lastError: null }],
    });
    const square = (f: ReturnType<typeof facts>, e = env) => buildIntegrationStatuses(e, f as never).find((x) => x.id === 'square');
    expect(square(facts('production', {}))?.verified).toBe(false);
    expect(square(facts('production', { selfTestStatus: 'passed', selfTestEnvironment: 'sandbox' }))?.verified).toBe(false);
    expect(square(facts('production', { selfTestStatus: 'passed', selfTestEnvironment: 'production' }))?.verified).toBe(true);
    const sandboxEnv = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40), SQUARE_APPLICATION_ID: 'a', SQUARE_APPLICATION_SECRET: 'b', SQUARE_ENVIRONMENT: 'sandbox' });
    expect(square(facts('sandbox', { selfTestStatus: 'passed', selfTestEnvironment: 'sandbox' }), sandboxEnv)?.verified).toBe(false);
  });
});
