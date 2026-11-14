'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { apiRequest } from '@/lib/client/api-client';
import type { AvailabilitySlotDto, ClientDto, SquareStatusDto } from '@/lib/shared/square-dto';
import { zoneAt } from './change-dialog';
import { ClientPicker } from './client-picker';
import { SlotChoice, slotKey } from './slot-choice';
import { melbourneToday, useFreeTimes } from './use-free-times';

/**
 * The booking-changes self-test (design §4.5.1): never automatic. The owner chooses a client (yourself is best), a
 * service confirmed free of no-show fees, a barber and a free time at least 2 days ahead, reads exactly what will
 * happen, and on live Square ticks that these are real bookings. Then Studio Assistant books, moves and cancels it.
 */
export function SelfTestDialog({ open, status, onClose, onStarted }: { open: boolean; status: SquareStatusDto; onClose: () => void; onStarted: () => void }) {
  const free = useFreeTimes();
  const bookable = status.services.filter((s) => s.label === 'bookable');
  const [client, setClient] = useState<ClientDto | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [teamMemberId, setTeamMemberId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [slot, setSlot] = useState<AvailabilitySlotDto | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resetFree = free.reset;
  useEffect(() => {
    if (!open) return;
    setClient(null);
    setServiceId(bookable[0]?.variationId ?? '');
    setTeamMemberId('');
    setFromDate(melbourneToday(2));
    setSlot(null);
    setAcknowledged(false);
    setError(null);
    resetFree();
    // Reset only when the dialog opens.
  }, [open]);

  const live = status.environment === 'production';
  const service = bookable.find((s) => s.variationId === serviceId);
  const barbers = status.teamMembers.filter((t) => service?.teamMemberIds.includes(t.id));
  const twoDays = Date.now() + 48 * 3600_000;
  const slots = (free.search?.slots ?? []).filter((s) => Date.parse(s.startAt) >= twoDays);
  const when = slot ? `${slot.dayLabel}, ${slot.startLabel} ${zoneAt(slot.startAt)}` : 'the chosen time';
  const what = live
    ? `This makes three real changes in your Square account: book ${client?.name ?? 'the client'} for ${service?.name ?? 'the service'} with ${slot?.teamMemberName ?? 'the barber'} on ${when}, move it by one free slot, then cancel it. Square may send that client its own confirmation and cancellation messages. Choose yourself as the client to avoid messaging a real customer.`
    : `This makes three changes in your Square sandbox (test) account: book ${client?.name ?? 'the test client'} for ${service?.name ?? 'the service'} on ${when}, move it by one free slot, then cancel it.`;

  const start = async () => {
    if (!client || !slot || !free.search) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/api/integrations/square/self-test', {
        method: 'POST',
        body: { customerId: client.id, serviceVariationId: serviceId, teamMemberId: slot.teamMemberId, startAt: slot.startAt, availabilitySearchId: free.search.id, acknowledgeLive: acknowledged },
      });
      onStarted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Run the self-test"
      description="Checks that Square accepts booking changes from Studio Assistant on your account."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button loading={busy} disabled={!client || !slot || (live && !acknowledged)} onClick={() => void start()}>
            Run self-test
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-charcoal-700">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <ClientPicker value={client} onChange={setClient} hint="Choose yourself, so no real client gets Square’s messages." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Service" value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSlot(null); free.reset(); }} options={bookable.map((s) => ({ value: s.variationId, label: s.name }))} />
          <Select label="Barber" value={teamMemberId} onChange={(e) => setTeamMemberId(e.target.value)} options={[{ value: '', label: 'Any barber' }, ...barbers.map((b) => ({ value: b.id, label: b.displayName }))]} />
          <Input label="From" type="date" min={melbourneToday(2)} value={fromDate} onChange={(e) => setFromDate(e.target.value)} hint="At least 2 days ahead." />
        </div>
        <Button variant="secondary" className="min-h-11" disabled={!serviceId || !fromDate} loading={free.busy} onClick={() => { setSlot(null); void free.find({ serviceVariationId: serviceId, teamMemberId: teamMemberId || null, fromDate, days: 3 }); }}>
          Find free times
        </Button>
        {free.busy ? (
          <p className="flex items-center gap-2">
            <Spinner /> Checking Square for free times…
          </p>
        ) : null}
        {free.error ? <Alert tone="danger">{free.error}</Alert> : null}
        {free.search?.status === 'failed' ? <Alert tone="danger">{free.search.error ?? 'Square didn’t answer. Try again.'}</Alert> : null}
        {free.search?.status === 'done' ? <SlotChoice slots={slots} chosen={slot ? slotKey(slot) : null} onChoose={setSlot} empty="No free times at least 2 days ahead in those days. Try a later date." /> : null}
        <p className="rounded-[var(--radius-control)] bg-charcoal-50 p-3 text-charcoal-800">{what}</p>
        {live ? (
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" className="mt-1 size-4" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>I understand these are real bookings in Square</span>
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}
