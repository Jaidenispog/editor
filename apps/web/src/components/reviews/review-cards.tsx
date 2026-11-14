'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDateTime } from '@studio/core';
import type { PlacesStateDto } from '@/components/email/types';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';

/**
 * Review link card (Tier 0, always available): the official link the owner pasted, its validity, and a test link
 * that opens in a new tab (the server never fetches it). The app never builds a Google review URL itself.
 */
export function ReviewLinkCard({ initialUrl, valid, googleUri, canEdit }: { initialUrl: string; valid: boolean; googleUri: string | null; canEdit: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  const [saved, setSaved] = useState(initialUrl);
  const [ok, setOk] = useState(valid);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader title="Review link" description="In Google Business Profile on a computer: Read reviews → Get more reviews → copy the link." actions={saved ? <StatusPill status={ok ? 'ready' : 'error'} label={ok ? 'Link saved' : 'Check the link'} /> : <StatusPill status="not_configured" label="Add your review link" />} />
      <CardBody className="space-y-3">
        <Input label="Your Google review link" value={url} maxLength={500} disabled={!canEdit} placeholder="https://g.page/r/…/review" onChange={(e) => setUrl(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {canEdit ? (
            <Button
              className="min-h-11"
              disabled={url === saved}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await apiRequest<{ url: string; valid: boolean }>('/api/reviews/link', { method: 'PUT', body: { url } });
                  setSaved(r.url);
                  setOk(r.valid);
                  toast.success('Review link saved');
                  router.refresh();
                } catch (e) {
                  toast.error('Not saved', (e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save link
            </Button>
          ) : null}
          {saved && ok ? (
            <a href={saved} target="_blank" rel="noopener noreferrer" className={buttonClasses('secondary', 'md', 'min-h-11')}>
              Test link
            </a>
          ) : null}
          {canEdit && googleUri && googleUri !== saved ? (
            <Button
              variant="ghost"
              className="min-h-11"
              onClick={async () => {
                try {
                  const r = await apiRequest<{ url: string }>('/api/reviews/link/use-google', { method: 'POST' });
                  setUrl(r.url);
                  setSaved(r.url);
                  setOk(true);
                  toast.success("Using Google's review link");
                } catch (e) {
                  toast.error('Not changed', (e as Error).message);
                }
              }}
            >
              Use Google&rsquo;s review link
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/** Rating card (Tier 1, Places API): only real numbers from Google, labelled with their source and time. */
export function GoogleRatingCard({ initial, canEdit }: { initial: PlacesStateDto; canEdit: boolean }) {
  const toast = useToast();
  const [s, setS] = useState(initial);
  const [placeId, setPlaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => setS(await apiRequest<PlacesStateDto>('/api/integrations/google-places'));
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await reload();
    } catch (e) {
      toast.error('Not done', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  let body;
  switch (s.state) {
    case 'not_configured':
      body = <p className="text-sm text-charcoal-600">Optional: add a Google Maps key to show your Google rating here.</p>;
      break;
    case 'no_place':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">
            Enter your Place ID. Find it with{' '}
            <a className="font-medium underline" href="https://developers.google.com/maps/documentation/places/web-service/place-id" target="_blank" rel="noopener noreferrer">
              Google&rsquo;s Place ID Finder
            </a>
            .
          </p>
          {canEdit ? (
            <div className="flex flex-wrap items-end gap-2">
              <Input label="Place ID" value={placeId} containerClassName="min-w-0 flex-1" onChange={(e) => setPlaceId(e.target.value.trim())} />
              <Button className="min-h-11" loading={busy} disabled={placeId.length < 10} onClick={() => run(() => apiRequest('/api/integrations/google-places', { method: 'PUT', body: { placeId } }), 'Looking it up')}>
                Look up
              </Button>
            </div>
          ) : null}
        </div>
      );
      break;
    case 'checking':
      body = (
        <div className="space-y-2">
          <p className="text-sm text-charcoal-600">Looking up your place with Google…</p>
          <Button variant="secondary" className="min-h-11" onClick={() => void reload()}>
            Check again
          </Button>
        </div>
      );
      break;
    case 'confirm':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-800">
            Is this your business? <strong>{s.candidate?.displayName ?? 'Unnamed place'}</strong>
            {s.candidate?.formattedAddress ? `, ${s.candidate.formattedAddress}` : ''}
          </p>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button className="min-h-11" loading={busy} onClick={() => run(() => apiRequest('/api/integrations/google-places/confirm', { method: 'POST', body: { confirm: true } }), 'Confirmed')}>
                Yes, that&rsquo;s us
              </Button>
              <Button variant="ghost" className="min-h-11" onClick={() => run(() => apiRequest('/api/integrations/google-places/confirm', { method: 'POST', body: { confirm: false } }), 'Removed')}>
                No
              </Button>
            </div>
          ) : null}
        </div>
      );
      break;
    case 'connected':
      body = (
        <div className="space-y-2">
          {s.rating !== null ? (
            <p className="text-2xl font-semibold text-charcoal-950">
              {s.rating.toFixed(1)} ★ <span className="text-base font-normal text-charcoal-600">· {s.userRatingCount ?? 0} reviews</span>
            </p>
          ) : (
            <p className="text-sm text-charcoal-600">Google shows no rating for this place yet.</p>
          )}
          <p className="text-xs text-charcoal-500">
            {s.attribution}
            {s.fetchedAt ? `, updated ${formatDateTime(s.fetchedAt)}` : ''}
          </p>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" className="min-h-11" loading={busy} onClick={() => run(() => apiRequest('/api/integrations/google-places/refresh', { method: 'POST' }), 'Refreshing (reload in a moment)')}>
                Refresh
              </Button>
              <Button variant="ghost" className="min-h-11" onClick={() => run(() => apiRequest('/api/integrations/google-places', { method: 'DELETE' }), 'Removed')}>
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      );
      break;
    default:
      body = (
        <div className="space-y-2">
          <Alert tone="danger">Google refused the request: {s.message ?? 'unknown reason'}</Alert>
          {canEdit ? (
            <Button variant="ghost" className="min-h-11" onClick={() => run(() => apiRequest('/api/integrations/google-places', { method: 'DELETE' }), 'Removed')}>
              Enter the Place ID again
            </Button>
          ) : null}
        </div>
      );
  }
  return (
    <Card>
      <CardHeader title="Google rating" description="Read once a day from Google Maps. Never typed in by hand." />
      <CardBody>{body}</CardBody>
    </Card>
  );
}
