'use client';

import { Headphones, Scissors, Wand2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatSeconds } from '@/lib/format';
import type { MusicTrackSummary } from '@/lib/music';
import type { VersionMusicDto } from '@/lib/shared/studio-dto';
import { buildAudioPatch, originalSoundChoices, withTrack, type SoundState } from '@/lib/shared/studio-schemas';
import { EnergyStrip, strongestWindowStart } from './energy-strip';

function initialState(m: VersionMusicDto): SoundState {
  return {
    track: m.sound.hasMusic && m.track ? m.track.id : 'none',
    start: m.sound.startOffsetSec ?? 0,
    beatSync: m.sound.beatAligned,
    reveal: false,
    volume: Math.round((m.sound.volume ?? 0.85) * 100),
    fadeIn: m.sound.fadeInSec ?? 0.3,
    fadeOut: m.sound.fadeOutSec ?? 1.2,
    duck: m.sound.duckUnderOriginal ?? true,
    original: m.sound.originalSound,
    originalVolume: Math.round(m.sound.originalVolume * 100),
  };
}

const ORIGINAL_SOUND_LABELS: Record<SoundState['original'], string> = {
  off: 'Off',
  under_music: 'Under the music',
  only: 'Original sound only',
};

function Slider({ label, value, min, max, step, format, onChange, disabled }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-sm text-charcoal-800">
        <span>{label}</span>
        <span className="font-semibold tabular-nums">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-valuetext={format(value)} className="mt-1 h-11 w-full accent-[var(--accent)]" />
    </label>
  );
}

/**
 * The Sound panel of the revise flow (preferences/music design §4.9): track, song section, beat options, music
 * volume, original sound, ducking and fades. Volume, fades, original sound and "Keep my cuts" change only the sound
 * (a new version with the same cuts); a new track, the beat options or "Re-cut to this section" re-plan the edit.
 * Every apply makes a new version; the current one is kept.
 */
