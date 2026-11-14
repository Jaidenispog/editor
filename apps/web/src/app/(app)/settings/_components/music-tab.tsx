'use client';

import { FileCheck2, Music, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { LICENCE_KINDS, LICENCE_PLACES, LicenceFields, RightsConfirmation, licenceDraftFrom, licenceFromDraft, type LicenceDraft } from '@/components/studio/licence-form';
import { MusicUploadDialog, type MusicUploadRequest } from '@/components/studio/music-upload-dialog';
import { UploadList } from '@/components/studio/upload-zone';
import { apiRequest } from '@/lib/client/api-client';
import { ChunkedUploader, type UploadItem } from '@/lib/client/uploader';
import { formatBytes, formatDate, formatSeconds } from '@/lib/format';
import type { MusicTrackSummary } from '@/lib/music';

const EMPTY_UPLOADS: UploadItem[] = [];
/** How often the list refreshes while a track is still being analysed. */
const ANALYSING_REFRESH_MS = 5000;

type LicenceState = 'confirmed' | 'unconfirmed' | 'expired';

function licenceState(t: MusicTrackSummary): LicenceState {
  if (!t.licenceConfirmed) return 'unconfirmed';
  if (t.licence.expiresAt && new Date(t.licence.expiresAt).getTime() < Date.now()) return 'expired';
  return 'confirmed';
}

const LICENCE_STATE_TEXT: Record<LicenceState, { label: string; tone: 'success' | 'warning' | 'danger'; help: string }> = {
  confirmed: { label: 'Licence confirmed', tone: 'success', help: '' },
  unconfirmed: { label: 'Licence not confirmed', tone: 'warning', help: 'Open “Licence details” and confirm your rights before this track can be used in edits.' },
  expired: { label: 'Licence expired', tone: 'danger', help: 'The licence end date has passed. Update the details if you renewed it.' },
};

/** "Licence details": edit the licence record of a track and confirm (or withdraw) the owner's rights. */
function LicenceDetailsDialog({ track, onClose, onSaved }: { track: MusicTrackSummary; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const formId = useId();
  const [draft, setDraft] = useState<LicenceDraft>(() => licenceDraftFrom(track.licence));
  const [confirmed, setConfirmed] = useState(track.licenceConfirmed);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
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
      description={
        track.licence.confirmedByOwnerAt
          ? `You confirmed your rights on ${formatDate(track.licence.confirmedByOwnerAt)}. Saving changed details with the box ticked confirms them again.`
          : 'Record where this track came from and where you may use it, then confirm your rights so it can be used in edits.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Save licence details
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={save} className="space-y-4" noValidate>
        <LicenceFields draft={draft} onChange={setDraft} disabled={saving} />
        <RightsConfirmation checked={confirmed} onChange={setConfirmed} disabled={saving} />
        {!confirmed ? <p className="text-sm text-amber-800">Without this confirmation the track cannot be used in new edits.</p> : null}
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
 * Music library: every track with its licence status, a "Licence details" form with the explicit rights
 * confirmation, and uploading new licensed tracks with the same resumable uploader as the Video Studio.
 */
export function MusicTab({ tracks, maxUploadBytes }: { tracks: MusicTrackSummary[]; maxUploadBytes: number }) {
  const router = useRouter();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState<MusicTrackSummary | null>(null);
  const [editing, setEditing] = useState<MusicTrackSummary | null>(null);
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
              const state = licenceState(t);
              const info = LICENCE_STATE_TEXT[state];
              const places = LICENCE_PLACES.filter(([key]) => t.licence.permitted[key]).map(([, label]) => label);
              return (
                <li key={t.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold">{t.title}</p>
                      <StatusPill status={t.status} />
                    </div>
                    <p className="mt-0.5 text-sm text-charcoal-500">
                      {[t.artist || null, t.durationSec ? formatSeconds(t.durationSec) : null, t.bpm ? `${Math.round(t.bpm)} BPM` : null, formatBytes(t.byteSize)].filter(Boolean).join(' · ')}
                    </p>
                    {t.status === 'failed' && t.statusMessage ? <p className="mt-1 text-sm text-red-600">{t.statusMessage}</p> : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone={info.tone}>{info.label}</Badge>
                      <Badge>{LICENCE_KINDS.find((k) => k.value === t.licence.kind)?.label ?? 'Not sure'}</Badge>
                      {t.licence.licenceName ? <Badge>{t.licence.licenceName}</Badge> : null}
                    </div>
                    <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-charcoal-600 sm:grid-cols-2">
                      <div>
                        <dt className="inline font-medium text-charcoal-700">Allowed for: </dt>
                        <dd className="inline">{places.length ? places.join(', ') : 'nothing recorded yet'}</dd>
                      </div>
                      <div>
                        <dt className="inline font-medium text-charcoal-700">Licence ends: </dt>
                        <dd className="inline">{t.licence.expiresAt ? formatDate(t.licence.expiresAt) : 'no end date recorded'}</dd>
                      </div>
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
                  <div className="flex shrink-0 gap-1.5">
                    <Button variant={state === 'confirmed' ? 'ghost' : 'secondary'} size="sm" onClick={() => setEditing(t)} aria-label={`Licence details for ${t.title}`}>
                      <FileCheck2 className="size-4" aria-hidden="true" /> Licence details
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
  );
}
