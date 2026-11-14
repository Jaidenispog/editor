'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDate } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { cn } from '@/lib/shared/cn';
import { DailyChart } from './daily-chart';
import { QueryGroupTiles } from './query-group-tiles';
import { QueryGroupsEditor } from './query-groups-editor';
import { TopQueriesTable } from './top-queries-table';
import type { SearchPerformanceDto, WebsiteOverviewDto } from './types';

const RANGES: Array<{ id: SearchPerformanceDto['range']; label: string }> = [
  { id: '28d', label: 'Last 28 days' },
  { id: '3m', label: 'Last 3 months' },
  { id: '16m', label: 'Last 16 months' },
];

/**
 * "Google search performance" (design §4.5): every state from not configured to connected, real numbers only when
 * Google returned them, the source and "data up to" date, and the average-position footnote. No ranking promises.
 */
export function SearchPerformanceCard({
  initial,
  queryGroups,
  onChanged,
}: {
  initial: SearchPerformanceDto;
  queryGroups: WebsiteOverviewDto['queryGroups'];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [range, setRange] = useState<SearchPerformanceDto['range']>(initial.range);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async (r: SearchPerformanceDto['range']) => {
    try {
      setData(await apiRequest<SearchPerformanceDto>(`/api/website/search-performance?range=${r}`));
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
      onChanged();
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const connectHref = '/api/integrations/google/connect?product=search_console';
  let body: React.ReactNode = null;
  switch (data.state) {
    case 'not_configured':
      body = (
        <p className="text-sm text-charcoal-600">
          Optional: shows how many people found you on Google search. It needs a Google Cloud project (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server); the setup steps are
          in the deployment notes.
        </p>
      );
      break;
    case 'not_connected':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">Connect Google Search Console to see real search numbers. Your website must be verified in Search Console first.</p>
          <a href={connectHref} className={buttonClasses('primary', 'md', 'min-h-11')}>
            Connect Search Console
          </a>
        </div>
      );
      break;
    case 'needs_reauth':
      body = (
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">Google needs you to sign in again.</p>
          <p className="text-xs text-charcoal-500">If this happens every 7 days, the Google consent screen is still in Testing — publish it to Production.</p>
          <a href={connectHref} className={buttonClasses('primary', 'md', 'min-h-11')}>
            Reconnect
          </a>
        </div>
      );
      break;
    case 'error':
      body = (
        <div className="space-y-3">
          <Alert tone="danger">{data.message ?? "Search Console couldn't be read."}</Alert>
          <Button
            variant="secondary"
            className="min-h-11"
            loading={busy === 'check'}
            onClick={() =>
              void act(
                'check',
                () =>
                  apiRequest('/api/integrations/google-search-console/check', {
                    method: 'POST',
                    body: {},
                  }),
                'Checking (read-only)',
              )
            }
          >
            Check again
          </Button>
        </div>
      );
      break;
    case 'choose_property':
    case 'no_property':
      body = (
        <div className="space-y-3">
          {data.message ? <p className="text-sm text-charcoal-600">{data.message}</p> : null}
          {data.properties.length ? (
            <>
              <p className="text-sm text-charcoal-600">Google lists these websites for your account. Choose the one for the studio.</p>
              <ul className="space-y-2">
                {data.properties.map((p) => (
                  <li key={p.siteUrl} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-charcoal-200 px-3 py-2">
                    <span className={cn('text-sm [overflow-wrap:anywhere]', p.readable ? 'text-charcoal-900' : 'text-charcoal-400')}>
                      {p.siteUrl} · {p.permission}
                    </span>
                    {p.readable ? (
                      <Button
                        size="sm"
                        className="min-h-11"
                        loading={busy === p.siteUrl}
                        onClick={() =>
                          void act(
                            p.siteUrl,
                            () => apiRequest('/api/integrations/google-search-console/property', { method: 'PUT', body: { siteUrl: p.siteUrl } }),
                            'Property chosen; fetching data',
                          )
                        }
                      >
                        Use this one
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Button
            variant="secondary"
            className="min-h-11"
            loading={busy === 'check'}
            onClick={() =>
              void act(
                'check',
                () =>
                  apiRequest('/api/integrations/google-search-console/check', {
                    method: 'POST',
                    body: {},
                  }),
                'Checking (read-only)',
              )
            }
          >
            Check again
          </Button>
        </div>
      );
      break;
    case 'syncing':
      body = <p className="text-sm text-charcoal-600">Fetching up to 16 months of data from Google…</p>;
      break;
    case 'no_data':
      body = (
        <p className="text-sm text-charcoal-600">Connected. Google hasn&apos;t reported any searches for this site yet. New sites and newly verified sites can take a few days.</p>
      );
      break;
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
            Source: Google Search Console ({data.property}). Data up to {data.dataThrough ? formatDate(`${data.dataThrough}T12:00:00Z`) : '—'} (Google reports with a 2–3 day
            delay). Days are as Google counts them (US Pacific time).
          </p>
          <QueryGroupTiles data={data} />
          <DailyChart daily={data.daily} />
          {data.topQueries ? <TopQueriesTable topQueries={data.topQueries} /> : null}
          <p className="text-xs text-charcoal-500">
            Average position is where your site usually appeared in Google&apos;s results (1 is the top). It changes daily and is not a ranking we can promise or control.
          </p>
        </div>
      );
      break;
  }
  const connected = data.state === 'connected' || data.state === 'no_data' || data.state === 'syncing';
  return (
    <Card>
      <CardHeader
        title="Google search performance"
        description="Real numbers from Google Search Console, read-only. Studio Assistant can't change anything in Search Console."
        actions={
          connected && data.canRefresh ? (
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11"
              loading={busy === 'sync'}
              onClick={() =>
                void act(
                  'sync',
                  () =>
                    apiRequest('/api/website/search-performance/sync', {
                      method: 'POST',
                      body: { source: 'search_console' },
                    }),
                  'Refreshing from Google',
                )
              }
            >
              Refresh
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {body}
        {connected ? <QueryGroupsEditor initial={queryGroups} brandAmbiguous={data.brandAmbiguous} onSaved={() => void load(range)} /> : null}
      </CardBody>
    </Card>
  );
}
