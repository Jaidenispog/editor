'use client';

import type { ReactNode } from 'react';
import { CC_BY_NC_REFUSAL, normaliseLicence, planNameWarning, type MusicLicence, type MusicLicenceKind } from '@studio/core';
import { Input, Textarea } from '@/components/ui/field';
import { cn } from '@/lib/shared/cn';

/**
 * The licence passport (memo §2): a three-step form shared by the upload dialog (Studio and Settings → Music) and
 * "Licence details". Step 1 asks where the track is from, step 2 the licence details, step 3 where it may be used
 * plus the rights confirmation. Nothing is uploaded until step 3 is confirmed.
 */

/** "Where is this track from?" in plain words. */
export const LICENCE_KIND_OPTIONS: ReadonlyArray<{ value: MusicLicenceKind; label: string }> = [
  { value: 'owner_upload', label: 'I made it, or I own the recording' },
  { value: 'catalogue', label: 'Music library subscription (Epidemic Sound, Soundstripe, Artlist, Uppbeat, Musicbed or similar)' },
  { value: 'commercial_licence', label: 'I bought a licence for this one track' },
  { value: 'meta_sound_collection', label: "Meta Sound Collection (downloaded with the business's Meta login)" },
  { value: 'cc0', label: 'Creative Commons zero (CC0)' },
  { value: 'cc_by', label: 'Creative Commons with credit (CC BY)' },
  { value: 'public_domain', label: 'Public domain' },
  { value: 'cc_by_nc', label: 'Creative Commons non-commercial (CC BY-NC)' },
  { value: 'unknown', label: "I'm not sure" },
];

/** Short name of a licence kind for chips. */
export function licenceKindLabel(kind: MusicLicenceKind): string {
  switch (kind) {
    case 'owner_upload':
      return 'Own recording';
    case 'catalogue':
      return 'Music library';
    case 'commercial_licence':
      return 'Track licence';
    case 'meta_sound_collection':
      return 'Meta Sound Collection';
    case 'cc0':
      return 'CC0';
    case 'cc_by':
      return 'CC BY';
    case 'cc_by_nc':
      return 'CC BY-NC';
    case 'public_domain':
      return 'Public domain';
    default:
      return 'Origin not recorded';
  }
}

