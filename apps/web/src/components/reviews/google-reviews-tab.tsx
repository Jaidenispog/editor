'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BUSINESS_PROFILE_AWAITING_APPROVAL_MESSAGE, formatDate, formatDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { GoogleReviewsDto } from '@/lib/shared/business-profile-dto';

const CONNECT_HREF = '/api/integrations/google/connect?product=business_profile';
/** While a check runs the tab asks again every 5 seconds, for at most 5 minutes (then Check again is the way on). */
const POLL_MS = 5000;
const POLL_MAX = 60;

/** The pill for each tab state (shared status words; Google's own review states are shown separately, as Google's). */
function pillFor(state: GoogleReviewsDto['state']): { status: string; label: string } {
  switch (state) {
    case 'connected':
      return { status: 'connected', label: 'Connected' };
    case 'awaiting_approval':
      return { status: 'awaiting_approval', label: 'Waiting for Google' };
    case 'choose_location':
      return { status: 'manual_step_required', label: 'Choose location' };
    case 'checking':
      return { status: 'processing', label: 'Checking' };
    case 'not_checked':
      return { status: 'manual_step_required', label: 'Not checked yet' };
    case 'needs_reauth':
      return { status: 'needs_reauth', label: 'Reconnect' };
    case 'error':
      return { status: 'error', label: 'Problem' };
    case 'not_connected':
      return { status: 'not_connected', label: 'Not connected' };
    default:
      return { status: 'not_configured', label: 'Not set up' };
  }
}

