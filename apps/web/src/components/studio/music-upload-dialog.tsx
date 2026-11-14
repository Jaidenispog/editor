'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import type { MusicLicence } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/field';
import { UPLOAD_ACCEPT, checkUploadFile } from '@/lib/shared/upload-math';

const LICENCE_KINDS: Array<{ value: MusicLicence['kind']; label: string }> = [
  { value: 'owner_upload', label: 'I made it or own the recording' },
  { value: 'commercial_licence', label: 'Bought a commercial licence' },
  { value: 'catalogue', label: 'Licensed music library (subscription)' },
  { value: 'cc0', label: 'Creative Commons zero (CC0)' },
  { value: 'cc_by', label: 'Creative Commons with credit (CC BY)' },
  { value: 'public_domain', label: 'Public domain' },
];

const PLACES = [
  ['promotionalUse', 'Promoting the business'],
  ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'],
  ['website', 'The studio website'],
] as const;

type Permitted = MusicLicence['permitted'];

/** What the dialog hands back once the owner has filled in the licence and confirmed it. */
export interface MusicUploadRequest {
  file: File;
  completeBody: { title: string; artist: string; licence: MusicLicence; confirmLicence: true };
}

/**
 * "Upload licensed track": choose an audio file, record where it came from and where it may be used, and
 * confirm the rights. Nothing is uploaded until the confirmation box is ticked.
 */
export function MusicUploadDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (request: MusicUploadRequest) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [kind, setKind] = useState<MusicLicence['kind']>('commercial_licence');
  const [source, setSource] = useState('');
  const [licenceName, setLicenceName] = useState('');
  const [proofUrl, setProofUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [attributionText, setAttributionText] = useState('');
  const [permitted, setPermitted] = useState<Permitted>({ promotionalUse: true, instagram: true, tiktok: true, youtube: false, website: false });
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setTitle('');
    setArtist('');
    setSource('');
    setLicenceName('');
    setProofUrl('');
    setNotes('');
    setExpiresAt('');
    setAttributionText('');
    setConfirmed(false);
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Choose the music file first.');
    const check = checkUploadFile({ filename: file.name, mimeType: file.type, kind: 'audio' });
    if (!check.ok) return setError(check.reason);
    if (!confirmed) return setError('Tick the box to confirm you hold the rights to this music.');
    const attributionRequired = kind === 'cc_by' || attributionText.trim().length > 0;
    if (kind === 'cc_by' && !attributionText.trim()) return setError('Creative Commons with credit needs the credit line to show with the video.');
    const licence: MusicLicence = {
      kind,
      source: source.trim(),
      licenceName: licenceName.trim(),
      proofUrl: proofUrl.trim(),
      notes: notes.trim(),
      permitted,
      attributionRequired,
      attributionText: attributionText.trim(),
      expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      confirmedByOwnerAt: null,
    };
    onSubmit({ file, completeBody: { title: title.trim() || file.name.replace(/\.[^.]+$/, ''), artist: artist.trim(), licence, confirmLicence: true } });
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
        <Select label="Where did the music come from?" value={kind} onChange={(e) => setKind(e.target.value as MusicLicence['kind'])} options={LICENCE_KINDS} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Seller or library (optional)" value={source} onChange={(e) => setSource(e.target.value)} maxLength={120} placeholder="e.g. Artlist" />
          <Input label="Licence name (optional)" value={licenceName} onChange={(e) => setLicenceName(e.target.value)} maxLength={120} placeholder="e.g. Social media licence" />
        </div>
        <Input label="Link to the licence or receipt (optional)" value={proofUrl} onChange={(e) => setProofUrl(e.target.value)} maxLength={500} type="url" />
        <fieldset>
          <legend className="text-sm font-medium text-charcoal-800">The licence allows use for</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {PLACES.map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-charcoal-700">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={permitted[key]} onChange={(e) => setPermitted((p) => ({ ...p, [key]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Licence ends (optional)" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          <Input label="Credit line (if required)" value={attributionText} onChange={(e) => setAttributionText(e.target.value)} maxLength={300} />
        </div>
        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
        <label className="flex items-start gap-2 rounded-lg bg-charcoal-50 p-3 text-sm text-charcoal-800">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>I confirm I hold the rights to use this recording for the purposes ticked above.</span>
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
