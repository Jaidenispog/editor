'use client';

import type { MusicLicence } from '@studio/core';
import { Input, Select, Textarea } from '@/components/ui/field';

/** "Where did the music come from?" choices in plain language. */
export const LICENCE_KINDS: Array<{ value: MusicLicence['kind']; label: string }> = [
  { value: 'owner_upload', label: 'I made it or own the recording' },
  { value: 'commercial_licence', label: 'Bought a commercial licence' },
  { value: 'catalogue', label: 'Licensed music library (subscription)' },
  { value: 'cc0', label: 'Creative Commons zero (CC0)' },
  { value: 'cc_by', label: 'Creative Commons with credit (CC BY)' },
  { value: 'public_domain', label: 'Public domain' },
  { value: 'unknown', label: 'Not sure' },
];

/** Where the licence may allow the music to be used. */
export const LICENCE_PLACES = [
  ['promotionalUse', 'Promoting the business'],
  ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'],
  ['website', 'The studio website'],
] as const;

/** The exact wording the owner ticks to confirm the rights. */
export const RIGHTS_CONFIRMATION_TEXT = 'I confirm I have the rights to use this recording as described';

/** The licence form's editable values (dates as yyyy-mm-dd for the date input). */
export interface LicenceDraft {
  kind: MusicLicence['kind'];
  source: string;
  licenceName: string;
  proofUrl: string;
  notes: string;
  permitted: MusicLicence['permitted'];
  attributionRequired: boolean;
  attributionText: string;
  expiresOn: string;
}

/** A blank draft for a new upload (a bought licence for social media is the most common case). */
export function emptyLicenceDraft(): LicenceDraft {
  return {
    kind: 'commercial_licence',
    source: '',
    licenceName: '',
    proofUrl: '',
    notes: '',
    permitted: { promotionalUse: true, instagram: true, tiktok: true, youtube: false, website: false },
    attributionRequired: false,
    attributionText: '',
    expiresOn: '',
  };
}

/** Loads a stored licence into the form. */
export function licenceDraftFrom(licence: MusicLicence): LicenceDraft {
  return {
    kind: licence.kind,
    source: licence.source,
    licenceName: licence.licenceName,
    proofUrl: licence.proofUrl,
    notes: licence.notes,
    permitted: { ...licence.permitted },
    attributionRequired: licence.attributionRequired,
    attributionText: licence.attributionText,
    expiresOn: licence.expiresAt ? toDateInput(licence.expiresAt) : '',
  };
}

function toDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Turns the form into the licence record sent to the server, or a plain reason it cannot be saved yet. The
 * confirmation time is never set here: only the server records it, when the owner ticks the confirmation.
 */
export function licenceFromDraft(draft: LicenceDraft): { licence: MusicLicence } | { error: string } {
  const proofUrl = draft.proofUrl.trim();
  if (proofUrl && !/^https?:\/\/\S+$/i.test(proofUrl)) return { error: 'The proof link should start with https:// (or leave it empty).' };
  const attributionText = draft.attributionText.trim();
  const attributionRequired = draft.kind === 'cc_by' || draft.attributionRequired || attributionText.length > 0;
  if (attributionRequired && !attributionText) return { error: 'Add the credit line the licence asks you to show with the video.' };
  return {
    licence: {
      kind: draft.kind,
      source: draft.source.trim(),
      licenceName: draft.licenceName.trim(),
      proofUrl,
      notes: draft.notes.trim(),
      permitted: draft.permitted,
      attributionRequired,
      attributionText,
      expiresAt: draft.expiresOn ? new Date(`${draft.expiresOn}T23:59:59`).toISOString() : null,
      confirmedByOwnerAt: null,
    },
  };
}

/**
 * The licence questions in plain language: where the music came from, the licence name and a link to the
 * proof, where it may be used, whether a credit line is needed and when the licence ends.
 */
export function LicenceFields({ draft, onChange, disabled = false }: { draft: LicenceDraft; onChange: (next: LicenceDraft) => void; disabled?: boolean }) {
  const set = <K extends keyof LicenceDraft>(key: K, value: LicenceDraft[K]) => onChange({ ...draft, [key]: value });
  return (
    <div className="space-y-4">
      <Select label="Where did the music come from?" value={draft.kind} disabled={disabled} onChange={(e) => set('kind', e.target.value as MusicLicence['kind'])} options={LICENCE_KINDS} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Seller, library or artist (optional)" value={draft.source} disabled={disabled} onChange={(e) => set('source', e.target.value)} maxLength={120} placeholder="e.g. Artlist" />
        <Input label="Licence name (optional)" value={draft.licenceName} disabled={disabled} onChange={(e) => set('licenceName', e.target.value)} maxLength={120} placeholder="e.g. Social media licence" />
      </div>
      <Input
        label="Link to the licence or receipt (optional)"
        value={draft.proofUrl}
        disabled={disabled}
        onChange={(e) => set('proofUrl', e.target.value)}
        maxLength={500}
        type="url"
        hint="Keep proof somewhere you can find it if a platform ever asks."
      />
      <fieldset disabled={disabled}>
        <legend className="text-sm font-medium text-charcoal-800">The licence allows use for</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {LICENCE_PLACES.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-charcoal-700">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={draft.permitted[key]} onChange={(e) => set('permitted', { ...draft.permitted, [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-charcoal-700">
        <input
          type="checkbox"
          className="size-4 accent-[var(--accent)]"
          disabled={disabled || draft.kind === 'cc_by'}
          checked={draft.kind === 'cc_by' || draft.attributionRequired}
          onChange={(e) => set('attributionRequired', e.target.checked)}
        />
        The licence asks for a credit line with the video
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Credit line (if required)" value={draft.attributionText} disabled={disabled} onChange={(e) => set('attributionText', e.target.value)} maxLength={300} placeholder="e.g. Music: Song name by Artist" />
        <Input label="Licence ends (optional)" type="date" value={draft.expiresOn} disabled={disabled} onChange={(e) => set('expiresOn', e.target.value)} />
      </div>
      <Textarea label="Notes (optional)" value={draft.notes} disabled={disabled} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={1000} />
    </div>
  );
}

/** The explicit rights confirmation checkbox. */
export function RightsConfirmation({ checked, onChange, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 rounded-lg bg-charcoal-50 p-3 text-sm text-charcoal-800">
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{RIGHTS_CONFIRMATION_TEXT}.</span>
    </label>
  );
}
