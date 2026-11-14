'use client';

import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { apiRequest } from '@/lib/client/api-client';
import { Button } from '@/components/ui/button';
import type { BookingDetailDto, BookingDto } from '@/lib/shared/square-dto';
import { AttendanceControl } from './attendance-control';
import type { ChangeTarget } from './change-dialog';

const SIGNAL_WORDS: Record<string, string> = {
  customer: 'same client',
  appointments_payment: 'paid through Square Appointments',
  team_member: 'same barber',
  service: 'same service on the receipt',
};

/**
 * One booking (design §4.2, §4.6): Square's status, the attendance label with its evidence, notes for the owner, the
 * attendance buttons, Move and Cancel when booking changes from Studio Assistant are on (with the reason when not),
 * the changes made from here, and "Open in Square". Square's text is shown as plain text, never as HTML.
 */
export function BookingDialog({ bookingId, onClose, onMarked, onChange, version = 0 }: { bookingId: string | null; onClose: () => void; onMarked?: (b: BookingDto) => void; onChange?: (t: ChangeTarget) => void; version?: number }) {
  const [detail, setDetail] = useState<BookingDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bookingId) return;
    let alive = true;
    setDetail(null);
    setError(null);
    apiRequest<BookingDetailDto>(`/api/appointments/${encodeURIComponent(bookingId)}`)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [bookingId, version]);

  const d = detail;
  return (
    <Dialog open={Boolean(bookingId)} onClose={onClose} title={d ? `${d.clientName}` : 'Booking'} description={d ? `${d.dayLabel}, ${d.timeRangeLabel}` : undefined}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!d && !error ? <Skeleton className="h-40" /> : null}
      {d ? (
        <div className="space-y-4 text-sm text-charcoal-700">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={d.status} label={d.statusLabel} />
            <span className="text-xs text-charcoal-500">Square’s status</span>
          </div>
          {d.statusExplanation && d.status !== 'ACCEPTED' ? <p>{d.statusExplanation}</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-charcoal-500">Service</dt>
            <dd>{d.serviceName}</dd>
            <dt className="text-charcoal-500">Barber</dt>
            <dd>{d.teamMemberName}</dd>
            <dt className="text-charcoal-500">Made in</dt>
            <dd>{d.createdIn}</dd>
            {d.clientEmail ? (
              <>
                <dt className="text-charcoal-500">Email</dt>
                <dd className="break-all">{d.clientEmail}</dd>
              </>
            ) : null}
            {d.clientPhone ? (
              <>
                <dt className="text-charcoal-500">Phone</dt>
                <dd>{d.clientPhone}</dd>
              </>
            ) : null}
          </dl>
          {d.customerNote ? (
            <div>
              <p className="text-xs font-semibold text-charcoal-500">Client’s note</p>
              <p className="whitespace-pre-wrap">{d.customerNote}</p>
            </div>
          ) : null}
          {d.sellerNote ? (
            <div>
              <p className="text-xs font-semibold text-charcoal-500">Studio note</p>
              <p className="whitespace-pre-wrap">{d.sellerNote}</p>
            </div>
          ) : null}
          {d.status === 'ACCEPTED' && d.attendance !== 'upcoming' ? (
            <div className="rounded-[var(--radius-control)] bg-charcoal-50 p-3">
              <p className="flex flex-wrap items-center gap-2">
                <StatusPill status={d.attendance} />
                <span>{d.attendanceLabel}</span>
                {d.attendanceIsEstimate ? <Badge>Estimate</Badge> : null}
              </p>
              {d.evidence ? <p className="mt-1 text-xs text-charcoal-500">Matched on: {d.evidence.signals.map((s) => SIGNAL_WORDS[s] ?? s).join(', ')}.</p> : null}
              <p className="mt-1 text-xs text-charcoal-500">Square has no “completed” status, so this is Studio Assistant’s estimate until someone marks it.</p>
            </div>
          ) : null}
          {d.missingFromSquare ? <Alert tone="warning">Square no longer has this booking. It may have been deleted there.</Alert> : null}
          {onChange && (d.actions.move.allowed || d.actions.cancel.allowed) ? (
            <div className="flex flex-wrap gap-2">
              {d.actions.move.allowed ? (
                <Button variant="secondary" className="min-h-11" onClick={() => onChange({ kind: 'reschedule', booking: d })}>
                  Move
                </Button>
              ) : null}
              {d.actions.cancel.allowed ? (
                <Button variant="ghost" className="min-h-11" onClick={() => onChange({ kind: 'cancel', booking: d })}>
                  Cancel booking
                </Button>
              ) : null}
              {!d.actions.move.allowed && d.actions.move.reason ? <p className="w-full text-xs text-charcoal-500">{d.actions.move.reason}</p> : null}
            </div>
          ) : null}
          {d.changes.length ? (
            <div>
              <p className="text-xs font-semibold text-charcoal-500">Changes from Studio Assistant</p>
              <ul className="mt-1 space-y-1">
                {d.changes.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusPill status={c.pill} label={c.statusLabel} />
                    <span>{c.kind === 'create' ? 'Booked' : c.kind === 'reschedule' ? `Move${c.startLabel ? ` to ${c.startLabel}` : ''}` : 'Cancel'}</span>
                    <span className="text-charcoal-500">{c.createdLabel}</span>
                    {c.statusMessage ? <span className="w-full text-charcoal-600">{c.statusMessage}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <AttendanceControl
            booking={d}
            onMarked={(b) => {
              setDetail({ ...d, ...b });
              onMarked?.(b);
            }}
          />
          <div className="border-t border-charcoal-100 pt-3">
            <p className="text-xs text-charcoal-500">{d.deepLink.instruction}</p>
            {d.deepLink.url ? (
              <a href={d.deepLink.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-charcoal-900 underline">
                Open in Square <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
