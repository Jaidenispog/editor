import type { QueryGroup } from '@studio/core';
import type { SearchPerformanceDto } from './types';

/** Plain names of the search groups (design §4.5). */
export const GROUP_LABELS: Record<QueryGroup, { title: string; hint: string }> = {
  brand: {
    title: 'Searches for your business name',
    hint: 'For example your name, or your name plus "hours".',
  },
  local: {
    title: 'Local searches',
    hint: 'A service plus your suburb or "near me", such as "barber Ivanhoe".',
  },
  service: {
    title: 'Service searches without a place',
    hint: 'Such as "skin fade". Google may still show local results for these.',
  },
  other: { title: 'Other searches', hint: 'Everything else Google listed.' },
};

const n = (v: number) => new Intl.NumberFormat('en-AU').format(v);

/** Four group tiles with clicks, impressions and average position, plus the "not listed" remainder. */
export function QueryGroupTiles({ data }: { data: SearchPerformanceDto }) {
  if (!data.groups) return null;
  const groups = data.groups;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(GROUP_LABELS) as QueryGroup[]).map((g) => (
          <div key={g} className={`rounded-lg border p-3 ${g === 'local' ? 'border-[var(--accent)]' : 'border-charcoal-200'}`}>
            <p className="text-sm font-medium text-charcoal-900">{GROUP_LABELS[g].title}</p>
            <p className="text-xs text-charcoal-500">{GROUP_LABELS[g].hint}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
              <div>
                <dt className="text-xs text-charcoal-500">Clicks</dt>
                <dd className="font-semibold text-charcoal-900">{n(groups[g].clicks)}</dd>
              </div>
              <div>
                <dt className="text-xs text-charcoal-500">Impressions</dt>
                <dd className="font-semibold text-charcoal-900">{n(groups[g].impressions)}</dd>
              </div>
              <div>
                <dt className="text-xs text-charcoal-500">Avg. position</dt>
                <dd className="font-semibold text-charcoal-900">{groups[g].position ?? '—'}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      {data.notListed ? (
        <p className="text-xs text-charcoal-500">
          Searches Google doesn&apos;t list individually: {n(data.notListed.impressions)} impressions, {n(data.notListed.clicks)} clicks.
        </p>
      ) : null}
    </div>
  );
}
