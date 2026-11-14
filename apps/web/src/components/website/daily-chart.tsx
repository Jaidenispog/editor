import { QUERY_GROUPS, type QueryGroup } from '@studio/core';
import { GROUP_LABELS } from './query-group-tiles';
import type { SearchPerformanceDto } from './types';

const COLOURS: Record<QueryGroup, string> = {
  local: 'var(--accent)',
  brand: '#3f3f46',
  service: '#a1a1aa',
  other: '#d4d4d8',
};

/**
 * Impressions per day, one line per group (accent for local searches, greys for the rest), drawn as inline SVG with a
 * table for screen readers. Days come from Google exactly as stored; nothing is smoothed or filled in.
 */
export function DailyChart({ daily }: { daily: SearchPerformanceDto['daily'] }) {
  if (daily.length < 2) return null;
  const W = 600;
  const H = 160;
  const max = Math.max(1, ...daily.flatMap((d) => QUERY_GROUPS.map((g) => d[g])));
  const x = (i: number) => (i / (daily.length - 1)) * (W - 8) + 4;
  const y = (v: number) => H - 4 - (v / max) * (H - 12);
  return (
    <figure className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label="Impressions per day by search group" preserveAspectRatio="none">
        {QUERY_GROUPS.map((g) => (
          <polyline
            key={g}
            fill="none"
            stroke={COLOURS[g]}
            strokeWidth={g === 'local' ? 2.5 : 1.5}
            vectorEffect="non-scaling-stroke"
            points={daily.map((d, i) => `${x(i)},${y(d[g])}`).join(' ')}
          />
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-3 text-xs text-charcoal-600">
        {QUERY_GROUPS.map((g) => (
          <span key={g} className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-4" style={{ background: COLOURS[g] }} aria-hidden="true" />
            {GROUP_LABELS[g].title}
          </span>
        ))}
      </figcaption>
      <div className="sr-only">
        <table>
          <caption>Impressions per day</caption>
          <thead>
            <tr>
              <th>Day</th>
              {QUERY_GROUPS.map((g) => (
                <th key={g}>{GROUP_LABELS[g].title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.date}>
                <td>{d.date}</td>
                {QUERY_GROUPS.map((g) => (
                  <td key={g}>{d[g]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