function Stars({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-xs text-charcoal-500">No star rating from Google</span>;
  return (
    <span className="text-sm text-charcoal-900" aria-label={`${rating} out of 5 stars`}>
      <span aria-hidden="true">{'★'.repeat(rating)}</span>
      <span aria-hidden="true" className="text-charcoal-300">
        {'★'.repeat(5 - rating)}
      </span>
    </span>
  );
}

/**
 * "Reviews on Google" (email design §4.8, Tier 2): the Business Profile reviews Google returned, with Google's reply
 * state and policy flag, and every honest state before that (not set up, connect, choose location, waiting for
 * Google's approval, reconnect, problem). Reviews are never typed in, edited or replied to here, and are never matched
 * to review requests. Staff see the connection state only.
 */
export function GoogleReviewsTab({ initial, fallback, canEdit }: { initial: GoogleReviewsDto | null; fallback: { state: string; label: string; message: string }; canEdit: boolean }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ profile: GoogleReviewsDto }>('/api/reviews/google');
      setData(res.profile);
    } catch {
      // Keep what is shown; the next action tries again.
    }
  }, []);
  const polls = useRef(0);
  useEffect(() => {
    if (data?.state !== 'checking') {
      polls.current = 0;
      return;
    }
    const t = setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_MAX) {
        clearInterval(t);
        return;
      }
      void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [data?.state, load]);
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done, 'This reads Google only; nothing on Google changes.');
      await load();
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!canEdit || !data) {
    return (
      <Card>
        <CardHeader title="Reviews on Google" actions={<StatusPill status={fallback.state} label={fallback.label} />} />
        <CardBody className="space-y-2 text-sm text-charcoal-700">
          <p>{fallback.message}</p>
          <p>Only the studio owner can see the Google reviews list here. Reviews are never typed in by hand.</p>
        </CardBody>
      </Card>
    );
  }
  const pill = pillFor(data.state);
  const checkAgain = (
    <Button
      variant="secondary"
      className="min-h-11"
      loading={busy === 'check'}
      onClick={() => void act('check', () => apiRequest('/api/integrations/google-business-profile/check', { method: 'POST', body: {} }), 'Checking with Google')}
    >
      {data.state === 'error' ? 'Try again' : 'Check again'}
    </Button>
  );
  let body: React.ReactNode;
  switch (data.state) {
    case 'not_configured':
      body = <p>Optional: needs a Google Cloud project and Google&apos;s approval. Review requests work without it.</p>;
      break;
    case 'not_connected':
      body = (
        <div className="space-y-3">
          <p>Connect your Business Profile to list your Google reviews here. Google has to approve API access first, which usually takes about 14 days and isn&apos;t guaranteed.</p>
          <a href={CONNECT_HREF} className={buttonClasses('primary', 'md', 'min-h-11')}>
            Connect Google Business Profile
          </a>
        </div>
      );
      break;
    case 'checking':
      body = (
        <div className="space-y-3">
          <p>Signed in. Checking your Business Profile with Google (read-only)…</p>
          {checkAgain}
        </div>
      );
      break;
    case 'not_checked':
      body = (
        <div className="space-y-3">
          <p>Signed in. Google hasn&apos;t been asked about your Business Profile yet, or the first check didn&apos;t finish. Press Check again to ask Google now (read-only).</p>
          {checkAgain}
        </div>
      );
      break;
    case 'awaiting_approval':
      body = (
        <div className="space-y-3">
          <p>{BUSINESS_PROFILE_AWAITING_APPROVAL_MESSAGE}</p>
          {checkAgain}
        </div>
      );
      break;
    case 'choose_location':
      body = (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('location', () => apiRequest('/api/integrations/google-business-profile/location', { method: 'PUT', body: { locationName: choice } }), 'Location chosen; reading reviews');
          }}
        >
          {data.message ? <p>{data.message}</p> : null}
          <fieldset className="space-y-2">
            <legend className="mb-1 font-medium text-charcoal-900">Which location is the studio?</legend>
            {data.locations.map((l) => (
              <label key={l.name} className="flex min-h-11 items-start gap-3 rounded-lg border border-charcoal-200 px-3 py-2">
                <input type="radio" name="gbp-location" className="mt-1 size-5" value={l.name} checked={choice === l.name} onChange={() => setChoice(l.name)} />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block text-charcoal-900">{l.title || 'Untitled location'}</span>
                  {l.address ? <span className="block text-xs text-charcoal-500">{l.address}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" className="min-h-11" disabled={!choice} loading={busy === 'location'}>
            Use this location
          </Button>
        </form>
      );
      break;
    case 'needs_reauth':
      body = (
        <div className="space-y-3">
          <p>{data.message ?? 'Google needs you to sign in again.'}</p>
          <p className="text-xs text-charcoal-500">If this happens every 7 days, the Google consent screen is still in Testing — publish it to Production.</p>
          <a href={CONNECT_HREF} className={buttonClasses('primary', 'md', 'min-h-11')}>
            Reconnect
          </a>
        </div>
      );
      break;
    case 'error':
      body = (
        <div className="space-y-3">
          <Alert tone="danger">{data.message ?? "Google couldn't be read."}</Alert>
          {checkAgain}
        </div>
      );
      break;
    default:
      body = (
        <div className="space-y-4">
          <p className="text-xs text-charcoal-500">
            From Google Business Profile{data.location?.title ? ` (${data.location.title})` : ''}
            {data.syncedAt ? `. Synced ${formatDateTime(data.syncedAt)}` : ''}
            {data.totalReviewCount !== null ? `. Google lists ${data.totalReviewCount} review${data.totalReviewCount === 1 ? '' : 's'}` : ''}
            {data.averageRating !== null ? `, average ${data.averageRating.toFixed(1)} ★` : ''}.
          </p>
          {data.limited ? <p className="text-xs text-charcoal-500">Showing the newest {data.reviews.length} reviews stored from Google.</p> : null}
          {data.reviews.length === 0 ? (
            <EmptyState title="No Google reviews yet" description="Reviews appear here after Google lists them." />
          ) : (
            <ul className="space-y-3">
              {data.reviews.map((r) => (
                <li key={r.id} className="min-w-0 rounded-lg border border-charcoal-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Stars rating={r.rating} />
                    <span className="text-xs text-charcoal-500">{r.createdAt ? formatDate(r.createdAt) : r.updatedAt ? formatDate(r.updatedAt) : ''}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-charcoal-900 [overflow-wrap:anywhere]">{r.reviewerName}</p>
                  {r.comment ? <p className="mt-1 whitespace-pre-line text-sm text-charcoal-700 [overflow-wrap:anywhere]">{r.comment}</p> : null}
                  {r.replyText ? (
                    <div className="mt-2 rounded-md bg-charcoal-50 p-2 text-sm text-charcoal-700">
                      <p className="text-xs font-medium text-charcoal-500">Your reply on Google</p>
                      <p className="whitespace-pre-line [overflow-wrap:anywhere]">{r.replyText}</p>
                    </div>
                  ) : null}
                  {r.replyState || r.policyFlag ? (
                    <p className="mt-2 text-xs text-charcoal-500">
                      {r.replyState ? `Reply status from Google: ${r.replyState}.` : ''}
                      {r.replyState && r.policyFlag ? ' ' : ''}
                      {r.policyFlag ? `Google flagged this review: ${r.policyFlag}.` : ''}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-charcoal-500">
            Google&apos;s API can occasionally miss reviews; check Google Maps for the full list. Requests are tracked separately from reviews: Google doesn&apos;t tell us who
            left a review, so we never match the two.
          </p>
        </div>
      );
  }
  return (
    <Card>
      <CardHeader
        title="Reviews on Google"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {data.state === 'connected' && data.canRefresh ? (
              <Button variant="secondary" size="sm" className="min-h-11" loading={busy === 'refresh'} onClick={() => void act('refresh', () => apiRequest('/api/reviews/google/refresh', { method: 'POST', body: {} }), 'Reading reviews from Google')}>
                Refresh
              </Button>
            ) : null}
            <StatusPill status={pill.status} label={pill.label} />
          </div>
        }
      />
      <CardBody className="space-y-2 text-sm text-charcoal-700">
        {body}
        <p className="text-xs text-charcoal-500">Read-only: Studio Assistant can&apos;t change, reply to or remove anything on Google. Reviews are never typed in by hand.</p>
      </CardBody>
    </Card>
  );
}
