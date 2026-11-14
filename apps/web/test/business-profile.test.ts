import { describe, expect, it } from 'vitest';
import { AppSettingsSchema, buildQueryClassifier } from '@studio/core';
import { buildProfileNumbers, locationsOf, toGoogleReviewDto } from '../src/lib/business-profile';
import { businessProfileCard, businessProfileState, buildBusinessProfileIntegrations, profilePerformanceState } from '../src/lib/integrations/business_profile';
import { defaultRefId } from '../src/lib/jobs';
import { keywordCount, profileNumber } from '../src/lib/shared/business-profile-dto';

const env = { GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g' } as never;
const row = (extra: Record<string, unknown>) => ({ provider: 'google_business_profile', status: 'connected', displayName: '', ...extra });
const located = { account: 'accounts/1', location: 'locations/2', locationTitle: 'Ivanhoe Barber Co' };

describe('Business Profile card states (email design §4.8, website design §10.5)', () => {
  it('goes from not set up to connected, with "waiting for Google approval" while quota is 0', () => {
    const none = businessProfileCard({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } as never, undefined);
    expect(none).toMatchObject({ state: 'not_configured', missingEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], liveMode: null, connected: false });
    expect(businessProfileCard(env, undefined)).toMatchObject({ state: 'not_connected', configured: true });
    expect(businessProfileCard(env, row({ status: 'disconnected' }) as never).state).toBe('not_connected');
    // Signed in but Google not answered yet: "checking" only while a check is in flight (R13).
    expect(businessProfileCard(env, row({}) as never)).toMatchObject({ state: 'connected', stateLabel: 'Not checked yet', pillStatus: 'manual_step_required' });
    expect(businessProfileState(env, row({}) as never)).toBe('not_checked');
    expect(businessProfileState(env, row({}) as never, true)).toBe('checking');
    const waiting = businessProfileCard(env, row({ capabilities: { apiAccess: 'awaiting_approval' } }) as never);
    expect(waiting).toMatchObject({ state: 'awaiting_approval', stateLabel: 'Waiting for Google', liveMode: 'read_only' });
    expect(waiting.message).toMatch(/about 14 days and isn't guaranteed/);
    expect(businessProfileCard(env, row({ capabilities: { apiAccess: 'available' }, config: { locations: [{}, {}] } }) as never)).toMatchObject({ stateLabel: 'Choose location', pillStatus: 'manual_step_required' });
    const ok = businessProfileCard(env, row({ capabilities: { apiAccess: 'available', performanceApi: 'awaiting_approval' }, config: located }) as never);
    expect(ok).toMatchObject({ state: 'connected', liveMode: 'read_only', detail: 'Ivanhoe Barber Co', verified: false });
    expect(ok.message).toMatch(/Performance numbers: waiting for Google approval\.$/);
    expect(businessProfileCard(env, row({ status: 'needs_reauth', lastError: 'Google needs you to sign in again.' }) as never)).toMatchObject({ state: 'needs_reauth', message: 'Google needs you to sign in again.' });
    expect(businessProfileCard(env, row({ status: 'error', lastError: 'Turn on the API' }) as never)).toMatchObject({ state: 'error', message: 'Turn on the API' });
    for (const c of [none, waiting, ok]) expect(c.message).not.toMatch(/^Needs setup:/);
    expect(buildBusinessProfileIntegrations(env, { connections: [], socialAccounts: [] })).toHaveLength(1);
  });

  it('derives the Performance state from the shared connection', () => {
    expect(profilePerformanceState(env, undefined)).toBe('not_connected');
    expect(profilePerformanceState(env, row({ capabilities: { apiAccess: 'awaiting_approval' } }) as never)).toBe('awaiting_approval');
    expect(profilePerformanceState(env, row({ capabilities: { apiAccess: 'available' }, config: located }) as never)).toBe('not_checked');
    for (const s of ['available', 'awaiting_approval', 'api_disabled', 'error'] as const) {
      expect(profilePerformanceState(env, row({ capabilities: { apiAccess: 'available', performanceApi: s }, config: located }) as never)).toBe(s);
    }
    // A malformed stored location is never trusted.
    expect(businessProfileState(env, row({ capabilities: { apiAccess: 'available' }, config: { ...located, location: 'locations/../x' } }) as never)).toBe('choose_location');
  });
});

describe('Business Profile job attribution', () => {
  it('puts the Performance probe and sync on the Business Profile card (R16)', () => {
    expect(defaultRefId('website.connection_check', { provider: 'business_profile_performance', reason: 'manual' })).toBe('google_business_profile');
    expect(defaultRefId('search.sync', { source: 'business_profile', reason: 'manual' })).toBe('google_business_profile');
    expect(defaultRefId('website.connection_check', { provider: 'google_search_console', reason: 'manual' })).toBe('google_search_console');
  });
});

describe('Business Profile numbers (no placeholder numbers)', () => {
  const classifier = buildQueryClassifier(AppSettingsSchema.parse({ brand: { businessName: 'Ivanhoe Barber Co' }, business: { suburb: 'Ivanhoe', postcode: '3079' } }));

  it('sums only what Google returned; a metric with no values is null, a real 0 stays 0', () => {
    const out = buildProfileNumbers(
      [
        { date: '2026-11-01', metric: 'CALL_CLICKS', value: 3 },
        { date: '2026-11-02', metric: 'CALL_CLICKS', value: null },
        { date: '2026-11-03', metric: 'WEBSITE_CLICKS', value: 0 },
        { date: '2026-11-03', metric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', value: 120 },
        { date: '2026-11-04', metric: 'BUSINESS_BOOKINGS', value: null },
        { date: '2026-09-01', metric: 'CALL_CLICKS', value: 50 },
      ],
      [],
      classifier,
      '28d',
    );
    expect(out.dataThrough).toBe('2026-11-03');
    expect(out.totals).toEqual({ calls: 3, directions: null, website: 0, bookings: null, messages: null, search_views: null, maps_views: 120 });
    expect(out.viewParts).toEqual({ search: { mobile: null, desktop: null }, maps: { mobile: 120, desktop: null } });
    expect(out.keywords).toBeNull();
  });

  it('returns no numbers at all when Google returned none', () => {
    expect(buildProfileNumbers([{ date: '2026-11-01', metric: 'CALL_CLICKS', value: null }], [], classifier, '3m')).toEqual({ dataThrough: null, totals: null, viewParts: null, keywords: null });
  });

  it('groups the latest month of keywords and keeps "fewer than" thresholds', () => {
    const out = buildProfileNumbers(
      [],
      [
        { month: '2026-10', keyword: 'barber ivanhoe', value: 40, threshold: null },
        { month: '2026-10', keyword: 'ivanhoe barber co', value: null, threshold: 15 },
        { month: '2026-09', keyword: 'old', value: 99, threshold: null },
      ],
      classifier,
      '28d',
    );
    expect(out.keywords?.month).toBe('2026-10');
    expect(out.keywords?.groups.brand).toEqual([{ keyword: 'ivanhoe barber co', value: null, threshold: 15 }]);
    expect(out.keywords?.groups.local).toEqual([{ keyword: 'barber ivanhoe', value: 40, threshold: null }]);
  });

  it('shows "—" for a number Google did not send, never a made-up 0', () => {
    expect(profileNumber(null)).toBe('—');
    expect(profileNumber(undefined)).toBe('—');
    expect(profileNumber(0)).toBe('0');
    expect(profileNumber(1234)).toBe('1,234');
    expect(keywordCount({ keyword: 'a', value: null, threshold: 15 })).toBe('< 15');
    expect(keywordCount({ keyword: 'a', value: null, threshold: null })).toBe('—');
  });
});

describe('Google reviews as shown', () => {
  it('shows Google’s reply state and policy flag in plain words, and only well-formed locations', () => {
    const dto = toGoogleReviewDto({
      id: 'x',
      rating: 4,
      reviewerName: 'Sam',
      comment: 'Good',
      reviewCreatedAt: new Date('2026-10-01T00:00:00Z'),
      reviewUpdatedAt: new Date('2026-10-02T00:00:00Z'),
      replyText: null,
      raw: { reviewReplyState: 'REPLY_PENDING_REVIEW', policyViolation: { type: 'SPAM' } },
    });
    expect(dto).toMatchObject({ rating: 4, replyState: 'Reply pending review', policyFlag: 'Spam', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(locationsOf({ locations: [{ name: 'locations/1', title: 'A' }, { title: 'no name' }, 'x'] })).toEqual([{ name: 'locations/1', title: 'A', address: '' }]);
  });
});
