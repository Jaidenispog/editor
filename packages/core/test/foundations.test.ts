import { describe, expect, it } from 'vitest';
import type { EditPlan } from '../src/edit-plan.js';
import { isGenuinelyCompleted } from '../src/completion.js';
import { PlanFactsSchema, computePlanFacts } from '../src/plan-facts.js';
import { ALL_JOB_TYPES, JOB_PAYLOAD_SCHEMAS, JOB_TYPES, isJobType } from '../src/jobs.js';
import { AppSettingsSchema, DEFAULT_SETTINGS, resolveLegalUrls } from '../src/settings.js';
import { LEGAL_PAGE_KINDS, publishedLegalPage, suggestedLegalDraft } from '../src/settings/legal.js';
import { GOOGLE_OAUTH_PRODUCTS, googleProductForProvider } from '../src/integrations.js';

describe('isGenuinelyCompleted', () => {
  const at = new Date('2026-11-10T03:00:00Z');
  const cases: Array<[string, string, Date | null, boolean]> = [
    ['ACCEPTED', 'payment', at, true],
    ['ACCEPTED', 'owner_marked', at, true],
    ['ACCEPTED', 'square_status', at, false],
    ['ACCEPTED', 'none', at, false],
    ['ACCEPTED', 'none', null, false],
    ['ACCEPTED', 'payment', null, false],
    ['ACCEPTED', 'owner_marked', null, false],
    ['NO_SHOW', 'payment', at, false],
    ['NO_SHOW', 'owner_marked', at, false],
    ['CANCELLED_BY_CUSTOMER', 'payment', at, false],
    ['CANCELLED_BY_SELLER', 'owner_marked', at, false],
    ['DECLINED', 'payment', at, false],
    ['PENDING', 'owner_marked', at, false],
    ['accepted', 'payment', at, false],
  ];
  it.each(cases)('status %s, source %s, completedAt %s → %s', (status, completionSource, completedAt, expected) => {
    expect(isGenuinelyCompleted({ status, completionSource, completedAt })).toBe(expected);
  });
});

function fixturePlan(): EditPlan {
  const seg = (id: string, inSec: number, outSec: number, extra: Partial<EditPlan['segments'][number]> = {}) => ({
    id,
    assetId: 'a1',
    inSec,
    outSec,
    speed: 1,
    framing: { mode: 'centre' as const, focusX: 0.5, focusY: 0.5 },
    zoom: null,
    transitionIn: null,
    role: 'cutting' as const,
    keepOriginalSound: false,
    ...extra,
  });
  return {
    version: 1,
    styleId: 'beat_montage',
    title: 'Fixture',
    description: 'Fixture plan',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 10,
    segments: [
      seg('s1', 0, 2),
      seg('s2', 2, 5, { transitionIn: { type: 'fade', durationSec: 0.5 } }),
      seg('s3', 5, 6, { transitionIn: { type: 'wipeleft', durationSec: 0.5 } }),
      seg('s4', 6, 10, { speed: 2, transitionIn: { type: 'zoomin', durationSec: 0.25 } }),
    ],
    textOverlays: [
      { id: 't1', text: 'Fresh fade', startSec: 0.5, endSec: 2, placement: 'lower', style: 'headline', animation: 'fade', emphasis: 'normal' },
      { id: 't2', text: 'Book now', startSec: 5, endSec: 6, placement: 'lower', style: 'label', animation: 'fade', emphasis: 'accent' },
    ],
    captions: [],
    audio: {
      music: { trackId: 'm1', startOffsetSec: 12.3456, volume: 0.7, fadeInSec: 0.3, fadeOutSec: 1.2, duckUnderOriginal: true },
      originalSound: { enabled: false, volume: 1 },
      beatAlignment: { bpm: 120, alignedCutTimesSec: [2, 4.5] },
      loudnessTargetLufs: -14,
    },
    colourPreset: 'punchy',
  };
}

describe('computePlanFacts', () => {
  it('summarises a plan with music, transitions and text', () => {
    const facts = computePlanFacts(fixturePlan());
    // Shots: 2, 3, 1, 2 (4 s at double speed); transitions overlap 0.5 + 0.5 + 0.25.
    expect(facts).toEqual({
      styleId: 'beat_montage',
      durationSec: 6.75,
      segmentCount: 4,
      avgShotSec: 2,
      medianShotSec: 2,
      textOverlayCount: 2,
      textPer10Sec: 2.963,
      transitionCount: 3,
      flashyTransitionCount: 2,
      colourPreset: 'punchy',
      hasMusic: true,
      musicTrackId: 'm1',
      musicVolume: 0.7,
      musicStartSec: 12.346,
      originalSound: false,
      beatAligned: true,
    });
    expect(PlanFactsSchema.parse(facts)).toEqual(facts);
  });

  it('describes a plan without music that keeps original sound', () => {
    const plan = fixturePlan();
    plan.audio = { music: null, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 };
    plan.segments = [plan.segments[0]!, { ...plan.segments[1]!, keepOriginalSound: true, transitionIn: null }, plan.segments[2]!];
    plan.textOverlays = [];
    const facts = computePlanFacts(plan);
    expect(facts).toMatchObject({
      segmentCount: 3,
      medianShotSec: 2,
      textOverlayCount: 0,
      textPer10Sec: 0,
      transitionCount: 1,
      flashyTransitionCount: 1,
      hasMusic: false,
      musicTrackId: null,
      musicVolume: null,
      musicStartSec: null,
      originalSound: true,
      beatAligned: false,
    });
  });
});

