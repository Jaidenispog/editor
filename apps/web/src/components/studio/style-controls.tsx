'use client';

import { Music, Sparkles } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { StyleId } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatSeconds } from '@/lib/format';
import { cn } from '@/lib/shared/cn';
import type { StudioStatusDto } from '@/lib/shared/studio-dto';
import { MusicUploadDialog, type MusicUploadRequest } from './music-upload-dialog';

const SOUND_OPTIONS = [
  { value: 'auto', label: 'Automatic: keep talking, drop clipper noise' },
  { value: 'always', label: 'Always keep the original sound' },
  { value: 'never', label: 'Never: music only' },
];

const CAPTION_OPTIONS = [
  { value: 'auto', label: 'Add captions when someone is talking' },
  { value: 'never', label: 'No captions' },
];

/** Label for the main button: the real number of edits that will be made. */
export function generateButtonLabel(count: number): string {
  return `Generate ${count} edit${count === 1 ? '' : 's'}`;
}

/**
 * Style toggles, length slider, music choice, original-sound and caption options, free-text instructions and
 * the primary "Generate N edits" button. Unsupported styles are disabled with their plain reason.
 */
export function StyleControls({
  status,
  onGenerated,
  onUploadMusic,
}: {
  status: StudioStatusDto;
  onGenerated: () => void;
  onUploadMusic: (request: MusicUploadRequest) => void;
}) {
  const toast = useToast();
  const last = status.project.lastSettings;
  const durationId = useId();
  const [deselected, setDeselected] = useState<Set<StyleId>>(() => {
    if (!last) return new Set();
    return new Set(status.styles.filter((s) => !last.styles.includes(s.id)).map((s) => s.id));
  });
  const [durationSec, setDurationSec] = useState(last?.durationSec ?? status.defaults.durationSec);
  const [musicTrackId, setMusicTrackId] = useState<string>(last?.musicTrackId ?? '');
  const [keepOriginalSound, setKeepOriginalSound] = useState(last?.keepOriginalSound ?? status.defaults.keepOriginalSound);
  const [captions, setCaptions] = useState(last?.captions ?? status.defaults.captions);
  const [instructions, setInstructions] = useState(last?.instructions ?? '');
  const [musicOpen, setMusicOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const supported = status.styles.filter((s) => s.supported);
  const unsupported = status.styles.filter((s) => !s.supported);
  const chosen = supported.filter((s) => !deselected.has(s.id));
  const processing = status.assets.some((a) => a.status === 'uploaded' || a.status === 'processing');
  const readyClips = status.assets.filter((a) => a.status === 'ready').length;
  const planningNow = status.generations.some((g) => g.status === 'queued' || g.status === 'planning');
  const musicChoice = status.music.find((m) => m.id === musicTrackId) ?? null;
  const musicValid = !musicTrackId || (musicChoice?.status === 'ready' && musicChoice.licenceConfirmed);

  const musicOptions = useMemo(
    () => [
      { value: '', label: 'No music (original sound only)' },
      ...status.music.map((m) => {
        const parts = [m.artist ? `${m.title} – ${m.artist}` : m.title];
        if (m.status === 'ready') parts.push(m.bpm ? `${Math.round(m.bpm)} BPM` : 'tempo unknown');
        else if (m.status === 'failed') parts.push('could not be analysed');
        else parts.push('analysing…');
        parts.push(m.licenceSummary);
        return { value: m.id, label: parts.join(' · '), disabled: m.status !== 'ready' || !m.licenceConfirmed };
      }),
    ],
    [status.music],
  );

  let blockedReason: string | null = null;
  if (status.assets.length === 0) blockedReason = 'Add your clips to start.';
  else if (processing) blockedReason = 'Waiting for the clips to finish analysing.';
  else if (readyClips === 0) blockedReason = 'None of the clips could be analysed yet. Retry or replace them.';
  else if (planningNow) blockedReason = 'Edits are being planned right now.';
  else if (supported.length === 0) blockedReason = 'These clips do not support any style yet. Tag what each clip shows.';
  else if (chosen.length === 0) blockedReason = 'Choose at least one style.';
  else if (!musicValid) blockedReason = 'The chosen music is not ready or its licence is not confirmed.';

  const toggle = (id: StyleId) =>
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const generate = async () => {
    setSubmitting(true);
    try {
      await apiRequest(`/api/projects/${status.project.id}/generate`, {
        method: 'POST',
        body: { durationSec, styles: chosen.map((s) => s.id), musicTrackId: musicTrackId || null, keepOriginalSound, captions, instructions: instructions.trim() },
      });
      toast.success(`Making ${chosen.length} edit${chosen.length === 1 ? '' : 's'}`, 'Previews appear below as each one finishes.');
      onGenerated();
    } catch (err) {
      toast.error('Could not start the edits', err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Choose your edits" description="Each style is a genuinely different cut of the same footage. You can revise any of them afterwards." />
      <CardBody className="space-y-6">
        <fieldset>
          <legend className="text-sm font-medium text-charcoal-800">Styles</legend>
          <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {status.styles.map((s) => {
              const on = s.supported && !deselected.has(s.id);
              return (
                <li key={s.id}>
                  <label
                    className={cn(
                      'flex h-full cursor-pointer gap-3 rounded-lg border p-3 transition',
                      !s.supported && 'cursor-not-allowed bg-charcoal-50 opacity-80',
                      on ? 'border-charcoal-900 ring-1 ring-charcoal-900' : 'border-charcoal-200 hover:border-charcoal-300',
                    )}
                  >
                    <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" checked={on} disabled={!s.supported} onChange={() => toggle(s.id)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-charcoal-900">{s.name}</span>
                      <span className="block text-sm text-charcoal-600">{s.description}</span>
                      {!s.supported ? <span className="mt-1 block text-xs text-amber-800">{s.reason}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={durationId} className="text-sm font-medium text-charcoal-800">
              Length
            </label>
            <span className="text-sm font-semibold text-charcoal-900 tabular-nums">
              {durationSec} s <span className="font-normal text-charcoal-500">({formatSeconds(durationSec)})</span>
            </span>
          </div>
          <input
            id={durationId}
            type="range"
            min={8}
            max={90}
            step={1}
            value={durationSec}
            onChange={(e) => setDurationSec(Number(e.target.value))}
            className="mt-2 w-full accent-[var(--accent)]"
            aria-describedby={`${durationId}-hint`}
          />
          <p id={`${durationId}-hint`} className="mt-1 text-xs text-charcoal-500">
            20–30 seconds usually works best for Reels and TikTok.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Select label="Music" value={musicTrackId} onChange={(e) => setMusicTrackId(e.target.value)} options={musicOptions} hint={status.music.length === 0 ? 'No licensed tracks yet. Upload one you have the rights to.' : 'Only tracks with a confirmed licence can be used.'} />
            <Button variant="secondary" size="sm" onClick={() => setMusicOpen(true)}>
              <Music className="size-4" aria-hidden="true" /> Upload licensed track
            </Button>
          </div>
          <div className="space-y-4">
            <Select label="Original sound" value={keepOriginalSound} onChange={(e) => setKeepOriginalSound(e.target.value as typeof keepOriginalSound)} options={SOUND_OPTIONS} />
            <Select label="Captions" value={captions} onChange={(e) => setCaptions(e.target.value as typeof captions)} options={CAPTION_OPTIONS} hint="Captions only ever use words actually spoken in your clips." />
          </div>
        </div>

        <Textarea
          label="Anything the editor should know? (optional)"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="e.g. Show the line-up detail, keep it calm, end on the side profile"
        />

        <div className="flex flex-col gap-2 border-t border-charcoal-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-charcoal-600" aria-live="polite">
            {blockedReason ? (
              <p>{blockedReason}</p>
            ) : unsupported.length ? (
              <p>
                {unsupported.length} style{unsupported.length === 1 ? ' needs' : 's need'} different footage: {unsupported.map((s) => s.name).join(', ')}. Tagging your clips can unlock them.
              </p>
            ) : (
              <p>All five styles are available for these clips.</p>
            )}
          </div>
          <Button size="lg" onClick={generate} loading={submitting} disabled={Boolean(blockedReason)} className="shrink-0">
            <Sparkles className="size-4" aria-hidden="true" />
            {generateButtonLabel(chosen.length)}
          </Button>
        </div>
      </CardBody>
      <MusicUploadDialog open={musicOpen} onClose={() => setMusicOpen(false)} onSubmit={onUploadMusic} />
    </Card>
  );
}
