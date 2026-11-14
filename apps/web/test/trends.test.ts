import { describe, expect, it } from 'vitest';
import type { TrendWatch } from '@studio/db';
import { defaultRefId } from '../src/lib/jobs';
import { YOUTUBE_NOT_CONFIGURED_MESSAGE, buildTrendsIntegrations, youTubeChartStatus, type TrendWatchFact } from '../src/lib/integrations/trends';
import { trendSourceStatuses } from '../src/lib/trend-watches';
import { CreateTrendSchema, NoteTrendSchema, toTrendItemDto } from '../src/lib/trends';

const CLAIM = /trending|viral/i;
const fact = (status: TrendWatchFact['status'], extra: Partial<TrendWatchFact> = {}): TrendWatchFact => ({ provider: 'youtube_chart', enabled: true, status, statusMessage: '', lastSuccessAt: null, ...extra });

describe('YouTube chart integration status', () => {
  it('needs setup without a key, naming only the setting', () => {
    const s = youTubeChartStatus({}, null);
    expect(s).toMatchObject({ id: 'youtube_chart', configured: false, connected: false, state: 'not_configured', liveMode: null, missingEnv: ['YOUTUBE_API_KEY'], message: YOUTUBE_NOT_CONFIGURED_MESSAGE, verified: false });
  });

  it('never shows the key and points to Settings → Trends when the watches are not read', () => {
    const [s] = buildTrendsIntegrations({ YOUTUBE_API_KEY: 'secret-key' } as never, { connections: [], socialAccounts: [] });
    expect(s).toMatchObject({ configured: true, connected: false, state: 'not_connected', liveMode: 'read_only' });
    expect(JSON.stringify(s)).not.toContain('secret-key');
    expect(s?.message).toMatch(/Settings → Trends/);
  });

  it('shows the chart\'s real state in the shared list when the aggregator passes the watches', () => {
    const [s] = buildTrendsIntegrations({ YOUTUBE_API_KEY: 'k' } as never, { connections: [], socialAccounts: [], trendWatches: [fact('ok', { lastSuccessAt: '2026-11-13T19:05:00Z' })] });
    expect(s).toMatchObject({ state: 'connected', connected: true, liveMode: 'read_only', detail: 'Last fetched 14 Nov 2026, 6:05 am.' });
  });

  it('maps every watch state to the shared contract', () => {
    const env = { YOUTUBE_API_KEY: 'k' };
    expect(youTubeChartStatus(env, [])).toMatchObject({ state: 'not_connected', connected: false });
    expect(youTubeChartStatus(env, [fact('ok', { enabled: false })])).toMatchObject({ state: 'not_connected' });
    expect(youTubeChartStatus(env, [fact('pending')])).toMatchObject({ state: 'not_connected', message: 'Turned on. Waiting for the first fetch.' });
    expect(youTubeChartStatus(env, [fact('ok', { lastSuccessAt: '2026-11-13T19:05:00Z' })])).toMatchObject({ state: 'connected', connected: true, liveMode: 'read_only', detail: 'Last fetched 14 Nov 2026, 6:05 am.' });
    expect(youTubeChartStatus(env, [fact('quota', { statusMessage: 'Daily limit.' })])).toMatchObject({ state: 'error', message: 'Daily limit.' });
    expect(youTubeChartStatus(env, [fact('error', { statusMessage: 'The YouTube API key isn’t valid.' })])).toMatchObject({ state: 'error', message: 'The YouTube API key isn’t valid.' });
    for (const status of ['pending', 'ok', 'quota', 'error', 'unavailable', 'needs_reauth'] as const) {
      expect(youTubeChartStatus(env, [fact(status)]).message).not.toMatch(CLAIM);
    }
  });

  it('builds the source card with its watch and the next manual refresh time', () => {
    const now = new Date('2026-11-14T00:00:00Z');
    const watch = { id: 'w1', provider: 'youtube_chart', query: 'AU', externalId: null, socialAccountId: null, enabled: true, status: 'ok', statusMessage: '', lastQueriedAt: new Date('2026-11-13T23:00:00Z'), lastSuccessAt: new Date('2026-11-13T23:00:00Z'), createdBy: null, createdAt: now, updatedAt: now } satisfies TrendWatch;
    const [card] = trendSourceStatuses({ YOUTUBE_API_KEY: 'k' }, [watch], now);
    expect(card).toMatchObject({ provider: 'youtube_chart', status: { state: 'connected' }, watch: { id: 'w1', status: 'ok', nextRefreshAt: '2026-11-14T05:00:00.000Z' } });
  });

  it('puts trends.refresh progress on its watch', () => {
    expect(defaultRefId('trends.refresh', { watchId: 'w9' })).toBe('w9');
    expect(defaultRefId('trends.refresh', { watchId: null })).toBeNull();
  });
});

