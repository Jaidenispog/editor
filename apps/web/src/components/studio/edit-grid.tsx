'use client';

import { Download, FileVideo, RefreshCw, Star, Wand2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select, Textarea } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatBytes, formatSeconds } from '@/lib/format';
import { cn } from '@/lib/shared/cn';
import type { EditDto, GenerationDto, VersionDto } from '@/lib/shared/studio-dto';
import { REVISION_SUGGESTIONS } from '@/lib/shared/studio-schemas';
import { useStableLink } from './use-studio-status';

type Refresh = (options?: { expectBusy?: boolean }) => void;

const ORIGIN_TEXT: Record<VersionDto['origin'], string> = { initial: 'First cut', revise: 'Revised', regenerate: 'Fresh take' };

/** One line describing a version for the version switcher. */
export function versionLabel(v: VersionDto): string {
  const base = `v${v.versionNo} · ${ORIGIN_TEXT[v.origin]}`;
  const note = v.instruction ? `: “${v.instruction.length > 48 ? `${v.instruction.slice(0, 47)}…` : v.instruction}”` : '';
  const state = v.status === 'preview_ready' ? '' : v.status === 'failed' ? ' (failed)' : v.status === 'cancelled' ? ' (cancelled)' : ' (in progress)';
  return `${base}${note}${state}`;
}

function currentVersionOf(edit: EditDto): VersionDto | null {
  return edit.versions.find((v) => v.id === edit.currentVersionId) ?? edit.versions[0] ?? null;
}

