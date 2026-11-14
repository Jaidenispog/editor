'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { StatusPill } from '@/components/ui/status-pill';
import { apiRequest } from '@/lib/client/api-client';
import type { AvailabilitySlotDto, BookingChangeDto, BookingDetailDto, ClientDto, SquareStatusDto } from '@/lib/shared/square-dto';
import { ClientPicker } from './client-picker';
import { SlotChoice, slotKey } from './slot-choice';
import { melbourneToday, useFreeTimes } from './use-free-times';

/** What the dialog changes: a new booking (optionally at a time already found), or a move or cancel of one booking. */
export type ChangeTarget =
  | { kind: 'create'; preset?: { slot: AvailabilitySlotDto; searchId: string; serviceVariationId: string } }
  | { kind: 'reschedule'; booking: BookingDetailDto }
  | { kind: 'cancel'; booking: BookingDetailDto };

/** The zone in force in Melbourne at an instant ("AEDT" or "AEST"). */
export function zoneAt(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', timeZoneName: 'short' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

const VERB = { create: 'Book in Square', reschedule: 'Move in Square', cancel: 'Cancel in Square' } as const;
const TITLE = { create: 'New booking', reschedule: 'Move booking', cancel: 'Cancel booking' } as const;

/**
 * Create, move or cancel one booking from Studio Assistant (Tier 1, design §4.6): choose → confirm → progress. The
 * confirmation says exactly what will happen in Square (with AEDT/AEST and what Square may tell the client), and
 * nothing shows as done until Square confirmed it. The five outcomes are shown in plain words; Square's own refusal
 * text is shown as text.
 */
export function ChangeDialog({ target, status, onClose, onFinished }: { target: ChangeTarget | null; status: SquareStatusDto; onClose: () => void; onFinished?: (c: BookingChangeDto) => void }) {
  const free = useFreeTimes();
  const bookable = status.services.filter((s) => s.label === 'bookable');
  const [phase, setPhase] = useState<'choose' | 'confirm' | 'progress'>('choose');
  const [client, setClient] = useState<ClientDto | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [teamMemberId, setTeamMemberId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [days, setDays] = useState('7');
  const [slot, setSlot] = useState<AvailabilitySlotDto | null>(null);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [change, setChange] = useState<BookingChangeDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetFree = free.reset;

  useEffect(() => {
    if (!target) return;
    setPhase(target.kind === 'cancel' ? 'confirm' : 'choose');
    setClient(null);
    setServiceId(target.kind === 'create' ? (target.preset?.serviceVariationId ?? bookable[0]?.variationId ?? '') : (target.booking.serviceVariationId ?? ''));
    setTeamMemberId('');
    setFromDate(melbourneToday());
    setSlot(target.kind === 'create' ? (target.preset?.slot ?? null) : null);
    setSearchId(target.kind === 'create' ? (target.preset?.searchId ?? null) : null);
    setNote('');
    setChange(null);
    setError(null);
    resetFree();
    // Only when a new target opens the dialog (the lists it reads come with it).
  }, [target]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (free.search?.status === 'done') setSearchId(free.search.id);
  }, [free.search]);

  if (!target) return null;
  const kind = target.kind;
  const booking = kind === 'create' ? null : target.booking;
  const service = status.services.find((s) => s.variationId === serviceId) ?? null;
  const barbers = status.teamMembers.filter((t) => service?.teamMemberIds.includes(t.id));
  const sandbox = status.environment === 'sandbox';
  const preset = kind === 'create' ? target.preset : undefined;

  const poll = (id: string, started: number) => {
    timer.current = setTimeout(() => {
      apiRequest<BookingChangeDto>(`/api/appointments/changes/${encodeURIComponent(id)}`)
        .then((c) => {
          setChange(c);
          if (!c.done && Date.now() - started < 90_000) poll(id, started);
          else if (c.done) onFinished?.(c);
        })
        .catch((e: Error) => setError(e.message));
    }, 1000);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body =
        kind === 'create'
          ? { kind, customerId: client?.id, serviceVariationId: serviceId, teamMemberId: slot?.teamMemberId, startAt: slot?.startAt, availabilitySearchId: searchId, ...(note.trim() ? { sellerNote: note.trim() } : {}) }
          : kind === 'reschedule'
            ? { kind, bookingId: booking?.id, startAt: slot?.startAt, teamMemberId: slot?.teamMemberId, availabilitySearchId: searchId, expectedVersion: booking?.squareVersion }
            : { kind, bookingId: booking?.id, expectedVersion: booking?.squareVersion };
      const r = await apiRequest<{ change: BookingChangeDto }>('/api/appointments/changes', { method: 'POST', body });
      setChange(r.change);
      setPhase('progress');
      poll(r.change.id, Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!change) return;
    try {
      const c = await apiRequest<BookingChangeDto>(`/api/appointments/changes/${encodeURIComponent(change.id)}/cancel`, { method: 'POST' });
      if (timer.current) clearTimeout(timer.current);
      setChange(c);
      onFinished?.(c);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const findTimes = () => {
    setSlot(null);
    setSearchId(null);
    void free.find({ serviceVariationId: serviceId, teamMemberId: teamMemberId || null, fromDate, days: Number(days), bookingId: booking?.id ?? null });
  };

  const when = slot ? `${slot.dayLabel}, ${slot.startLabel}–${slot.endLabel} (${zoneAt(slot.startAt)})` : booking ? `${booking.dayLabel}, ${booking.timeRangeLabel} (${zoneAt(booking.startAt)})` : '';
  const summary =
    kind === 'create'
      ? `Book ${client?.name ?? 'the client'} for ${service?.name ?? 'the service'}${slot ? ` (${slot.durationMinutes} min)` : ''} with ${slot?.teamMemberName ?? 'the barber'} on ${when}.`
      : kind === 'reschedule'
        ? `Move ${booking?.clientName}’s ${booking?.serviceName} to ${when} with ${slot?.teamMemberName ?? booking?.teamMemberName}.`
        : `Cancel ${booking?.clientName}’s ${booking?.serviceName} on ${when}.`;
  const real = sandbox ? 'This changes your Square sandbox (test) account, not real bookings.' : kind === 'create' ? 'This creates a real booking in Square.' : 'This changes a real booking in Square.';

  const footer =
    phase === 'choose' ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button disabled={!slot || !searchId || (kind === 'create' && !client)} onClick={() => setPhase('confirm')}>
          Next
        </Button>
      </>
    ) : phase === 'confirm' ? (
      <>
        <Button variant="ghost" onClick={() => (kind === 'cancel' ? onClose() : setPhase('choose'))}>
          {kind === 'cancel' ? 'Keep the booking' : 'Back'}
        </Button>
        <Button variant={kind === 'cancel' ? 'danger' : 'primary'} loading={busy} onClick={() => void submit()}>
          {VERB[kind]}
        </Button>
      </>
    ) : (
      <>
        {change?.canWithdraw ? (
          <Button variant="ghost" onClick={() => void withdraw()}>
            Withdraw
          </Button>
        ) : null}
        {change?.status === 'slot_unavailable' ? (
          <Button
            variant="secondary"
            onClick={() => {
              setChange(null);
              setPhase('choose');
              findTimes();
            }}
          >
            Choose another time
          </Button>
        ) : null}
        <Button variant={change?.done ? 'primary' : 'ghost'} onClick={onClose}>
          Close
        </Button>
      </>
    );

  return (
    <Dialog open onClose={onClose} title={TITLE[kind]} description={booking ? `${booking.clientName} · ${booking.serviceName}` : 'Times come straight from Square and are checked again before booking.'} footer={footer}>
      <div className="space-y-4 text-sm text-charcoal-700">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {phase === 'choose' ? (
          <>
            {kind === 'create' ? <ClientPicker value={client} onChange={setClient} /> : null}
            {preset && slot ? (
              <p>
                <span className="font-medium text-charcoal-900">Time:</span> {when} with {slot.teamMemberName}
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {kind === 'create' ? (
                    <Select
                      label="Service"
                      value={serviceId}
                      onChange={(e) => {
                        setServiceId(e.target.value);
                        setTeamMemberId('');
                        free.reset();
                        setSlot(null);
                      }}
                      options={bookable.map((s) => ({ value: s.variationId, label: s.name }))}
                    />
                  ) : null}
                  <Select label="Barber" value={teamMemberId} onChange={(e) => setTeamMemberId(e.target.value)} options={[{ value: '', label: 'Any barber' }, ...barbers.map((b) => ({ value: b.id, label: b.displayName }))]} />
                  <Input label="From" type="date" value={fromDate} min={melbourneToday()} onChange={(e) => setFromDate(e.target.value)} />
                  <Select label="For" value={days} onChange={(e) => setDays(e.target.value)} options={['1', '3', '7', '14'].map((d) => ({ value: d, label: d === '1' ? '1 day' : `${d} days` }))} />
                </div>
                {kind === 'create' && !bookable.length ? <Alert tone="info">No service is confirmed as bookable from Studio Assistant yet. Confirm one under Services.</Alert> : null}
                <Button variant="secondary" className="min-h-11" onClick={findTimes} loading={free.busy} disabled={!serviceId || !fromDate}>
                  Find free times
                </Button>
                {free.busy ? (
                  <p className="flex items-center gap-2">
                    <Spinner /> Checking Square for free times…
                  </p>
                ) : null}
                {free.error ? <Alert tone="danger">{free.error}</Alert> : null}
                {free.search?.status === 'failed' ? <Alert tone="danger">{free.search.error ?? 'Square didn’t answer. Try again.'}</Alert> : null}
                {free.search?.status === 'done' ? <SlotChoice slots={free.search.slots} chosen={slot ? slotKey(slot) : null} onChoose={setSlot} /> : null}
              </>
            )}
          </>
        ) : null}

        {phase === 'confirm' ? (
          <>
            <p className="text-base text-charcoal-900">{summary}</p>
            <p>{real}</p>
            <p className="text-charcoal-600">{status.tier1.notificationSentence}</p>
            {kind === 'create' ? <Textarea label="Note for the studio (not shown to the client)" value={note} maxLength={4096} rows={2} onChange={(e) => setNote(e.target.value)} /> : null}
            <p className="text-xs text-charcoal-500">Studio Assistant checks with Square that {kind === 'cancel' ? 'the booking hasn’t changed' : 'the time is still free'} just before sending.</p>
          </>
        ) : null}

        {phase === 'progress' && change ? (
          <div className="space-y-3" aria-live="polite">
            <p className="flex flex-wrap items-center gap-2">
              <StatusPill status={change.pill} label={change.statusLabel} />
              {!change.done ? <Spinner /> : null}
            </p>
            {change.done && change.statusMessage ? (
              <Alert tone={change.status === 'confirmed' ? (change.statusMessage.includes('overlaps') ? 'warning' : 'success') : change.status === 'unknown' || change.status === 'slot_unavailable' || change.status === 'changed_in_square' ? 'warning' : 'danger'}>
                {change.statusMessage}
              </Alert>
            ) : null}
            {change.squareDetail && !change.statusMessage.includes(change.squareDetail) ? <p className="text-xs text-charcoal-600">Square said: {change.squareDetail}</p> : null}
            {change.freshSlots?.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold text-charcoal-500">Free times Square has now</p>
                <ul className="flex flex-wrap gap-2">
                  {change.freshSlots.map((s) => (
                    <li key={slotKey(s)} className="rounded-full border border-charcoal-200 px-3 py-1.5 text-sm">
                      {s.dayLabel} {s.startLabel} · {s.teamMemberName}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
