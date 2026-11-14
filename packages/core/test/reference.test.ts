import { describe, expect, it } from 'vitest';
import {
  BrandConfigSchema,
  DEFAULT_SETTINGS,
  MATCHES_SETTINGS_REASON,
  RenderBrandSnapshotSchema,
  ReferenceStyleProfileSchema,
  brandSnapshotFrom,
  classifyColourLook,
  classifyPacing,
  classifyTextDensity,
  describeReferenceProfile,
  isBundledFont,
  openSuggestions,
  profileReference,
  suggestedDuration,
  type ReferenceMeasurements,
} from '../src/index.js';

const measured = (overrides: Partial<ReferenceMeasurements> = {}): ReferenceMeasurements => ({
  assetId: 'ref-1',
  sourceFilename: 'liked-reel.mp4',
  durationSec: 34,
  shotDurationsSec: [1.2, 1.4, 1.4, 1.8, 0.1, 1.5],
  look: { meanLuma: 0.6, meanSaturation: 0.2, contrast: 0.3 },
  text: null,
  measuredAt: new Date('2026-11-14T00:00:00.000Z'),
  ...overrides,
});
const current = DEFAULT_SETTINGS.preferences;

describe('profileReference', () => {
  it('classifies pacing at the 1.0 s and 2.2 s boundaries', () => {
    expect(classifyPacing(0.99)).toBe('fast');
    expect(classifyPacing(1.0)).toBe('balanced');
    expect(classifyPacing(2.2)).toBe('balanced');
    expect(classifyPacing(2.21)).toBe('slow');
  });

  it('classifies colour with the documented rules', () => {
    expect(classifyColourLook({ meanLuma: 0.5, meanSaturation: 0.4, contrast: 0.3 })).toBe('punchy');
    expect(classifyColourLook({ meanLuma: 0.4, meanSaturation: 0.1, contrast: 0.25 })).toBe('cinematic');
    expect(classifyColourLook({ meanLuma: 0.6, meanSaturation: 0.2, contrast: 0.1 })).toBe('clean');
    expect(classifyColourLook({ meanLuma: 0.4, meanSaturation: 0.25, contrast: 0.1 })).toBe('natural');
  });

  it('rounds the duration to 5 s and only suggests 8–90 s', () => {
    expect(suggestedDuration(34)).toBe(35);
    expect(suggestedDuration(32.4)).toBe(30);
    expect(suggestedDuration(7.9)).toBeNull();
    expect(suggestedDuration(91)).toBeNull();
    expect(suggestedDuration(90)).toBe(90);
  });

  it('leaves text density null when it was not measured', () => {
    expect(classifyTextDensity(null)).toBeNull();
    expect(classifyTextDensity({ framesChecked: 8, framesWithText: 0 })).toBe('none');
    expect(classifyTextDensity({ framesChecked: 8, framesWithText: 3 })).toBe('light');
    expect(classifyTextDensity({ framesChecked: 8, framesWithText: 4 })).toBe('medium');
    const p = profileReference(measured(), current);
    expect(p.text).toEqual({ density: null, framesChecked: 0, framesWithText: 0, source: 'not_measured' });
    expect(p.suggestions.map((s) => s.field)).toEqual(['defaultDurationSec', 'pacing', 'colour']);
  });

  it('builds a valid profile, ignores shots under 0.2 s and marks suggestions that match the settings', () => {
    const p = profileReference(measured({ text: { framesChecked: 8, framesWithText: 6 } }), current);
    expect(ReferenceStyleProfileSchema.parse(p)).toEqual(p);
    expect(p.shotCount).toBe(5);
    expect(p.shotSec.median).toBe(1.4);
    expect(p.colourLook).toBe('clean');
    expect(p.text).toEqual({ density: 'medium', framesChecked: 8, framesWithText: 6, source: 'vision_model' });
    const pacing = p.suggestions.find((s) => s.field === 'pacing')!;
    expect(pacing).toEqual({ field: 'pacing', value: 'balanced', reason: MATCHES_SETTINGS_REASON });
    expect(openSuggestions(p).map((s) => s.field)).toEqual(['defaultDurationSec', 'colour', 'textDensity']);
    expect(openSuggestions({ ...p, decisions: { colour: 'dismissed' } }).map((s) => s.field)).toEqual(['defaultDurationSec', 'textDensity']);
    expect(describeReferenceProfile(p)).toBe('34 s long · 5 shots · shots mostly 1.4–1.5 s (median 1.4 s) · clean colour (estimate) · medium on-screen text (6 of 8 frames)');
  });
});

describe('brand additions', () => {
  it('defaults the logo to off and keeps older settings valid', () => {
    const brand = BrandConfigSchema.parse({ fontHeadline: 'DejaVu Sans' });
    expect(brand).toMatchObject({ logoPlacement: 'off', logoCorner: 'top_left', logoOpacity: 0.85, fontHeadline: 'DejaVu Sans' });
    expect(isBundledFont('Inter Display')).toBe(true);
    expect(isBundledFont('DejaVu Sans')).toBe(false);
    expect(() => BrandConfigSchema.parse({ logoOpacity: 0.3 })).toThrow();
  });

  it('snapshots the brand with the logo only when placement is on and a logo file exists', () => {
    const sha = 'a'.repeat(64);
    const off = brandSnapshotFrom(BrandConfigSchema.parse({ logoStorageKey: 'brand/logo.png' }), sha);
    expect(off.logo).toBeNull();
    const noFile = brandSnapshotFrom(BrandConfigSchema.parse({ logoStorageKey: 'brand/logo.png', logoPlacement: 'both' }), null);
    expect(noFile.logo).toBeNull();
    const on = brandSnapshotFrom(BrandConfigSchema.parse({ logoStorageKey: 'brand/logo.png', logoPlacement: 'corner', logoCorner: 'top_right', logoOpacity: 0.7 }), sha);
    expect(on.logo).toEqual({ storageKey: 'brand/logo.png', sha256: sha, placement: 'corner', corner: 'top_right', opacity: 0.7 });
    expect(RenderBrandSnapshotSchema.parse(on)).toEqual(on);
  });
});
