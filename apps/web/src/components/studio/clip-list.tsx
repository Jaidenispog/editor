'use client';

import { ArrowDown, ArrowUp, Film, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatSeconds } from '@/lib/format';
import type { AssetDto, StyleOptionDto } from '@/lib/shared/studio-dto';
import { CLIP_TAG_OPTIONS } from '@/lib/shared/studio-schemas';
import { clipStatusLine } from '@/lib/shared/clip-summary';
import { moveInOrder, type MoveDirection } from '@/lib/shared/clip-order';
import { ShotsPanel } from './shots-panel';
import { useStableLink } from './use-studio-status';

const ASSET_STATUS_LABELS: Record<AssetDto['status'], string> = {
  uploaded: 'Waiting',
  processing: 'Analysing',
  ready: 'Ready',
  failed: 'Needs attention',
};

/**
 * One clip: position controls, thumbnail, duration, badges, analysis status, the "What's in this clip?" tag,
 * the per-shot "Shots" panel, retry and remove. Alt + Up/Down arrow anywhere on the card (outside a menu)
 * moves the clip too.
 */
function ClipCard({
  asset,
  index,
  total,
  focusMove,
  ttlSeconds,
  onMove,
  onChanged,
  onStyles,
}: {
  asset: AssetDto;
  index: number;
  total: number;
  /** Set right after this clip moved by keyboard or button, so focus stays on its move controls. */
  focusMove: MoveDirection | null;
  ttlSeconds: number;
  onMove: (direction: MoveDirection) => void;
  onChanged: (options?: { expectBusy?: boolean }) => void;
  onStyles: (styles: StyleOptionDto[]) => void;
}) {
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const isFirst = index === 0;
  const isLast = index === total - 1;
  useEffect(() => {
    if (!focusMove) return;
    const preferred = focusMove === 'up' ? (isFirst ? downRef : upRef) : isLast ? upRef : downRef;
    preferred.current?.focus();
  }, [focusMove, index, isFirst, isLast]);
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && !isFirst) onMove('up');
    if (e.key === 'ArrowDown' && !isLast) onMove('down');
  };
  const toast = useToast();
  const thumb = useStableLink(asset.id, asset.thumbnailUrl, ttlSeconds);
  const [tag, setTag] = useState(asset.clipLabel ?? '');
  const [savingTag, setSavingTag] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const statusLine = clipStatusLine(asset);

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
    <li onKeyDown={onKeyDown} className="flex gap-3 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white p-3 shadow-[var(--shadow-card)]">
      <div className="flex shrink-0 flex-col items-center gap-1">
        <span className="text-xs font-semibold text-charcoal-500 tabular-nums">
          <span className="sr-only">Clip </span>
          {index + 1}
          <span className="sr-only"> of {total}</span>
        </span>
        <Button ref={upRef} size="icon" variant="ghost" className="size-8" disabled={isFirst} onClick={() => onMove('up')} aria-label={`Move ${asset.filename} up`} title="Move up (Alt + Up arrow)" aria-keyshortcuts="Alt+ArrowUp">
          <ArrowUp className="size-4" aria-hidden="true" />
        </Button>
        <Button ref={downRef} size="icon" variant="ghost" className="size-8" disabled={isLast} onClick={() => onMove('down')} aria-label={`Move ${asset.filename} down`} title="Move down (Alt + Down arrow)" aria-keyshortcuts="Alt+ArrowDown">
          <ArrowDown className="size-4" aria-hidden="true" />
        </Button>
      </div>
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
        <p className={asset.status === 'failed' ? 'text-xs text-red-600' : 'text-xs text-charcoal-500'}>{statusLine || ' '}</p>
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
        {asset.status === 'ready' && asset.shots && asset.shots.count > 0 ? (
          <ShotsPanel assetId={asset.id} filename={asset.filename} shotCount={asset.shots.count} onStyles={onStyles} onChanged={() => onChanged()} />
        ) : null}
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

/**
 * The project's clips in order. "Move up" / "Move down" (or Alt + arrow keys) change the order the editor
 * uses: the new order shows straight away and is saved in one request; if saving fails it snaps back.
 */
export function ClipList({
  projectId,
  assets,
  ttlSeconds,
  onChanged,
  onStyles,
}: {
  projectId: string;
  assets: AssetDto[];
  ttlSeconds: number;
  onChanged: (options?: { expectBusy?: boolean }) => void;
  onStyles: (styles: StyleOptionDto[]) => void;
}) {
  const toast = useToast();
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [focus, setFocus] = useState<{ id: string; direction: MoveDirection } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  const serverOrder = useMemo(() => assets.map((a) => a.id), [assets]);
  const ordered = useMemo(() => {
    if (!pendingOrder) return assets;
    const byId = new Map(assets.map((a) => [a.id, a]));
    const listed = pendingOrder.map((id) => byId.get(id)).filter((a): a is AssetDto => Boolean(a));
    const rest = assets.filter((a) => !pendingOrder.includes(a.id));
    return [...listed, ...rest];
  }, [assets, pendingOrder]);

  // Focus is moved by the card's own effect (children run first); the request is then cleared so a later
  // refresh never steals focus.
  useEffect(() => {
    if (focus) setFocus(null);
  }, [focus]);

  // Once the server reports the order we asked for, stop overriding it.
  useEffect(() => {
    if (pendingOrder && pendingOrder.length === serverOrder.length && pendingOrder.every((id, i) => serverOrder[i] === id)) setPendingOrder(null);
  }, [pendingOrder, serverOrder]);

  const move = useCallback(
    (asset: AssetDto, direction: MoveDirection) => {
      const current = ordered.map((a) => a.id);
      const next = moveInOrder(current, asset.id, direction);
      if (next.every((id, i) => current[i] === id)) return;
      setPendingOrder(next);
      setFocus({ id: asset.id, direction });
      setAnnouncement(`${asset.filename} moved to position ${next.indexOf(asset.id) + 1} of ${next.length}.`);
      saveChain.current = saveChain.current.then(async () => {
        try {
          await apiRequest(`/api/projects/${projectId}/assets/order`, { method: 'POST', body: { assetIds: next } });
          onChanged();
        } catch (err) {
          setPendingOrder(null);
          setAnnouncement('The clip order could not be saved.');
          toast.error('Could not change the clip order', err instanceof Error ? err.message : undefined);
        }
      });
    },
    [onChanged, ordered, projectId, toast],
  );

  if (assets.length === 0) return null;
  const processing = assets.filter((a) => a.status === 'uploaded' || a.status === 'processing').length;
  return (
    <section aria-labelledby="clips-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="clips-heading" className="text-lg font-semibold text-charcoal-950">
          Clips <span className="text-sm font-normal text-charcoal-500">({assets.length})</span>
        </h2>
        <p className="text-sm text-charcoal-500">
          {processing ? `Analysing ${processing} clip${processing === 1 ? '' : 's'}…` : 'Tag what each clip shows to unlock more styles. The order here is the order of the story.'}
        </p>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Clips in order">
        {ordered.map((a, i) => (
          <ClipCard
            key={a.id}
            asset={a}
            index={i}
            total={ordered.length}
            focusMove={focus?.id === a.id ? focus.direction : null}
            ttlSeconds={ttlSeconds}
            onMove={(direction) => move(a, direction)}
            onChanged={onChanged}
            onStyles={onStyles}
          />
        ))}
      </ol>
    </section>
  );
}
