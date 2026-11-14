'use client';

import { Film, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { describeReferenceProfile, describeSuggestion, openSuggestions, MATCHES_SETTINGS_REASON, type ReferenceStyleProfile, type ReferenceSuggestionField } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { UploadItem } from '@/lib/client/uploader';
import type { ReferenceDto } from '@/lib/shared/studio-dto';
import { UPLOAD_ACCEPT } from '@/lib/shared/upload-math';
import { UploadList } from './upload-zone';

/** Whether the AI text estimate can be offered (AI is set up on the server). Read once from the integrations list. */
function useAiAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    apiRequest<{ integrations: Array<{ id: string; connected: boolean }> }>('/api/integrations/status')
      .then((r) => alive && setAvailable(r.integrations.some((i) => i.id === 'ai' && i.connected)))
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
    };
  }, []);
  return available;
}

/** The dialog that explains what is measured and starts the upload. */
function AddReferenceDialog({ open, onClose, onFile }: { open: boolean; onClose: () => void; onFile: (file: File, useVision: boolean) => void }) {
  const aiAvailable = useAiAvailable();
  const [useVision, setUseVision] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a reference video (style only)"
      description="Upload a video whose pace and look you like. Studio Assistant measures only its shot lengths, length, colour and how much text is on screen. Nothing from it is used in your edits, and the file is deleted once it has been measured. Only upload videos you are allowed to view and keep."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => input.current?.click()}>Choose a video</Button>
        </>
      }
    >
      {aiAvailable ? (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm text-charcoal-800">
          <input type="checkbox" checked={useVision} onChange={(e) => setUseVision(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
          <span>Also estimate how much on-screen text it has (sends up to 8 still frames to Anthropic)</span>
        </label>
      ) : (
        <p className="text-sm text-charcoal-600">On-screen text is not measured: AI is not set up on the server.</p>
      )}
      <input
        ref={input}
        type="file"
        accept={UPLOAD_ACCEPT.video}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) {
            onFile(file, aiAvailable && useVision);
            onClose();
          }
        }}
      />
    </Dialog>
  );
}

