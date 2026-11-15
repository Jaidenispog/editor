import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  FORBIDDEN_STYLE_WORDS,
  ReferenceStyleProfileSchema,
  alignCutsToBeats,
  applySummaryDecisions,
  assembleReferenceSignals,
  beatsPerCutCounts,
  beatsPerCutMode,
  binomialMinAligned,
  describeStyleSignals,
  energyShape,
  findDrop,
  foldTempo,
  measureBeatSignal,
  paletteFromCounts,
  profileReference,
  readReferenceProfile,
  resetEditingStyle,
  stableJson,
  summariseReferenceStyle,
  transitionFamily,
  type EditingPreferences,
  type RawJoin,
  type RawReferenceStyle,
  type ReferenceStyleProfileV2,
  type ReferenceStyleSignals,
} from '../src/index.js';

const beatsAt = (bpm: number, sec: number, start = 0) => Array.from({ length: Math.floor(((sec - start) * bpm) / 60) + 1 }, (_, i) => start + (i * 60) / bpm);
const prefs = (): EditingPreferences => structuredClone(DEFAULT_SETTINGS.preferences);

/** A 0.25 s energy curve: quiet (−18 dB) until `dropAt`, loud after, with click alternation. */
function stepEnergy(sec: number, dropAt: number | null, quietDb = -18): number[] {
  const n = Math.round(sec / 0.25);
  return Array.from({ length: n }, (_, i) => {
    const t = i * 0.25;
    const level = dropAt !== null && t >= dropAt ? 1 : Math.pow(10, quietDb / 20);
    return Math.round(level * (i % 2 === 0 ? 1 : 0.4) * 1000) / 1000;
  });
}

function rawStyle(over: Partial<RawReferenceStyle> = {}): RawReferenceStyle {
  const joins: RawJoin[] = Array.from({ length: 15 }, (_, i) => ({ kind: 'hard', timeSec: i + 1, durationSec: 0 }));
  return {
    fps: 30,
    measuredSec: 16,
    endScreenTrimmedSec: 0,
    joins,
    zoomShots: { checked: 16, pushScales: [], pullScales: [] },
    audio: { bpm: 120, confidence: 0.8, beatTimesSec: beatsAt(120, 16), energy: stepEnergy(16, null), energyStepSec: 0.25, speechLikely: false },
    ...over,
  };
}

function profileWith(style: ReferenceStyleSignals | null, id: string, over: Partial<ReferenceStyleProfileV2> = {}): ReferenceStyleProfileV2 {
  const p = profileReference(
    { assetId: id, sourceFilename: `${id}.mp4`, durationSec: style?.measuredSec ?? 30, shotDurationsSec: [1, 1, 1], look: { meanLuma: 0.5, meanSaturation: 0.4, contrast: 0.3 }, text: null, measuredAt: new Date('2026-11-15T03:00:00Z'), style },
    DEFAULT_SETTINGS.preferences,
  );
  return { ...p, ...over };
}

describe('binomial chance correction', () => {
  it('matches the documented kMin table', () => {
    expect(binomialMinAligned(15, 0.32)).toBe(10);
    expect(binomialMinAligned(30, 0.32)).toBe(17);
    expect(binomialMinAligned(8, 0.32)).toBe(7);
  });

  it('reports random cuts as not reportable, never as off the beat', () => {
    const beats = beatsAt(120, 16);
    const random = [0.73, 1.61, 2.27, 3.38, 4.12, 5.09, 6.44, 7.31, 8.66, 9.18, 10.37, 11.82, 12.29, 13.71, 14.55];
    const b = measureBeatSignal({ hasAudio: true, bpm: 120, confidence: 0.8, beatTimesSec: beats, speechLikely: false, cutTimesSec: random, fps: 30 });
    expect(b.status).toBe('measured');
    if (b.status === 'measured') expect(b.reportable).toBe(false);
  });

  it('says why the beat was not measured', () => {
    const base = { beatTimesSec: [], cutTimesSec: [1, 2, 3, 4, 5, 6, 7, 8, 9], fps: 30 };
    expect(measureBeatSignal({ ...base, hasAudio: false, bpm: null, confidence: 0, speechLikely: false })).toMatchObject({ status: 'not_measured', reason: 'no_audio' });
    expect(measureBeatSignal({ ...base, hasAudio: true, bpm: 100, confidence: 0.2, speechLikely: false })).toMatchObject({ status: 'not_measured', reason: 'no_clear_beat' });
    expect(measureBeatSignal({ ...base, hasAudio: true, bpm: 100, confidence: 0.4, speechLikely: true })).toMatchObject({ status: 'not_measured', reason: 'mostly_speech' });
    expect(measureBeatSignal({ ...base, cutTimesSec: [1, 2], hasAudio: true, bpm: 120, confidence: 0.9, speechLikely: false })).toMatchObject({ status: 'not_measured', reason: 'too_few_cuts', bpm: 120 });
  });

  it('counts cuts within a frame and 80 ms, the median offset and beats per cut', () => {
    const beats = beatsAt(120, 16);
    const cuts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t) => t - 0.02);
    const a = alignCutsToBeats(cuts, beats, 30);
    expect(a.within1Frame).toBe(10);
    expect(a.within80ms).toBe(10);
    expect(a.medianOffsetMs).toBe(-20);
    const counts = beatsPerCutCounts(a.alignedCutTimesSec, 0.5);
    expect(counts.two).toBe(9);
    expect(beatsPerCutMode(counts)).toBe(2);
    expect(beatsPerCutMode({ one: 2, two: 2, four: 2, eight: 0, other: 3 })).toBeNull();
  });
});

