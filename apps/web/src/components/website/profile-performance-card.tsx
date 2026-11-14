'use client';

import { useCallback, useEffect, useState } from 'react';
import { PERFORMANCE_TILES, QUERY_GROUPS, formatDate, formatDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { keywordCount, profileNumber, type ProfilePerformanceDto } from '@/lib/shared/business-profile-dto';
import { cn } from '@/lib/shared/cn';
import { GROUP_LABELS } from './query-group-tiles';

const RANGES: Array<{ id: ProfilePerformanceDto['range']; label: string }> = [
  { id: '28d', label: 'Last 28 days' },
  { id: '3m', label: 'Last 3 months' },
  { id: '12m', label: 'Last 12 months' },
];

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
}

/**
 * "Google Business Profile performance" (website design §4.6): calls, direction requests, website clicks, bookings,
 * message clicks and views from Google Search and Google Maps, only as Google returned them, with the source and the
 * "data up to" date; search keywords for the last complete month. Every state is honest: not connected, waiting for
 * Google's approval, API not turned on, reconnect needed. Read-only: nothing on Google changes.
 */
export function ProfilePerformanceCard({ initial }: { initial: ProfilePerformanceDto }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [range, setRange] = useState<ProfilePerformanceDto['range']>(initial.range);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async (r: ProfilePerformanceDto['range']) => {
    try {
      setData(await apiRequest<ProfilePerformanceDto>(`/api/website/business-profile-performance?range=${r}`));
    } catch {
      // Keep what is shown; the next refresh tries again.
    }
  }, []);
  useEffect(() => {
    if (data.state !== 'syncing') return;
    const t = setInterval(() => void load(range), 5000);
    return () => clearInterval(t);
  }, [data.state, range, load]);
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load(range);
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const checkAgain = (
    <Button
      variant="secondary"
      className="min-h-11"
      loading={busy === 'check'}
      onClick={() => void act('check', () => apiRequest('/api/integrations/google-business-profile/check', { method: 'POST', body: {} }), 'Checking (read-only)')}
    >
      Check again
    </Button>
  );
  let body: React.ReactNode = null;
  switch (data.state) {
    case 'not_configured':
      body = (
        <p className="text-sm text-charcoal-600">
          Optional: calls, direction requests and website clicks from your Google listing. It needs a Google Cloud project (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the
          server) and Google&apos;s approval, which isn&apos;t guaranteed for a single shop.
        </p>
      );
      break;
    case 'not_connected':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">
            Calls, direction requests and website clicks from your Google listing can appear here once your Business Profile is connected (Reviews → Reviews on Google). It needs
            Google&apos;s approval, which isn&apos;t guaranteed for a single shop.
          </p>
          <a href="/reviews?tab=google" className={buttonClasses('secondary', 'md', 'min-h-11')}>
            Go to Reviews
          </a>
        </div>
      );
      break;
    case 'choose_location':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">Choose which Business Profile location is the studio first (Reviews → Reviews on Google).</p>
          <a href="/reviews?tab=google" className={buttonClasses('secondary', 'md', 'min-h-11')}>
            Go to Reviews
          </a>
        </div>
      );
      break;
    case 'awaiting_approval':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">
            Google hasn&apos;t approved API access for this project yet. It usually takes about 14 days and isn&apos;t guaranteed. You can see these numbers in your Business
            Profile on Google meanwhile.
          </p>
          {checkAgain}
        </div>
      );
      break;
    case 'api_disabled':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">Turn on the Business Profile Performance API in your Google Cloud project, then press Check again.</p>
          {checkAgain}
        </div>
      );
      break;
    case 'not_checked':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">Checking whether Google lets this project read your Business Profile numbers (read-only)…</p>
          {checkAgain}
        </div>
      );
      break;
    case 'needs_reauth':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">{data.message ?? 'Google needs you to sign in again.'}</p>
          <p className="text-xs text-charcoal-500">If this happens every 7 days, the Google consent screen is still in Testing — publish it to Production.</p>
          <a href="/api/integrations/google/connect?product=business_profile" className={buttonClasses('primary', 'md', 'min-h-11')}>
            Reconnect
          </a>
        </div>
      );
      break;
    case 'error':
      body = (
        <div className="space-y-3">
          <Alert tone="danger">{data.message ?? "Your Business Profile numbers couldn't be read."}</Alert>
          {checkAgain}
        </div>
      );
      break;
    case 'syncing':
      body = <p className="text-sm text-charcoal-600">Fetching your Business Profile numbers from Google…</p>;
      break;
    case 'no_data':
      body = <p className="text-sm text-charcoal-600">Connected. Google hasn&apos;t reported any numbers for this listing yet.</p>;
      break;
    case 'available':
    case 'connected':
      body = (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={range === r.id}
                onClick={() => {
                  setRange(r.id);
                  void load(r.id);
                }}
                className={cn(
                  'min-h-11 rounded-full border px-3 text-sm',
                  range === r.id ? 'border-charcoal-900 bg-charcoal-900 text-white' : 'border-charcoal-200 bg-white text-charcoal-700',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-charcoal-500">
            Source: Google Business Profile{data.location?.title ? ` (${data.location.title})` : ''}. Data up to {data.dataThrough ? formatDate(`${data.dataThrough}T12:00:00Z`) : '—'}.
            Google reports daily numbers only, a few days late. &ldquo;—&rdquo; means Google sent no number.
          </p>
          {data.totals ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2">
              {PERFORMANCE_TILES.map((tile) => {
                const parts = tile.id === 'search_views' ? data.viewParts?.search : tile.id === 'maps_views' ? data.viewParts?.maps : null;
                const title = parts ? `Mobile ${profileNumber(parts.mobile)} · Desktop ${profileNumber(parts.desktop)}` : undefined;
                return (
                  <div key={tile.id} className="min-w-0 rounded-lg border border-charcoal-200 p-3" title={title}>
                    <dt className="text-xs text-charcoal-500">{tile.label}</dt>
                    <dd className="text-lg font-semibold text-charcoal-900">{profileNumber(data.totals?.[tile.id])}</dd>
                    {parts ? <dd className="text-xs text-charcoal-500">{title}</dd> : null}
                  </div>
                );
              })}
            </dl>
          ) : null}
          {data.keywords ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-charcoal-900">What people searched before finding your listing ({monthLabel(data.keywords.month)})</h3>
              {QUERY_GROUPS.every((g) => !data.keywords?.groups[g].length) ? (
                <p className="text-sm text-charcoal-600">Google listed no searches for this month.</p>
              ) : (
                QUERY_GROUPS.filter((g) => data.keywords?.groups[g].length).map((g) => (
                  <div key={g} className="min-w-0">
                    <p className="text-xs font-medium text-charcoal-700">{GROUP_LABELS[g].title}</p>
                    <table className="w-full table-fixed text-sm">
                      <caption className="sr-only">{GROUP_LABELS[g].title}</caption>
                      <tbody>
                        {data.keywords?.groups[g].map((k) => (
                          <tr key={k.keyword} className="border-b border-charcoal-100">
                            <td className="py-1 pr-2 text-charcoal-800 [overflow-wrap:anywhere]">{k.keyword}</td>
                            <td className="w-20 py-1 text-right text-charcoal-900">{keywordCount(k)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))
              )}
              <p className="text-xs text-charcoal-500">&ldquo;&lt; 15&rdquo; means Google only says it was fewer than 15.</p>
            </div>
          ) : null}
          {data.syncedAt ? <p className="text-xs text-charcoal-500">Synced {formatDateTime(data.syncedAt)}.</p> : null}
        </div>
      );
      break;
  }
  const refreshable = (data.state === 'connected' || data.state === 'no_data') && data.canRefresh;
  return (
    <Card>
      <CardHeader
        title="Google Business Profile performance"
        description="Real numbers from your Google listing, read-only. Studio Assistant can't change anything on Google."
        actions={
          refreshable ? (
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11"
              loading={busy === 'sync'}
              onClick={() => void act('sync', () => apiRequest('/api/website/business-profile-performance', { method: 'POST', body: {} }), 'Refreshing from Google')}
            >
              Refresh
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-4">{body}</CardBody>
    </Card>
  );
}
