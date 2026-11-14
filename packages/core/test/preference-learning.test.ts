import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  EditingPreferencesSchema,
  STYLE_IDS,
  computeLearnedPreferences,
  effectivePreferences,
  explainEvidence,
  parseStoredSettings,
  preferenceSource,
  styleAffinityFrom,
  type EditingPreferences,
  type LearningEvent,
  type PlanFacts,
  type StyleId,
} from '../src/index.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function facts(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return {
    styleId: 'clean_promo',
    durationSec: 20,
    segmentCount: 10,
    avgShotSec: 1.85,
    medianShotSec: 1.8,
    textOverlayCount: 2,
    textPer10Sec: 1,
    transitionCount: 4,
    flashyTransitionCount: 0,
    colourPreset: 'clean',
    hasMusic: true,
    musicTrackId: 't1',
    musicVolume: 0.85,
    musicStartSec: 0,
    originalSound: false,
    beatAligned: false,
    ...overrides,
  };
}

let seq = 0;
function ev(type: LearningEvent['type'], opts: { version?: string; edit?: string; style?: StyleId; at?: string; data?: Record<string, unknown> } = {}): LearningEvent {
  seq++;
  const version = opts.version ?? `v${seq}`;
  return { id: `e${String(seq).padStart(4, '0')}`, type, createdAt: opts.at ?? NOW.toISOString(), editId: opts.edit ?? `edit-${version}`, editVersionId: version, styleId: opts.style ?? 'clean_promo', data: opts.data ?? {} };
}
const fav = (version: string, f: PlanFacts, at?: string) => ev('favourite', { version, edit: `edit-${version}`, style: f.styleId, data: { planFacts: f }, ...(at ? { at } : {}) });
const prefs = (p: Partial<EditingPreferences> = {}): EditingPreferences => ({ ...DEFAULT_SETTINGS.preferences, ...p });

