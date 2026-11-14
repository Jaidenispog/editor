'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { SquareStatusDto } from '@/lib/shared/square-dto';
import { Tier1Checklist } from './tier1-checklist';

type Notice = { tone: 'success' | 'info' | 'danger'; text: string };

/** Reads the outcome the Square callback put in the address, then removes it. */
function useSquareNotice(): Notice | null {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('square_error');
    const state = url.searchParams.get('square');
    if (!error && !state) return;
    setNotice(error ? { tone: 'danger', text: error.slice(0, 300) } : state === 'checking' ? { tone: 'info', text: 'Square is connected. Fetching your bookings, customers and services from Square…' } : { tone: 'success', text: 'Square is connected.' });
    url.searchParams.delete('square_error');
    url.searchParams.delete('square');
    window.history.replaceState(null, '', url.toString());
  }, []);
  return notice;
}

const WEBHOOK_WORDS: Record<SquareStatusDto['webhooks'], string> = {
  off: 'Webhooks not set up — bookings refresh every 10 minutes.',
  waiting: 'Webhooks are set up; no update has arrived from Square yet.',
  ok: 'Updates arrive instantly.',
  quiet: 'No webhook received for 3 days — check the subscription in Square.',
};

/**
 * Settings → Integrations → Square (design §4.1, §9.2): the connection states, connect and reconnect, the location
 * picker, the webhook line, Sync now, the booking-changes checklist with the self-test and switch (read-only while
 * booking changes are not available in this version),
 * disconnect with an optional purge, and the technical details for the owner. Staff see the state only.
 */
