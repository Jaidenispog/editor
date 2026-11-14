'use client';

import { CalendarDays } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import type { BookingDto } from '@/lib/shared/square-dto';
import { AttendanceControl } from './attendance-control';

/** One booking: time, client, service, barber, Square's status and the attendance label. */
export function BookingCard({ booking, onOpen, showAttendance, onMarked }: { booking: BookingDto; onOpen: (id: string) => void; showAttendance?: boolean; onMarked?: (b: BookingDto) => void }) {
  return (
    <li className="rounded-[var(--radius-card)] border border-charcoal-200 bg-white p-4 shadow-xs">
      <button type="button" onClick={() => onOpen(booking.id)} className="block w-full min-w-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-charcoal-900">{booking.timeRangeLabel}</p>
            <p className="mt-0.5 truncate text-sm text-charcoal-800">{booking.clientName}</p>
            <p className="mt-0.5 text-sm text-charcoal-600">
              {booking.serviceName} · {booking.teamMemberName}
            </p>
          </div>
          <StatusPill status={booking.status} label={booking.statusLabel} />
        </div>
        {booking.statusExplanation && booking.status !== 'ACCEPTED' ? <p className="mt-2 text-xs text-charcoal-600">{booking.statusExplanation}</p> : null}
        {booking.attendance !== 'upcoming' && booking.attendance !== 'pending' && booking.status === 'ACCEPTED' ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-charcoal-600">
            <StatusPill status={booking.attendance} />
            <span>{booking.attendanceLabel}</span>
            {booking.attendanceIsEstimate ? <Badge>Estimate</Badge> : null}
          </p>
        ) : null}
        {booking.missingFromSquare ? <p className="mt-2 text-xs text-amber-800">Not found in Square any more — it may have been deleted there.</p> : null}
      </button>
      {showAttendance ? (
        <div className="mt-3 border-t border-charcoal-100 pt-3">
          <AttendanceControl booking={booking} {...(onMarked ? { onMarked } : {})} />
        </div>
      ) : null}
    </li>
  );
}

/** Bookings grouped by Melbourne day, with an empty state per view. */
export function BookingList({
  bookings,
  emptyTitle,
  emptyDescription,
  onOpen,
  showAttendance,
  onMarked,
}: {
  bookings: BookingDto[];
  emptyTitle: string;
  emptyDescription?: string;
  onOpen: (id: string) => void;
  showAttendance?: boolean;
  onMarked?: (b: BookingDto) => void;
}) {
  if (!bookings.length) return <EmptyState icon={<CalendarDays />} title={emptyTitle} {...(emptyDescription ? { description: emptyDescription } : {})} />;
  const groups: Array<{ key: string; label: string; items: BookingDto[] }> = [];
  for (const b of bookings) {
    const last = groups.at(-1);
    if (last && last.key === b.dayKey) last.items.push(b);
    else groups.push({ key: b.dayKey, label: b.dayLabel, items: [b] });
  }
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-charcoal-500 uppercase">{g.label}</h3>
          <ul className="space-y-3">
            {g.items.map((b) => (
              <BookingCard key={b.id} booking={b} onOpen={onOpen} {...(showAttendance ? { showAttendance } : {})} {...(onMarked ? { onMarked } : {})} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