/** Revise dialog: an instruction box with suggestion chips, plus "Regenerate" for a completely fresh take. */
function ReviseDialog({ edit, open, onClose, onDone }: { edit: EditDto; open: boolean; onClose: () => void; onDone: Refresh }) {
  const toast = useToast();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<'revise' | 'regenerate' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (mode: 'revise' | 'regenerate') => {
    setBusy(mode);
    setError(null);
    try {
      await apiRequest(`/api/edits/${edit.id}/${mode}`, { method: 'POST', body: mode === 'revise' ? { instruction } : {} });
      toast.success(mode === 'revise' ? 'Making a revised version' : 'Making a fresh take', 'The earlier version is kept in the version list.');
      setInstruction('');
      onClose();
      onDone({ expectBusy: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (instruction.trim().length < 2) return setError('Tell the editor what to change, or choose a suggestion.');
    void run('revise');
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Revise “${edit.styleName}”`}
      description="Describe the change in your own words. A new version is made and the current one is kept."
      footer={
        <>
          <Button variant="ghost" onClick={() => void run('regenerate')} loading={busy === 'regenerate'} disabled={busy !== null}>
            <RefreshCw className="size-4" aria-hidden="true" /> Regenerate
          </Button>
          <Button type="submit" form={`revise-${edit.id}`} loading={busy === 'revise'} disabled={busy !== null}>
            <Wand2 className="size-4" aria-hidden="true" /> Make this change
          </Button>
        </>
      }
    >
      <form id={`revise-${edit.id}`} onSubmit={submit} className="space-y-3" noValidate>
        <Textarea label="What should change?" value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} maxLength={500} placeholder="e.g. Hold the final look longer and use fewer words on screen" />
        <div className="flex flex-wrap gap-2" aria-label="Suggestions">
          {REVISION_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="rounded-full border border-charcoal-200 bg-white px-3 py-1 text-sm text-charcoal-700 hover:border-charcoal-400 hover:bg-charcoal-50"
              onClick={() => setInstruction((prev) => (prev.trim() ? `${prev.trim().replace(/[.]$/, '')}. ${s}` : s))}
            >
              {s}
            </button>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** One of the edits: vertical player, style, notes, favourite, revise, version switcher and export/download. */
export function EditCard({ edit, ttlSeconds, onChanged }: { edit: EditDto; ttlSeconds: number; onChanged: Refresh }) {
  const toast = useToast();
  const version = currentVersionOf(edit);
  const preview = useStableLink(version?.id ?? null, version?.previewUrl ?? null, ttlSeconds);
  const poster = useStableLink(version ? `${version.id}:poster` : null, version?.posterUrl ?? null, ttlSeconds);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [favourite, setFavourite] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isFavourite = favourite ?? edit.isFavourite;
  // Once the server's value arrives, drop the optimistic one.
  useEffect(() => setFavourite(null), [edit.isFavourite]);
  const working = version ? version.status === 'planning' || version.status === 'planned' || version.status === 'rendering_preview' : true;

  const toggleFavourite = async () => {
    const next = !isFavourite;
    setFavourite(next);
    try {
      await apiRequest(`/api/edits/${edit.id}/favourite`, { method: 'POST', body: { value: next } });
      onChanged();
    } catch (err) {
      setFavourite(null);
      toast.error('Could not update the favourite', err instanceof Error ? err.message : undefined);
    }
  };

  const switchVersion = async (versionId: string) => {
    setBusy('switch');
    try {
      await apiRequest(`/api/edits/${edit.id}/current-version`, { method: 'POST', body: { versionId } });
      onChanged();
    } catch (err) {
      toast.error('Could not switch versions', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const exportVersion = async () => {
    if (!version) return;
    setBusy('export');
    try {
      await apiRequest(`/api/edit-versions/${version.id}/export`, { method: 'POST' });
      toast.success('Exporting full quality', 'This takes a little longer than the preview. You can keep working.');
      onChanged({ expectBusy: true });
    } catch (err) {
      toast.error('Could not start the export', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!version) return;
    setBusy('download');
    try {
      const res = await apiRequest<{ url: string; filename: string }>(`/api/edit-versions/${version.id}/download`);
      const a = document.createElement('a');
      a.href = res.url;
      a.download = res.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast.error('Could not download', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white shadow-[var(--shadow-card)]">
      <div className="relative aspect-[9/16] w-full bg-charcoal-950">
        {version?.status === 'preview_ready' && preview.url ? (
          <video
            key={version.id}
            src={preview.url}
            poster={poster.url ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="size-full object-contain"
            aria-label={`${edit.styleName} preview, version ${version.versionNo}`}
            onError={preview.renew}
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center text-charcoal-200">
            {working ? <Spinner className="size-6" /> : <FileVideo className="size-7" aria-hidden="true" />}
            <p className="text-sm">{version?.statusMessage || (working ? 'Working on it…' : 'No preview')}</p>
          </div>
        )}
        <button
          type="button"
          onClick={toggleFavourite}
          aria-pressed={isFavourite}
          aria-label={isFavourite ? `Remove ${edit.styleName} from favourites` : `Mark ${edit.styleName} as a favourite`}
          className="absolute top-2 right-2 flex size-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
        >
          <Star className={cn('size-5', isFavourite && 'fill-[var(--accent)] text-[var(--accent)]')} aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-base font-semibold text-charcoal-950">{edit.styleName}</h3>
            {version ? <StatusPill status={version.status} className="shrink-0" /> : null}
          </div>
          <p className="text-sm text-charcoal-600">{edit.styleDescription}</p>
          {version?.previewDurationSec ? <p className="mt-1 text-xs text-charcoal-500">Length {formatSeconds(version.previewDurationSec)}</p> : null}
        </div>
        {version?.status === 'failed' || version?.status === 'cancelled' ? <p className="text-sm text-red-600">{version.statusMessage || 'This version could not be made.'}</p> : null}
        {version?.planSource === 'rules' ? (
          <p className="rounded-md bg-charcoal-50 px-3 py-2 text-xs text-charcoal-600">Put together by the built-in editor rather than the AI planner. It follows the same style rules.</p>
        ) : null}
        {version && version.warnings.length ? (
          <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {version.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {version?.instruction ? <p className="text-xs text-charcoal-500">Your note: “{version.instruction}”</p> : null}

        {edit.versions.length > 1 ? (
          <Select
            label="Version"
            value={version?.id ?? ''}
            disabled={busy === 'switch'}
            onChange={(e) => void switchVersion(e.target.value)}
            options={edit.versions.map((v) => ({ value: v.id, label: versionLabel(v) }))}
            className="h-9 text-sm"
          />
        ) : null}

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={() => setReviseOpen(true)} disabled={working}>
            <Wand2 className="size-4" aria-hidden="true" /> Revise
          </Button>
          {version?.status === 'preview_ready' ? (
            version.exportStatus === 'ready' ? (
              <Button size="sm" onClick={download} loading={busy === 'download'}>
                <Download className="size-4" aria-hidden="true" /> Download{version.exportByteSize ? ` (${formatBytes(version.exportByteSize)})` : ''}
              </Button>
            ) : version.exportStatus === 'queued' || version.exportStatus === 'rendering' ? (
              <span className="inline-flex items-center gap-2 text-sm text-charcoal-600" aria-live="polite">
                <Spinner className="size-4" /> {version.exportMessage || 'Exporting…'}
              </span>
            ) : (
              <Button size="sm" onClick={exportVersion} loading={busy === 'export'}>
                <FileVideo className="size-4" aria-hidden="true" /> Export full quality
              </Button>
            )
          ) : null}
        </div>
        {version?.exportStatus === 'failed' ? <p className="text-xs text-red-600">{version.exportMessage || 'The export did not finish. Press Export to try again.'}</p> : null}
        {version?.status === 'preview_ready' && version.exportStatus === 'none' && version.exportMessage ? (
          <p className="text-xs text-charcoal-600" aria-live="polite">
            {version.exportMessage.replace(/[.]$/, '')}. Press Export full quality to start it again.
          </p>
        ) : null}
      </div>
      <ReviseDialog edit={edit} open={reviseOpen} onClose={() => setReviseOpen(false)} onDone={onChanged} />
    </li>
  );
}

/** The edits of one generation in a responsive grid (1 column on phones, 2 on tablets, 3–5 on desktops). */
export function EditGrid({ generation, ttlSeconds, onChanged }: { generation: GenerationDto; ttlSeconds: number; onChanged: Refresh }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
      {generation.edits.map((e) => (
        <EditCard key={e.id} edit={e} ttlSeconds={ttlSeconds} onChanged={onChanged} />
      ))}
    </ul>
  );
}
