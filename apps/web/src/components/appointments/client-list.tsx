'use client';

import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { apiRequest } from '@/lib/client/api-client';
import type { ClientDetailDto, ClientDto } from '@/lib/shared/square-dto';
import { BookingList } from './booking-list';

/** Clients copied from Square, searchable; email and phone only reach the owner (the server leaves them out for staff). */
export function ClientList({ onOpenBooking }: { onOpenBooking: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [clients, setClients] = useState<ClientDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClientDetailDto | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      apiRequest<{ clients: ClientDto[] }>(`/api/appointments/clients?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => {
          setClients(r.clients);
          setError(null);
        })
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    if (!openId) return;
    setDetail(null);
    apiRequest<ClientDetailDto>(`/api/appointments/clients/${encodeURIComponent(openId)}`)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [openId]);

  return (
    <div className="space-y-4">
      <Input label="Search clients" placeholder="Name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} type="search" />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {clients === null ? <Skeleton className="h-32" /> : null}
      {clients && !clients.length ? <EmptyState icon={<Users />} title={q ? 'No clients match' : 'No clients copied from Square yet'} description={q ? 'Try part of their first or last name.' : 'Clients appear after the first sync with Square.'} /> : null}
      {clients?.length ? (
        <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200 bg-white">
          {clients.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setOpenId(c.id)} className="flex min-h-11 w-full min-w-0 flex-col items-start px-4 py-3 text-left hover:bg-charcoal-50">
                <span className="text-sm font-medium text-charcoal-900">{c.name}</span>
                {c.email || c.phone ? <span className="w-full truncate text-xs text-charcoal-500">{[c.email, c.phone].filter(Boolean).join(' · ')}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog open={Boolean(openId)} onClose={() => setOpenId(null)} title={detail?.name ?? 'Client'} description={detail && (detail.email || detail.phone) ? [detail.email, detail.phone].filter(Boolean).join(' · ') : undefined}>
        {!detail ? (
          <Skeleton className="h-32" />
        ) : (
          <BookingList
            bookings={detail.bookings}
            emptyTitle="No bookings copied for this client"
            onOpen={(id) => {
              setOpenId(null);
              onOpenBooking(id);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
