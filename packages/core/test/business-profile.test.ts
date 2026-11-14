import { describe, expect, it } from 'vitest';
import {
  JOB_PAYLOAD_SCHEMAS,
  PERFORMANCE_METRICS,
  PERFORMANCE_TILES,
  businessProfileApiState,
  googleWords,
  performanceDaily,
  performanceDataThrough,
  performanceTotals,
  starRatingToNumber,
} from '../src/index.js';

describe('Business Profile vocabulary', () => {
  it('maps Google star words to 1–5 and anything else to no rating', () => {
    expect(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].map(starRatingToNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(starRatingToNumber('STAR_RATING_UNSPECIFIED')).toBeNull();
    expect(starRatingToNumber(5)).toBeNull();
  });

  it('shows Google enum values as plain words without guessing their meaning', () => {
    expect(googleWords('REPLY_PUBLISHED')).toBe('Reply published');
    expect(googleWords({ type: 'OFF_TOPIC' })).toBe('Off topic');
    expect(googleWords({ somethingElse: 1 })).toBe('Flagged by Google');
    expect(googleWords('')).toBeNull();
    expect(googleWords(null)).toBeNull();
  });

  it('reads only known API states', () => {
    expect(businessProfileApiState('awaiting_approval')).toBe('awaiting_approval');
    expect(businessProfileApiState('approved')).toBeNull();
    expect(businessProfileApiState(undefined)).toBeNull();
  });

  it('requests MESSAGING_CLICKS and never BUSINESS_CONVERSATIONS (memo §7); every tile uses known metrics', () => {
    expect(PERFORMANCE_METRICS).toContain('MESSAGING_CLICKS');
    expect(PERFORMANCE_METRICS as readonly string[]).not.toContain('BUSINESS_CONVERSATIONS');
    for (const tile of PERFORMANCE_TILES) for (const m of tile.metrics) expect(PERFORMANCE_METRICS).toContain(m);
  });

  it('totals only what Google returned: nothing → null, never 0; a real 0 stays 0', () => {
    const rows = [
      { date: '2026-11-01', metric: 'CALL_CLICKS', value: 2 },
      { date: '2026-11-02', metric: 'CALL_CLICKS', value: null },
      { date: '2026-11-02', metric: 'WEBSITE_CLICKS', value: 0 },
      { date: '2026-11-02', metric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', value: 10 },
      { date: '2026-11-02', metric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', value: 5 },
    ];
    expect(performanceTotals(rows)).toEqual({ calls: 2, directions: null, website: 0, bookings: null, messages: null, search_views: 15, maps_views: null });
    expect(performanceDaily(rows).map((d) => [d.date, d.values.calls])).toEqual([
      ['2026-11-01', 2],
      ['2026-11-02', null],
    ]);
    expect(performanceDataThrough(rows)).toBe('2026-11-02');
    expect(performanceDataThrough([{ date: '2026-11-03', metric: 'CALL_CLICKS', value: null }])).toBeNull();
  });

  it('extends the website queues backwards-compatibly', () => {
    expect(JOB_PAYLOAD_SCHEMAS['website.connection_check'].parse({ provider: 'website' })).toEqual({ provider: 'website', reason: 'manual' });
    expect(JOB_PAYLOAD_SCHEMAS['website.connection_check'].parse({ provider: 'business_profile_performance', reason: 'daily' })).toMatchObject({ provider: 'business_profile_performance' });
    expect(JOB_PAYLOAD_SCHEMAS['search.sync'].parse({ source: 'search_console' })).toEqual({ source: 'search_console', reason: 'daily' });
    expect(JOB_PAYLOAD_SCHEMAS['search.sync'].parse({ source: 'business_profile', reason: 'connect' })).toMatchObject({ source: 'business_profile' });
    expect(() => JOB_PAYLOAD_SCHEMAS['reviews.gbp.sync'].parse({ reason: 'hourly' })).toThrow();
  });
});
