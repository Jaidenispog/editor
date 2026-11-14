'use client';

import { CheckCircle2, Pause, Play, RotateCcw, UploadCloud, X } from 'lucide-react';
import { useId, useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/shared/cn';
import { formatBytes } from '@/lib/format';
import type { UploadItem } from '@/lib/client/uploader';
import { UPLOAD_ACCEPT } from '@/lib/shared/upload-math';

const STATE_TEXT: Record<UploadItem['state'], string> = {
  queued: 'Waiting',
  uploading: 'Uploading',
  paused: 'Paused',
  finishing: 'Finishing',
  done: 'Uploaded',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

/**
 * Large drag-and-drop area for haircut clips (several at once) plus the list of uploads with per-file
 * progress, pause/resume, cancel and retry.
 */
export function UploadZone({
  items,
  hasClips,
  onFiles,
  onPause,
  onResume,
  onCancel,
  onDismiss,
}: {
  items: UploadItem[];
  hasClips: boolean;
  onFiles: (files: File[]) => void;
  onPause: (key: string) => void;
  onResume: (key: string) => void;
  onCancel: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hintId = useId();

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) onFiles(files);
  };

  return (
    <section aria-labelledby="upload-heading" className="space-y-3">
      <h2 id="upload-heading" className="sr-only">
        Add clips
      </h2>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed px-6 text-center transition',
          hasClips ? 'py-8' : 'py-14 sm:py-20',
          dragging ? 'border-accent bg-accent-soft' : 'border-charcoal-300 bg-white hover:border-charcoal-400',
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-charcoal-900 text-accent" aria-hidden="true">
          <UploadCloud className="size-6" />
        </span>
        <p className="mt-4 text-base font-semibold text-charcoal-950">{hasClips ? 'Add more clips' : 'Drop your haircut clips here to start'}</p>
        <p id={hintId} className="mt-1 max-w-md text-sm text-charcoal-600">
          Videos straight from your phone (.mov, .mp4 or .m4v). Add the before, the cut, the fade detail and the finished look. Big files are fine, and uploads pick up where they left off.
        </p>
        <Button className="mt-4" variant="secondary" onClick={() => inputRef.current?.click()} aria-describedby={hintId}>
          Choose videos
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT.video}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onFiles(files);
          }}
        />
      </div>

      {items.length ? (
        <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white" aria-label="Uploads">
          {items.map((item) => {
            const fraction = item.size > 0 ? item.uploadedBytes / item.size : 0;
            const active = item.state === 'uploading' || item.state === 'queued' || item.state === 'finishing';
            return (
              <li key={item.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {item.state === 'done' ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden="true" /> : null}
                    <span className="truncate text-sm font-medium text-charcoal-900">{item.name}</span>
                    {item.kind === 'audio' ? <span className="shrink-0 text-xs text-charcoal-500">Music</span> : null}
                  </div>
                  <p className={cn('mt-0.5 text-xs', item.state === 'failed' ? 'text-red-600' : 'text-charcoal-500')}>
                    {STATE_TEXT[item.state]} · {formatBytes(item.uploadedBytes)} of {formatBytes(item.size)}
                    {item.message && item.state !== 'paused' && item.state !== 'cancelled' ? ` · ${item.message}` : ''}
                  </p>
                  {item.state !== 'done' && item.state !== 'cancelled' ? (
                    <div
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-charcoal-100"
                      role="progressbar"
                      aria-label={`Upload progress for ${item.name}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(fraction * 100)}
                    >
                      <div className={cn('h-full rounded-full transition-[width]', item.state === 'failed' ? 'bg-red-400' : 'bg-accent')} style={{ width: `${Math.round(fraction * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {item.state === 'uploading' || item.state === 'queued' ? (
                    <Button size="sm" variant="ghost" onClick={() => onPause(item.key)} aria-label={`Pause ${item.name}`}>
                      <Pause className="size-4" aria-hidden="true" /> Pause
                    </Button>
                  ) : null}
                  {item.state === 'paused' ? (
                    <Button size="sm" variant="secondary" onClick={() => onResume(item.key)} aria-label={`Resume ${item.name}`}>
                      <Play className="size-4" aria-hidden="true" /> Resume
                    </Button>
                  ) : null}
                  {item.state === 'failed' && item.canRetry ? (
                    <Button size="sm" variant="secondary" onClick={() => onResume(item.key)} aria-label={`Retry ${item.name}`}>
                      <RotateCcw className="size-4" aria-hidden="true" /> Retry
                    </Button>
                  ) : null}
                  {active || item.state === 'paused' ? (
                    <Button size="sm" variant="ghost" onClick={() => onCancel(item.key)} aria-label={`Cancel ${item.name}`}>
                      <X className="size-4" aria-hidden="true" /> Cancel
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => onDismiss(item.key)} aria-label={`Hide ${item.name} from this list`}>
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
