'use client';

import { CheckSquare, Download, Send } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { MAX_VIDEOS_PER_BATCH } from '@studio/core';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import type { PublishBadgeDto } from '@/lib/shared/publishing-dto';
import { cn } from '@/lib/shared/cn';
import { PublishBadges } from './publish-badges';

/** One Content Library card as the server prepared it (links expire). */
export interface LibraryItem {
  versionId: string;
  versionNo: number;
  status: string;
  previewUrl: string | null;
  exportUrl: string | null;
  exportSizeLabel: string | null;
  durationLabel: string;
  updatedLabel: string;
  styleName: string;
  projectId: string;
  projectTitle: string;
  publishable: boolean;
  exported: boolean;
  /** "For Instagram/Facebook upload only" when the export's music is locked to Meta. */
  downloadLabel: string | null;
  badges: PublishBadgeDto[];
}

/**
 * The Content Library grid with publishing: per-platform badges, a Publish link per card, and a Select mode where the
 * owner ticks cards one by one (nothing is ticked, no "select all", at most five) for "Publish selected (n)".
 */
export function LibraryGrid({ items }: { items: LibraryItem[] }) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= MAX_VIDEOS_PER_BATCH ? s : [...s, id]));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          className="min-h-11"
          aria-pressed={selecting}
          onClick={() => {
            setSelecting((v) => !v);
            setSelected([]);
          }}
        >
          <CheckSquare className="size-4" aria-hidden="true" /> {selecting ? 'Stop selecting' : 'Select'}
        </Button>
        {selecting ? <span className="text-sm text-charcoal-600">Tick up to {MAX_VIDEOS_PER_BATCH} finished edits to publish together.</span> : null}
      </div>
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => {
          const ticked = selected.includes(item.versionId);
          return (
            <li key={item.versionId}>
              <Card className={cn('overflow-hidden', ticked && 'ring-2 ring-[var(--accent)]')}>
                <div className="relative aspect-[9/16] w-full bg-charcoal-950">
                  {item.previewUrl ? (
                    <video src={item.previewUrl} controls preload="metadata" playsInline className="size-full object-contain" aria-label={`Preview of ${item.styleName} for ${item.projectTitle}`} />
                  ) : (
                    <div className="flex size-full items-center justify-center px-6 text-center text-sm text-charcoal-400">Preview not available</div>
                  )}
                  {selecting && item.publishable ? (
                    <label className="absolute left-2 top-2 flex min-h-11 items-center gap-2 rounded-lg bg-white/95 px-3 text-sm font-medium text-charcoal-900 shadow">
                      <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={ticked} disabled={!ticked && selected.length >= MAX_VIDEOS_PER_BATCH} onChange={() => toggle(item.versionId)} />
                      Select
                    </label>
                  ) : null}
                </div>
                <div className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{item.styleName}</p>
                    <StatusPill status={item.exported ? 'ready' : item.status} label={item.exported ? 'Exported' : undefined} />
                  </div>
                  <Link href={`/studio/${item.projectId}`} className="block truncate text-sm text-charcoal-600 hover:underline">
                    {item.projectTitle}
                  </Link>
                  <p className="text-xs text-charcoal-500">
                    Version {item.versionNo}
                    {item.durationLabel ? ` · ${item.durationLabel}` : ''} · {item.updatedLabel}
                  </p>
                  <PublishBadges badges={item.badges} />
                  {item.exportUrl ? (
                    <a href={item.exportUrl} className={buttonClasses('secondary', 'md', 'min-h-11 w-full')}>
                      <Download className="size-4" aria-hidden="true" /> {item.downloadLabel ? 'Download (Instagram/Facebook only)' : 'Download MP4'}
                      {item.exportSizeLabel ? ` (${item.exportSizeLabel})` : ''}
                    </a>
                  ) : null}
                  {item.downloadLabel ? <p className="text-xs text-amber-800">{item.downloadLabel}</p> : null}
                  {item.publishable && !selecting ? (
                    <Link href={`/publishing/new?versions=${item.versionId}`} className={buttonClasses('primary', 'md', 'min-h-11 w-full')}>
                      <Send className="size-4" aria-hidden="true" /> Publish
                    </Link>
                  ) : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      {selecting ? (
        <div className="z-10 -mx-4 mt-4 border-t sm:sticky sm:bottom-0 border-charcoal-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
          {selected.length ? (
            <Link href={`/publishing/new?versions=${selected.join(',')}`} className={buttonClasses('primary', 'md', 'min-h-11 w-full sm:w-auto')}>
              Publish selected ({selected.length})
            </Link>
          ) : (
            <Button className="min-h-11 w-full sm:w-auto" disabled>
              Publish selected (0)
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}
