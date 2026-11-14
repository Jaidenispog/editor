'use client';

import { useId } from 'react';
import { formatSeconds } from '@/lib/format';
import { latestMusicStart } from '@/lib/shared/music-curve';
import type { MusicOptionDto } from '@/lib/shared/studio-dto';

const CURVE_WIDTH = 600;
const CURVE_HEIGHT = 64;

/**
 * Where the chosen track starts in the edit: "Automatic" (the editor picks a part that fits) or a start point
 * picked on a slider over the track's loudness curve, shown as mm:ss. The highlighted band is the part of the
 * track the edit will use. The editor snaps the start to the next beat.
 */
export function MusicStartPicker({
  track,
  editSec,
  value,
  onChange,
}: {
  track: MusicOptionDto;
  editSec: number;
  /** Seconds into the track, or null for automatic. */
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  const duration = track.durationSec ?? 0;
  const latest = latestMusicStart(track.durationSec, editSec);
  const canChoose = duration > 0 && latest > 0;
  const manual = value !== null && canChoose;
  const start = manual ? Math.min(value, latest) : 0;
  const energy = track.energy;

  const bars = energy?.values ?? [];
  const barWidth = bars.length ? CURVE_WIDTH / bars.length : 0;
  const x = (sec: number) => (duration > 0 ? Math.min(CURVE_WIDTH, (sec / duration) * CURVE_WIDTH) : 0);

  return (
    <fieldset className="space-y-3 rounded-lg border border-charcoal-200 p-3">
      <legend className="px-1 text-sm font-medium text-charcoal-800">Music start</legend>
      <p className="text-sm text-charcoal-600">
        {track.bpm ? `${Math.round(track.bpm)} BPM` : 'Tempo unknown'}
        {duration > 0 ? ` · ${formatSeconds(duration)} long` : ''}
      </p>
      {energy && bars.length ? (
        <svg viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`} preserveAspectRatio="none" className="h-16 w-full rounded bg-charcoal-50" role="img" aria-label={manual ? `Loudness of the track. The edit uses ${formatSeconds(start)} to ${formatSeconds(start + editSec)}.` : 'Loudness of the track over its length.'}>
          {manual ? <rect x={x(start)} y={0} width={Math.max(2, x(start + editSec) - x(start))} height={CURVE_HEIGHT} className="fill-[var(--accent-soft)]" /> : null}
          {bars.map((v, i) => {
            const h = Math.max(1, v * (CURVE_HEIGHT - 4));
            const t = i * energy.stepSec;
            const inside = manual && t + energy.stepSec > start && t < start + editSec;
            return <rect key={i} x={i * barWidth} y={CURVE_HEIGHT - h} width={Math.max(1, barWidth - 1)} height={h} className={inside ? 'fill-charcoal-900' : 'fill-charcoal-300'} />;
          })}
          {manual ? <line x1={x(start)} x2={x(start)} y1={0} y2={CURVE_HEIGHT} className="stroke-[var(--accent)]" strokeWidth={3} /> : null}
        </svg>
      ) : (
        <p className="text-xs text-charcoal-500">The loudness curve appears once the track has been analysed.</p>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-charcoal-800">
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-mode`} className="size-4 accent-[var(--accent)]" checked={!manual} onChange={() => onChange(null)} />
          Automatic (the editor picks a part that fits)
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-mode`} className="size-4 accent-[var(--accent)]" checked={manual} disabled={!canChoose} onChange={() => onChange(0)} />
          Choose where it starts
        </label>
      </div>
      {!canChoose ? (
        <p className="text-xs text-charcoal-500">This track is not much longer than the edit, so the music starts at the beginning.</p>
      ) : manual ? (
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${id}-start`} className="text-sm text-charcoal-700">
              Start the music at
            </label>
            <span className="text-sm font-semibold text-charcoal-900 tabular-nums">{formatSeconds(start)}</span>
          </div>
          <input
            id={`${id}-start`}
            type="range"
            min={0}
            max={latest}
            step={0.5}
            value={start}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-valuetext={`Starts at ${formatSeconds(start)}, ends at ${formatSeconds(start + editSec)}`}
            className="mt-1 w-full accent-[var(--accent)]"
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="mt-1 text-xs text-charcoal-500">
            The edit plays {formatSeconds(start)}–{formatSeconds(start + editSec)} of the track. The music starts on the next beat from this point.
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