/** Where the licence may allow the music to be used (step 3). */
export const LICENCE_PLACES = [
  ['promotionalUse', 'Promoting the business'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'],
  ['website', 'Website'],
  ['paidAds', 'Paid ads / boosts'],
] as const;

/** The exact wording the owner ticks to confirm the rights. */
export const RIGHTS_CONFIRMATION_TEXT = 'I confirm the business holds the rights to use this recording for the purposes ticked above';

/** The form's editable values (dates as yyyy-mm-dd for the date inputs). */
export interface LicenceDraft {
  kind: MusicLicenceKind;
  source: string;
  licenceName: string;
  planName: string;
  accountHolder: string;
  providerTrackRef: string;
  proofUrl: string;
  notes: string;
  downloadedOn: string;
  termsAcceptedOn: string;
  expiresOn: string;
  attributionRequired: boolean;
  attributionText: string;
  permitted: MusicLicence['permitted'];
}

/** A blank draft for a new upload. */
export function emptyLicenceDraft(): LicenceDraft {
  return {
    kind: 'catalogue',
    source: '',
    licenceName: '',
    planName: '',
    accountHolder: '',
    providerTrackRef: '',
    proofUrl: '',
    notes: '',
    downloadedOn: '',
    termsAcceptedOn: '',
    expiresOn: '',
    attributionRequired: false,
    attributionText: '',
    permitted: { promotionalUse: true, instagram: true, facebook: false, tiktok: true, youtube: false, website: false, paidAds: false },
  };
}

function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const fromDateInput = (v: string, endOfDay = false) => (v ? new Date(`${v}T${endOfDay ? '23:59:59' : '12:00:00'}`).toISOString() : null);

/** Loads a stored licence into the form. */
export function licenceDraftFrom(licence: MusicLicence): LicenceDraft {
  const l = normaliseLicence(licence);
  return {
    kind: l.kind,
    source: l.source,
    licenceName: l.licenceName,
    planName: l.planName,
    accountHolder: l.accountHolder,
    providerTrackRef: l.providerTrackRef,
    proofUrl: l.proofUrl,
    notes: l.notes,
    downloadedOn: toDateInput(l.downloadedAt),
    termsAcceptedOn: toDateInput(l.termsAcceptedAt),
    expiresOn: toDateInput(l.expiresAt),
    attributionRequired: l.attributionRequired,
    attributionText: l.attributionText,
    permitted: { ...l.permitted },
  };
}

/** A plain reason the given step cannot be left yet, or null. */
export function licenceStepError(draft: LicenceDraft, step: 1 | 2 | 3): string | null {
  if (step === 1 && draft.kind === 'cc_by_nc') return CC_BY_NC_REFUSAL;
  if (step >= 2) {
    const proof = draft.proofUrl.trim();
    if (proof && /^[a-z]+:/i.test(proof) && !/^https?:\/\/\S+$/i.test(proof)) return 'The proof link should start with https:// (or type an invoice number instead).';
    if (draft.kind === 'cc_by' && !draft.attributionText.trim()) return 'Add the credit line the CC BY licence asks for.';
    if (draft.attributionRequired && !draft.attributionText.trim()) return 'Add the credit line the licence asks you to show with the video.';
  }
  return null;
}

/**
 * Turns the form into the licence record sent to the server, or a plain reason it cannot be saved. The
 * confirmation time is never set here: only the server records it, when the owner ticks the confirmation.
 */
export function licenceFromDraft(draft: LicenceDraft): { licence: MusicLicence } | { error: string } {
  const error = licenceStepError(draft, 1) ?? licenceStepError(draft, 3);
  if (error) return { error };
  const attributionText = draft.attributionText.trim();
  const licence: MusicLicence = {
    kind: draft.kind,
    source: draft.source.trim(),
    licenceName: draft.licenceName.trim(),
    planName: draft.planName.trim(),
    accountHolder: draft.accountHolder.trim(),
    providerTrackRef: draft.providerTrackRef.trim(),
    proofUrl: draft.proofUrl.trim(),
    notes: draft.notes.trim(),
    downloadedAt: fromDateInput(draft.downloadedOn),
    termsAcceptedAt: fromDateInput(draft.termsAcceptedOn),
    expiresAt: fromDateInput(draft.expiresOn, true),
    permitted: draft.permitted,
    attributionRequired: draft.kind === 'cc_by' || draft.attributionRequired || attributionText.length > 0,
    attributionText,
    destinationLock: null,
    confirmedByOwnerAt: null,
  };
  return { licence: normaliseLicence(licence) };
}

const STEP_TITLES = ['Where is this track from?', 'Licence details', 'Where can it be used?'] as const;

/** "Step 2 of 3 · Licence details". */
export function stepTitle(step: 1 | 2 | 3): string {
  return `Step ${step} of 3 · ${STEP_TITLES[step - 1]}`;
}

function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className={cn('flex min-h-11 items-center gap-2 text-sm text-charcoal-700', disabled && 'opacity-70')}>
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** One step of the licence passport. */
export function LicencePassportForm({ draft, onChange, step, disabled = false }: { draft: LicenceDraft; onChange: (next: LicenceDraft) => void; step: 1 | 2 | 3; disabled?: boolean }) {
  const set = <K extends keyof LicenceDraft>(key: K, value: LicenceDraft[K]) => onChange({ ...draft, [key]: value });
  const meta = draft.kind === 'meta_sound_collection';
  const library = draft.kind === 'catalogue' || draft.kind === 'commercial_licence';
  const warning = library ? planNameWarning(draft.planName) : null;

  if (step === 1) {
    return (
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm font-medium text-charcoal-800">{STEP_TITLES[0]}</legend>
        {LICENCE_KIND_OPTIONS.map((o) => (
          <label key={o.value} className="flex min-h-11 items-start gap-2 rounded-lg border border-charcoal-200 px-3 py-2 text-sm text-charcoal-800 has-[:checked]:border-charcoal-900">
            <input type="radio" name="licence-kind" className="mt-0.5 size-4 accent-[var(--accent)]" checked={draft.kind === o.value} onChange={() => onChange({ ...draft, kind: o.value })} />
            <span>{o.label}</span>
          </label>
        ))}
        {draft.kind === 'cc_by_nc' ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {CC_BY_NC_REFUSAL}
          </p>
        ) : null}
        {draft.kind === 'unknown' ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">You can try it in previews. Exports with this track are blocked until you confirm a licence.</p> : null}
      </fieldset>
    );
  }

  if (step === 2) {
    if (meta) {
      return (
        <div className="space-y-4">
          <p className="rounded-md bg-charcoal-50 px-3 py-2 text-sm text-charcoal-700">
            Meta&apos;s licence covers use on Meta&apos;s apps only. Videos with this track are marked &ldquo;For Instagram/Facebook upload only&rdquo;.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Download date" type="date" value={draft.downloadedOn} disabled={disabled} onChange={(e) => set('downloadedOn', e.target.value)} />
            <Input label="Date you accepted Meta's terms" type="date" value={draft.termsAcceptedOn} disabled={disabled} onChange={(e) => set('termsAcceptedOn', e.target.value)} />
          </div>
          <Input label="Link to the track in Sound Collection (optional)" value={draft.providerTrackRef} disabled={disabled} onChange={(e) => set('providerTrackRef', e.target.value)} maxLength={300} />
          <Textarea label="Notes (optional)" value={draft.notes} disabled={disabled} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={1000} />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={library ? 'Library or seller' : 'Who owns the recording (optional)'}
            value={draft.source}
            disabled={disabled}
            onChange={(e) => set('source', e.target.value)}
            maxLength={120}
            placeholder={library ? 'e.g. Soundstripe' : ''}
          />
          {library ? (
            <Input label="Plan name" value={draft.planName} disabled={disabled} onChange={(e) => set('planName', e.target.value)} maxLength={120} placeholder="e.g. Business" />
          ) : (
            <Input label="Licence name (optional)" value={draft.licenceName} disabled={disabled} onChange={(e) => set('licenceName', e.target.value)} maxLength={120} />
          )}
        </div>
        {warning ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{warning}</p> : null}
        {library ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Account holder" hint="Should be the business name." value={draft.accountHolder} disabled={disabled} onChange={(e) => set('accountHolder', e.target.value)} maxLength={120} />
            <Input label="Track link or ID at the library (optional)" value={draft.providerTrackRef} disabled={disabled} onChange={(e) => set('providerTrackRef', e.target.value)} maxLength={300} />
            <Input label="Download date (optional)" type="date" value={draft.downloadedOn} disabled={disabled} onChange={(e) => set('downloadedOn', e.target.value)} />
            <Input label="Licence end date (optional)" type="date" value={draft.expiresOn} disabled={disabled} onChange={(e) => set('expiresOn', e.target.value)} />
          </div>
        ) : null}
        <Input
          label="Proof: a link or invoice number (optional)"
          value={draft.proofUrl}
          disabled={disabled}
          onChange={(e) => set('proofUrl', e.target.value)}
          maxLength={500}
          hint="Keep proof somewhere you can find it if a platform ever asks."
        />
        {draft.kind === 'cc_by' || draft.attributionRequired ? (
          <Input
            label="Credit line"
            hint="This credit is added to your post captions automatically."
            value={draft.attributionText}
            disabled={disabled}
            onChange={(e) => set('attributionText', e.target.value)}
            maxLength={300}
            placeholder="e.g. Music: Song name by Artist (CC BY 4.0)"
          />
        ) : (
          <Check checked={draft.attributionRequired} disabled={disabled} onChange={(v) => set('attributionRequired', v)}>
            The licence asks for a credit line with the video
          </Check>
        )}
        <Textarea label="Notes (optional)" value={draft.notes} disabled={disabled} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={1000} />
      </div>
    );
  }

  const fixed = meta ? new Set(['tiktok', 'youtube', 'website']) : new Set<string>();
  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium text-charcoal-800">{STEP_TITLES[2]}</legend>
      {meta ? <p className="mt-1 text-sm text-charcoal-600">Meta Sound Collection tracks can only be used on Instagram and Facebook.</p> : null}
      <div className="mt-2 grid gap-x-4 sm:grid-cols-2">
        {LICENCE_PLACES.map(([key, label]) => (
          <Check key={key} checked={fixed.has(key) ? false : draft.permitted[key]} disabled={fixed.has(key)} onChange={(v) => set('permitted', { ...draft.permitted, [key]: v })}>
            {label}
          </Check>
        ))}
      </div>
    </fieldset>
  );
}

/** The explicit rights confirmation checkbox (the server stamps the time it was given). */
export function RightsConfirmation({ checked, onChange, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 rounded-lg bg-charcoal-50 p-3 text-sm text-charcoal-800">
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{RIGHTS_CONFIRMATION_TEXT}.</span>
    </label>
  );
}

/** Splits "hip hop, lo-fi" into tags (at most 12, each up to 40 characters). */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
}