export function SoundPanel({ editId, editName, versionId, open, onClose, onDone }: { editId: string; editName: string; versionId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [music, setMusic] = useState<VersionMusicDto | null>(null);
  const [tracks, setTracks] = useState<MusicTrackSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<SoundState | null>(null);
  const [state, setState] = useState<SoundState | null>(null);
  const [busy, setBusy] = useState<'keep' | 'recut' | 'apply' | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    Promise.all([apiRequest<VersionMusicDto>(`/api/music/versions/${versionId}`), apiRequest<{ tracks: MusicTrackSummary[] }>('/api/music')])
      .then(([m, t]) => {
        if (!alive) return;
        setMusic(m);
        setTracks(t.tracks);
        const s = initialState(m);
        setFrom(s);
        setState(s);
      })
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : 'The sound settings could not be loaded.'));
    return () => {
      alive = false;
    };
  }, [open, versionId]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (stopTimer.current) clearTimeout(stopTimer.current);
    },
    [],
  );

  const set = <K extends keyof SoundState>(key: K, value: SoundState[K]) => setState((s) => (s ? { ...s, [key]: value } : s));
  const chosenTrack = state && state.track !== 'none' ? (state.track === music?.track?.id ? music.track : null) : null;
  const otherTrack = state && state.track !== 'none' && state.track !== music?.track?.id ? tracks.find((t) => t.id === state.track) ?? null : null;
  const trackSec = chosenTrack?.durationSec ?? otherTrack?.durationSec ?? 0;
  const beats = chosenTrack?.beatTimesSec ?? [];
  const hasBeats = beats.length >= 4;
  const usable = tracks.filter((t) => t.status === 'ready' && t.licenceConfirmed && (t.durationSec ?? 0) + 0.05 >= (music?.durationSec ?? 0));
  const sectionChanged = Boolean(from && state && state.track === from.track && state.track !== 'none' && Math.abs(state.start - from.start) > 0.05);
  const patch = from && state ? buildAudioPatch(from, state, true) : {};
  const nothing = Object.keys(patch).length === 0;
  const montage = music?.styleId === 'beat_montage';
  const otherTracks = usable.filter((t) => t.id !== music?.track?.id);

  const listen = async () => {
    if (!state || state.track === 'none') return;
    try {
      const { url } = await apiRequest<{ url: string }>(`/api/music/${state.track}/listen`);
      audioRef.current?.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.currentTime = state.track === music?.track?.id ? state.start : 0;
      await audio.play();
      if (stopTimer.current) clearTimeout(stopTimer.current);
      stopTimer.current = setTimeout(() => audio.pause(), Math.max(1, music?.durationSec ?? 10) * 1000);
    } catch (err) {
      toast.error('Could not play the track', err instanceof Error ? err.message : undefined);
    }
  };

  const apply = async (kind: 'keep' | 'recut' | 'apply') => {
    if (!from || !state) return;
    setBusy(kind);
    try {
      const body = buildAudioPatch(from, state, kind !== 'recut');
      await apiRequest(`/api/edits/${editId}/revise`, { method: 'POST', body: { audio: body } });
      const recut = body.trackId !== undefined || body.beatSync !== undefined || body.revealOnBeat !== undefined || (body.startSec !== undefined && body.keepCuts === false);
      toast.success(recut ? 'Re-cutting to the music' : 'Changing the sound', recut ? 'A new version is being made. The current one is kept.' : 'Same cuts, new sound. The current version is kept.');
      audioRef.current?.pause();
      onClose();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const footer = (
    <>
      {music && state && nothing && !sectionChanged ? <p className="mr-auto self-center text-xs text-charcoal-500">Change something to make a new version.</p> : null}
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {sectionChanged ? (
        <>
          <Button variant="secondary" onClick={() => void apply('recut')} loading={busy === 'recut'} disabled={busy !== null}>
            <Scissors className="size-4" aria-hidden="true" /> Re-cut to this section
          </Button>
          <Button onClick={() => void apply('keep')} loading={busy === 'keep'} disabled={busy !== null}>
            <Wand2 className="size-4" aria-hidden="true" /> Keep my cuts
          </Button>
        </>
      ) : (
        <Button onClick={() => void apply('apply')} loading={busy === 'apply'} disabled={busy !== null || nothing}>
          <Wand2 className="size-4" aria-hidden="true" /> Apply
        </Button>
      )}
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} title={`Sound for “${editName}”`} description="Changes make a new version. The current one is kept in the version list." footer={footer}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!music || !state ? (
        !error ? <Skeleton className="h-48 w-full" /> : null
      ) : (
        <div className="space-y-5">
          <Select
            label="Track"
            value={state.track}
            onChange={(e) => setState(withTrack(state, e.target.value, from))}
            options={[
              ...(music.track && music.sound.hasMusic ? [{ value: music.track.id, label: `Current track: ${music.track.title}` }] : []),
              ...otherTracks.map((t) => ({ value: t.id, label: `${t.title}${t.artist ? ` · ${t.artist}` : ''}` })),
              { value: 'none', label: 'No music' },
            ]}
            hint={
              otherTracks.length === 0 ? (
                <>
                  {music.track && music.sound.hasMusic ? 'No other track fits this edit yet.' : 'No track fits this edit yet.'} Add one with “Upload licensed track” on this page or in{' '}
                  <Link href="/settings?tab=music" className="font-medium text-charcoal-800 underline decoration-[var(--accent)] decoration-2 underline-offset-4">
                    Settings → Music library
                  </Link>
                  . A track needs a confirmed licence, must have finished analysing and must be at least as long as this edit.
                </>
              ) : undefined
            }
          />
          {otherTrack ? <p className="text-sm text-charcoal-600">A new track re-cuts the edit to its beat.</p> : null}
          {chosenTrack && trackSec > 0 ? (
            <div className="space-y-2">
              <EnergyStrip energy={chosenTrack.energy} beats={beats} trackSec={trackSec} windowSec={music.durationSec} start={state.start} onChange={(v) => set('start', v)} />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => set('start', strongestWindowStart(chosenTrack.energy, trackSec, music.durationSec))}>
                  Use the strongest part
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void listen()}>
                  <Headphones className="size-4" aria-hidden="true" /> Listen from {formatSeconds(state.start)}
                </Button>
              </div>
            </div>
          ) : null}
          {state.track !== 'none' ? (
            <div className="space-y-3">
              {hasBeats || otherTrack ? (
                <Switch
                  checked={montage ? true : state.beatSync}
                  disabled={montage}
                  onChange={(v) => set('beatSync', v)}
                  label="Cut to the beat"
                  description={montage ? 'The beat montage always cuts on the beat.' : 'Changing this re-cuts the edit.'}
                />
              ) : (
                <p className="text-sm text-charcoal-600">No clear beat found — beat options are off.</p>
              )}
              {music.hasResultShot && (hasBeats || otherTrack) ? <Switch checked={state.reveal} onChange={(v) => set('reveal', v)} label="Land the reveal on a beat" description="The finished cut appears on a beat. Re-cuts the edit." /> : null}
              <Slider label="Music volume" value={state.volume} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set('volume', v)} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Slider label="Fade in" value={state.fadeIn} min={0} max={3} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(v) => set('fadeIn', v)} />
                <Slider label="Fade out" value={state.fadeOut} min={0} max={4} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(v) => set('fadeOut', v)} />
              </div>
            </div>
          ) : null}
          <fieldset className="space-y-2" disabled={!music.clipsHaveSound}>
            <legend className="text-sm font-medium text-charcoal-800">Original sound</legend>
            {!music.clipsHaveSound ? <p className="text-sm text-charcoal-500">None of the clips in this edit has its own sound.</p> : null}
            <div className="flex flex-wrap gap-x-5">
              {originalSoundChoices(state.track, state.original).map((value) => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-charcoal-800">
                  <input type="radio" name={`original-${versionId}`} className="size-4 shrink-0 accent-[var(--accent)]" checked={state.original === value} onChange={() => set('original', value)} />
                  {ORIGINAL_SOUND_LABELS[value]}
                </label>
              ))}
            </div>
            {state.original !== 'off' ? <Slider label="Original sound volume" value={state.originalVolume} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set('originalVolume', v)} /> : null}
            {state.original === 'under_music' && state.track !== 'none' ? <Switch checked={state.duck} onChange={(v) => set('duck', v)} label="Lower music while people talk" /> : null}
          </fieldset>
        </div>
      )}
    </Dialog>
  );
}
