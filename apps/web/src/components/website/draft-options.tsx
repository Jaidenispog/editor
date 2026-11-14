'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Up to three AI wording options (labelled), chosen with radio buttons; choosing copies one into the change. */
export function DraftOptions({ options, busy, onChoose }: { options: string[]; busy: boolean; onChoose: (index: number) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  if (options.length === 0) return null;
  return (
    <fieldset className="space-y-2 rounded-lg border border-charcoal-200 p-3">
      <legend className="px-1 text-xs font-medium text-charcoal-600">AI wording — check before using</legend>
      {options.map((o, i) => (
        <label key={o} className="flex min-h-11 items-start gap-2 text-sm text-charcoal-800">
          <input type="radio" name="draft" className="mt-1 size-4" checked={picked === i} onChange={() => setPicked(i)} />
          <span className="[overflow-wrap:anywhere]">
            {o} <span className="text-xs text-charcoal-500">({o.length} characters)</span>
          </span>
        </label>
      ))}
      <Button size="sm" variant="secondary" className="min-h-11" disabled={picked === null} loading={busy} onClick={() => picked !== null && onChoose(picked)}>
        Use this wording
      </Button>
    </fieldset>
  );
}
