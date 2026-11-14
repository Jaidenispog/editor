import { describe, expect, it } from 'vitest';
import { AppSettingsSchema, buildQueryClassifier, type WebsiteChange } from '@studio/core';
import { buildWebsiteIntegrations } from '../src/lib/integrations/website';
import { PAGES_NOT_READ, countsLine, findingsNote } from '../src/components/website/check-words';
import { mergeSettings } from '../src/lib/settings-merge';
import { applyAvailability, checkedWordPressBaseUrl, groupSearchRows, missingBusinessDetails, openingHoursLines } from '../src/lib/website';

const env = { GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g' } as never;
const card = (facts: { connections: Array<Record<string, unknown>> }, e = env) => {
  const list = buildWebsiteIntegrations(e, { socialAccounts: [], ...facts } as never);
  return { gsc: list.find((s) => s.id === 'google_search_console')!, wp: list.find((s) => s.id === 'website_editing')! };
};

describe('website integration cards (design §10.5)', () => {
  it('Search Console: not configured, not connected, choose property, connected, reconnect and error', () => {
    const none = card({ connections: [] }, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } as never);
    expect(none.gsc).toMatchObject({ state: 'not_configured', missingEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], liveMode: null });
    expect(card({ connections: [] }).gsc).toMatchObject({ state: 'not_connected', configured: true, connected: false });
    expect(card({ connections: [{ provider: 'google_search_console', status: 'disconnected', displayName: '' }] }).gsc.state).toBe('not_connected');
    const choose = card({ connections: [{ provider: 'google_search_console', status: 'connected', displayName: '', config: {} }] }).gsc;
    expect(choose).toMatchObject({ state: 'connected', stateLabel: 'Choose property', liveMode: 'read_only' });
    const ok = card({ connections: [{ provider: 'google_search_console', status: 'connected', displayName: '', config: { siteUrl: 'sc-domain:example.com.au' } }] }).gsc;
    expect(ok).toMatchObject({ state: 'connected', liveMode: 'read_only', detail: 'sc-domain:example.com.au', verified: false });
    expect(card({ connections: [{ provider: 'google_search_console', status: 'needs_reauth', displayName: '' }] }).gsc.state).toBe('needs_reauth');
    expect(card({ connections: [{ provider: 'google_search_console', status: 'error', displayName: '', lastError: 'Turn on the API' }] }).gsc).toMatchObject({
      state: 'error',
      message: 'Turn on the API',
    });
    for (const c of [none.gsc, ok, choose]) expect(c.message).not.toMatch(/^Needs setup:/);
  });

  it('WordPress: never "not configured"; checking, live or staging, reconnect and error', () => {
    expect(card({ connections: [] }).wp).toMatchObject({ state: 'not_connected', configured: true, missingEnv: [] });
    expect(card({ connections: [{ provider: 'website', status: 'not_configured', displayName: 'x' }] }).wp).toMatchObject({ state: 'not_connected', stateLabel: 'Checking' });
    const staging = card({
      connections: [{ provider: 'website', status: 'connected', displayName: 'studio-assistant', capabilities: { environment: 'staging', roles: 'editor' } }],
    }).wp;
    expect(staging).toMatchObject({ state: 'connected', liveMode: 'staging', detail: 'Editor · staging site' });
    expect(staging.message).toContain('Connected as studio-assistant (Editor)');
    expect(card({ connections: [{ provider: 'website', status: 'connected', displayName: 'a', capabilities: { environment: 'live', roles: 'editor' } }] }).wp.liveMode).toBe(
      'live',
    );
    expect(card({ connections: [{ provider: 'website', status: 'needs_reauth', displayName: '' }] }).wp.state).toBe('needs_reauth');
    expect(card({ connections: [{ provider: 'website', status: 'error', displayName: '', lastError: 'REST blocked' }] }).wp).toMatchObject({
      state: 'error',
      message: 'REST blocked',
    });
  });
});

