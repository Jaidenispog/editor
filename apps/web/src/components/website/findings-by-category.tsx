'use client';

import { useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, prioritiseFindings, type Finding, type FindingCategory } from '@studio/core';
import { cn } from '@/lib/shared/cn';
import { FindingCard, type AltImage } from './finding-card';

/** All findings grouped by category, with filter chips (design §4.2 step 3). */
export function FindingsByCategory({
  findings,
  changeKeys,
  onShowChange,
  altImages,
}: {
  findings: Finding[];
  changeKeys: Set<string>;
  onShowChange: () => void;
  altImages?: AltImage[];
}) {
  const [filter, setFilter] = useState<FindingCategory | 'all'>('all');
  const present = CATEGORIES.filter((c) => findings.some((f) => f.category === c));
  const shown = prioritiseFindings(findings.filter((f) => filter === 'all' || f.category === filter));
  if (findings.length === 0) return <p className="text-sm text-charcoal-600">The check found nothing to fix. Nice work.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter findings">
        {(['all', ...present] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={filter === c}
            onClick={() => setFilter(c)}
            className={cn(
              'min-h-11 rounded-full border px-3 text-sm',
              filter === c ? 'border-charcoal-900 bg-charcoal-900 text-white' : 'border-charcoal-200 bg-white text-charcoal-700 hover:border-charcoal-300',
            )}
          >
            {c === 'all' ? `All (${findings.length})` : `${CATEGORY_LABELS[c]} (${findings.filter((f) => f.category === c).length})`}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {shown.map((f) => (
          <FindingCard key={f.key} finding={f} hasChange={changeKeys.has(f.key)} onShowChange={onShowChange} altImages={altImages} />
        ))}
      </div>
    </div>
  );
}