export function SquareIntegrationCard() {
  const toast = useToast();
  const notice = useSquareNotice();
  const [s, setS] = useState<SquareStatusDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [purge, setPurge] = useState(true);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    try {
      setS(await apiRequest<SquareStatusDto>('/api/integrations/square'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const syncing = s?.sync?.status === 'queued' || s?.sync?.status === 'running';
  useEffect(() => {
    if (!syncing) return;
    const t = setTimeout(() => void load(), 3000);
    return () => clearTimeout(t);
  }, [syncing, s, load]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load();
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const connectLink = (label: string) => (
    <a href="/api/integrations/square/connect?access=read" className={buttonClasses('primary', 'md', 'min-h-11')}>
      {label}
    </a>
  );

  return (
    <Card>
      <CardHeader
        title="Square Appointments"
        description="Studio Assistant reads your bookings, clients and services from Square. It never sends messages; Square keeps sending its own confirmations and reminders."
        actions={s ? <StatusPill status={s.state} /> : null}
      />
      <CardBody className="space-y-4 text-sm text-charcoal-700 [overflow-wrap:anywhere]">
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
        {failed ? <Alert tone="danger">The Square status could not be loaded. Reload the page to try again.</Alert> : null}
        {s ? (
          <>
            {s.liveMode ? (
              <p className="flex flex-wrap items-center gap-2">
                <StatusPill status={s.liveMode === 'live' ? 'live' : 'sandbox'} label={s.liveMode === 'live' ? 'Live' : 'Sandbox (test)'} />
                <span className="text-xs text-charcoal-500">{s.liveMode === 'live' ? 'Your real Square account.' : 'Square’s test environment: test bookings and test clients only.'}</span>
              </p>
            ) : null}

            {s.state === 'not_configured' ? (
              <p>
                Needs these server settings from your Square developer dashboard: <span className="font-mono text-xs">{s.missingEnv.join(', ')}</span>. Start with the sandbox (test) keys. No bookings are shown until then.
              </p>
            ) : null}

            {s.revoke ? (
              <Alert tone={s.revoke.state === 'failed' ? 'warning' : s.revoke.state === 'revoked' ? 'success' : 'info'} title={s.revoke.state === 'failed' ? 'Remove Studio Assistant in Square' : undefined}>
                {s.revoke.message}
              </Alert>
            ) : null}

            {s.state === 'not_connected' ? (s.canManage ? <div className="flex flex-wrap items-center gap-3">{connectLink('Connect Square')}<span className="text-xs text-charcoal-500">Read-only permissions: bookings, clients, services, payments and business settings.</span></div> : <p>Ask the owner to connect Square.</p>) : null}

            {s.state === 'needs_reauth' || s.state === 'error' ? (
              <Alert tone={s.state === 'error' ? 'danger' : 'warning'}>
                <p>{s.message}</p>
                {s.canManage ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.state === 'needs_reauth' ? connectLink('Reconnect Square') : <Button size="sm" className="min-h-11 sm:min-h-8" loading={busy === 'sync'} onClick={() => void act('sync', () => apiRequest('/api/integrations/square/sync', { method: 'POST' }), 'Trying again')}>Try again</Button>}
                  </div>
                ) : null}
              </Alert>
            ) : null}

            {s.dataEnvironment && s.state !== 'not_connected' ? (
              <>
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                  {s.merchantName ? (
                    <>
                      <dt className="text-charcoal-500">Business</dt>
                      <dd>{s.merchantName}</dd>
                    </>
                  ) : null}
                  <dt className="text-charcoal-500">Last synced</dt>
                  <dd>{syncing ? (s.sync?.message || 'Fetching your bookings, customers and services from Square…') : (s.lastSyncLabel ?? 'Not yet')}</dd>
                  <dt className="text-charcoal-500">Updates</dt>
                  <dd>{WEBHOOK_WORDS[s.webhooks]}</dd>
                  {s.bookingSiteUrl ? (
                    <>
                      <dt className="text-charcoal-500">Online booking</dt>
                      <dd>
                        <a className="underline" href={s.bookingSiteUrl} target="_blank" rel="noopener noreferrer">
                          Your Square online booking page
                        </a>
                      </dd>
                    </>
                  ) : null}
                </dl>
                {s.timezoneWarning ? <Alert tone="info">{s.timezoneWarning}</Alert> : null}

                {s.locations.length > 1 ? (
                  <div className="max-w-sm">
                    <Select
                      label={s.needsLocation ? 'Choose your studio’s Square location' : 'Square location'}
                      value={s.locationId ?? ''}
                      disabled={!s.canManage || busy === 'location'}
                      onChange={(e) => void act('location', () => apiRequest('/api/integrations/square', { method: 'PATCH', body: { locationId: e.target.value } }), 'Location saved')}
                      options={[...(s.locationId ? [] : [{ value: '', label: 'Choose a location', disabled: true }]), ...s.locations.map((l) => ({ value: l.id, label: l.name }))]}
                    />
                    <p className="mt-1 text-xs text-charcoal-500">
                      {s.needsLocation
                        ? 'No bookings are copied until you choose. Only your studio’s location is shown.'
                        : 'Only bookings at this location are copied and shown. Changing it removes the other location’s copied bookings.'}
                    </p>
                  </div>
                ) : null}

                <Tier1Checklist status={s} onChanged={setS} reload={load} />

                {s.canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" className="min-h-11" loading={busy === 'sync' || syncing} disabled={s.state !== 'connected'} onClick={() => void act('sync', () => apiRequest('/api/integrations/square/sync', { method: 'POST' }), 'Syncing with Square')}>
                      Sync now
                    </Button>
                    <Button variant="ghost" className="min-h-11" onClick={() => { setTyped(''); setPurge(true); setDisconnectOpen(true); }}>
                      Disconnect
                    </Button>
                  </div>
                ) : null}

                {s.details ? (
                  <details className="text-xs text-charcoal-600">
                    <summary className="cursor-pointer py-2 text-charcoal-700">Technical details</summary>
                    <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
                      <dt>Square merchant id</dt>
                      <dd className="font-mono">{s.details.merchantId ?? '—'}</dd>
                      <dt>Access expires</dt>
                      <dd>{s.details.tokenExpiresLabel ?? '—'} (renewed automatically)</dd>
                      <dt>Permissions (scopes)</dt>
                      <dd className="font-mono break-all">{s.details.scopes.length ? s.details.scopes.join(' ') : 'Not checked yet'}</dd>
                    </dl>
                  </details>
                ) : null}
              </>
            ) : null}
          </>
        ) : !failed ? (
          <p className="text-charcoal-500">Loading…</p>
        ) : null}
      </CardBody>
      <Dialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title="Disconnect Square?"
        description="Studio Assistant can no longer read or change your Square bookings. Your bookings in Square are not affected."
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setDisconnectOpen(false)}>
              Keep connected
            </Button>
            <Button
              variant="danger"
              disabled={typed.trim().toLowerCase() !== 'disconnect'}
              loading={busy === 'disconnect'}
              onClick={() =>
                void act('disconnect', () => apiRequest('/api/integrations/square', { method: 'DELETE', body: { purgeData: purge } }), 'Square disconnected').then(() => setDisconnectOpen(false))
              }
            >
              Disconnect
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" className="mt-1 size-4" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            <span>Also remove synced bookings and client details from Studio Assistant</span>
          </label>
          <Input label="Type “disconnect” to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
      </Dialog>
    </Card>
  );
}
