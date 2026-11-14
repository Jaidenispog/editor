'use client';

import { RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import type { SquareStatusDto } from '@/lib/shared/square-dto';

/** The sandbox warning every Square-backed view shows (design §9.3). */
export function SandboxBanner({ status }: { status: Pick<SquareStatusDto, 'dataEnvironment'> }) {
  if (status.dataEnvironment !== 'sandbox') return null;
  return <Alert tone="warning">Sandbox — these are Square test bookings and test clients, not real ones.</Alert>;
}

/**
 * Header strip of the Appointments page: environment, last sync, Refresh (owner), the booking-changes summary, and
 * the stale, reconnect and error notices. Data stays visible when it may be out of date; nothing is hidden or invented.
 */
export function SquareBanner({ status, onRefresh, refreshing }: { status: SquareStatusDto; onRefresh: () => void; refreshing: boolean }) {
  const syncing = status.sync && (status.sync.status === 'queued' || status.sync.status === 'running');
  return (
    <div className="space-y-3">
      <SandboxBanner status={status} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-charcoal-600">
        {status.dataEnvironment ? <StatusPill status={status.dataEnvironment === 'production' ? 'live' : 'sandbox'} label={status.dataEnvironment === 'production' ? 'Live Square' : 'Sandbox (test)'} /> : null}
        <span>{syncing ? (status.sync?.message || 'Fetching your bookings from Square…') : status.lastSyncLabel ? `Synced ${status.lastSyncLabel}` : 'Not synced yet'}</span>
        {status.merchantName ? <span className="min-w-0 truncate">· {status.merchantName}</span> : null}
        {status.canManage ? (
          <Button variant="secondary" size="sm" className="ml-auto min-h-11 sm:min-h-8" onClick={onRefresh} loading={refreshing || Boolean(syncing)} disabled={status.state !== 'connected' && status.state !== 'error'}>
            <RefreshCw className="size-4" aria-hidden="true" /> Refresh
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-charcoal-500">Changes from here: {status.tier1.summary}</p>
      {status.timezoneWarning ? <Alert tone="info">{status.timezoneWarning}</Alert> : null}
      {status.state === 'needs_reauth' || status.state === 'error' ? (
        <Alert tone={status.state === 'error' ? 'danger' : 'warning'} title="May be out of date">
          {status.message}
        </Alert>
      ) : status.stale && status.lastSyncAt ? (
        <Alert tone="warning">Bookings may be out of date — last synced {status.lastSyncLabel}.</Alert>
      ) : null}
    </div>
  );
}
