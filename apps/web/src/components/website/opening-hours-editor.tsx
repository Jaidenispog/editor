'use client';

import { Plus, X } from 'lucide-react';
import { OPENING_DAYS, OPENING_DAY_NAMES, type OpeningDay, type OpeningRange } from '@studio/core';
import { Button } from '@/components/ui/button';

/**
 * Opening hours for Settings → Business (website design §5.3, §10.1): up to two ranges per day in 24-hour Melbourne
 * time; a day without a range is "Closed". Used for the website check and the business details code it prepares.
 */
export function OpeningHoursEditor({
  value,
  onChange,
  disabled,
  error,
}: {
  value: OpeningRange[];
  onChange: (next: OpeningRange[]) => void;
  disabled: boolean;
  error?: string | null;
}) {
  const forDay = (day: OpeningDay) => value.map((r, index) => ({ r, index })).filter((x) => x.r.day === day);
  const update = (index: number, patch: Partial<OpeningRange>) => onChange(value.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const add = (day: OpeningDay) => {
    const existing = forDay(day);
    const range: OpeningRange = existing.length ? { day, opens: '13:00', closes: '17:00' } : { day, opens: '09:00', closes: '17:00' };
    onChange([...value, range]);
  };
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-charcoal-100 rounded-lg border border-charcoal-200">
        {OPENING_DAYS.map((day) => {
          const ranges = forDay(day);
          return (
            <li key={day} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
              <span className="w-24 shrink-0 text-sm font-medium text-charcoal-800">{OPENING_DAY_NAMES[day]}</span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {ranges.length === 0 ? <span className="text-sm text-charcoal-500">Closed</span> : null}
                {ranges.map(({ r, index }) => (
                  <span key={index} className="inline-flex flex-wrap items-center gap-1.5">
                    <input
                      type="time"
                      aria-label={`${OPENING_DAY_NAMES[day]} opens`}
                      className="min-h-11 rounded-md border border-charcoal-200 px-2 text-sm"
                      value={r.opens}
                      disabled={disabled}
                      onChange={(e) => update(index, { opens: e.target.value.slice(0, 5) })}
                    />
                    <span className="text-sm text-charcoal-500">to</span>
                    <input
                      type="time"
                      aria-label={`${OPENING_DAY_NAMES[day]} closes`}
                      className="min-h-11 rounded-md border border-charcoal-200 px-2 text-sm"
                      value={r.closes}
                      disabled={disabled}
                      onChange={(e) => update(index, { closes: e.target.value.slice(0, 5) })}
                    />
                    <button
                      type="button"
                      className="inline-flex size-11 items-center justify-center rounded-md text-charcoal-500 hover:bg-charcoal-100"
                      aria-label={`Remove ${OPENING_DAY_NAMES[day]} ${r.opens}–${r.closes}`}
                      disabled={disabled}
                      onClick={() => remove(index)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
              {ranges.length < 2 ? (
                <Button type="button" variant="ghost" size="sm" className="min-h-11" disabled={disabled} onClick={() => add(day)}>
                  <Plus className="size-4" aria-hidden="true" /> {ranges.length ? 'Add a second time' : 'Add hours'}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