describe('apply availability', () => {
  const text: WebsiteChange = { kind: 'text_replace', pageUrl: 'https://e.com/', before: 'a', after: 'b' };
  const title: WebsiteChange = { kind: 'page_title', pageUrl: 'https://e.com/', before: 'Home', after: 'A good long title here' };
  const conn = { status: 'connected' as const, capabilities: { supportedKinds: 'text_replace,image_alt_text' } };
  it('needs a connected adapter that supports the kind, and an open change', () => {
    expect(applyAvailability(text, 'proposed', null)).toEqual({ ok: false, reason: 'Connect WordPress in Settings → Integrations to apply changes from here.' });
    expect(applyAvailability(text, 'proposed', { status: 'needs_reauth', capabilities: {} }).reason).toMatch(/needs attention/);
    expect(applyAvailability(title, 'proposed', conn)).toEqual({ ok: false, reason: "WordPress can't change page titles through its standard connection; use the steps instead." });
    expect(applyAvailability(text, 'apply_failed', conn)).toEqual({ ok: true, reason: null });
    expect(applyAvailability(text, 'applied', conn).ok).toBe(false);
  });
});

describe('search grouping at read time', () => {
  const settings = AppSettingsSchema.parse({ brand: { businessName: 'Fade Republic' }, business: { website: 'https://faderepublic.example.com.au/' } });
  const rows = [
    { periodStart: '2026-11-01', kind: 'total', key: '', clicks: 20, impressions: 500, position: 9 },
    { periodStart: '2026-11-01', kind: 'query', key: 'fade republic', clicks: 10, impressions: 100, position: 1 },
    { periodStart: '2026-11-01', kind: 'query', key: 'barber ivanhoe', clicks: 4, impressions: 200, position: 6 },
    { periodStart: '2026-11-01', kind: 'query', key: 'skin fade', clicks: 1, impressions: 100, position: 12 },
    { periodStart: '2026-11-02', kind: 'total', key: '', clicks: 2, impressions: 50, position: 8 },
    { periodStart: '2026-11-02', kind: 'query', key: 'barber ivanhoe', clicks: 3, impressions: 60, position: 4 },
  ];
  it('groups, weights position by impressions, and keeps "not listed" separate (clamped per day)', () => {
    const out = groupSearchRows(rows, buildQueryClassifier(settings));
    expect(out.groups?.brand).toEqual({ clicks: 10, impressions: 100, position: 1 });
    expect(out.groups?.local).toEqual({ clicks: 7, impressions: 260, position: Math.round(((6 * 200 + 4 * 60) / 260) * 10) / 10 });
    expect(out.groups?.service.impressions).toBe(100);
    expect(out.notListed).toEqual({ clicks: 5, impressions: 100 });
    expect(out.daily).toEqual([
      { date: '2026-11-01', brand: 100, local: 200, service: 100, other: 0, notListed: 100 },
      { date: '2026-11-02', brand: 0, local: 60, service: 0, other: 0, notListed: 0 },
    ]);
    expect(out.dataThrough).toBe('2026-11-02');
    expect(out.topQueries?.local[0]).toMatchObject({ query: 'barber ivanhoe', impressions: 260 });
  });
  it('returns no numbers without rows', () => {
    expect(groupSearchRows([], buildQueryClassifier(settings))).toEqual({ groups: null, notListed: null, daily: [], topQueries: null, dataThrough: null });
  });
});

describe('settings for the website module', () => {
  it('PUT /api/settings drops the server-only ownership fields but keeps word lists', () => {
    const current = AppSettingsSchema.parse({});
    const merged = mergeSettings(current, { website: { ownershipConfirmedHost: 'evil.example', ownershipConfirmedAt: new Date().toISOString(), placeTerms: ['Heidelberg'] } });
    expect(merged.website.ownershipConfirmedHost).toBeNull();
    expect(merged.website.ownershipConfirmedAt).toBeNull();
    expect(merged.website.placeTerms).toEqual(['Heidelberg']);
    const hours = mergeSettings(current, { business: { openingHours: [{ day: 'Sa', opens: '08:00', closes: '14:00' }] } });
    expect(hours.business.openingHours).toEqual([{ day: 'Sa', opens: '08:00', closes: '14:00' }]);
    expect(() => mergeSettings(current, { business: { openingHours: [{ day: 'Sa', opens: '14:00', closes: '08:00' }] } })).toThrow();
  });
  it('lists missing details with what they enable, and opening hours as plain lines', () => {
    const missing = missingBusinessDetails(AppSettingsSchema.parse({}));
    expect(missing.map((m) => m.field)).toEqual(['businessName', 'addressLine', 'phone', 'bookingLink', 'openingHours']);
    expect(openingHoursLines([{ day: 'Tu', opens: '09:00', closes: '17:30' }])).toContain('Tuesday: 09:00–17:30');
    expect(openingHoursLines([])).toContain('Monday: Closed');
  });
});

