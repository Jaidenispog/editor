'use client';

import { ChevronDown, Film } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { Select } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatSeconds } from '@/lib/format';
import { cn } from '@/lib/shared/cn';
import type { AssetShotsDto, ShotDto, StyleOptionDto } from '@/lib/shared/studio-dto';
import { CLIP_TAG_OPTIONS, clipTagName } from '@/lib/shared/studio-schemas';

const SOURCE_TEXT: Record<ShotDto['source'], string> = {
  shot_tag: 'Tagged by you',
  clip_tag: 'From the clip tag',
  vision_model: 'Suggested by the AI',
  heuristic: 'Best guess',
};

/** Per-shot choices: "no tag" falls back to the clip tag or the analysis. */
const SHOT_TAG_OPTIONS = [{ value: '', label: 'No tag for this shot' }, ...CLIP_TAG_OPTIONS.filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.label }))];

function timeRange(shot: ShotDto): string {
  return `${formatSeconds(shot.startSec)}–${formatSeconds(shot.endSec)}`;
}

/**
 * Expandable "Shots" panel on a clip card: each shot the analysis found, with its time range, a frame from the
 * clip, the label the editor will use and where that label came from, and a select to tag that shot. Shot
 * tags are saved as the clip's manual labels and recompute which styles the footage supports.
 */
export function ShotsPanel({
  assetId,
  filename,
  shotCount,
  onStyles,
  onChanged,
}: {
  assetId: string;
  filename: string;
  shotCount: number;
  onStyles: (styles: StyleOptionDto[]) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AssetShotsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await apiRequest<AssetShotsDto>(`/api/assets/${assetId}/shots`));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The shots could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  const setShotTag = async (shot: ShotDto, value: string) => {
    if (!data) return;
    const manualLabels = { ...data.manualLabels };
    if (value) manualLabels[shot.id] = value;
    else delete manualLabels[shot.id];
    setSaving(shot.id);
    try {
      const res = await apiRequest<{ styles?: StyleOptionDto[] }>(`/api/assets/${assetId}`, { method: 'PATCH', body: { manualLabels } });
      if (res.styles) onStyles(res.styles);
      await load();
      onChanged();
    } catch (err) {
      toast.error('Could not save the shot tag', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="border-t border-charcoal-100 pt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left text-sm font-medium text-charcoal-800 hover:bg-charcoal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <span>
          Shots <span className="font-normal text-charcoal-500">({shotCount})</span>
        </span>
        <ChevronDown className={cn('size-4 text-charcoal-500 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!open} className="mt-2">
        {loading && !data ? (
          <p className="flex items-center gap-2 text-sm text-charcoal-500">
            <Spinner className="size-4" /> Loading shots…
          </p>
        ) : loadError ? (
          <p role="alert" className="text-sm text-red-600">
            {loadError}
          </p>
        ) : data && data.shots.length === 0 ? (
          <p className="text-sm text-charcoal-500">No separate shots were found in this clip.</p>
        ) : data ? (
          <ul className="space-y-2" aria-label={`Shots in ${filename}`}>
            {data.shots.map((shot, i) => (
              <li key={shot.id} className="flex gap-2 rounded-lg bg-charcoal-50 p-2">
                <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded bg-charcoal-900">
                  {shot.frameUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed, expiring private link; next/image cannot optimise it
                    <img src={shot.frameUrl} alt={`Frame from shot ${i + 1}`} className="size-full object-cover" loading="lazy" />
                  ) : (
                    <span className="flex size-full items-center justify-center text-charcoal-400" aria-hidden="true">
                      <Film className="size-4" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-xs text-charcoal-600">
                    <span className="font-medium text-charcoal-900">Shot {i + 1}</span> · <span className="tabular-nums">{timeRange(shot)}</span> · {clipTagName(shot.label)}{' '}
                    <span className="text-charcoal-500">({SOURCE_TEXT[shot.source]})</span>
                  </p>
                  {shot.description ? <p className="line-clamp-2 text-xs text-charcoal-500">{shot.description}</p> : null}
                  <Select
                    label={`Tag for shot ${i + 1} (${timeRange(shot)})`}
                    hideLabel
                    value={shot.manualLabel ?? ''}
                    disabled={saving !== null}
                    onChange={(e) => void setShotTag(shot, e.target.value)}
                    options={SHOT_TAG_OPTIONS}
                    className="h-8 text-xs"
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