describe('trend item labels and request schemas', () => {
  const base = {
    id: 'r1',
    title: 'Fade process',
    summary: 'Close-ups',
    category: 'format' as const,
    sourceName: 'Guides',
    sourceUrl: 'https://example.com/a',
    sourceKind: 'curated' as const,
    lastVerifiedAt: new Date('2026-11-09T01:00:00Z'),
    enabled: true,
    watchId: null,
    externalId: null,
    fetchedAt: null,
    staleAfter: null,
    data: {},
    notedBy: null,
    createdAt: new Date('2026-11-09T01:00:00Z'),
    updatedAt: new Date('2026-11-09T01:00:00Z'),
  };

  it('labels each group with trendLabel and flags review dates and staleness', () => {
    const now = new Date('2027-06-01T00:00:00Z');
    const curated = toTrendItemDto(base, null, now);
    expect(curated).toMatchObject({ kind: 'curated', label: 'Guides · last reviewed 9 Nov 2026', dueForReview: true, editorSuggestion: false, sources: [{ name: 'Guides', url: 'https://example.com/a' }] });
    expect(toTrendItemDto({ ...base, sourceUrl: '' }, null, now)).toMatchObject({ editorSuggestion: true, label: 'Editor suggestion — no external source · last reviewed 9 Nov 2026', sources: [] });

    const noted = toTrendItemDto({ ...base, sourceKind: 'noted', sourceName: 'Noted by staff', notedBy: 'u1', data: { platform: 'tiktok', seenOn: '2026-11-12' } }, 'Sam', now);
    expect(noted).toMatchObject({ kind: 'noted', label: 'Noted by Sam on 12 Nov 2026 · seen on TikTok', platform: 'tiktok', seenOn: '2026-11-12', notedById: 'u1' });

    const fetchedAt = new Date('2026-11-13T19:05:00Z');
    const live = toTrendItemDto(
      { ...base, sourceKind: 'live', watchId: 'w1', externalId: 'abcdefghijk', fetchedAt, staleAfter: new Date(fetchedAt.getTime() + 48 * 3_600_000), data: { provider: 'youtube_chart', channelTitle: 'Chan', categoryId: '10', url: 'https://www.youtube.com/watch?v=abcdefghijk', position: 3 } },
      null,
      new Date('2026-11-14T00:00:00Z'),
    );
    expect(live).toMatchObject({ kind: 'live', label: 'YouTube AU popular chart (music/movies/gaming) — fetched 14 Nov 2026, 6:05 am', stale: false, channelTitle: 'Chan', categoryName: 'Music', position: 3 });
    expect(toTrendItemDto({ ...base, sourceKind: 'live', fetchedAt, staleAfter: new Date('2026-11-15T19:05:00Z') }, null, new Date('2026-11-16T00:00:00Z')).stale).toBe(true);
    for (const item of [curated, noted, live]) expect(item.label).not.toMatch(CLAIM);
  });

  it('keeps clients from choosing the kind and checks notes', () => {
    expect(CreateTrendSchema.parse({ title: 'X', sourceName: 'Me', sourceKind: 'live' })).not.toHaveProperty('sourceKind');
    expect(NoteTrendSchema.safeParse({ title: 'X', platform: 'tiktok', seenOn: '2026-11-12' }).success).toBe(true);
    expect(NoteTrendSchema.safeParse({ title: 'X', platform: 'tiktok', seenOn: '2026-02-30' }).success).toBe(false);
    expect(NoteTrendSchema.safeParse({ title: 'X', platform: 'tiktok', seenOn: '2999-01-01' }).success).toBe(false);
    expect(NoteTrendSchema.safeParse({ title: 'X', platform: 'myspace', seenOn: '2026-11-12' }).success).toBe(false);
    expect(NoteTrendSchema.safeParse({ title: 'X', platform: 'tiktok', seenOn: '2026-11-12', sourceUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
});