describe('computeLearnedPreferences', () => {
  it('learns nothing from no events', () => {
    const out = computeLearnedPreferences([], prefs(), NOW);
    expect(out).toEqual({ computedAt: NOW.toISOString(), eventsConsidered: 0, since: null, fields: {}, error: null });
  });

  it('learns a 20 s default from three favourites around 20 s when 25 s is declared', () => {
    const events = [fav('a', facts({ durationSec: 19.6 })), fav('b', facts({ durationSec: 20.4, styleId: 'process_story' })), fav('c', facts({ durationSec: 21 }))];
    const out = computeLearnedPreferences(events, prefs(), NOW);
    expect(out.fields.defaultDurationSec?.value).toBe(20);
    expect(out.fields.defaultDurationSec?.counts.favourites).toBe(3);
    expect(out.fields.defaultDurationSec?.explanation).toMatch(/^From 3 favourites since \d{1,2} Nov 2026\.$/);
  });

  it('does not emit a length within 3 s of the declared value', () => {
    const events = [fav('a', facts({ durationSec: 24 })), fav('b', facts({ durationSec: 24 })), fav('c', facts({ durationSec: 24 }))];
    expect(computeLearnedPreferences(events, prefs(), NOW).fields.defaultDurationSec).toBeUndefined();
  });

  it('cancels a favourite with a later unfavourite', () => {
    const f = facts({ durationSec: 15 });
    const events = [fav('a', f), fav('b', f), fav('c', f), ev('unfavourite', { version: 'c', edit: 'edit-c', data: { planFacts: f } })];
    const out = computeLearnedPreferences(events, prefs(), NOW);
    // Two favourites (weight ~6, two versions) are not enough: three distinct versions are needed.
    expect(out.fields.defaultDurationSec).toBeUndefined();
  });

  it('counts repeated downloads of one version once', () => {
    const f = facts({ durationSec: 15 });
    const repeated = [ev('download', { version: 'a', data: { planFacts: f } }), ev('download', { version: 'a', data: { planFacts: f } }), ev('download', { version: 'a', data: { planFacts: f } })];
    expect(computeLearnedPreferences(repeated, prefs(), NOW).fields.defaultDurationSec).toBeUndefined();
    const distinct = ['a', 'b', 'c'].map((v) => ev('download', { version: v, data: { planFacts: f } }));
    const out = computeLearnedPreferences(distinct, prefs(), NOW);
    expect(out.fields.defaultDurationSec?.value).toBe(15);
    expect(out.fields.defaultDurationSec?.counts.downloads).toBe(3);
  });

  it('ignores events before resetAt and outside the 180-day window', () => {
    const f = facts({ durationSec: 15 });
    const old = [fav('a', f, daysAgo(10)), fav('b', f, daysAgo(10)), fav('c', f, daysAgo(10))];
    const reset = prefs({ learning: { enabled: true, resetAt: daysAgo(5), pinned: {} } });
    expect(computeLearnedPreferences(old, reset, NOW)).toMatchObject({ eventsConsidered: 0, fields: {} });
    const ancient = [fav('a', f, daysAgo(200)), fav('b', f, daysAgo(200)), fav('c', f, daysAgo(200))];
    expect(computeLearnedPreferences(ancient, prefs(), NOW).eventsConsidered).toBe(0);
  });

  it('halves the weight of evidence every 60 days', () => {
    const f = facts({ durationSec: 15 });
    const fresh = computeLearnedPreferences([fav('a', f, NOW.toISOString()), fav('b', f, NOW.toISOString()), fav('c', f, NOW.toISOString())], prefs(), NOW);
    expect(fresh.fields.defaultDurationSec?.weight).toBeCloseTo(9, 6);
    const aged = computeLearnedPreferences([fav('a', f, daysAgo(60)), fav('b', f, daysAgo(60)), fav('c', f, daysAgo(60))], prefs(), NOW);
    // 3 × 3 × 0.5 = 4.5 < 6: no longer enough evidence.
    expect(aged.fields.defaultDurationSec).toBeUndefined();
    expect(aged.fields.styleOrder?.weight).toBeCloseTo(4.5, 6);
  });

  it('scores a version that is both favourited and downloaded 5', () => {
    const f = facts({ styleId: 'before_after' });
    const out = computeLearnedPreferences([fav('a', f, NOW.toISOString()), ev('download', { version: 'a', style: 'before_after', at: NOW.toISOString(), data: { planFacts: f } }), fav('b', facts(), NOW.toISOString())], prefs(), NOW);
    expect(out.fields.styleOrder?.weight).toBeCloseTo(8, 6);
    expect((out.fields.styleOrder?.value as StyleId[])[0]).toBe('before_after');
    expect(styleAffinityFrom([fav('a', f, NOW.toISOString()), ev('download', { version: 'a', style: 'before_after', at: NOW.toISOString(), data: { planFacts: f } }), fav('b', facts(), NOW.toISOString())], prefs(), NOW)).toEqual({ before_after: 5, clean_promo: 3 });
  });

  it('orders styles by signed score with ties in the standard order, and regenerations count against a style', () => {
    const events = [
      fav('a', facts({ styleId: 'process_story' })),
      ev('dismiss', { version: 'b', style: 'beat_montage', data: { value: true, planFacts: facts({ styleId: 'beat_montage' }) } }),
      ev('regenerate', { version: 'c', style: 'clean_promo', data: { parentPlanFacts: facts() } }),
    ];
    const order = computeLearnedPreferences(events, prefs(), NOW).fields.styleOrder?.value as StyleId[];
    expect(order[0]).toBe('process_story');
    expect(order.slice(-2)).toEqual(['clean_promo', 'beat_montage']);
    expect([...order].sort()).toEqual([...STYLE_IDS].sort());
  });

  it('uses events without plan facts for the style order only', () => {
    const events = [ev('favourite', { version: 'a', style: 'cinematic_reveal' }), ev('favourite', { version: 'b', style: 'cinematic_reveal' }), ev('download', { version: 'c', style: 'cinematic_reveal' })];
    const out = computeLearnedPreferences(events, prefs(), NOW);
    expect(Object.keys(out.fields)).toEqual(['styleOrder']);
    expect((out.fields.styleOrder?.value as StyleId[])[0]).toBe('cinematic_reveal');
  });

  it('learns colour only when the same look was kept across at least two styles', () => {
    const one = [fav('a', facts({ colourPreset: 'punchy', styleId: 'beat_montage' })), fav('b', facts({ colourPreset: 'punchy', styleId: 'beat_montage' })), fav('c', facts({ colourPreset: 'punchy', styleId: 'beat_montage' }))];
    expect(computeLearnedPreferences(one, prefs(), NOW).fields.colour).toBeUndefined();
    const two = [...one, fav('d', facts({ colourPreset: 'punchy', styleId: 'clean_promo' }))];
    expect(computeLearnedPreferences(two, prefs(), NOW).fields.colour?.value).toBe('punchy');
    const asked = [0, 1].map(() => ev('revise', { data: { hints: { colour: 'cinematic' }, parentPlanFacts: facts() } }));
    expect(computeLearnedPreferences(asked, prefs(), NOW).fields.colour?.value).toBe('cinematic');
  });

  it('learns pacing, text, transitions and music volume from revisions at their thresholds', () => {
    const faster = (n: number) => Array.from({ length: n }, () => ev('revise', { data: { hints: { pacing: 'faster' }, parentPlanFacts: facts() } }));
    expect(computeLearnedPreferences(faster(2), prefs(), NOW).fields.pacing).toBeUndefined();
    expect(computeLearnedPreferences(faster(3), prefs(), NOW).fields.pacing?.value).toBe('fast');
    const noText = [0, 1].map(() => ev('revise', { data: { hints: { text: 'none' }, parentPlanFacts: facts() } }));
    expect(computeLearnedPreferences(noText, prefs(), NOW).fields.textDensity?.value).toBe('none');
    const calm = [0, 1].map(() => ev('revise', { data: { hints: { transitions: 'restrained' }, parentPlanFacts: facts() } }));
    expect(computeLearnedPreferences(calm, prefs({ transitions: 'varied' }), NOW).fields.transitions?.value).toBe('restrained');
    const quieter = [0, 1].map(() => ev('revise', { data: { audioPatch: { volume: 0.5 }, parentPlanFacts: facts() } }));
    const vol = computeLearnedPreferences(quieter, prefs(), NOW).fields.musicVolume;
    expect(vol?.value).toBe(0.5);
    expect(vol?.counts.revisions).toBe(2);
    expect(vol?.explanation).toMatch(/^From 2 revisions since/);
  });

  it('turns relative length requests into lengths from the parent', () => {
    const shorter = ['a', 'b', 'c'].map((v) => ev('revise', { version: v, data: { hints: { targetDurationSec: -1 }, parentPlanFacts: facts({ durationSec: 20 }) } }));
    expect(computeLearnedPreferences(shorter, prefs(), NOW).fields.defaultDurationSec?.value).toBe(15);
  });

  it('is deterministic whatever order the events arrive in', () => {
    const events = [
      fav('a', facts({ durationSec: 30, styleId: 'process_story' })),
      fav('b', facts({ durationSec: 35, colourPreset: 'cinematic', styleId: 'cinematic_reveal' })),
      ev('download', { version: 'c', data: { planFacts: facts({ durationSec: 30, flashyTransitionCount: 2 }) } }),
      ev('revise', { data: { hints: { pacing: 'slower', text: 'more' }, parentPlanFacts: facts() } }),
      ev('regenerate', { style: 'beat_montage', data: { parentPlanFacts: facts({ styleId: 'beat_montage' }) } }),
    ];
    const a = computeLearnedPreferences(events, prefs(), NOW);
    const b = computeLearnedPreferences([...events].reverse(), prefs(), NOW);
    expect(b).toEqual(a);
    expect(JSON.stringify(computeLearnedPreferences(events, prefs(), NOW))).toBe(JSON.stringify(a));
  });

  it('explains evidence in plain words', () => {
    expect(explainEvidence({ favourites: 4, downloads: 2, publishes: 0, revisions: 1, regenerations: 0, dismissals: 0 }, '2026-10-03T03:00:00.000Z')).toBe('From 4 favourites, 2 downloads and 1 revision since 3 Oct 2026.');
  });
});