describe('drop and energy shape', () => {
  it('finds a step rise and refines it to the beat', () => {
    const d = findDrop(stepEnergy(16, 8), 0.25, { beatTimesSec: beatsAt(120, 16) })!;
    expect(d.found).toBe(true);
    expect(d.atSec).toBeCloseTo(8, 1);
    expect(d.riseDb).toBeGreaterThanOrEqual(10);
  });

  it('rejects a single knock and smooths alternating click windows', () => {
    const knock = stepEnergy(16, null).map((e, i) => (i === 30 ? 1 : e * 0.3));
    expect(findDrop(knock, 0.25)!.found).toBe(false);
    expect(findDrop(stepEnergy(16, null), 0.25)!.found).toBe(false);
  });

  it('describes the shape in 8 parts', () => {
    const e = energyShape(stepEnergy(16, 8), 0.25, 16)!;
    expect(e.shape).toHaveLength(8);
    expect(e.shape[7]).toBe(1);
    expect(e.shape[0]).toBeLessThan(0.4);
    expect(e.dynamicRangeDb).toBeGreaterThan(10);
  });
});

describe('palette', () => {
  const t = (counts: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    joins: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    directions: { up: 0, down: 0, left: 0, right: 0 },
    crossFadeMedianSec: null,
    flashMedianSec: null,
    flashesOnBeat: null,
    flashEveryBeats: null,
    ...extra,
  });

  it('gives the worked example: straight cuts with a white flash every 4 beats', () => {
    const counts = { hard: 15, fade_white: 4, unclear: 1 };
    expect(transitionFamily(t(counts))).toBe('straight_flash');
    expect(paletteFromCounts(t(counts, { flashMedianSec: 0.2, flashesOnBeat: 4, flashEveryBeats: 4 }))).toEqual({
      hardCutShare: 1,
      types: [],
      durationSec: 0.3,
      accent: { type: 'fadewhite', everyBeats: 4, durationSec: 0.2 },
    });
  });

  it('covers every family', () => {
    expect(paletteFromCounts(t({ hard: 20 }))).toEqual({ hardCutShare: 1, types: [], durationSec: 0.3, accent: null });
    expect(paletteFromCounts(t({ cross_fade: 5 }, { crossFadeMedianSec: 0.52 }))).toEqual({ hardCutShare: 0, types: ['fade'], durationSec: 0.5, accent: null });
    const movement = paletteFromCounts(t({ slide_vertical: 3, wipe_horizontal: 2 }, { directions: { up: 2, down: 1, left: 1, right: 1 } }))!;
    expect(movement.types).toEqual(['slideup', 'wipeleft']);
    expect(transitionFamily(t({ hard: 6, cross_fade: 2, zoom: 1, slide_vertical: 1 }))).toBe('mixed');
    expect(paletteFromCounts(t({ unclear: 3 }))).toBeNull();
  });
});

describe('assembling one video', () => {
  it('keeps only numbers: no array longer than 8', () => {
    const s = assembleReferenceSignals(rawStyle());
    const arrays: number[] = [];
    JSON.stringify(s, (_k, v) => {
      if (Array.isArray(v)) arrays.push(v.length);
      return v;
    });
    expect(Math.max(0, ...arrays)).toBeLessThanOrEqual(8);
    expect(s.estimate).toBe(true);
    expect(s.shots.count).toBe(16);
    expect(s.transitions.family).toBe('straight_only');
    expect(s.beat).toMatchObject({ status: 'measured', reportable: true, beatsPerCut: 2, within80ms: 15 });
  });

  it('describes a video without forbidden words', () => {
    const line = describeStyleSignals(assembleReferenceSignals(rawStyle()), 'punchy');
    expect(line).toContain('cuts on the beat (15 of 15, about 120 BPM)');
    expect(line).not.toMatch(FORBIDDEN_STYLE_WORDS);
  });
});

