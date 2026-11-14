import { describe, expect, it } from 'vitest';
import { countNeedingSetup, integrationPill } from '../src/components/app/integration-pill';
import { toneForStatus } from '../src/components/ui/status-words';
import { buildIntegrationStatuses } from '../src/lib/integrations';
import { musicStatusEntries } from '../src/lib/integrations/music';
import { clipStatusLine, shotSummary } from '../src/lib/shared/clip-summary';
import { integrationStateOf } from '../src/lib/shared/integration-types';
import { LIBRARY_LICENCE_KINDS, finishedUploadsShownAsTracks, showsLicenceEnd, trackStatusPill } from '../src/lib/shared/music-display';
import { PROJECT_STATUS_LABELS, projectStatusPill } from '../src/lib/shared/project-status';
import { originalSoundChoices, withTrack, type SoundState } from '../src/lib/shared/studio-schemas';
import { revealTabScrollLeft, stripFadeMask, stripOverflow } from '../src/lib/shared/tab-scroll';
import { WORDING_CASES } from './integration-wording-cases';

describe('project status words', () => {
  it('reads the same on the project list, the dashboard and the project page', () => {
    expect(projectStatusPill('ready')).toEqual({ status: 'ready', label: 'Ready to generate' });
    expect(projectStatusPill('complete', 'complete')).toEqual({ status: 'complete', label: 'Edits ready' });
    expect(projectStatusPill('draft', null)).toEqual({ status: 'draft', label: 'No clips yet' });
    expect(projectStatusPill('analysing')).toEqual({ status: 'analysing', label: 'Analysing clips' });
    // A running generation is the project's own "Making edits", whatever the generation's step is.
    expect(projectStatusPill('generating', 'rendering')).toEqual({ status: 'generating', label: 'Making edits' });
    expect(projectStatusPill('generating', 'failed').label).toBe('Making edits');
  });

  it('never says a bare "Ready" or "Complete"', () => {
    for (const label of Object.values(PROJECT_STATUS_LABELS)) expect(['Ready', 'Complete']).not.toContain(label);
    for (const status of ['draft', 'analysing', 'ready', 'generating', 'complete', 'archived']) {
      for (const gen of [null, 'queued', 'planning', 'rendering', 'complete', 'partial', 'failed', 'cancelled']) {
        expect(['Ready', 'Complete'], `${status}/${gen}`).not.toContain(projectStatusPill(status, gen).label);
      }
    }
  });

  it('flags a latest generation that failed or only partly worked', () => {
    expect(projectStatusPill('ready', 'failed')).toEqual({ status: 'failed', label: 'Edits failed' });
    expect(projectStatusPill('complete', 'partial')).toEqual({ status: 'partial', label: 'Some edits ready' });
    expect(projectStatusPill('ready', 'cancelled')).toEqual({ status: 'ready', label: 'Ready to generate' });
  });
});

describe('clip status line', () => {
  const shots = { count: 3, identified: 3, labels: { before: 3 } };

  it('shows only the shot summary for a ready clip (no repeated count or HDR note)', () => {
    expect(shotSummary({ shots })).toBe('3 shots: Before ×3');
    expect(clipStatusLine({ status: 'ready', statusMessage: '3 shots · HDR converted', shots })).toBe('3 shots: Before ×3');
    expect(clipStatusLine({ status: 'ready', statusMessage: '1 shot', shots: { count: 1, identified: 0, labels: { unknown: 1 } } })).toBe('1 shot');
    expect(clipStatusLine({ status: 'ready', statusMessage: 'Analysed', shots: null })).toBe('Analysed');
  });

  it("keeps the worker's message while a clip is waiting, analysing or failed", () => {
    expect(clipStatusLine({ status: 'processing', statusMessage: 'Finding shots', shots: null })).toBe('Finding shots');
    expect(clipStatusLine({ status: 'failed', statusMessage: 'The file could not be read', shots: null })).toBe('The file could not be read');
    expect(clipStatusLine({ status: 'uploaded', statusMessage: '', shots: null })).toBe('');
  });
});

