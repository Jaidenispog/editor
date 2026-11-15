import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPublishingIntegrations } from '../src/lib/integrations/publishing';
import { verifyZernioSignature } from '../src/lib/publishing';
import { buildCreateRequest, draftProblems, initialDraft, methodOption } from '../src/components/publishing/composer-state';
import { methodLabel } from '../src/components/publishing/labels';
import type { EligibilityItemDto } from '../src/lib/shared/publishing-dto';

/** TikTok through Zernio, web pieces without a database (design §5.3 states, composer choices, webhook signature). */

const tiktokCard = (env: Record<string, unknown>, facts: { connections?: Array<Record<string, unknown>>; socialAccounts?: Array<Record<string, unknown>> } = {}) =>
  buildPublishingIntegrations(env as never, { connections: (facts.connections ?? []) as never, socialAccounts: (facts.socialAccounts ?? []) as never }).find((i) => i.id === 'tiktok')!;

describe('the TikTok card (design §5.3)', () => {
  const on = { TIKTOK_PUBLISH_PROVIDER: 'zernio', ZERNIO_API_BASE_URL: 'https://zernio.com/api' };

  it('without the flag says nothing about Zernio beyond "off", and manual posting comes first', () => {
    const c = tiktokCard({});
    expect(c).toMatchObject({ state: 'unavailable', configured: false, connected: false, missingEnv: [] });
    expect(c.message).toMatch(/^Post it yourself works now/);
  });

  it('walks through not configured, not connected, choose account, connected (live), verified, reconnect and error', () => {
    expect(tiktokCard({ TIKTOK_PUBLISH_PROVIDER: 'zernio' })).toMatchObject({ state: 'not_configured', missingEnv: ['ZERNIO_API_BASE_URL'] });
    expect(tiktokCard(on).state).toBe('not_connected');
    const conn = (status: string, lastError: string | null = null) => [{ provider: 'zernio', status, displayName: '', lastError }];
    const noAccount = tiktokCard(on, { connections: conn('connected') });
    expect(noAccount.state).toBe('not_connected');
    expect(noAccount.message).toMatch(/Choose your TikTok account/);
    const live = tiktokCard(on, { connections: conn('connected'), socialAccounts: [{ platform: 'tiktok', status: 'connected', username: 'ivanhoe_cuts', capabilities: {} }] });
    expect(live).toMatchObject({ state: 'connected', connected: true, liveMode: 'live', verified: false, detail: '@ivanhoe_cuts' });
    expect(live.message).toMatch(/real, public TikTok post/);
    expect(live.message).toMatch(/public immediately/);
    expect(tiktokCard(on, { connections: conn('connected'), socialAccounts: [{ platform: 'tiktok', status: 'connected', username: 'ivanhoe_cuts', capabilities: { verifiedDirectAt: '2026-11-15T00:00:00Z' } }] })).toMatchObject({ state: 'connected', verified: true });
    expect(tiktokCard(on, { connections: conn('needs_reauth', "Zernio didn't accept this key.") }).state).toBe('needs_reauth');
    expect(tiktokCard(on, { connections: conn('connected'), socialAccounts: [{ platform: 'tiktok', status: 'needs_reauth', username: 'ivanhoe_cuts' }] }).state).toBe('needs_reauth');
    const err = tiktokCard(on, { connections: conn('error', 'Connect TikTok inside Zernio first, then press Check connection.') });
    expect(err.state).toBe('error');
    expect(err.message).toMatch(/Connect TikTok inside Zernio first/);
    for (const c of [live, err, noAccount]) expect(c.message).not.toMatch(/^Needs setup:/);
  });
});