describe('website check wording when no page was read', () => {
  const summary = (pagesChecked: number, partialReasons: string[] = []) => ({
    pagesChecked,
    pagesSkipped: 0,
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    partialReasons,
  });
  it('never says "nothing to fix" for a check that read no page, and gives the stored reason', () => {
    const reason = "Your robots.txt asks automated tools not to read your site, so we didn't check it.";
    expect(countsLine(summary(0, [reason]))).toBe('No pages could be read');
    expect(countsLine(summary(3))).toBe('Nothing to fix');
    const empty = findingsNote(0, { reasons: [reason] });
    expect(empty).toContain(PAGES_NOT_READ);
    expect(empty).toContain(reason);
    expect(empty).not.toMatch(/nothing to fix/i);
    expect(findingsNote(1, { reasons: [] })).toContain(PAGES_NOT_READ);
    expect(findingsNote(0, null)).toBe('The check found nothing to fix. Nice work.');
    expect(findingsNote(2, null)).toBeNull();
  });
});

describe('WordPress address rule and the test-only fixture host', () => {
  const FIXTURE = 'http://ivanhoe-studio.test:4701';
  /** A resolver that answers loopback for every name (what the fixture host would resolve to if it were looked up). */
  const looked: string[] = [];
  const loopback = async (host: string) => {
    looked.push(host);
    return [{ address: '127.0.0.1' }];
  };
  const publicDns = async () => [{ address: '93.184.215.14' }];
  const refused = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(message) });

  it('ignores WEBSITE_FIXTURE_BASE_URL outside NODE_ENV=test: plain http and the private-address check apply to the fixture host', async () => {
    for (const NODE_ENV of ['production', 'development'] as const) {
      const env = { NODE_ENV, WEBSITE_FIXTURE_BASE_URL: FIXTURE };
      await refused(checkedWordPressBaseUrl('http://ivanhoe-studio.test', env, loopback), /https:\/\//);
      await refused(checkedWordPressBaseUrl('http://ivanhoe-studio.test/', env, loopback), /https:\/\//);
      // Over https the name is looked up like any other and refused when it points to a private address.
      looked.length = 0;
      await refused(checkedWordPressBaseUrl('https://ivanhoe-studio.test', env, loopback), /private or reserved address/);
      expect(looked).toEqual(['ivanhoe-studio.test']);
    }
  });

  it('under NODE_ENV=test allows plain http for exactly the fixture host (no port, no look-up) and nothing else', async () => {
    const env = { NODE_ENV: 'test' as const, WEBSITE_FIXTURE_BASE_URL: FIXTURE };
    looked.length = 0;
    await expect(checkedWordPressBaseUrl('http://ivanhoe-studio.test/', env, loopback)).resolves.toBe('http://ivanhoe-studio.test');
    expect(looked).toEqual([]);
    for (const other of ['http://other.example', 'http://www.ivanhoe-studio.test', 'http://ivanhoe-studio.test.evil.example', 'http://127.0.0.1', 'http://localhost']) {
      await refused(checkedWordPressBaseUrl(other, env, publicDns), /https:\/\//);
    }
    await refused(checkedWordPressBaseUrl('http://ivanhoe-studio.test:4701', env, loopback), /https:\/\//);
    for (const literal of ['https://127.0.0.1', 'https://10.0.0.5', 'https://[::1]', 'https://169.254.169.254', 'https://localhost']) {
      await refused(checkedWordPressBaseUrl(literal, env, publicDns), /private|reserved|local|not a public/);
    }
    await refused(checkedWordPressBaseUrl('https://rebind.example', env, loopback), /private or reserved address/);
    await expect(checkedWordPressBaseUrl('https://studio.example.com.au/blog/', env, publicDns)).resolves.toBe('https://studio.example.com.au/blog');
  });

  it('without WEBSITE_FIXTURE_BASE_URL even NODE_ENV=test keeps the https rule', async () => {
    await refused(checkedWordPressBaseUrl('http://ivanhoe-studio.test', { NODE_ENV: 'test', WEBSITE_FIXTURE_BASE_URL: undefined }, loopback), /https:\/\//);
  });
});