describe('profiles', () => {
  it('reads v1 profiles unchanged as v2 with style null and round-trips v2', () => {
    const v2 = profileWith(assembleReferenceSignals(rawStyle()), 'a');
    expect(ReferenceStyleProfileSchema.parse(v2)).toEqual(v2);
    expect(readReferenceProfile(v2)).toEqual(v2);
    const { style: _s, ...rest } = v2;
    const v1 = { ...rest, version: 1 };
    const read = readReferenceProfile(v1)!;
    expect(read.version).toBe(2);
    expect(read.style).toBeNull();
    expect(read.shotSec).toEqual(v2.shotSec);
    expect(readReferenceProfile({ version: 3 })).toBeNull();
  });

  it('fills the v1 shot numbers from the raw v2 boundaries', () => {
    const style = assembleReferenceSignals(rawStyle({ joins: Array.from({ length: 39 }, (_, i) => ({ kind: 'hard', timeSec: (i + 1) * 0.4, durationSec: 0 })) }));
    const p = profileWith(style, 'fast');
    expect(p.shotSec.median).toBeCloseTo(0.4, 2);
    expect(p.suggestions.find((s) => s.field === 'pacing')?.value).toBe('fast');
  });
});

describe('summariseReferenceStyle', () => {
  const r2 = () =>
    assembleReferenceSignals(
      rawStyle({
        joins: Array.from({ length: 15 }, (_, i): RawJoin => (i % 2 === 1 ? { kind: 'fade_white', timeSec: i + 1, durationSec: 0.2 } : { kind: 'hard', timeSec: i + 1, durationSec: 0 })),
        audio: { bpm: 124, confidence: 0.8, beatTimesSec: beatsAt(120, 16), energy: stepEnergy(16, 8), energyStepSec: 0.25, speechLikely: false },
      }),
    );

  it('offers a row from 1 of 1 video', () => {
    const s = summariseReferenceStyle([profileWith(r2(), 'a')], prefs());
    const row = s.suggestions.find((r) => r.field === 'transitionPalette')!;
    expect(row.state).toBe('open');
    expect(row.evidence).toMatchObject({ measured: 1, agreeing: 1, total: 1 });
    expect(row.seen).toContain('Seen in 1 of 1 video');
    expect(row.value).toMatchObject({ hardCutShare: 1, accent: { type: 'fadewhite', everyBeats: 4 } });
    expect(s.suggestions.map((r) => r.field)).toEqual(['pacing', 'defaultDurationSec', 'colour', 'textDensity', 'transitionPalette', 'beatSync', 'reveal', 'zoom', 'musicFit']);
    for (const r of s.suggestions) expect(`${r.seen} ${r.action ?? ''}`).not.toMatch(FORBIDDEN_STYLE_WORDS);
  });

  it('says videos differ when 1 of 2 agrees, and pools 3 of 4', () => {
    const cross = assembleReferenceSignals(rawStyle({ joins: Array.from({ length: 6 }, (_, i): RawJoin => ({ kind: 'cross_fade', timeSec: 2 * i + 2, durationSec: 0.5 })) }));
    const two = summariseReferenceStyle([profileWith(r2(), 'a'), profileWith(cross, 'b')], prefs());
    const row2 = two.suggestions.find((r) => r.field === 'transitionPalette')!;
    expect(row2.state).toBe('differs');
    expect(row2.action).toBeNull();
    const four = summariseReferenceStyle([profileWith(r2(), 'a'), profileWith(r2(), 'b'), profileWith(r2(), 'c'), profileWith(cross, 'd')], prefs());
    const row4 = four.suggestions.find((r) => r.field === 'transitionPalette')!;
    expect(row4.state).toBe('open');
    expect(row4.evidence).toMatchObject({ measured: 4, agreeing: 3, total: 4 });
  });

  it('folds half and double tempos into one range', () => {
    expect(foldTempo(62, 124)).toBe(124);
    const at = (bpm: number) => assembleReferenceSignals(rawStyle({ audio: { bpm, confidence: 0.8, beatTimesSec: beatsAt(bpm, 16), energy: stepEnergy(16, 8), energyStepSec: 0.25, speechLikely: false } }));
    const s = summariseReferenceStyle([profileWith(at(124), 'a'), profileWith(at(62), 'b'), profileWith(at(126), 'c')], prefs());
    const music = s.suggestions.find((r) => r.field === 'musicFit')!;
    expect(music.state).toBe('open');
    expect(music.value).toMatchObject({ bpmLow: 120, bpmHigh: 130, prefersClearDrop: true });
  });

  it('counts older profiles only for the v1 rows', () => {
    const v1 = profileWith(null, 'old');
    const s = summariseReferenceStyle([v1], prefs());
    expect(s.olderMeasurement).toBe(1);
    expect(s.suggestions.find((r) => r.field === 'colour')!.state).toBe('open');
    const t = s.suggestions.find((r) => r.field === 'transitionPalette')!;
    expect(t.state).toBe('not_measured');
    expect(t.evidence.notMeasured).toEqual([{ reason: 'older_measurement', count: 1 }]);
  });

  it('accepts with side effects visible, records the valueKey and detects a changed summary', () => {
    const flashy = assembleReferenceSignals(rawStyle({ joins: Array.from({ length: 8 }, (_, i): RawJoin => ({ kind: 'slide_vertical', timeSec: 2 * i + 1, durationSec: 0.3, direction: 'up' })) }));
    const summary = summariseReferenceStyle([profileWith(flashy, 'a')], prefs());
    const row = summary.suggestions.find((r) => r.field === 'transitionPalette')!;
    expect(row.alsoChanges).toEqual([{ field: 'transitions', value: 'varied' }]);
    expect(row.valueKey).toBe(stableJson({ value: row.value, alsoChanges: row.alsoChanges }));

    const conflict = applySummaryDecisions(prefs(), summary, { accept: ['transitionPalette'], dismiss: [], valueKeys: { transitionPalette: 'stale' } }, '2026-11-15T04:00:00Z');
    expect(conflict.conflicts).toEqual(['transitionPalette']);

    const ok = applySummaryDecisions(prefs(), summary, { accept: ['transitionPalette'], dismiss: ['colour'], valueKeys: { transitionPalette: row.valueKey!, colour: summary.suggestions.find((r) => r.field === 'colour')!.valueKey! } }, '2026-11-15T04:00:00Z');
    expect(ok.conflicts).toEqual([]);
    const p = ok.preferences;
    expect(p.editingStyle.transitionPalette).toEqual(row.value);
    expect(p.transitions).toBe('varied');
    expect(p.learning.pinned.transitions).toMatchObject({ by: 'reference', referenceAssetIds: ['a'] });
    expect(p.editingStyle.sources.transitionPalette).toMatchObject({ by: 'reference', referenceName: 'Your videos (1)' });
    expect(p.editingStyle.summaryDecisions.colour).toMatchObject({ decision: 'dismissed' });
    // A row without a suggestion cannot be decided.
    expect(applySummaryDecisions(prefs(), summary, { accept: ['beatSync'], dismiss: [], valueKeys: {} }, 'x').invalid).toEqual(['beatSync']);

    const onBeat = summariseReferenceStyle([profileWith(assembleReferenceSignals(rawStyle()), 'b')], prefs());
    const beat = onBeat.suggestions.find((r) => r.field === 'beatSync')!;
    expect(beat.alsoChanges).toEqual([{ field: 'beatsPerCut', value: 2 }]);
    const withBeat = applySummaryDecisions(p, onBeat, { accept: ['beatSync'], dismiss: [], valueKeys: { beatSync: beat.valueKey! } }, '2026-11-15T04:00:00Z').preferences;
    expect(withBeat.editingStyle.beatSync).toBe('on');
    expect(withBeat.editingStyle.beatsPerCut).toBe(2);

    const after = summariseReferenceStyle([profileWith(flashy, 'a')], p);
    expect(after.suggestions.find((r) => r.field === 'transitionPalette')).toMatchObject({ state: 'accepted', inUse: true });
    expect(after.suggestions.find((r) => r.field === 'colour')!.state).toBe('dismissed');

    const reset = resetEditingStyle(withBeat);
    expect(reset.editingStyle.transitionPalette).toBeNull();
    expect(reset.editingStyle.beatSync).toBe('auto');
    expect(reset.transitions).toBe('varied');
    expect(reset.editingStyle.summaryDecisions.colour).toBeDefined();
    expect(reset.editingStyle.summaryDecisions.transitionPalette).toBeUndefined();
  });

  it('keeps valueKeys stable regardless of key order', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
