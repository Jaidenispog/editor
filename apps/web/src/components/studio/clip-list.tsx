'use client';

import { Film, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatSeconds } from '@/lib/format';
import type { AssetDto, StyleOptionDto } from '@/lib/shared/studio-dto';
import { CLIP_TAG_OPTIONS, clipTagName } from '@/lib/shared/studio-schemas';
import { useStableLink } from './use-studio-status';

const ASSET_STATUS_LABELS: Record<AssetDto['status'], string> = {
  uploaded: 'Waiting',
  processing: 'Analysing',
  ready: 'Ready',
  failed: 'Needs attention',
};

function shotSummary(asset: AssetDto): string | null {
  if (!asset.shots) return null;
  const { count, labels } = asset.shots;
  const named = Object.entries(labels)
    .filter(([label]) => label !== 'unknown' && label !== 'other')
    .map(([label, n]) => `${clipTagName(label)}${n > 1 ? ` ×${n}` : ''}`);
  const base = `${count} shot${count === 1 ? '' : 's'}`;
  return named.length ? `${base}: ${named.join(', ')}` : base;
}

/** One clip: thumbnail, duration, badges, analysis status, the "What's in this clip?" tag, retry and remove. */
function ClipCard({
  asset,
  ttlSeconds,
  onChanged,
  onStyles,
}: {
  asset: AssetDto;
  ttlSeconds: number;
  onChanged: (options?: { expectBusy?: boolean }) => void;
  onStyles: (styles: StyleOptionDto[]) => void;
}) {
  const toast = useToast();
  const thumb = useStableLink(asset.id, asset.thumbnailUrl, ttlSeconds);
  const [tag, setTag] = useState(asset.clipLabel ?? '');
  const [savingTag, setSavingTag] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const summary = shotSummary(asset);

  const saveTag = async (value: string) => {
    const previous = tag;
    setTag(value);
    setSavingTag(true);
    try {
      const res = await apiRequest<{ styles?: StyleOptionDto[] }>(`/api/assets/${asset.id}`, { method: 'PATCH', body: { clipLabel: value === '' ? null : value } });
      if (res.styles) onStyles(res.styles);
      onChanged();
    } catch (err) {
      setTag(previous);
      toast.error('Could not save the tag', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingTag(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    try {
      await apiRequest(`/api/assets/${asset.id}/retry`, { method: 'POST' });
      toast.success('Analysing the clip again');
      onChanged({ expectBusy: true });
    } catch (err) {
      toast.error('Could not retry', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiRequest(`/api/assets/${asset.id}`, { method: 'DELETE' });
      toast.success('Clip removed');
      setConfirmRemove(false);
      onChanged();
    } catch (err) {
      toast.error('Could not remove the clip', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex gap-3 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white p-3 shadow-[var(--shadow-card)]">
      <div className="relative aspect-[9/16] w-20 shrink-0 overflow-hidden rounded-lg bg-charcoal-900 sm:w-24">
        {thumb.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, expiring private link; next/image cannot optimise it
          <img src={thumb.url} alt="" className="size-full object-cover" onError={thumb.renew} />
        ) : (
          <span className="flex size-full items-center justify-center text-charcoal-400" aria-hidden="true">
            <Film className="size-6" />
          </span>
        )}
        {asset.durationSec !== null ? (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[11px] font-medium text-white tabular-nums">{formatSeconds(asset.durationSec)}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-medium text-charcoal-900" title={asset.filename}>
            {asset.filename}
          </p>
          <StatusPill status={asset.status} label={ASSET_STATUS_LABELS[asset.status]} className="shrink-0" />
        </div>
        <p className={asset.status === 'failed' ? 'text-xs text-red-600' : 'text-xs text-charcoal-500'}>{asset.statusMessage || summary || ' '}</p>
        {asset.status === 'ready' && summary && asset.statusMessage !== summary ? <p className="text-xs text-charcoal-500">{summary}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          {asset.isHdr ? <Badge tone="info">HDR, colour converted</Badge> : null}
          {asset.rotation !== 0 ? <Badge>Rotated</Badge> : null}
          {asset.hasTranscript ? <Badge tone="success">Speech transcribed</Badge> : asset.speechLikely ? <Badge>Speech</Badge> : null}
          {asset.hasAudio === false ? <Badge>No sound</Badge> : null}
        </div>
        <Select
          label="What's in this clip?"
          value={tag}
          disabled={savingTag}
          onChange={(e) => void saveTag(e.target.value)}
          options={CLIP_TAG_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          className="h-9 text-sm"
        />
        <div className="flex flex-wrap gap-1.5">
          {asset.status === 'failed' ? (
            <Button size="sm" variant="secondary" onClick={retry} loading={busy}>
              <RotateCcw className="size-4" aria-hidden="true" /> Retry
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} aria-label={`Remove ${asset.filename}`}>
            <Trash2 className="size-4" aria-hidden="true" /> Remove
          </Button>
        </div>
      </div>
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove this clip?"
        description="The clip and its preview copies are deleted. Edits you have already made keep their previews."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep clip
            </Button>
            <Button variant="danger" onClick={remove} loading={busy}>
              Remove clip
            </Button>
          </>
        }
      />
    </li>
  );
}

/** The project's clips in order, or skeletons while nothing has arrived yet. */
export function ClipList({
  assets,
  ttlSeconds,
  onChanged,
  onStyles,
}: {
  assets: AssetDto[];
  ttlSeconds: number;
  onChanged: (options?: { expectBusy?: boolean }) => void;
  onStyles: (styles: StyleOptionDto[]) => void;
}) {
  if (assets.length === 0) return null;
  const processing = assets.filter((a) => a.status === 'uploaded' || a.status === 'processing').length;
  return (
    <section aria-labelledby="clips-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="clips-heading" className="text-lg font-semibold text-charcoal-950">
          Clips <span className="text-sm font-normal text-charcoal-500">({assets.length})</span>
        </h2>
        <p className="text-sm text-charcoal-500">
          {processing ? `Analysing ${processing} clip${processing === 1 ? '' : 's'}…` : 'Tag what each clip shows to unlock more styles.'}
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {assets.map((a) => (
          <ClipCard key={a.id} asset={a} ttlSeconds={ttlSeconds} onChanged={onChanged} onStyles={onStyles} />
        ))}
      </ul>
    </section>
  );
}
