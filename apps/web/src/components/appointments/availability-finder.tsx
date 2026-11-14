'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { apiRequest } from '@/lib/client/api-client';
import { cn } from '@/lib/shared/cn';
import type { AvailabilitySearchDto, AvailabilitySlotDto, SquareServiceDto, SquareTeamMemberDto } from '@/lib/shared/square-dto';

/** Today's date in Melbourne, `YYYY-MM-DD`. */
function melbourneToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * Free times from Square for a service (design §4.4): service, optional barber, a start day and 1–14 days. The search
 * runs in the background and this polls every second for up to 30 seconds. Times are Square's. With `onBook` (booking
 * changes on, owner) each time of a service bookable from here opens the booking dialog.
 */
export function AvailabilityFinder({ services, teamMembers, onBook }: { services: SquareServiceDto[]; teamMembers: SquareTeamMemberDto[]; onBook?: ((slot: AvailabilitySlotDto, searchId: string, serviceVariationId: string) => void) | undefined }) {
  const open = services.filter((s) => s.label !== 'not_bookable');
  const [serviceId, setServiceId] = useState(open[0]?.variationId ?? '');
  const [teamMemberId, setTeamMemberId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [days, setDays] = useState('7');
  const [search, setSearch] = useState<AvailabilitySearchDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setFromDate(melbourneToday());
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const service = open.find((s) => s.variationId === serviceId);
  const barbers = teamMembers.filter((t) => service?.teamMemberIds.includes(t.id));

  const poll = (id: string, started: number) => {
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
  };

  const run = async () => {
    if (!serviceId) return;
    setBusy(true);
    setError(null);
    setSearch(null);
    try {
      const r = await apiRequest<{ searchId: string }>('/api/appointments/availability', { method: 'POST', body: { serviceVariationId: serviceId, teamMemberId: teamMemberId || null, fromDate, days: Number(days) } });
      poll(r.searchId, Date.now());
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  if (!open.length) return <p className="text-sm text-charcoal-600">No Square services are open for booking, so there are no free times to look up.</p>;
  const groups: Array<{ key: string; label: string; slots: AvailabilitySearchDto['slots'] }> = [];
  for (const s of search?.slots ?? []) {
    const last = groups.at(-1);
    if (last && last.key === s.dayKey) last.slots.push(s);
    else groups.push({ key: s.dayKey, label: s.dayLabel, slots: [s] });
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-charcoal-600">Same times your clients see online.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Service" value={serviceId} onChange={(e) => { setServiceId(e.target.value); setTeamMemberId(''); }} options={open.map((s) => ({ value: s.variationId, label: s.name }))} />
        <Select label="Barber" value={teamMemberId} onChange={(e) => setTeamMemberId(e.target.value)} options={[{ value: '', label: 'Any barber' }, ...barbers.map((b) => ({ value: b.id, label: b.displayName }))]} />
        <Input label="From" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <Select label="For" value={days} onChange={(e) => setDays(e.target.value)} options={['1', '3', '7', '14'].map((d) => ({ value: d, label: d === '1' ? '1 day' : `${d} days` }))} />
      </div>
      <Button onClick={() => void run()} loading={busy} disabled={!serviceId || !fromDate} className="min-h-11">
        {search?.status === 'done' ? 'Check again' : 'Find free times'}
      </Button>
      {busy ? (
        <p className="flex items-center gap-2 text-sm text-charcoal-600">
          <Spinner /> Checking Square for free times…
        </p>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {search?.status === 'failed' ? <Alert tone="danger">{search.error ?? 'Square didn’t answer. Try again.'}</Alert> : null}
      {search?.status === 'done' ? (
        <div className={cn('space-y-4', search.stale && 'opacity-60')}>
          <p className="text-xs text-charcoal-500">Free times from Square at {search.fetchedLabel}. Times can be taken at any moment{search.stale ? '; these are more than 5 minutes old, so check again' : ''}.</p>
          {!groups.length ? <p className="text-sm text-charcoal-600">No free times in Square for those days.</p> : null}
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h4 className="mb-2 text-xs font-semibold tracking-wide text-charcoal-500 uppercase">{g.label}</h4>
              <ul className="flex flex-wrap gap-2">
                {g.slots.map((s) =>
                  onBook && service?.label === 'bookable' && !search.stale ? (
                    <li key={`${s.startAt}-${s.teamMemberId}`}>
                      <button type="button" onClick={() => onBook(s, search.id, service.variationId)} className="min-h-11 rounded-full border border-charcoal-300 bg-white px-3 text-sm text-charcoal-900 hover:border-charcoal-600" aria-label={`Book ${s.dayLabel} ${s.startLabel} with ${s.teamMemberName}`}>
                        {s.startLabel} · {s.teamMemberName}
                      </button>
                    </li>
                  ) : (
                    <li key={`${s.startAt}-${s.teamMemberId}`} className="rounded-full border border-charcoal-200 bg-white px-3 py-1.5 text-sm text-charcoal-800">
                      {s.startLabel} · {s.teamMemberName}
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
