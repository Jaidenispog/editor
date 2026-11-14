import { describe, expect, it } from 'vitest';
import {
  addDaysToDate,
  melbourneDateOf,
  melbourneDayRange,
  melbourneLocalToUtc,
  melbourneTimeOf,
  melbourneZoneLabel,
  nextSendSlot,
} from '../src/time.js';

const HOUR = 3600_000;

describe('melbourneLocalToUtc', () => {
  it('converts ordinary times in both zones', () => {
    expect(melbourneLocalToUtc('2026-12-01', '09:30')).toEqual({ ok: true, instant: new Date('2026-11-30T22:30:00Z'), ambiguous: false });
    expect(melbourneLocalToUtc('2026-07-01', '09:30')).toEqual({ ok: true, instant: new Date('2026-06-30T23:30:00Z'), ambiguous: false });
  });

  it('reports 02:30 on 4 October 2026 as nonexistent (clocks go forward)', () => {
    expect(melbourneLocalToUtc('2026-10-04', '02:30')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(melbourneLocalToUtc('2026-10-04', '02:00')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(melbourneLocalToUtc('2026-10-04', '01:59')).toMatchObject({ ok: true, ambiguous: false });
    expect(melbourneLocalToUtc('2026-10-04', '03:00')).toEqual({ ok: true, instant: new Date('2026-10-03T16:00:00Z'), ambiguous: false });
  });

  it('picks the first 02:30 on 4 April 2027 (clocks go back): 15:30Z on 3 April', () => {
    expect(melbourneLocalToUtc('2027-04-04', '02:30')).toEqual({ ok: true, instant: new Date('2027-04-03T15:30:00Z'), ambiguous: true });
    expect(melbourneLocalToUtc('2027-04-04', '03:00')).toEqual({ ok: true, instant: new Date('2027-04-03T17:00:00Z'), ambiguous: false });
  });

  it('rejects malformed or impossible input', () => {
    expect(melbourneLocalToUtc('2026-02-30', '10:00')).toEqual({ ok: false, reason: 'invalid' });
    expect(melbourneLocalToUtc('2026-1-01', '10:00')).toEqual({ ok: false, reason: 'invalid' });
    expect(melbourneLocalToUtc('2026-01-01', '24:00')).toEqual({ ok: false, reason: 'invalid' });
    expect(melbourneLocalToUtc('2026-01-01', '9:00')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('melbourne date helpers', () => {
  it('finds the Melbourne date and time of an instant', () => {
    expect(melbourneDateOf(new Date('2026-11-30T13:30:00Z'))).toBe('2026-12-01');
    expect(melbourneTimeOf(new Date('2026-11-30T13:30:00Z'))).toBe('00:30');
    expect(melbourneDateOf(new Date('2026-06-30T13:30:00Z'))).toBe('2026-06-30');
  });

  it('labels the zone by date', () => {
    expect(melbourneZoneLabel('2026-12-25')).toBe('AEDT');
    expect(melbourneZoneLabel('2026-07-01')).toBe('AEST');
    expect(melbourneZoneLabel(new Date('2027-04-03T15:30:00Z'))).toBe('AEDT');
    expect(melbourneZoneLabel(new Date('2027-04-03T16:30:00Z'))).toBe('AEST');
  });

  it('adds days across month and year ends', () => {
    expect(addDaysToDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToDate('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('melbourneDayRange', () => {
  const hours = (date: string) => {
    const r = melbourneDayRange(date);
    return (r.end.getTime() - r.start.getTime()) / HOUR;
  };

  it('gives 23-, 24- and 25-hour days', () => {
    expect(hours('2026-10-04')).toBe(23);
    expect(hours('2027-10-03')).toBe(23);
    expect(hours('2026-04-05')).toBe(25);
    expect(hours('2027-04-04')).toBe(25);
    expect(hours('2026-11-14')).toBe(24);
    expect(hours('2026-07-15')).toBe(24);
  });

  it('starts at Melbourne midnight', () => {
    expect(melbourneDayRange('2026-11-14')).toEqual({ start: new Date('2026-11-13T13:00:00Z'), end: new Date('2026-11-14T13:00:00Z') });
    expect(melbourneDayRange('2026-10-04')).toEqual({ start: new Date('2026-10-03T14:00:00Z'), end: new Date('2026-10-04T13:00:00Z') });
  });

  it('refuses a malformed date', () => {
    expect(() => melbourneDayRange('2026-13-01')).toThrow();
  });
});

describe('nextSendSlot', () => {
  it('keeps a time inside the window', () => {
    const t = new Date('2026-11-16T00:15:00Z'); // 11:15 AEDT
    expect(nextSendSlot(t)).toEqual(t);
  });

  it('moves an early time to 9 am the same day and a late time to 9 am the next day', () => {
    expect(nextSendSlot(new Date('2026-11-15T19:00:00Z'))).toEqual(new Date('2026-11-15T22:00:00Z')); // 06:00 → 09:00 AEDT
    expect(nextSendSlot(new Date('2026-11-16T08:00:00Z'))).toEqual(new Date('2026-11-16T22:00:00Z')); // 19:00 → next 09:00
    expect(nextSendSlot(new Date('2026-11-16T07:59:00Z'))).toEqual(new Date('2026-11-16T07:59:00Z')); // 18:59 stays
  });

  it('handles the October change (clocks go forward)', () => {
    // 20:00 AEST on Saturday 3 October → 09:00 AEDT on Sunday 4 October (UTC+11).
    expect(nextSendSlot(new Date('2026-10-03T10:00:00Z'))).toEqual(new Date('2026-10-03T22:00:00Z'));
    // 02:30 does not exist; 01:30 AEST → 09:00 AEDT the same morning.
    expect(nextSendSlot(new Date('2026-10-03T15:30:00Z'))).toEqual(new Date('2026-10-03T22:00:00Z'));
  });

  it('handles the April change (clocks go back)', () => {
    // 20:00 AEDT on Saturday 3 April 2027 → 09:00 AEST on Sunday 4 April (UTC+10).
    expect(nextSendSlot(new Date('2027-04-03T09:00:00Z'))).toEqual(new Date('2027-04-03T23:00:00Z'));
    // The second 02:30 (AEST) → 09:00 AEST.
    expect(nextSendSlot(new Date('2027-04-03T16:30:00Z'))).toEqual(new Date('2027-04-03T23:00:00Z'));
  });

  it('honours a custom window and rejects a backwards one', () => {
    expect(nextSendSlot(new Date('2026-11-16T00:15:00Z'), { start: '12:00', end: '13:00' })).toEqual(new Date('2026-11-16T01:00:00Z'));
    expect(() => nextSendSlot(new Date(), { start: '19:00', end: '09:00' })).toThrow();
  });
});
