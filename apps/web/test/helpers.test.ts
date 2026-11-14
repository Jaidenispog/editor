import { DEFAULT_SETTINGS } from '@studio/core';
import { describe, expect, it } from 'vitest';
import { buildIntegrationStatuses } from '../src/lib/integrations';
import { downloadNameFor } from '../src/lib/media-links';
import { accentCssVariables, contrastRatio } from '../src/lib/shared/accent';
import { mergeSettings, normaliseStoredSettings } from '../src/lib/settings-merge';

describe('mergeSettings', () => {
  it('merges one section without touching the others', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { brand: { accentColour: '#112233' } });
    expect(next.brand.accentColour).toBe('#112233');
    expect(next.brand.appName).toBe(DEFAULT_SETTINGS.brand.appName);
    expect(next.business).toEqual(DEFAULT_SETTINGS.business);
  });
  it('replaces arrays rather than appending', () => {
    const a = mergeSettings(DEFAULT_SETTINGS, { preferences: { preferredStyles: ['beat_montage', 'clean_promo'] } });
    const b = mergeSettings(a, { preferences: { preferredStyles: ['before_after'] } });
    expect(b.preferences.preferredStyles).toEqual(['before_after']);
  });
  it('never lets the logo key be set through a settings update', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { brand: { logoStorageKey: 'projects/x/assets/y/original.mov' } });
    expect(next.brand.logoStorageKey).toBeNull();
  });
  it('rejects invalid values with a zod error', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { brand: { accentColour: 'gold' } })).toThrow();
    expect(() => mergeSettings(DEFAULT_SETTINGS, { preferences: { defaultDurationSec: 200 } })).toThrow();
  });
  it('fills defaults for settings stored before new fields existed', () => {
    const stored = { brand: { appName: 'Chair Time' } };
    const s = normaliseStoredSettings(stored);
    expect(s.brand.appName).toBe('Chair Time');
    expect(s.preferences.defaultDurationSec).toBe(25);
  });
});

describe('accentCssVariables', () => {
  it('chooses readable text on the accent', () => {
    expect(accentCssVariables('#C8A24A')['--accent-foreground']).toBe('#17181A');
    expect(accentCssVariables('#1A237E')['--accent-foreground']).toBe('#FFFFFF');
    expect(accentCssVariables('not-a-colour')['--accent']).toBe('#C8A24A');
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });
});

describe('downloadNameFor', () => {
  it('builds a safe, readable filename', () => {
    expect(downloadNameFor(['Jordan’s Skin Fade', 'Beat-synced montage', 'v2'], 'mp4')).toBe('jordan-s-skin-fade-beat-synced-montage-v2.mp4');
    expect(downloadNameFor([null, '   '], '.mp4')).toBe('studio-assistant.mp4');
  });
});

describe('buildIntegrationStatuses', () => {
  const baseEnv = {
    AI_PROVIDER: 'none' as const,
    ANTHROPIC_API_KEY: undefined,
    AI_PLANNER_MODEL: 'claude-opus-5-5',
    AI_VISION_MODEL: 'claude-haiku-5-5',
    TRANSCRIPTION_PROVIDER: 'none' as const,
    OPENAI_API_KEY: undefined,
    OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
    STORAGE_DRIVER: 'local' as const,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_ENDPOINT: undefined,
    META_APP_ID: undefined,
    META_APP_SECRET: undefined,
    TIKTOK_CLIENT_KEY: undefined,
    TIKTOK_CLIENT_SECRET: undefined,
    SQUARE_APPLICATION_ID: undefined,
    SQUARE_APPLICATION_SECRET: undefined,
    SQUARE_WEBHOOK_SIGNATURE_KEY: undefined,
    RESEND_API_KEY: undefined,
    EMAIL_FROM: undefined,
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
  };

  it('shows honest "needs setup" states and names missing settings without values', () => {
    const list = buildIntegrationStatuses(baseEnv, { connections: [], socialAccounts: [] });
    const square = list.find((i) => i.id === 'square');
    expect(square).toMatchObject({ configured: false, connected: false });
    expect(square?.missingEnv).toEqual(['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET', 'SQUARE_WEBHOOK_SIGNATURE_KEY']);
    expect(square?.message).toMatch(/connect Square in Settings → Integrations/i);
    expect(list.filter((i) => i.id !== 'storage').every((i) => !i.connected)).toBe(true);
  });

  it('reports configured-but-not-connected separately from connected', () => {
    const env = { ...baseEnv, SQUARE_APPLICATION_ID: 'sq-id', SQUARE_APPLICATION_SECRET: 'sq-secret', META_APP_ID: 'm', META_APP_SECRET: 's' };
    const list = buildIntegrationStatuses(env, { connections: [{ provider: 'square', status: 'connected', displayName: 'Ivanhoe Studio' }], socialAccounts: [] });
    expect(list.find((i) => i.id === 'square')).toMatchObject({ configured: true, connected: true });
    expect(list.find((i) => i.id === 'instagram')).toMatchObject({ configured: true, connected: false });
    const json = JSON.stringify(list);
    expect(json).not.toContain('sq-secret');
  });

  it('marks AI planning active only with the provider and key', () => {
    const on = buildIntegrationStatuses({ ...baseEnv, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' }, { connections: [], socialAccounts: [] });
    expect(on.find((i) => i.id === 'ai')).toMatchObject({ configured: true, connected: true, missingEnv: [] });
    expect(JSON.stringify(on)).not.toContain('sk-test');
  });
});
