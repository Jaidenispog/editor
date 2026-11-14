'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import type { MusicLicence } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { UPLOAD_ACCEPT, checkUploadFile } from '@/lib/shared/upload-math';
import { LicenceFields, RightsConfirmation, emptyLicenceDraft, licenceFromDraft, type LicenceDraft } from './licence-form';

/** What the dialog hands back once the owner has filled in the licence and confirmed it. */
export interface MusicUploadRequest {
  file: File;
  completeBody: { title: string; artist: string; licence: MusicLicence; confirmLicence: true };
}

/**
 * "Upload licensed track": choose an audio file, record where it came from and where it may be used, and
 * confirm the rights. Nothing is uploaded until the confirmation box is ticked. Used in the Video Studio and
 * in Settings → Music library.
 */
export function MusicUploadDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (request: MusicUploadRequest) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [draft, setDraft] = useState<LicenceDraft>(emptyLicenceDraft);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setTitle('');
    setArtist('');
    setDraft(emptyLicenceDraft());
    setConfirmed(false);
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Choose the music file first.');
    const check = checkUploadFile({ filename: file.name, mimeType: file.type, kind: 'audio' });
    if (!check.ok) return setError(check.reason);
    if (!confirmed) return setError('Tick the box to confirm you have the rights to this recording.');
    const built = licenceFromDraft(draft);
    if ('error' in built) return setError(built.error);
    onSubmit({ file, completeBody: { title: title.trim() || file.name.replace(/\.[^.]+$/, ''), artist: artist.trim(), licence: built.licence, confirmLicence: true } });
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload a licensed track"
      description="Only add music you have the right to use in promotional videos. The details are kept with the track so you can show proof later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!confirmed || !file}>
            Upload track
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            {file ? 'Choose a different file' : 'Choose music file'}
          </Button>
          <span className="ml-3 text-sm text-charcoal-600">{file ? file.name : '.mp3, .m4a, .wav or .aac'}</span>
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
        </div>
        <LicenceFields draft={draft} onChange={setDraft} />
        <RightsConfirmation checked={confirmed} onChange={setConfirmed} />
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
