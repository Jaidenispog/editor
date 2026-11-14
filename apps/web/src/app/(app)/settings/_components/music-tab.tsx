'use client';

import { FileCheck2, Music, Tags, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import { LICENCE_STATE_LABELS, type LicenceState } from '@studio/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { Input } from '@/components/ui/field';
import { MusicUploadDialog, type MusicUploadRequest } from '@/components/studio/music-upload-dialog';
import { UploadList } from '@/components/studio/upload-zone';
import { apiRequest } from '@/lib/client/api-client';
import { ChunkedUploader, type UploadItem } from '@/lib/client/uploader';
import { formatBytes, formatDate, formatSeconds } from '@/lib/format';
import type { MusicTrackSummary } from '@/lib/music';
import { finishedUploadsShownAsTracks, isAnalysisCancelled, isTrackAnalysing, showsLicenceEnd, trackStatusPill } from '@/lib/shared/music-display';
import {
  LICENCE_PLACES,
  LicencePassportForm,
  RightsConfirmation,
  licenceDraftFrom,
  licenceFromDraft,
  licenceKindLabel,
  licenceStepError,
  parseTags,
  stepTitle,
  type LicenceDraft,
} from './licence-passport-form';
import { MusicReferences } from './music-references';

const EMPTY_UPLOADS: UploadItem[] = [];
/** How often the list refreshes while a track is still being analysed. */
const ANALYSING_REFRESH_MS = 5000;

const LICENCE_STATE_TEXT: Record<LicenceState, { tone: 'success' | 'warning' | 'danger' | 'info'; help: string }> = {
  confirmed: { tone: 'success', help: '' },
  not_confirmed: { tone: 'warning', help: 'Open “Licence details” and confirm your rights before this track can be used in edits.' },
  expired: { tone: 'danger', help: 'The licence end date has passed. Update the details if you renewed it.' },
  meta_only: { tone: 'info', help: 'Videos with this track are marked “For Instagram/Facebook upload only”.' },
};

/** "Licence details": the licence passport of a track in three steps, and confirming (or withdrawing) the owner's rights. */
function LicenceDetailsDialog({ track, onClose, onSaved }: { track: MusicTrackSummary; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const formId = useId();
  const [draft, setDraft] = useState<LicenceDraft>(() => licenceDraftFrom(track.licence));
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [confirmed, setConfirmed] = useState(track.licenceConfirmed);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (step < 3) {
      const problem = licenceStepError(draft, step);
      if (problem) return setError(problem);
      setError(null);
      return setStep(step === 1 ? 2 : 3);
    }
    const built = licenceFromDraft(draft);
    if ('error' in built) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/api/music/${track.id}`, { method: 'PATCH', body: { licence: built.licence, confirmLicence: confirmed } });
      toast.success(confirmed ? 'Licence confirmed' : 'Licence details saved', confirmed ? `${track.title} can now be used in new edits.` : `${track.title} cannot be used in edits until you confirm your rights.`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The licence details could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Licence details: ${track.title}`}
      description={`${stepTitle(step)}${stepTitle(step).endsWith('?') ? '' : '.'} ${
        track.licence.confirmedByOwnerAt
          ? `You confirmed your rights on ${formatDate(track.licence.confirmedByOwnerAt)}. Saving changed details with the box ticked confirms them again.`
          : 'Record where this track came from and where you may use it, then confirm your rights so it can be used in edits.'
      }`}
      footer={
        <>
          {step > 1 ? (
            <Button variant="ghost" onClick={() => setStep(step === 3 ? 2 : 1)}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="submit" form={formId} loading={saving} disabled={draft.kind === 'cc_by_nc'}>
            {step < 3 ? 'Next' : 'Save licence details'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={save} className="space-y-4" noValidate>
        <LicencePassportForm draft={draft} onChange={setDraft} step={step} disabled={saving} />
        {step === 3 ? <RightsConfirmation checked={confirmed} onChange={setConfirmed} disabled={saving} /> : null}
        {step === 3 && !confirmed ? <p className="text-sm text-amber-800">Without this confirmation the track cannot be used in new edits.</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** "Genres and moods" of one track (they guide "Suggested for you" in the Studio). */
function TagsDialog({ track, onClose, onSaved }: { track: MusicTrackSummary; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const formId = useId();
  const [genres, setGenres] = useState(track.genres.join(', '));
  const [moods, setMoods] = useState(track.moods.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/api/music/${track.id}`, { method: 'PATCH', body: { genres: parseTags(genres), moods: parseTags(moods) } });
      toast.success('Tags saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The tags could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Genres and moods: ${track.title}`}
      description="Used to suggest tracks from your own library in the Video Studio. Nothing is searched outside your library."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Save tags
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={save} className="space-y-4" noValidate>
        <Input label="Genres" hint="Separate with commas, e.g. hip hop, R&B, lo-fi" value={genres} onChange={(e) => setGenres(e.target.value)} maxLength={500} />
        <Input label="Moods" hint="e.g. upbeat, calm, cinematic" value={moods} onChange={(e) => setMoods(e.target.value)} maxLength={500} />
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * Music library: every track with its licence passport chips (licence state, origin, destinations, genres and
 * moods), "Licence details" with the explicit rights confirmation, uploading new licensed tracks with the same
 * resumable uploader as the Video Studio, and the private Spotify references.
 */
export function MusicTab({ tracks, maxUploadBytes }: { tracks: MusicTrackSummary[]; maxUploadBytes: number }) {
  const router = useRouter();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState<MusicTrackSummary | null>(null);
  const [editing, setEditing] = useState<MusicTrackSummary | null>(null);
  const [tagging, setTagging] = useState<MusicTrackSummary | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onFinished = useCallback(
    (item: UploadItem) => {
      toast.success('Track uploaded', `${item.name} is being analysed for its beat. It is ready to use once the analysis finishes.`);
      router.refresh();
    },
    [router, toast],
  );
  const [uploader] = useState(() => new ChunkedUploader({ onFinished }));
  useEffect(() => () => uploader.dispose(), [uploader]);
  const uploads = useSyncExternalStore(uploader.subscribe, uploader.getSnapshot, () => EMPTY_UPLOADS);

  // A finished upload's row goes once its track is listed below (the track row says the same and more).
  useEffect(() => {
    for (const key of finishedUploadsShownAsTracks(uploads, tracks.map((t) => t.id))) uploader.dismiss(key);
  }, [uploads, tracks, uploader]);

  const analysing = tracks.some((t) => t.status === 'uploaded' || t.status === 'processing');
  useEffect(() => {
    if (!analysing) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, ANALYSING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [analysing, router]);

  const startUpload = (request: MusicUploadRequest) =>
    uploader.add([request.file], { projectId: 'library', kind: 'audio', maxBytes: maxUploadBytes, completeBody: request.completeBody, createPath: '/api/music/uploads' });

  const remove = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiRequest(`/api/music/${confirmDelete.id}`, { method: 'DELETE' });
      toast.success('Track removed');
      setConfirmDelete(null);
      router.refresh();
    } catch (err) {
      toast.error('Track not removed', err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader
        title="Music library"
        description="Tracks you have the rights to use. A track can only go into an edit once its licence is confirmed."
        actions={
          <Button variant="secondary" size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="size-4" aria-hidden="true" /> Upload licensed track
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <UploadList items={uploads} onPause={(k) => uploader.pause(k)} onResume={(k) => uploader.resume(k)} onCancel={(k) => void uploader.cancel(k)} onDismiss={(k) => uploader.dismiss(k)} />
        {tracks.length === 0 ? (
          <EmptyState
            icon={<Music />}
            title="No music yet"
            description="Upload a track you have the rights to use. Edits can still use the original sound from your clips."
            action={
              <Button onClick={() => setUploadOpen(true)}>
                <Upload className="size-4" aria-hidden="true" /> Upload licensed track
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-charcoal-100">
            {tracks.map((t) => {
              const state = t.licenceState;
              const info = LICENCE_STATE_TEXT[state];
              const places = LICENCE_PLACES.filter(([key]) => key !== 'promotionalUse' && t.licence.permitted[key]).map(([, label]) => label);
              const pill = trackStatusPill(t.status, t.statusMessage);
              const busy = isTrackAnalysing(t);
              const stopped = isAnalysisCancelled(t);
              return (
                <li key={t.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold">{t.title}</p>
                      <StatusPill status={pill.status} label={pill.label} />
                    </div>
                    <p className="mt-0.5 text-sm text-charcoal-500">
                      {[t.artist || null, t.durationSec ? formatSeconds(t.durationSec) : null, t.bpm ? `${Math.round(t.bpm)} BPM` : null, formatBytes(t.byteSize)].filter(Boolean).join(' · ')}
                    </p>
                    {t.status === 'failed' && t.statusMessage ? <p className="mt-1 text-sm text-red-600">{t.statusMessage}</p> : null}
                    {busy ? <p className="mt-1 text-sm text-charcoal-600">{`${(t.statusMessage || 'Finding the beat').replace(/[.\s]+$/, '')}. It can be used in edits once this finishes.`}</p> : null}
                    {stopped ? <p className="mt-1 text-sm text-charcoal-600">The beat analysis was stopped, so this track cannot be used in edits. Remove it and upload it again to analyse it.</p> : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone={info.tone}>{LICENCE_STATE_LABELS[state]}</Badge>
                      <Badge>{licenceKindLabel(t.licence.kind)}</Badge>
                      {t.licence.planName ? <Badge>{t.licence.planName}</Badge> : t.licence.licenceName ? <Badge>{t.licence.licenceName}</Badge> : null}
                      {[...t.genres, ...t.moods].map((g) => (
                        <Badge key={`tag-${g}`} tone="accent">
                          {g}
                        </Badge>
                      ))}
                    </div>
                    {!t.licence.permitted.promotionalUse ? <p className="mt-1 text-xs text-amber-800">Not ticked for promoting the business, so exports with this track are blocked.</p> : null}
                    <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-charcoal-600 sm:grid-cols-2">
                      <div>
                        <dt className="inline font-medium text-charcoal-700">Allowed for: </dt>
                        <dd className="inline">{places.length ? places.join(', ') : 'nothing recorded yet'}</dd>
                      </div>
                      {showsLicenceEnd(t.licence) ? (
                        <div>
                          <dt className="inline font-medium text-charcoal-700">Licence ends: </dt>
                          <dd className="inline">{t.licence.expiresAt ? formatDate(t.licence.expiresAt) : 'no end date recorded'}</dd>
                        </div>
                      ) : null}
                      {t.licence.attributionRequired ? (
                        <div className="sm:col-span-2">
                          <dt className="inline font-medium text-charcoal-700">Credit line: </dt>
                          <dd className="inline">{t.licence.attributionText || 'required, but not filled in'}</dd>
                        </div>
                      ) : null}
                      {t.licence.confirmedByOwnerAt ? (
                        <div className="sm:col-span-2">
                          <dt className="inline font-medium text-charcoal-700">Rights confirmed: </dt>
                          <dd className="inline">{formatDate(t.licence.confirmedByOwnerAt)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {info.help ? <p className="mt-2 text-sm text-charcoal-600">{info.help}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button variant={state === 'confirmed' || state === 'meta_only' ? 'ghost' : 'secondary'} size="sm" onClick={() => setEditing(t)} aria-label={`Licence details for ${t.title}`}>
                      <FileCheck2 className="size-4" aria-hidden="true" /> Licence details
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setTagging(t)} aria-label={`Genres and moods for ${t.title}`}>
                      <Tags className="size-4" aria-hidden="true" /> Tags
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(t)} aria-label={`Remove ${t.title}`}>
                      <Trash2 className="size-4" aria-hidden="true" /> Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      {editing ? <LicenceDetailsDialog key={editing.id} track={editing} onClose={() => setEditing(null)} onSaved={() => router.refresh()} /> : null}
      {tagging ? <TagsDialog key={tagging.id} track={tagging} onClose={() => setTagging(null)} onSaved={() => router.refresh()} /> : null}
      <MusicUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onSubmit={startUpload} />
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Remove this track?"
        description="The audio file is deleted. Edits already rendered keep their sound, but new edits cannot use this track."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={remove} loading={deleting}>
              Remove track
            </Button>
          </>
        }
      />
    </Card>
    <MusicReferences />
    </div>
  );
}