describe('job registry', () => {
  it('has a payload schema for every job type name and a name for every schema', () => {
    const names = Object.values(JOB_TYPES).sort();
    expect(Object.keys(JOB_PAYLOAD_SCHEMAS).sort()).toEqual(names);
    expect([...ALL_JOB_TYPES].sort()).toEqual(names);
  });

  it('keeps the Stage A types and adds the shared Stage B/C ones', () => {
    for (const t of ['ingest.asset', 'edits.generate', 'edits.revise', 'render.preview', 'render.export', 'music.analyse', 'maintenance.cleanup', 'webhook.process', 'google.disconnect']) {
      expect(isJobType(t), t).toBe(true);
    }
    expect(isJobType('nope.never')).toBe(false);
    expect(isJobType('toString')).toBe(false);
    expect(JOB_PAYLOAD_SCHEMAS['webhook.process'].parse({ webhookEventId: 'w1' })).toEqual({ webhookEventId: 'w1' });
    expect(() => JOB_PAYLOAD_SCHEMAS['google.disconnect'].parse({})).toThrow();
  });

  it('names follow <module>.<action>', () => {
    for (const t of ALL_JOB_TYPES) expect(t).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });
});

describe('settings sections', () => {
  it('fills the legal section and the new business links for settings saved before they existed', () => {
    const old = { brand: {}, business: { suburb: 'Ivanhoe' }, preferences: {} };
    const parsed = AppSettingsSchema.parse(old);
    expect(parsed.business.termsUrl).toBe('');
    expect(parsed.business.privacyUrl).toBe('');
    for (const kind of LEGAL_PAGE_KINDS) expect(parsed.legal[kind]).toEqual({ draft: '', published: '', publishedAt: null });
  });

  it('serves a legal page only once it is published', () => {
    const s = AppSettingsSchema.parse({ legal: { privacy: { draft: 'Draft text', published: '', publishedAt: null } } });
    expect(publishedLegalPage(s.legal, 'privacy')).toBeNull();
    const published = AppSettingsSchema.parse({ legal: { privacy: { draft: 'x', published: 'Our policy', publishedAt: '2026-11-14T01:00:00.000Z' } } });
    expect(publishedLegalPage(published.legal, 'privacy')).toEqual({ title: 'Privacy policy', body: 'Our policy', publishedAt: '2026-11-14T01:00:00.000Z' });
  });

  it('resolves legal URLs: owner links win, own pages only when published', () => {
    expect(resolveLegalUrls(DEFAULT_SETTINGS, 'https://studio.example.com/')).toEqual({ privacy: null, terms: null, dataDeletion: null });
    const s = AppSettingsSchema.parse({
      business: { termsUrl: 'https://example.com.au/terms' },
      legal: { privacy: { published: 'P', publishedAt: '2026-11-14T01:00:00Z' }, dataDeletion: { published: 'D', publishedAt: '2026-11-14T01:00:00Z' } },
    });
    expect(resolveLegalUrls(s, 'https://studio.example.com')).toEqual({
      privacy: 'https://studio.example.com/privacy',
      terms: 'https://example.com.au/terms',
      dataDeletion: 'https://studio.example.com/data-deletion',
    });
  });

  it('suggests drafts from the business details without inventing contact details', () => {
    const facts = { businessName: 'Ivanhoe Cuts', addressLine: '1 Upper Heidelberg Rd', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', email: '', phone: '03 9000 0000', website: '' };
    const privacy = suggestedLegalDraft('privacy', facts);
    expect(privacy).toContain('Ivanhoe Cuts');
    expect(privacy).toContain('call 03 9000 0000');
    expect(privacy).not.toMatch(/@|\[|TODO/);
    const none = suggestedLegalDraft('dataDeletion', { ...facts, phone: '', addressLine: '', suburb: '', state: '', postcode: '' });
    expect(none).toContain('Ask us in the studio.');
    expect(suggestedLegalDraft('terms', facts)).toMatch(/never linked to a discount or reward/);
  });
});

describe('Google products', () => {
  it('maps each product to its own connection row and a read-only scope', () => {
    expect(GOOGLE_OAUTH_PRODUCTS.business_profile).toMatchObject({ provider: 'google_business_profile', scope: 'https://www.googleapis.com/auth/business.manage' });
    expect(GOOGLE_OAUTH_PRODUCTS.search_console).toMatchObject({ provider: 'google_search_console', scope: 'https://www.googleapis.com/auth/webmasters.readonly' });
    expect(googleProductForProvider('google_search_console')).toBe('search_console');
    expect(googleProductForProvider('square')).toBeNull();
  });
});
