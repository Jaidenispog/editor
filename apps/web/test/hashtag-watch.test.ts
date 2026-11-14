import { describe, expect, it } from 'vitest';
import type { TrendWatch } from '@studio/db';
import { integrationPill } from '../src/components/app/integration-pill';
import { buildIntegrationStatuses } from '../src/lib/integrations';
import { INSTAGRAM_HASHTAG_STATUS_MESSAGES, buildTrendsIntegrations, instagramHashtagStatus, type TrendWatchFact } from '../src/lib/integrations/trends';
import type { ConnectionFacts } from '../src/lib/integrations/types';
import { trendSourceStatuses } from '../src/lib/trend-watches';
import { toTrendItemDto } from '../src/lib/trends';

const CLAIM = /trending|viral/i;
const META = { META_APP_ID: 'app', META_APP_SECRET: 'secret-value', META_LOGIN_CONFIG_ID: 'cfg' };
const connected: Pick<ConnectionFacts, 'connections' | 'socialAccounts'> = {
  connections: [{ provider: 'meta', status: 'connected', displayName: '@studio' }],
  socialAccounts: [{ platform: 'instagram', status: 'connected', username: 'studio', capabilities: { contentPublish: true } }],
};
const fact = (status: TrendWatchFact['status'], extra: Partial<TrendWatchFact> = {}): TrendWatchFact => ({ provider: 'instagram_hashtag', enabled: true, status, statusMessage: '', lastSuccessAt: null, ...extra });

