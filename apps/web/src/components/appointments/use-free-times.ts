'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/client/api-client';
import type { AvailabilitySearchDto } from '@/lib/shared/square-dto';

/** Today's date in Melbourne, `YYYY-MM-DD`. */
export function melbourneToday(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

/** What a free-times search is for: a service (optionally one barber), or moving one booking. */
export interface FreeTimesQuery {
  serviceVariationId: string;
  teamMemberId: string | null;
  fromDate: string;
  days: number;
  bookingId?: string | null;
}

/**
 * Starts a read-only free-times search in Square and polls it every second for up to 30 seconds (design §4.4).
 * Used by the booking-change and self-test dialogs; the times are Square's own and may be taken at any moment.
 */
export function useFreeTimes() {
  const [search, setSearch] = useState<AvailabilitySearchDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const poll = useCallback((id: string, started: number) => {
    timer.current = setTimeout(() => {
      apiRequest<AvailabilitySearchDto>(`/api/appointments/availability/${encodeURIComponent(id)}`)
        .then((r) => {
          setSearch(r);
          if ((r.status === 'queued' || r.status === 'running') && Date.now() - started < 30_000) poll(id, started);
          else {
            setBusy(false);
            if (r.status !== 'done' && r.status !== 'failed') setError('Square didn’t answer. Try again.');
          }
        })
        .catch((e: Error) => {
          setBusy(false);
          setError(e.message);
        });
    }, 1000);
  }, []);

  const find = useCallback(
    async (q: FreeTimesQuery) => {
      if (timer.current) clearTimeout(timer.current);
      setBusy(true);
      setError(null);
      setSearch(null);
      try {
        const r = await apiRequest<{ searchId: string }>('/api/appointments/availability', { method: 'POST', body: { ...q, bookingId: q.bookingId ?? null } });
        poll(r.searchId, Date.now());
      } catch (e) {
        setBusy(false);
        setError((e as Error).message);
      }
    },
    [poll],
  );

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setSearch(null);
    setBusy(false);
    setError(null);
  }, []);

  return { search, busy, error, find, reset };
}
