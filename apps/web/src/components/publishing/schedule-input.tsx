'use client';

import { melbourneLocalToUtc, melbourneZoneLabel, resolveSchedule, type ScheduleInput as Schedule } from '@studio/core';
import { Input } from '@/components/ui/field';

/**
 * Melbourne date and time inputs with the zone label for that date (AEDT/AEST) and instant feedback from the same
 * `melbourneLocalToUtc` the server uses: a time that does not exist when the clocks go forward is refused, and the
 * repeated hour when they go back is marked "the first".
 */
export function ScheduleInput({ value, onChange }: { value: Schedule; onChange: (v: Schedule) => void }) {
  let zone = 'Melbourne time';
  try {
    zone = `Melbourne time (${melbourneZoneLabel(value.date)})`;
  } catch {
    // Not a full date yet.
  }
  const local = melbourneLocalToUtc(value.date, value.time);
  const r = resolveSchedule(value);
  const message = !r.ok ? r.message : local.ok && local.ambiguous ? `${value.time} ${melbourneZoneLabel(local.instant)}: the first ${value.time} that night (clocks go back an hour).` : null;
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-3">
        <Input label="Date" type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
        <Input label={zone} type="time" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
      </div>
      {message ? <p className={r.ok ? 'text-xs text-charcoal-600' : 'text-xs font-medium text-red-700'}>{message}</p> : r.ok ? <p className="text-xs text-charcoal-600">{r.label}</p> : null}
    </div>
  );
}
