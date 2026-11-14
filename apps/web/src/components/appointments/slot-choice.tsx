'use client';

import { cn } from '@/lib/shared/cn';
import type { AvailabilitySlotDto } from '@/lib/shared/square-dto';

/** Key of one slot (a time can be free with two barbers). */
export const slotKey = (s: Pick<AvailabilitySlotDto, 'startAt' | 'teamMemberId'>) => `${s.startAt}|${s.teamMemberId}`;

/**
 * Free times from Square grouped by Melbourne day, as large tap targets; the chosen one is marked. Times are
 * Square's exact instants and are only ever sent back as they came.
 */
export function SlotChoice({ slots, chosen, onChoose, empty = 'No free times in Square for those days.' }: { slots: AvailabilitySlotDto[]; chosen: string | null; onChoose: (slot: AvailabilitySlotDto) => void; empty?: string }) {
  if (!slots.length) return <p className="text-sm text-charcoal-600">{empty}</p>;
  const groups: Array<{ key: string; label: string; slots: AvailabilitySlotDto[] }> = [];
  for (const s of slots) {
    const last = groups.at(-1);
    if (last && last.key === s.dayKey) last.slots.push(s);
    else groups.push({ key: s.dayKey, label: s.dayLabel, slots: [s] });
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <fieldset key={g.key}>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-charcoal-500 uppercase">{g.label}</legend>
          <div className="flex flex-wrap gap-2">
            {g.slots.map((s) => {
              const on = chosen === slotKey(s);
              return (
                <button
                  key={slotKey(s)}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChoose(s)}
                  className={cn('min-h-11 rounded-full border px-3 text-sm', on ? 'border-charcoal-900 bg-charcoal-900 text-white' : 'border-charcoal-200 bg-white text-charcoal-800 hover:border-charcoal-400')}
                >
                  {s.startLabel} · {s.teamMemberName}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