describe('composer choices for Zernio', () => {
  const seeds = { allowComment: { enabled: true, default: true }, allowDuet: { enabled: true, default: false }, allowStitch: { enabled: false, default: false } };
  const item: EligibilityItemDto = {
    versionId: 'v1',
    projectId: 'p1',
    projectTitle: 'Skin fade',
    styleName: 'Clean promo',
    versionNo: 1,
    previewUrl: null,
    durationSec: 10,
    exportStatus: 'ready',
    noMusicExportStatus: 'none',
    defaultCoverTimeSec: 7.5,
    captionSuffix: null,
    hasMusic: false,
    eligibility: [
      { platform: 'instagram', allowedVariants: ['standard'], automationAllowedForStandard: true, reasons: [], manualStepHint: null, downloadLabel: null },
      { platform: 'tiktok', allowedVariants: ['standard'], automationAllowedForStandard: true, reasons: [], manualStepHint: null, downloadLabel: null },
    ],
    notes: [],
    methods: {
      instagram: [{ method: 'manual', available: true, isVerification: false, handle: '@studio' }],
      tiktok: [
        { method: 'zernio', delivery: 'publish', available: true, isVerification: true, accountId: 'a1', handle: '@studio', tiktokInteractions: seeds },
        { method: 'zernio', delivery: 'draft', available: false, reason: 'Sending to TikTok drafts is switched off in Settings → Integrations.', isVerification: false, accountId: 'a1', handle: '@studio', tiktokInteractions: seeds },
        { method: 'manual', available: true, isVerification: false, handle: '@studio' },
      ],
    },
    priorTargets: [],
  };

  it('starts on "Post it yourself" with TikTok off; Zernio is only ever chosen by the owner', () => {
    const d = initialDraft(item, '');
    expect(d.destinations.tiktok).toEqual({ enabled: false, method: 'manual', delivery: 'publish', variant: 'standard' });
  });

  it('tells the two Zernio options apart and sends the delivery the owner picked', () => {
    expect(methodOption(item, 'tiktok', 'zernio', 'publish')?.available).toBe(true);
    expect(methodOption(item, 'tiktok', 'zernio', 'draft')?.available).toBe(false);
    const d = initialDraft(item, 'Fresh fade');
    d.destinations.tiktok = { enabled: true, method: 'zernio', delivery: 'draft', variant: 'standard' };
    expect(draftProblems(item, d).join(' ')).toMatch(/drafts is switched off/);
    d.destinations.tiktok.delivery = 'publish';
    expect(draftProblems(item, d)).toEqual([]);
    expect(buildCreateRequest([d]).items[0]?.['targets']).toEqual([{ platform: 'tiktok', method: 'zernio', delivery: 'publish', variant: 'standard' }]);
  });

  it('labels the methods in plain words', () => {
    expect(methodLabel('zernio', 'publish', false)).toBe('Publish via Zernio');
    expect(methodLabel('zernio', 'draft', false)).toBe('Send to TikTok drafts via Zernio');
    expect(methodLabel('zernio', 'publish', true)).toBe('First verification post (publish via Zernio)');
    expect(methodLabel('instagram_api', undefined, true)).toBe('First verification post (publish from Studio Assistant)');
    expect(methodLabel('manual', undefined, false)).toBe('Post it yourself');
  });
});

describe('Zernio webhook signature (lowercase hex HMAC-SHA256 of the raw body)', () => {
  const secret = 's3cret-for-tests';
  const body = '{"id":"evt_1","event":"post.published"}';
  const good = createHmac('sha256', secret).update(body).digest('hex');
  it('accepts only the exact signature of the exact bytes', () => {
    expect(verifyZernioSignature(secret, body, good)).toBe(true);
    expect(verifyZernioSignature(secret, body, good.toUpperCase())).toBe(true);
    expect(verifyZernioSignature(secret, `${body} `, good)).toBe(false);
    expect(verifyZernioSignature('other', body, good)).toBe(false);
    expect(verifyZernioSignature(secret, body, good.slice(0, 10))).toBe(false);
    expect(verifyZernioSignature(secret, body, null)).toBe(false);
    expect(verifyZernioSignature(secret, body, 'z'.repeat(64))).toBe(false);
  });
});
