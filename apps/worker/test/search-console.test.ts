import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { siteScopeFrom } from '@studio/core';
import {
  SEARCH_ROW_LIMIT,
  SearchConsoleError,
  autoSelectProperty,
  fetchWindow,
  listSites,
  mapSearchConsoleError,
  pacificToday,
  parseAnalyticsRows,
  permissionLabel,
  syncWindows,
} from '../src/lib/google/search-console.js';
import { fakeFetch, json } from './helpers/fakes.js';

const logger = pino({ level: 'silent' });
const scope = siteScopeFrom('https://www.ivanhoebarber.example.com.au/');

describe('Search Console response mapping (recorded-shape fixtures)', () => {
  it('lists properties with permission levels', async () => {
    const f = fakeFetch(() =>
      json(200, {
        siteEntry: [
          {
            siteUrl: 'sc-domain:ivanhoebarber.example.com.au',
            permissionLevel: 'siteOwner',
          },
          {
            siteUrl: 'https://other.example/',
            permissionLevel: 'siteUnverifiedUser',
          },
        ],
      }),
    );
    const sites = await listSites({ fetch: f, logger }, 'token');
    expect(sites).toEqual([
      {
        siteUrl: 'sc-domain:ivanhoebarber.example.com.au',
        permissionLevel: 'siteOwner',
      },
      {
        siteUrl: 'https://other.example/',
        permissionLevel: 'siteUnverifiedUser',
      },
    ]);
    expect(f.calls[0]?.headers['authorization']).toBe('Bearer token');
    expect(permissionLabel('siteUnverifiedUser')).toBe('No access');
    expect(await listSites({ fetch: fakeFetch(() => json(200, {})), logger }, 't')).toEqual([]);
  });

  it('auto-selects the Domain property first, else one URL-prefix match, else nothing', () => {
    const domain = {
      siteUrl: 'sc-domain:ivanhoebarber.example.com.au',
      permissionLevel: 'siteFullUser',
    };
    const prefix = {
      siteUrl: 'https://ivanhoebarber.example.com.au/',
      permissionLevel: 'siteOwner',
    };
    const prefixWww = {
      siteUrl: 'https://www.ivanhoebarber.example.com.au/',
      permissionLevel: 'siteOwner',
    };
    expect(autoSelectProperty([prefix, domain], scope)).toBe(domain.siteUrl);
    expect(autoSelectProperty([prefix], scope)).toBe(prefix.siteUrl);
    expect(autoSelectProperty([prefix, prefixWww], scope)).toBeNull();
    expect(autoSelectProperty([{ ...domain, permissionLevel: 'siteUnverifiedUser' }], scope)).toBeNull();
    expect(autoSelectProperty([{ siteUrl: 'https://other.example/', permissionLevel: 'siteOwner' }], scope)).toBeNull();
  });

  it('parses rows and refuses unrecognised shapes instead of guessing', () => {
    expect(
      parseAnalyticsRows(
        {
          rows: [
            {
              keys: ['2026-11-01', 'barber ivanhoe'],
              clicks: 3,
              impressions: 40,
              ctr: 0.075,
              position: 4.2,
            },
          ],
        },
        'query',
      ),
    ).toEqual([
      {
        periodStart: '2026-11-01',
        kind: 'query',
        key: 'barber ivanhoe',
        clicks: 3,
        impressions: 40,
        position: 4.2,
      },
    ]);
    expect(parseAnalyticsRows({}, 'total')).toEqual([]);
    expect(() => parseAnalyticsRows({ rows: [{ keys: ['Nov 1'], clicks: 1, impressions: 1 }] }, 'total')).toThrow(SearchConsoleError);
    expect(() => parseAnalyticsRows({ rows: 'x' }, 'total')).toThrow(/wasn't recognised/);
  });

  it('pages per-query rows with startRow until a short page', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const row = (i: number) => ({
      keys: ['2026-11-01', `q${i}`],
      clicks: 0,
      impressions: 1,
      position: 9,
    });
    const f = fakeFetch((call) => {
      const body = JSON.parse(call.body) as Record<string, unknown>;
      bodies.push(body);
      if ((body['dimensions'] as string[]).length === 1)
        return json(200, {
          rows: [{ keys: ['2026-11-01'], clicks: 5, impressions: 100, position: 7 }],
        });
      const n = body['startRow'] === 0 ? SEARCH_ROW_LIMIT : 3;
      return json(200, { rows: Array.from({ length: n }, (_, i) => row(i)) });
    });
    const rows = await fetchWindow({ fetch: f, logger }, 't', 'sc-domain:ivanhoebarber.example.com.au', { startDate: '2026-10-05', endDate: '2026-11-04' });
    expect(rows).toHaveLength(1 + SEARCH_ROW_LIMIT + 3);
    expect(bodies.map((b) => b['startRow'] ?? null)).toEqual([null, 0, SEARCH_ROW_LIMIT]);
    expect(bodies[1]).toMatchObject({
      dimensions: ['date', 'query'],
      type: 'web',
      rowLimit: SEARCH_ROW_LIMIT,
    });
    expect(bodies[1]).not.toHaveProperty('dataState');
    expect(f.calls[0]?.url).toBe('https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aivanhoebarber.example.com.au/searchAnalytics/query');
  });

  it('maps errors: 401 reauth, disabled API, no access, removed property, transient', () => {
    expect(mapSearchConsoleError(401, {}).kind).toBe('reauth');
    expect(
      mapSearchConsoleError(403, {
        error: {
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      }).kind,
    ).toBe('api_disabled');
    expect(
      mapSearchConsoleError(403, {
        error: { message: 'User does not have sufficient permission' },
      }).kind,
    ).toBe('no_access');
    expect(mapSearchConsoleError(404, {}).kind).toBe('not_found');
    expect(mapSearchConsoleError(429, {}).kind).toBe('transient');
    expect(mapSearchConsoleError(503, {}).kind).toBe('transient');
  });

  it('backfills 16 months in 31-day windows oldest first, otherwise re-fetches 10 days', () => {
    const windows = syncWindows(true, '2026-11-12');
    expect(windows[0]?.startDate).toBe('2025-07-12');
    expect(windows.at(-1)?.endDate).toBe('2026-11-12');
    expect(windows.length).toBeGreaterThanOrEqual(16);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.startDate > windows[i - 1]!.endDate).toBe(true);
    expect(syncWindows(false, '2026-11-12')).toEqual([{ startDate: '2026-11-03', endDate: '2026-11-12' }]);
    expect(pacificToday(new Date('2026-11-14T03:00:00Z'))).toBe('2026-11-13');
  });
});
