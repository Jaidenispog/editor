'use client';

import { useId, type KeyboardEvent, type PointerEvent } from 'react';
import { formatSeconds } from '@/lib/format';
import { latestMusicStart, type EnergyCurve } from '@/lib/shared/music-curve';
export { strongestWindowStart } from '@/lib/shared/studio-schemas';

const W = 600;
const H = 64;

/** The beat nearest to `t` that still leaves room for the window; `t` itself without beats. */
function nearestBeat(beats: readonly number[], t: number, latest: number): number {
  const usable = beats.filter((b) => b <= latest + 0.001);
  if (usable.length === 0) return Math.min(Math.max(0, t), latest);
  return usable.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), usable[0]!);
}

/**
 * The song-section strip of the Sound panel: the track's loudness with a window as long as the edit. Click or drag
 * to move it, or use the arrow keys to move it by one beat (Home/End jump to the ends). The start is shown in m:ss.
 */
export function EnergyStrip({
  energy,
  beats,
  trackSec,
  windowSec,
  start,
  onChange,
  label = 'Song section',
}: {
  energy: EnergyCurve | null;
  beats: readonly number[];
  trackSec: number;
  windowSec: number;
  start: number;
  onChange: (startSec: number) => void;
  label?: string;
}) {
  const id = useId();
  const latest = latestMusicStart(trackSec, windowSec);
  const x = (sec: number) => (trackSec > 0 ? Math.min(W, (sec / trackSec) * W) : 0);
  const bars = energy?.values ?? [];
  const barW = bars.length ? W / bars.length : 0;
  const clamped = Math.max(0, Math.min(start, latest));

  const fromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = ((e.clientX - rect.left) / Math.max(1, rect.width)) * trackSec - windowSec / 2;
    onChange(nearestBeat(beats, Math.max(0, sec), latest));
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const after = beats.filter((b) => b <= latest + 0.001);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = after.find((b) => b > clamped + 0.01) ?? Math.min(latest, clamped + 0.5);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = [...after].reverse().find((b) => b < clamped - 0.01) ?? Math.max(0, clamped - 0.5);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = latest;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span id={`${id}-label`} className="text-sm font-medium text-charcoal-800">
          {label}
        </span>
        <span className="text-sm font-semibold text-charcoal-900 tabular-nums">
          {formatSeconds(clamped)}–{formatSeconds(clamped + windowSec)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full cursor-pointer touch-none rounded bg-charcoal-50 focus:outline-2 focus:outline-offset-2 focus:outline-[var(--accent)]"
        role="slider"
        tabIndex={0}
        aria-labelledby={`${id}-label`}
        aria-valuemin={0}
        aria-valuemax={Math.round(latest * 10) / 10}
        aria-valuenow={Math.round(clamped * 10) / 10}
        aria-valuetext={`Starts at ${formatSeconds(clamped)}, ends at ${formatSeconds(clamped + windowSec)}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) fromPointer(e);
        }}
        onKeyDown={onKey}
      >
        <rect x={x(clamped)} y={0} width={Math.max(2, x(clamped + windowSec) - x(clamped))} height={H} className="fill-[var(--accent-soft)]" />
        {bars.map((v, i) => {
          const h = Math.max(1, v * (H - 4));
          const t = i * (energy?.stepSec ?? 0);
          const inside = t + (energy?.stepSec ?? 0) > clamped && t < clamped + windowSec;
          return <rect key={i} x={i * barW} y={H - h} width={Math.max(1, barW - 1)} height={h} className={inside ? 'fill-charcoal-900' : 'fill-charcoal-300'} />;
        })}
        <line x1={x(clamped)} x2={x(clamped)} y1={0} y2={H} className="stroke-[var(--accent)]" strokeWidth={3} />
      </svg>
      <p className="text-xs text-charcoal-500">Click or drag to move the section. Arrow keys move it by one beat.</p>
    </div>
  );
}
