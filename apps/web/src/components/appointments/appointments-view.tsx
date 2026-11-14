'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { BookingDto, SquareStatusDto } from '@/lib/shared/square-dto';
import { AvailabilityFinder } from './availability-finder';
import { BookingDialog } from './booking-dialog';
import { BookingList } from './booking-list';
import { ClientList } from './client-list';
import { ServiceList } from './service-list';
import { SquareBanner } from './square-banner';

type View = 'upcoming' | 'confirm' | 'past';

const EMPTY: Record<View, { title: string; description: string }> = {
  upcoming: { title: 'No bookings in the next 31 days in Square.', description: 'New bookings appear here after the next sync.' },
  confirm: { title: 'Nothing to confirm', description: 'Finished bookings from the last 14 days without a matched payment or a mark show up here.' },
  past: { title: 'No past bookings in the last 90 days', description: 'Bookings appear here once they have started.' },
};

/** One booking list tab: loads from the local copy and keeps it fresh after a mark. */
function BookingsTab({ view, version, onOpen }: { view: View; version: number; onOpen: (id: string) => void }) {
  const [bookings, setBookings] = useState<BookingDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiRequest<{ bookings: BookingDto[] }>(`/api/appointments?view=${view}`)
      .then((r) => alive && (setBookings(r.bookings), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [view, version]);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!bookings)
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  const onMarked = (b: BookingDto) => setBookings((list) => (view === 'confirm' ? (list ?? []).filter((x) => x.id !== b.id) : (list ?? []).map((x) => (x.id === b.id ? b : x))));
  return <BookingList bookings={bookings} emptyTitle={EMPTY[view].title} emptyDescription={EMPTY[view].description} onOpen={onOpen} showAttendance={view !== 'upcoming'} onMarked={onMarked} />;
}

/**
 * The Appointments page once Square is connected (design §4.2): Upcoming · To confirm · Past · Clients · Services,
 * from Studio Assistant's copy of Square. Square stays the source of truth; nothing is invented.
 */
export function AppointmentsView({ initialStatus }: { initialStatus: SquareStatusDto }) {
  const toast = useToast();
  const [status, setStatus] = useState(initialStatus);
  const [tab, setTab] = useState('upcoming');
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStatus(await apiRequest<SquareStatusDto>('/api/integrations/square'));
    } catch {
      // Keep the last known state; the banner still shows when it was synced.
    }
  }, []);

  // While a sync runs, look again every few seconds, then refresh the lists once it is done.
  const syncing = status.sync?.status === 'queued' || status.sync?.status === 'running';
  useEffect(() => {
    if (!syncing) return;
    const t = setTimeout(() => {
      void reload().then(() => setVersion((v) => v + 1));
    }, 3000);
    return () => clearTimeout(t);
  }, [syncing, status, reload]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await apiRequest('/api/integrations/square/sync', { method: 'POST' });
      await reload();
    } catch (e) {
      toast.error('Could not refresh', (e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const firstSync = !status.lastSyncAt && syncing;
  return (
    <div className="space-y-6">
      <SquareBanner status={status} onRefresh={() => void refresh()} refreshing={refreshing} />
      {firstSync ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-charcoal-600">Fetching your bookings from Square…</p>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </CardBody>
        </Card>
      ) : (
        <Tabs
          label="Appointments"
          value={tab}
          onValueChange={setTab}
          items={[
            { id: 'upcoming', label: 'Upcoming', content: <BookingsTab view="upcoming" version={version} onOpen={setOpenId} /> },
            { id: 'confirm', label: 'To confirm', content: <BookingsTab view="confirm" version={version} onOpen={setOpenId} /> },
            { id: 'past', label: 'Past', content: <BookingsTab view="past" version={version} onOpen={setOpenId} /> },
            { id: 'clients', label: 'Clients', content: <ClientList onOpenBooking={setOpenId} /> },
            {
              id: 'services',
              label: 'Services',
              content: (
                <div className="space-y-8">
                  <ServiceList services={status.services} canManage={status.canManage} onChanged={setStatus} />
                  <section aria-labelledby="free-times" className="space-y-3">
                    <h3 id="free-times" className="text-base font-semibold text-charcoal-900">
                      Free times
                    </h3>
                    <AvailabilityFinder services={status.services} teamMembers={status.teamMembers} />
                  </section>
                </div>
              ),
            },
          ]}
        />
      )}
      <BookingDialog bookingId={openId} onClose={() => setOpenId(null)} onMarked={() => setVersion((v) => v + 1)} />
    </div>
  );
}
