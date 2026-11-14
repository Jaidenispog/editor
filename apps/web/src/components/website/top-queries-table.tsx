'use client';

import { useState } from 'react';
import { QUERY_GROUPS, type QueryGroup } from '@studio/core';
import { cn } from '@/lib/shared/cn';
import { GROUP_LABELS } from './query-group-tiles';
import type { SearchPerformanceDto } from './types';

/** "Top searches" per group (up to 20), as Google listed them. Searches are text typed by the public: shown as text. */
export function TopQueriesTable({ topQueries }: { topQueries: NonNullable<SearchPerformanceDto['topQueries']> }) {
  const [group, setGroup] = useState<QueryGroup>('local');
  const rows = topQueries[group];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a search group">
        {QUERY_GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={group === g}
            onClick={() => setGroup(g)}
            className={cn(
              'min-h-11 rounded-full border px-3 text-sm',
              group === g ? 'border-charcoal-900 bg-charcoal-900 text-white' : 'border-charcoal-200 bg-white text-charcoal-700',
            )}
          >
            {GROUP_LABELS[g].title}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-charcoal-600">No searches in this group for the chosen period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-sm">
            <thead className="text-xs text-charcoal-500">
              <tr>
                <th className="py-1 pr-2 font-medium">Search</th>
                <th className="py-1 pr-2 text-right font-medium">Clicks</th>
                <th className="py-1 pr-2 text-right font-medium">Impressions</th>
                <th className="py-1 text-right font-medium">Avg. position</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal-100">
              {rows.map((r) => (
                <tr key={r.query}>
                  <td className="py-1.5 pr-2 [overflow-wrap:anywhere]">{r.query}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{r.clicks}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{r.impressions}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.position ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
