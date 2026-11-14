'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { formatSeconds } from '@studio/core';
import { Button } from '@/components/ui/button';

/**
 * Cover frame picker over the 540×960 preview: a slider (one frame per step at 30 fps; arrow keys step one frame),
 * "Use this frame", and a thumbnail of the chosen frame drawn from the preview. The worker cuts the real cover JPEG
 * from the full-quality export at the same time.
 */
export function CoverPicker({ previewUrl, durationSec, value, onChange }: { previewUrl: string | null; durationSec: number; value: number; onChange: (sec: number) => void }) {
  const id = useId();
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scrub, setScrub] = useState(value);

  useEffect(() => {
    if (video.current && Math.abs(video.current.currentTime - scrub) > 0.01) video.current.currentTime = scrub;
  }, [scrub]);

  const capture = () => {
    const v = video.current;
    const c = canvas.current;
    if (v && c && v.videoWidth) {
      c.width = 90;
      c.height = 160;
      try {
        c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
      } catch {
        // A cross-origin preview cannot be drawn; the time is still saved.
      }
    }
    onChange(Math.round(scrub * 1000) / 1000);
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-charcoal-800">Cover</p>
      <div className="flex gap-3">
        <div className="aspect-[9/16] w-32 shrink-0 overflow-hidden rounded-lg bg-charcoal-950 sm:w-40">
          {previewUrl ? <video ref={video} src={previewUrl} muted playsInline preload="auto" crossOrigin="anonymous" className="size-full object-contain" aria-label="Cover preview" /> : null}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor={id} className="text-xs text-charcoal-600">
            Frame at {formatSeconds(scrub)}
          </label>
          <input
            id={id}
            type="range"
            min={0}
            max={Math.max(0, durationSec)}
            step={1 / 30}
            value={scrub}
            onChange={(e) => setScrub(Number(e.target.value))}
            className="h-11 w-full accent-[var(--accent)]"
          />
          <Button variant="secondary" className="min-h-11" onClick={capture}>
            Use this frame
          </Button>
          <div className="flex items-center gap-2">
            <canvas ref={canvas} width={90} height={160} className="h-16 w-9 rounded border border-charcoal-200 bg-charcoal-100" aria-hidden="true" />
            <span className="text-xs text-charcoal-600">Chosen: {formatSeconds(value)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