describe('sound panel choices', () => {
  const state: SoundState = { track: 't1', start: 12, beatSync: true, reveal: false, volume: 85, fadeIn: 0.3, fadeOut: 1.2, duck: true, original: 'under_music', originalVolume: 40 };

  it('offers "Under the music" only while a track is chosen', () => {
    expect(originalSoundChoices('t1')).toEqual(['off', 'under_music', 'only']);
    expect(originalSoundChoices('none')).toEqual(['off', 'only']);
    expect(originalSoundChoices('none', 'off')).toEqual(['off', 'only']);
    // A saved version that already has it keeps the option listed, so the radio group keeps its checked choice.
    expect(originalSoundChoices('none', 'under_music')).toEqual(['off', 'under_music', 'only']);
  });

  it('falls back to "Original sound only" when the music is taken away', () => {
    expect(withTrack(state, 'none', state)).toMatchObject({ track: 'none', start: 0, original: 'only' });
    expect(withTrack({ ...state, original: 'off' }, 'none', state)).toMatchObject({ original: 'off' });
    expect(withTrack({ ...state, track: 'none', original: 'only' }, 't1', state)).toMatchObject({ track: 't1', start: 12, original: 'only' });
    expect(withTrack(state, 't2', state)).toMatchObject({ track: 't2', start: 0, original: 'under_music' });
    expect(withTrack(state, 't2', null).start).toBe(0);
  });
});

describe('tab strip scrolling', () => {
  const strip = { scrollLeft: 0, clientWidth: 358, scrollWidth: 1000 };

  it('scrolls only as far as needed to show the selected tab with room for the fade', () => {
    // Already visible: no movement.
    expect(revealTabScrollLeft(strip, { offsetLeft: 100, offsetWidth: 80 })).toBe(0);
    // Off to the right ("Music library" on a 390 px phone): its right edge plus padding lines up with the view.
    expect(revealTabScrollLeft(strip, { offsetLeft: 420, offsetWidth: 110 }, 32)).toBe(420 + 110 + 32 - 358);
    // Off to the left after scrolling the other way.
    expect(revealTabScrollLeft({ ...strip, scrollLeft: 500 }, { offsetLeft: 300, offsetWidth: 90 }, 32)).toBe(268);
    // Never past either end.
    expect(revealTabScrollLeft(strip, { offsetLeft: 920, offsetWidth: 80 }, 32)).toBe(642);
    expect(revealTabScrollLeft({ ...strip, scrollLeft: 50 }, { offsetLeft: 4, offsetWidth: 80 }, 32)).toBe(0);
  });

  it('fades only the edges with more tabs beyond them', () => {
    expect(stripOverflow(strip)).toEqual({ start: false, end: true });
    expect(stripOverflow({ ...strip, scrollLeft: 642 })).toEqual({ start: true, end: false });
    expect(stripOverflow({ scrollLeft: 0, clientWidth: 900, scrollWidth: 900 })).toEqual({ start: false, end: false });
    expect(stripFadeMask({ start: false, end: false })).toBeUndefined();
    expect(stripFadeMask({ start: false, end: true })).toBe('linear-gradient(to right, #000, #000, #000 calc(100% - 24px), transparent)');
    expect(stripFadeMask({ start: true, end: true })).toBe('linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 24px), transparent)');
  });
});

