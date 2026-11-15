import { describe, expect, it } from 'vitest';
import { AppSettingsSchema, DEFAULT_EDITING_STYLE, EDITING_STYLE_FIELDS, EDITING_STYLE_PLANNING_FIELDS, EditingStyleSchema, MusicFitSchema, isDefaultPlanningStyle, type EditingStyle } from '../src/index.js';

describe('which editing-style values change plans', () => {
  it('every field but the music fit is a planning field', () => {
    expect([...EDITING_STYLE_PLANNING_FIELDS, 'musicFit']).toEqual([...EDITING_STYLE_FIELDS]);
  });

  it('the defaults, a dismissed suggestion and an accepted music fit alone leave plans as the defaults', () => {
    expect(isDefaultPlanningStyle(null)).toBe(true);
    expect(isDefaultPlanningStyle(DEFAULT_EDITING_STYLE)).toBe(true);
    expect(isDefaultPlanningStyle({ ...DEFAULT_EDITING_STYLE, summaryDecisions: { transitionPalette: { decision: 'dismissed', valueKey: 'x', at: '2026-11-15T00:00:00Z' } } })).toBe(true);
    const fitOnly: EditingStyle = { ...DEFAULT_EDITING_STYLE, musicFit: { bpmLow: 110, bpmHigh: 130, prefersClearDrop: true, dynamicRangeDb: 8 } };
    expect(isDefaultPlanningStyle(fitOnly)).toBe(true);
  });

  it('any accepted planning value changes plans', () => {
    expect(isDefaultPlanningStyle({ ...DEFAULT_EDITING_STYLE, beatSync: 'on' })).toBe(false);
    expect(isDefaultPlanningStyle({ ...DEFAULT_EDITING_STYLE, beatsPerCut: 2 })).toBe(false);
    expect(isDefaultPlanningStyle({ ...DEFAULT_EDITING_STYLE, reveal: 'strongest_beat' })).toBe(false);
    expect(isDefaultPlanningStyle({ ...DEFAULT_EDITING_STYLE, zoom: { mode: 'none' } })).toBe(false);
    expect(isDefaultPlanningStyle({ ...DEFAULT_EDITING_STYLE, transitionPalette: { hardCutShare: 1, types: [], durationSec: 0.3, accent: null } })).toBe(false);
  });
});

describe('the music tempo range', () => {
  const fit = (bpmLow: number, bpmHigh: number) => ({ bpmLow, bpmHigh, prefersClearDrop: false, dynamicRangeDb: null });

  it('accepts an ordered range and a single tempo', () => {
    expect(MusicFitSchema.parse(fit(110, 130))).toEqual(fit(110, 130));
    expect(MusicFitSchema.parse(fit(124, 124))).toEqual(fit(124, 124));
  });

  it('refuses a range the wrong way round, with a plain message on bpmLow, wherever it is nested', () => {
    const res = MusicFitSchema.safeParse(fit(130, 110));
    expect(res.success).toBe(false);
    expect(res.error?.issues).toEqual([
      expect.objectContaining({ path: ['bpmLow'], message: 'The music tempo range is the wrong way round: the lower BPM (bpmLow) must not be above the higher BPM (bpmHigh).' }),
    ]);
    const nested = AppSettingsSchema.safeParse({ preferences: { editingStyle: { musicFit: fit(130, 110) } } });
    expect(nested.success).toBe(false);
    expect(nested.error?.issues[0]?.path).toEqual(['preferences', 'editingStyle', 'musicFit', 'bpmLow']);
    expect(EditingStyleSchema.safeParse({ musicFit: fit(110, 130) }).success).toBe(true);
  });
});