describe('effectivePreferences', () => {
  const learned = {
    computedAt: NOW.toISOString(),
    eventsConsidered: 9,
    since: null,
    error: null,
    fields: {
      defaultDurationSec: { value: 20, weight: 9, counts: { favourites: 3, downloads: 0, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 }, explanation: '' },
      styleOrder: { value: ['process_story'], weight: 9, counts: { favourites: 3, downloads: 0, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 }, explanation: '' },
      pacing: { value: 'warp speed', weight: 9, counts: { favourites: 3, downloads: 0, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 }, explanation: '' },
    },
  };

  it('pinned → declared, else learned (when on and valid), else declared', () => {
    const p = prefs({ learned });
    const eff = effectivePreferences(p);
    expect(eff.defaultDurationSec).toBe(20);
    expect(eff.styleOrder[0]).toBe('process_story');
    expect([...eff.styleOrder].sort()).toEqual([...STYLE_IDS].sort());
    // An invalid learned value is ignored.
    expect(eff.pacing).toBe('balanced');
    const pinned = effectivePreferences(prefs({ learned, learning: { enabled: true, resetAt: null, pinned: { defaultDurationSec: { by: 'owner', at: NOW.toISOString(), referenceAssetId: null, referenceName: '' } } } }));
    expect(pinned.defaultDurationSec).toBe(25);
    const off = effectivePreferences(prefs({ learned, learning: { enabled: false, resetAt: null, pinned: {} } }));
    expect(off.defaultDurationSec).toBe(25);
    expect(off.styleOrder).toEqual([...STYLE_IDS]);
    expect(effectivePreferences(eff)).toEqual(eff);
  });

  it('reports where each value comes from', () => {
    const p = prefs({ learned, pacing: 'fast', learning: { enabled: true, resetAt: null, pinned: { colour: { by: 'reference', at: NOW.toISOString(), referenceAssetId: 'r1', referenceName: 'ref.mp4' } } } });
    const defaults = DEFAULT_SETTINGS.preferences;
    expect(preferenceSource(p, 'defaultDurationSec', defaults)).toBe('learned');
    expect(preferenceSource(p, 'colour', defaults)).toBe('reference');
    expect(preferenceSource(p, 'pacing', defaults)).toBe('owner');
    expect(preferenceSource(p, 'transitions', defaults)).toBe('default');
  });
});

describe('parseStoredSettings', () => {
  it('pins every learnable field the owner had changed when settings predate learning', () => {
    const stored = { preferences: { defaultDurationSec: 30, pacing: 'fast', textDensity: 'light' } };
    const parsed = parseStoredSettings(stored, NOW)!;
    expect(Object.keys(parsed.preferences.learning.pinned).sort()).toEqual(['defaultDurationSec', 'pacing']);
    expect(parsed.preferences.learning.pinned.pacing).toEqual({ by: 'owner', at: NOW.toISOString(), referenceAssetId: null, referenceName: '' });
    // Once learning exists it is left alone.
    const current = parseStoredSettings({ preferences: { ...stored.preferences, learning: { enabled: true, resetAt: null, pinned: {} } } }, NOW)!;
    expect(current.preferences.learning.pinned).toEqual({});
    expect(parseStoredSettings({}, NOW)!.preferences.learning.pinned).toEqual({});
    expect(parseStoredSettings({ preferences: { pacing: 'warp' } }, NOW)).toBeNull();
    expect(EditingPreferencesSchema.parse({}).learned.fields).toEqual({});
  });
});