describe('music track cards', () => {
  it('shows the licence end only where the licence can end, or when a date is set', () => {
    expect([...LIBRARY_LICENCE_KINDS].sort()).toEqual(['catalogue', 'commercial_licence']);
    expect(showsLicenceEnd({ kind: 'catalogue', expiresAt: null })).toBe(true);
    expect(showsLicenceEnd({ kind: 'commercial_licence', expiresAt: null })).toBe(true);
    expect(showsLicenceEnd({ kind: 'owner_upload', expiresAt: null })).toBe(false);
    expect(showsLicenceEnd({ kind: 'cc0', expiresAt: null })).toBe(false);
    expect(showsLicenceEnd({ kind: 'owner_upload', expiresAt: '2027-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('reads "Analysing" (busy) until the track is ready', () => {
    expect(trackStatusPill('uploaded')).toEqual({ status: 'analysing', label: 'Analysing' });
    expect(trackStatusPill('processing')).toEqual({ status: 'analysing', label: 'Analysing' });
    expect(toneForStatus(trackStatusPill('uploaded').status)).toBe('info');
    expect(trackStatusPill('ready')).toEqual({ status: 'ready', label: 'Ready' });
    expect(trackStatusPill('failed').status).toBe('failed');
  });

  it('dismisses a finished upload row once its track is listed', () => {
    const uploads = [
      { key: 'a', kind: 'audio', state: 'done', resultId: 't1' },
      { key: 'b', kind: 'audio', state: 'done', resultId: 't2' },
      { key: 'c', kind: 'audio', state: 'uploading', resultId: null },
      { key: 'd', kind: 'video', state: 'done', resultId: 't1' },
      { key: 'e', kind: 'audio', state: 'failed', resultId: null },
    ];
    expect(finishedUploadsShownAsTracks(uploads, ['t1'])).toEqual(['a']);
    expect(finishedUploadsShownAsTracks(uploads, [])).toEqual([]);
  });
});

describe('integration pills', () => {
  const all = WORDING_CASES.flatMap((c) => buildIntegrationStatuses(c.env as never, c.facts as never));

  it('come from the real state and never say a bare "Ready"', () => {
    for (const s of all) {
      const pill = integrationPill(s);
      expect(pill.status).toBe(integrationStateOf(s));
      expect(pill.label, s.id).not.toBe('Ready');
      expect(pill.label.length, s.id).toBeGreaterThan(0);
    }
  });

  it('keep the Stage A words for cards whose state matches their booleans', () => {
    const legacy = (s: { configured: boolean; connected: boolean }) => (s.connected ? 'Active' : s.configured ? 'Ready to connect' : 'Needs setup');
    for (const s of all) {
      if (integrationStateOf({ configured: s.configured, connected: s.connected }) !== integrationStateOf(s) || s.stateLabel) continue;
      expect(integrationPill(s).label, s.id).toBe(legacy(s));
    }
  });

  it('say "Reconnect needed" or "Not working" instead of offering to connect', () => {
    expect(integrationPill({ configured: true, connected: false, state: 'needs_reauth' })).toMatchObject({ status: 'needs_reauth', label: 'Reconnect needed', icon: 'idle' });
    expect(integrationPill({ configured: true, connected: false, state: 'error' })).toMatchObject({ status: 'error', label: 'Not working' });
    expect(integrationPill({ configured: true, connected: false })).toMatchObject({ status: 'not_connected', label: 'Ready to connect', icon: 'ready' });
  });

  it('are honest for the two music cards everywhere they appear', () => {
    const [spotify, library] = musicStatusEntries();
    expect(integrationPill(spotify!)).toEqual({ status: 'not_connected', label: 'Links only · no account needed', icon: 'idle' });
    expect(toneForStatus(integrationPill(spotify!).status)).toBe('neutral');
    expect(integrationPill(library!)).toEqual({ status: 'unavailable', label: 'Not available', icon: 'idle' });
    expect(toneForStatus('unavailable')).toBe('neutral');
    // The same entries are in the shared list (dashboard, Settings → Integrations).
    for (const id of ['spotify_reference', 'music_catalogue']) {
      const shared = all.find((s) => s.id === id);
      expect(shared && integrationPill(shared)).toEqual(integrationPill(id === 'spotify_reference' ? spotify! : library!));
    }
  });

  it('count only cards missing a server setting as needing setup', () => {
    expect(countNeedingSetup(musicStatusEntries())).toBe(0);
    expect(
      countNeedingSetup([
        { configured: false, connected: false },
        { configured: true, connected: false, state: 'needs_reauth' },
        { configured: false, connected: false, state: 'unavailable' },
      ]),
    ).toBe(1);
  });
});