describe('Instagram hashtag watch status (shared integration contract)', () => {
  it('needs the Meta app settings first, naming only the settings', () => {
    const s = instagramHashtagStatus({} as never, { connections: [], socialAccounts: [] }, null);
    expect(s).toMatchObject({ id: 'instagram_hashtags', state: 'not_configured', configured: false, connected: false, liveMode: null, verified: false, missingEnv: ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'] });
    expect(s.message).not.toMatch(/^Needs setup/);
    expect(integrationPill(s).label).toBe('Needs setup');
  });

  it('asks for Instagram to be connected, or reconnected, before anything else', () => {
    expect(instagramHashtagStatus(META as never, { connections: [], socialAccounts: [] }, [])).toMatchObject({ state: 'not_connected', liveMode: null, message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.noAccount });
    expect(instagramHashtagStatus(META as never, { connections: [{ provider: 'meta', status: 'needs_reauth', displayName: '' }], socialAccounts: connected.socialAccounts }, [])).toMatchObject({
      state: 'needs_reauth',
      message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.reconnect,
    });
    expect(instagramHashtagStatus(META as never, { connections: connected.connections, socialAccounts: [{ platform: 'instagram', status: 'needs_reauth', username: 'studio' }] }, [])).toMatchObject({ state: 'needs_reauth' });
    expect(instagramHashtagStatus(META as never, { connections: [{ provider: 'meta', status: 'disconnected', displayName: '' }], socialAccounts: [] }, [])).toMatchObject({ state: 'not_connected' });
  });

  it('is ready once Instagram is connected, and "not available" after a refused capability check', () => {
    expect(instagramHashtagStatus(META as never, connected, [])).toMatchObject({ state: 'not_connected', configured: true, liveMode: 'read_only', message: expect.stringMatching(/Settings → Trends/) });
    expect(instagramHashtagStatus(META as never, connected, null).message).toMatch(/@studio/);
    const refused = { ...connected, socialAccounts: [{ platform: 'instagram', status: 'connected', username: 'studio', capabilities: { hashtagSearch: false } }] };
    const s = instagramHashtagStatus(META as never, refused, [fact('ok')]);
    expect(s).toMatchObject({ state: 'unavailable', message: INSTAGRAM_HASHTAG_STATUS_MESSAGES.unavailable });
    expect(integrationPill(s).label).toBe('Not available');
  });

  it('maps the watched hashtags to one state, with the latest fetch time', () => {
    const at = '2026-11-13T19:05:00Z';
    expect(instagramHashtagStatus(META as never, connected, [fact('pending')])).toMatchObject({ state: 'not_connected', message: 'Turned on. Waiting for the first fetch.' });
    expect(instagramHashtagStatus(META as never, connected, [fact('ok', { lastSuccessAt: at }), fact('ok', { lastSuccessAt: '2026-11-12T19:05:00Z' })])).toMatchObject({
      state: 'connected',
      connected: true,
      liveMode: 'read_only',
      message: 'Watching 2 hashtags. Fetched once a day; read-only.',
      detail: 'Last fetched 14 Nov 2026, 6:05 am.',
    });
    expect(instagramHashtagStatus(META as never, connected, [fact('ok'), fact('error', { statusMessage: 'x' })]).message).toMatch(/One hashtag has a problem/);
    expect(instagramHashtagStatus(META as never, connected, [fact('quota', { statusMessage: 'Instagram asked us to slow down; trying again tomorrow.' })])).toMatchObject({ state: 'error', message: 'Instagram asked us to slow down; trying again tomorrow.' });
    expect(instagramHashtagStatus(META as never, connected, [fact('ok'), fact('needs_reauth')])).toMatchObject({ state: 'needs_reauth' });
    expect(instagramHashtagStatus(META as never, connected, [fact('unavailable')])).toMatchObject({ state: 'unavailable' });
    expect(instagramHashtagStatus(META as never, connected, [fact('ok', { enabled: false })])).toMatchObject({ state: 'not_connected' });
    for (const status of ['pending', 'ok', 'quota', 'error', 'unavailable', 'needs_reauth'] as const) {
      const s = instagramHashtagStatus(META as never, connected, [fact(status)]);
      expect(s.message).not.toMatch(CLAIM);
      expect(JSON.stringify(s)).not.toContain('secret-value');
    }
  });

  it('is listed after the YouTube chart in the trends cards and in the shared list', () => {
    const cards = buildTrendsIntegrations(META as never, { ...connected, trendWatches: [fact('ok')] });
    expect(cards.map((c) => c.id)).toEqual(['youtube_chart', 'instagram_hashtags']);
    const all = buildIntegrationStatuses({ ...META } as never, { ...connected, trendWatches: [] });
    expect(all.filter((s) => s.id === 'instagram_hashtags')).toHaveLength(1);
  });
});

describe('Instagram hashtag source card data', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const watch = (id: string, values: Partial<TrendWatch>): TrendWatch => ({
    id,
    provider: 'instagram_hashtag',
    query: id,
    externalId: null,
    socialAccountId: 'acc',
    enabled: true,
    status: 'ok',
    statusMessage: '',
    lastQueriedAt: null,
    lastSuccessAt: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...values,
  });

  it('lists the enabled hashtags, the one still fetching, and the weekly budget (turned-off ones still count)', () => {
    const watches = [
      watch('skinfade', { lastQueriedAt: new Date('2026-11-13T23:00:00Z') }),
      watch('taper', { status: 'pending', lastQueriedAt: null }),
      watch('oldfade', { enabled: false, lastQueriedAt: new Date('2026-11-10T00:00:00Z') }),
      watch('ancient', { enabled: false, lastQueriedAt: new Date('2026-11-01T00:00:00Z') }),
    ];
    const sources = trendSourceStatuses({ ...META }, watches, now, connected);
    expect(sources.map((s) => s.provider)).toEqual(['youtube_chart', 'instagram_hashtag']);
    const ig = sources[1]!;
    expect(ig.watches?.map((w) => w.query)).toEqual(['skinfade', 'taper']);
    expect(ig.watch?.query).toBe('taper');
    expect(ig.budget).toEqual({ used: 2, limit: 30, enabled: 2, maxEnabled: 10, nextFreeAt: null });
    expect(ig.status).toMatchObject({ id: 'instagram_hashtags', state: 'connected' });
    // Without the Instagram facts the card says it is not connected; it never guesses.
    expect(trendSourceStatuses({ ...META }, watches, now)[1]?.status.state).toBe('not_connected');
  });

  it('labels a stored hashtag item with trendLabel and never with a popularity word', () => {
    const row = {
      id: 'i1',
      title: 'Video under #skinfade, posted 12 Nov 2026',
      summary: '',
      category: 'other' as const,
      sourceName: 'Instagram hashtag watch',
      sourceUrl: 'https://www.instagram.com/p/abc/',
      sourceKind: 'live' as const,
      lastVerifiedAt: now,
      enabled: true,
      notedBy: null,
      watchId: 'skinfade',
      externalId: '18000000000000001',
      fetchedAt: new Date('2026-11-13T19:05:00Z'),
      staleAfter: new Date('2026-11-15T19:05:00Z'),
      data: { provider: 'instagram_hashtag', hashtag: 'skinfade', rank: 1, mediaType: 'VIDEO', postedAt: '2026-11-12T03:04:05.000Z', likeCount: 3, commentsCount: 0, permalink: 'https://www.instagram.com/p/abc/' },
      createdAt: now,
      updatedAt: now,
    };
    const dto = toTrendItemDto(row as never, null, now);
    expect(dto.label).toBe('Top posts under #skinfade — Instagram, fetched 14 Nov 2026, 6:05 am');
    expect(dto.label).not.toMatch(CLAIM);
    expect(dto.stale).toBe(false);
  });
});
