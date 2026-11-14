'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import type { MusicLicence } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { UPLOAD_ACCEPT, checkUploadFile } from '@/lib/shared/upload-math';
import {
  LicencePassportForm,
  RightsConfirmation,
  emptyLicenceDraft,
  licenceFromDraft,
  licenceStepError,
  parseTags,
  stepTitle,
  type LicenceDraft,
} from '@/app/(app)/settings/_components/licence-passport-form';

/** What the dialog hands back once the owner has filled in the licence passport and confirmed it. */
export interface MusicUploadRequest {
  file: File;
  completeBody: { title: string; artist: string; genres: string[]; moods: string[]; licence: MusicLicence; confirmLicence: true };
}

/**
 * "Upload licensed track": choose an audio file, then the three licence passport steps (where it is from, the
 * licence details, where it may be used) and the rights confirmation. Nothing is uploaded until step 3 is confirmed.
 * Used in the Video Studio and in Settings → Music library.
 */
export function MusicUploadDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (request: MusicUploadRequest) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [genres, setGenres] = useState('');
  const [moods, setMoods] = useState('');
  const [draft, setDraft] = useState<LicenceDraft>(emptyLicenceDraft);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setTitle('');
    setArtist('');
    setGenres('');
    setMoods('');
    setDraft(emptyLicenceDraft());
    setStep(1);
    setConfirmed(false);
    setError(null);
  };

  const next = () => {
    if (step === 1) {
      if (!file) return setError('Choose the music file first.');
      const check = checkUploadFile({ filename: file.name, mimeType: file.type, kind: 'audio' });
      if (!check.ok) return setError(check.reason);
    }
    const problem = licenceStepError(draft, step);
    if (problem) return setError(problem);
    setError(null);
    setStep(step === 1 ? 2 : 3);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step < 3) return next();
    if (!file) return setError('Choose the music file first.');
    if (!confirmed) return setError('Tick the box to confirm the business holds the rights to this recording.');
    const built = licenceFromDraft(draft);
    if ('error' in built) return setError(built.error);
    onSubmit({
      file,
      completeBody: { title: title.trim() || file.name.replace(/\.[^.]+$/, ''), artist: artist.trim(), genres: parseTags(genres), moods: parseTags(moods), licence: built.licence, confirmLicence: true },
    });
    reset();
    onClose();
  };

  const refused = draft.kind === 'cc_by_nc';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload a licensed track"
      description={stepTitle(step)}
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
          {step < 3 ? (
            <Button type="submit" form={formId} disabled={refused || (step === 1 && !file)}>
              Next
            </Button>
          ) : (
            <Button type="submit" form={formId} disabled={!confirmed || !file}>
              Upload track
            </Button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
        {step === 1 ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                {file ? 'Choose a different file' : 'Choose music file'}
              </Button>
              <span className="min-w-0 truncate text-sm text-charcoal-600">{file ? file.name : '.mp3, .m4a, .wav or .aac'}</span>
              <input
                ref={fileRef}
                type="file"
                accept={UPLOAD_ACCEPT.audio}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  setFile(f);
                  if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
                }}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Track title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
              <Input label="Artist (optional)" value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={160} />
              <Input label="Genres (optional)" hint="Separate with commas, e.g. hip hop, lo-fi" value={genres} onChange={(e) => setGenres(e.target.value)} maxLength={400} />
              <Input label="Moods (optional)" hint="e.g. upbeat, calm" value={moods} onChange={(e) => setMoods(e.target.value)} maxLength={400} />
            </div>
          </>
        ) : null}
        <LicencePassportForm draft={draft} onChange={setDraft} step={step} />
        {step === 3 ? <RightsConfirmation checked={confirmed} onChange={setConfirmed} /> : null}
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
