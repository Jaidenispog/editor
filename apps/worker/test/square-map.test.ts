import { describe, expect, it } from 'vitest';
import type { Square } from 'square';
import { bookingFromSdk } from '../src/square/api.js';

/** Normalising Square's booking objects (no network, no database). */
describe('bookingFromSdk', () => {
  const booking = (startAt: string): Square.Booking => ({ id: 'BK_1', version: 2, status: 'ACCEPTED', startAt, locationId: 'L1', appointmentSegments: [] }) as unknown as Square.Booking;

  it('keeps a booking whose start is an RFC 3339 instant', () => {
    expect(bookingFromSdk(booking('2026-11-20T23:00:00Z'))?.startAt).toBe('2026-11-20T23:00:00Z');
    expect(bookingFromSdk(booking('2026-11-21T10:00:00+11:00'))?.id).toBe('BK_1');
  });

  it('skips (and reports the id of) a booking whose start is a local time or not a time at all (design §4.8)', () => {
    const skipped: string[] = [];
    for (const bad of ['2026-11-21 10:00', '2026-11-21T10:00:00', '21/11/2026 10:00am', 'tomorrow']) {
      expect(bookingFromSdk(booking(bad), (id) => skipped.push(id))).toBeNull();
    }
    expect(skipped).toEqual(['BK_1', 'BK_1', 'BK_1', 'BK_1']);
  });
});
