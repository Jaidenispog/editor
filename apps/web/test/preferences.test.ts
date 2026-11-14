import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@studio/core';
import { SettingsPatchSchema, changedLearnableFields, mergeSettings, normaliseStoredSettings } from '../src/lib/settings-merge';
import { preferenceFields } from '../src/lib/preferences';
import { checkUploadFile } from '../src/lib/shared/upload-math';

const NOW = new Date('2026-11-14T00:00:00.000Z');

describe('PUT /api/settings patch rules', () => {
  it('refuses the learning fields and the Spotify mode with plain messages', () => {
    for (const field of ['learned', 'learning', 'styleAffinity']) {
      const r = SettingsPatchSchema.safeParse({ preferences: { [field]: {} } });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['preferences', field]);
      expect(r.error?.issues[0]?.message).toMatch(/preferences controls/);
    }
    const music = SettingsPatchSchema.safeParse({ music: { spotifyReferenceMode: 'embed' } });
    expect(music.success).toBe(false);
    expect(music.error?.issues[0]?.message).toMatch(/PUT \/api\/music\/references\/mode/);
    expect(SettingsPatchSchema.safeParse({ preferences: { pacing: 'fast' } }).success).toBe(true);
  });

  it('pins every learnable field a save changes, and keeps server-owned fields', () => {
    const learned = { ...DEFAULT_SETTINGS.preferences.learned, computedAt: NOW.toISOString(), eventsConsidered: 3 };
    const current: AppSettings = { ...DEFAULT_SETTINGS, preferences: { ...DEFAULT_SETTINGS.preferences, learned, styleAffinity: { clean_promo: 4 } } };
    const next = mergeSettings(current, { preferences: { pacing: 'fast', standingInstructions: 'Finish on the final look', learned: { eventsConsidered: 99 } } as never }, NOW);
    expect(next.preferences.pacing).toBe('fast');
    expect(next.preferences.learning.pinned).toEqual({ pacing: { by: 'owner', at: NOW.toISOString(), referenceAssetId: null, referenceName: '' } });
    expect(next.preferences.learned).toEqual(learned);
    expect(next.preferences.styleAffinity).toEqual({ clean_promo: 4 });
    expect(changedLearnableFields(current, next)).toEqual(['pacing']);
    // Saving the same values again pins nothing new.
    expect(mergeSettings(next, { preferences: { pacing: 'fast' } }, NOW).preferences.learning.pinned).toEqual(next.preferences.learning.pinned);
  });

  it('pins hand-set values of settings saved before learning existed', () => {
    const s = normaliseStoredSettings({ preferences: { defaultDurationSec: 40 } });
    expect(Object.keys(s.preferences.learning.pinned)).toEqual(['defaultDurationSec']);
  });
});

describe('preferenceFields', () => {
  const counts = { favourites: 3, downloads: 1, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 };
  const learned = {
    computedAt: NOW.toISOString(),
    eventsConsidered: 4,
    since: NOW.toISOString(),
    error: null,
    fields: { defaultDurationSec: { value: 20, weight: 11, counts, explanation: 'From 3 favourites and 1 download since 14 Nov 2026.' } },
  };

  it('shows learned values with their evidence and says when there is not enough yet', () => {
    const fields = preferenceFields({ ...DEFAULT_SETTINGS.preferences, learned });
    const duration = fields.find((f) => f.field === 'defaultDurationSec')!;
    expect(duration).toMatchObject({ value: 20, source: 'learned', explanation: 'From 3 favourites and 1 download since 14 Nov 2026.', suggestion: null, notEnoughEvidence: false });
    expect(fields.find((f) => f.field === 'pacing')).toMatchObject({ value: 'balanced', source: 'default', notEnoughEvidence: true });
    expect(fields.map((f) => f.label)).toEqual(['Default length', 'Style order', 'Pacing', 'On-screen text', 'Transitions', 'Colour', 'Music volume']);
  });

  it('keeps a pinned value and offers the learned one as a suggestion', () => {
    const pinned = { defaultDurationSec: { by: 'owner' as const, at: NOW.toISOString(), referenceAssetId: null, referenceName: '' } };
    const fields = preferenceFields({ ...DEFAULT_SETTINGS.preferences, learned, learning: { enabled: true, resetAt: null, pinned } });
    expect(fields.find((f) => f.field === 'defaultDurationSec')).toMatchObject({ value: 25, source: 'owner', suggestion: { value: 20 } });
  });
});

describe('reference video uploads', () => {
  it('follow the video file rules', () => {
    expect(checkUploadFile({ filename: 'liked.mp4', mimeType: 'video/mp4', kind: 'video' }).ok).toBe(true);
    expect(checkUploadFile({ filename: 'liked.gif', mimeType: 'image/gif', kind: 'video' }).ok).toBe(false);
  });
});
