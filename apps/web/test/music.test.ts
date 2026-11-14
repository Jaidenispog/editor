import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@studio/core';
import { buildMusicIntegrations, musicStatusEntries } from '../src/lib/integrations/music';
import { spotifyEmbedState } from '../src/lib/music-references';
import { CompleteUploadSchema, DownloadKindSchema, ExportVariantQuerySchema, ReviseSchema, buildAudioPatch, strongestWindowStart } from '../src/lib/shared/studio-schemas';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');

describe('music integration cards', () => {
  it('are read-only and never claim a connection', () => {
    const entries = musicStatusEntries();
    expect(entries.map((e) => e.id)).toEqual(['spotify_reference', 'music_catalogue']);
    expect(entries.every((e) => e.connected === false && e.verified === false && e.liveMode === null && e.missingEnv.length === 0)).toBe(true);
    expect(entries.find((e) => e.id === 'spotify_reference')).toMatchObject({ state: 'not_connected' });
    expect(entries.find((e) => e.id === 'spotify_reference')?.message).toMatch(/not licensed for playing in the shop or in your videos/);
    expect(entries.find((e) => e.id === 'music_catalogue')).toMatchObject({ state: 'not_configured' });
    expect(entries.find((e) => e.id === 'music_catalogue')?.message).toMatch(/^Not available\. Download tracks from your business-eligible library/);
    // Kept out of the shared list until the Stage A wording test compares only its own ids.
    expect(buildMusicIntegrations({} as never, { connections: [], socialAccounts: [] })).toEqual([]);
  });
});

describe('Spotify embed switch', () => {
  const published = { draft: 'x', published: 'x', publishedAt: '2026-11-14T00:00:00.000Z' };
  it('stays link-only until both legal pages exist and the terms are acknowledged', () => {
    const none = spotifyEmbedState({ ...DEFAULT_SETTINGS, music: { spotifyReferenceMode: 'embed', spotifyTermsAcknowledgedAt: null } }, 'https://app.example');
    expect(none).toMatchObject({ canEmbed: false, mode: 'link_only' });
    expect(none.missing).toHaveLength(3);
    const pagesOnly = spotifyEmbedState({ ...DEFAULT_SETTINGS, legal: { ...DEFAULT_SETTINGS.legal, terms: published, privacy: published }, music: { spotifyReferenceMode: 'embed', spotifyTermsAcknowledgedAt: null } }, 'https://app.example');
    expect(pagesOnly.missing).toEqual(["Your confirmation that you have read Spotify's Developer Terms and Widget Terms"]);
    const ready = spotifyEmbedState(
      { ...DEFAULT_SETTINGS, business: { ...DEFAULT_SETTINGS.business, termsUrl: 'https://x/terms', privacyUrl: 'https://x/privacy' }, music: { spotifyReferenceMode: 'embed', spotifyTermsAcknowledgedAt: '2026-11-14T00:00:00.000Z' } },
      'https://app.example',
    );
    expect(ready).toMatchObject({ canEmbed: true, mode: 'embed', missing: [] });
    const linkOnly = spotifyEmbedState({ ...DEFAULT_SETTINGS, business: { ...DEFAULT_SETTINGS.business, termsUrl: 'https://x/t', privacyUrl: 'https://x/p' }, music: { spotifyReferenceMode: 'link_only', spotifyTermsAcknowledgedAt: '2026-11-14T00:00:00.000Z' } }, 'https://app.example');
    expect(linkOnly.mode).toBe('link_only');
  });
});

describe('music request schemas', () => {
  it('accepts an instruction, a sound change or both, but not neither', () => {
    expect(ReviseSchema.safeParse({}).success).toBe(false);
    expect(ReviseSchema.parse({ audio: { volume: 0.5 } }).audio).toMatchObject({ volume: 0.5, music: 'keep', beatSync: 'keep' });
    expect(ReviseSchema.safeParse({ audio: { volume: 2 } }).success).toBe(false);
    expect(ReviseSchema.parse({ instruction: 'Cut to the beat', audio: { fadeOutSec: 2 } }).instruction).toBe('Cut to the beat');
  });
  it('knows the music-free export and download', () => {
    expect(DownloadKindSchema.parse('export_no_music')).toBe('export_no_music');
    expect(ExportVariantQuerySchema.parse(undefined)).toBe('standard');
    expect(ExportVariantQuerySchema.parse('no_music')).toBe('no_music');
    expect(ExportVariantQuerySchema.safeParse('karaoke').success).toBe(false);
  });
  it('refuses a CC BY-NC track at upload completion', () => {
    expect(CompleteUploadSchema.safeParse({ licence: { kind: 'cc_by_nc', permitted: {} }, confirmLicence: true }).success).toBe(false);
    expect(CompleteUploadSchema.parse({ licence: { kind: 'meta_sound_collection', permitted: { tiktok: true } } }).licence?.permitted.tiktok).toBe(false);
  });
});

describe('Sound panel patch', () => {
  const from = { track: 't1', start: 4, beatSync: true, reveal: false, volume: 85, fadeIn: 0.3, fadeOut: 1.2, duck: true, original: 'off' as const, originalVolume: 100 };
  it('sends only what changed', () => {
    expect(buildAudioPatch(from, from, true)).toEqual({});
    expect(buildAudioPatch(from, { ...from, volume: 40, fadeOut: 2 }, true)).toEqual({ volume: 0.4, fadeOutSec: 2 });
    expect(buildAudioPatch(from, { ...from, start: 12 }, true)).toEqual({ startSec: 12, keepCuts: true });
    expect(buildAudioPatch(from, { ...from, start: 12 }, false)).toEqual({ startSec: 12, keepCuts: false });
    expect(buildAudioPatch(from, { ...from, track: 'none' }, true)).toEqual({ music: 'none' });
    expect(buildAudioPatch(from, { ...from, track: 't2', start: 0 }, true)).toEqual({ trackId: 't2' });
    expect(buildAudioPatch(from, { ...from, beatSync: false, reveal: true }, true)).toEqual({ beatSync: 'off', revealOnBeat: 'on' });
    expect(buildAudioPatch(from, { ...from, original: 'under_music', originalVolume: 50 }, true)).toEqual({ originalSound: 'under_music', originalVolume: 0.5 });
  });
  it('finds the strongest part of the song for the edit length', () => {
    expect(strongestWindowStart({ values: [0.1, 0.2, 0.9, 0.8, 0.1], stepSec: 5 }, 25, 10)).toBe(10);
    expect(strongestWindowStart(null, 25, 10)).toBe(0);
  });
});

/** Every .ts/.tsx file under a directory. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('Spotify references stay private', () => {
  it('are never imported by publishing, email, website or AI code', () => {
    const lib = path.join(REPO, 'apps', 'web', 'src', 'lib');
    const guarded = [
      ...sourceFiles(lib).filter((f) => /^(publishing|email|website)/.test(path.relative(lib, f))),
      ...sourceFiles(path.join(REPO, 'packages', 'ai', 'src')),
      ...sourceFiles(path.join(REPO, 'apps', 'worker', 'src')),
    ];
    expect(guarded.length).toBeGreaterThan(10);
    const offenders = guarded.filter((f) => /music-references|musicReferences|music_references/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
