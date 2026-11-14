import { describe, expect, it } from 'vitest';
import { GenerationSettingsSchema } from '../src/jobs.js';

describe('GenerationSettingsSchema.musicStartSec', () => {
  it('defaults to null (automatic) so settings saved before the field existed still parse', () => {
    const parsed = GenerationSettingsSchema.parse({ styles: ['beat_montage'] });
    expect(parsed.musicStartSec).toBeNull();
    const old = GenerationSettingsSchema.parse({ durationSec: 20, styles: ['beat_montage'], musicTrackId: 't1', keepOriginalSound: 'auto', captions: 'auto', instructions: '' });
    expect(old.musicStartSec).toBeNull();
  });

  it('accepts a start point in seconds, including zero and fractions', () => {
    expect(GenerationSettingsSchema.parse({ styles: ['beat_montage'], musicTrackId: 't1', musicStartSec: 0 }).musicStartSec).toBe(0);
    expect(GenerationSettingsSchema.parse({ styles: ['beat_montage'], musicTrackId: 't1', musicStartSec: 42.75 }).musicStartSec).toBe(42.75);
  });

  it('rejects negative, non-finite, absurdly large and non-numeric start points', () => {
    for (const bad of [-1, Number.POSITIVE_INFINITY, Number.NaN, 3601, '12']) {
      expect(GenerationSettingsSchema.safeParse({ styles: ['beat_montage'], musicTrackId: 't1', musicStartSec: bad }).success).toBe(false);
    }
  });
});