/** Suggestion rows with "Use this" / "No thanks" and "Use all suggestions". */
function Suggestions({ reference, profile, onChanged }: { reference: ReferenceDto; profile: ReferenceStyleProfile; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const open = openSuggestions(profile);
  const decide = async (accept: ReferenceSuggestionField[], dismiss: ReferenceSuggestionField[], key: string) => {
    setBusy(key);
    try {
      await apiRequest(`/api/references/${reference.id}/decide`, { method: 'POST', body: { accept, dismiss } });
      if (accept.length) toast.success('Preferences updated', `Set from the reference video “${reference.filename}”. You can change them in Settings → Editing preferences.`);
      onChanged();
    } catch (err) {
      toast.error('Could not update your preferences', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };
  if (profile.suggestions.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm font-medium text-charcoal-800">Suggested preferences</p>
      <ul className="space-y-2">
        {profile.suggestions.map((s) => {
          const decision = profile.decisions[s.field];
          const matches = s.reason === MATCHES_SETTINGS_REASON;
          return (
            <li key={s.field} className="flex flex-col gap-2 rounded-lg border border-charcoal-100 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 text-sm text-charcoal-800">
                {describeSuggestion(s)}
                <span className="block text-xs text-charcoal-500">{matches ? 'Matches your settings' : decision === 'accepted' ? 'In use' : decision === 'dismissed' ? 'Not used' : s.reason}</span>
              </span>
              {!matches && !decision ? (
                <span className="flex shrink-0 gap-2">
                  <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-8" loading={busy === `a:${s.field}`} onClick={() => decide([s.field], [], `a:${s.field}`)}>
                    Use this
                  </Button>
                  <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" loading={busy === `d:${s.field}`} onClick={() => decide([], [s.field], `d:${s.field}`)}>
                    No thanks
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {open.length > 1 ? (
        <Button size="sm" className="min-h-11 sm:min-h-8" loading={busy === 'all'} onClick={() => decide(open.map((s) => s.field), [], 'all')}>
          <Sparkles className="size-4" aria-hidden="true" /> Use all suggestions
        </Button>
      ) : null}
    </div>
  );
}

/** One reference card: processing state, measurements in plain words and the suggestions. */
function ReferenceCard({ reference, onChanged }: { reference: ReferenceDto; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'retry' | 'remove' | null>(null);
  const profile = reference.profile;
  const act = async (kind: 'retry' | 'remove') => {
    setBusy(kind);
    try {
      if (kind === 'retry') await apiRequest(`/api/assets/${reference.id}/retry`, { method: 'POST' });
      else await apiRequest(`/api/assets/${reference.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      toast.error(kind === 'retry' ? 'Could not try again' : 'Could not remove the reference', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };
  const label = reference.status === 'ready' ? 'Ready' : reference.status === 'failed' ? 'Failed' : reference.statusMessage === 'Measuring style' ? 'Measuring style' : 'Processing';
  return (
    <li className="rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white p-4">
      <div className="flex gap-3">
        <div className="h-20 w-12 shrink-0 overflow-hidden rounded-md bg-charcoal-100">
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed link */}
          {reference.thumbnailUrl ? <img src={reference.thumbnailUrl} alt="" className="size-full object-cover" /> : <Film className="m-auto mt-7 size-5 text-charcoal-400" aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-charcoal-900">{reference.filename}</span>
            <StatusPill status={reference.status} label={label} />
          </div>
          {profile ? (
            <p className="mt-1 text-sm text-charcoal-600">{describeReferenceProfile(profile)}</p>
          ) : (
            <p className="mt-1 text-sm text-charcoal-600">{reference.status === 'failed' ? reference.statusMessage || 'Measuring failed. Try again.' : 'Measuring how it is paced and coloured…'}</p>
          )}
          {profile?.originalsDeletedAt ? <p className="mt-1 text-xs text-charcoal-500">The video itself has been deleted; only these measurements and the thumbnail are kept.</p> : null}
          {profile && profile.text.source === 'not_measured' ? <p className="mt-1 text-xs text-charcoal-500">On-screen text was not measured.</p> : null}
        </div>
      </div>
      {profile ? <Suggestions reference={reference} profile={profile} onChanged={onChanged} /> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {reference.status === 'failed' ? (
          <Button size="sm" variant="secondary" className="min-h-11 sm:min-h-8" loading={busy === 'retry'} onClick={() => act('retry')}>
            <RotateCcw className="size-4" aria-hidden="true" /> Try again
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" loading={busy === 'remove'} onClick={() => act('remove')} aria-label={`Remove reference ${reference.filename}`}>
          <Trash2 className="size-4" aria-hidden="true" /> Remove
        </Button>
      </div>
    </li>
  );
}

/**
 * "Reference videos" under the clip list: the add link (with the explanation dialog), uploads in progress and one
 * card per reference. References are never clips: they are only measured for style.
 */
export function ReferenceStrip({
  references,
  uploads,
  onFile,
  onChanged,
  onPause,
  onResume,
  onCancel,
  onDismiss,
}: {
  references: ReferenceDto[];
  uploads: UploadItem[];
  onFile: (file: File, useVision: boolean) => void;
  onChanged: () => void;
  onPause: (key: string) => void;
  onResume: (key: string) => void;
  onCancel: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="references-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="references-heading" className={references.length || uploads.length ? 'text-base font-semibold text-charcoal-950' : 'sr-only'}>
          Reference videos
        </h2>
        <button type="button" onClick={() => setOpen(true)} className="min-h-11 text-sm font-medium text-charcoal-800 underline underline-offset-4 hover:text-charcoal-950">
          Add a reference video (style only)
        </button>
      </div>
      <UploadList items={uploads} onPause={onPause} onResume={onResume} onCancel={onCancel} onDismiss={onDismiss} />
      {references.length ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {references.map((r) => (
            <ReferenceCard key={r.id} reference={r} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
      <AddReferenceDialog open={open} onClose={() => setOpen(false)} onFile={onFile} />
    </section>
  );
}
