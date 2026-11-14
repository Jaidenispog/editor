'use client';

import { ExternalLink, Lightbulb, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { YOUTUBE_CHART_FOOTER, formatTrendDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { TrendSourceDto, TrendWatchDto } from '@/lib/trend-watches';
import type { TrendItemDto } from '@/lib/trends';

/** How many chart rows are shown before "Show all". */
const FIRST_ROWS = 10;

/** The pill for a source card: the watch's own state when it is on, else the shared integration state. */
function sourcePill(source: TrendSourceDto): { status: string; label: string } {
  const watch = source.watch;
  if (!watch) return source.status.state === 'not_configured' ? { status: 'not_configured', label: 'Not set up' } : { status: 'not_connected', label: 'Off' };
  switch (watch.status) {
    case 'ok':
      return { status: 'connected', label: 'On · read-only' };
    case 'pending':
      return { status: 'checking', label: 'Fetching' };
    case 'quota':
      return { status: 'quota', label: 'Daily limit reached' };
    case 'unavailable':
      return { status: 'unavailable', label: 'Not available' };
    case 'needs_reauth':
      return { status: 'needs_reauth', label: 'Reconnect needed' };
    default:
      return { status: 'error', label: 'Not working' };
  }
}

/**
 * Settings → Trends → Live signals: one card per official source (this version: the YouTube AU popular chart; the
 * Instagram hashtag watch is added by WP5). Each card shows an explicit state, and every item shows when it was
 * fetched. Turning a source on, refreshing it and turning it off are owner actions; everything is read-only.
 */
export function LiveSignals({
  sources,
  live,
  isOwner,
  loading,
  onChanged,
  onUseAsIdea,
}: {
  sources: TrendSourceDto[];
  live: Array<{ watch: TrendWatchDto; items: TrendItemDto[] }>;
  isOwner: boolean;
  loading: boolean;
  onChanged: () => Promise<void> | void;
  onUseAsIdea: (item: TrendItemDto) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {sources.map((source) => (
        <SourceCard
          key={source.provider}
          source={source}
          items={live.find((l) => l.watch.id === source.watch?.id)?.items ?? []}
          isOwner={isOwner}
          onChanged={onChanged}
          onUseAsIdea={onUseAsIdea}
        />
      ))}
    </div>
  );
}

function SourceCard({
  source,
  items,
  isOwner,
  onChanged,
  onUseAsIdea,
}: {
  source: TrendSourceDto;
  items: TrendItemDto[];
  isOwner: boolean;
  onChanged: () => Promise<void> | void;
  onUseAsIdea: (item: TrendItemDto) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'add' | 'refresh' | 'remove' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const watch = source.watch;
  const pill = sourcePill(source);
  const nextRefresh = watch?.nextRefreshAt ? new Date(watch.nextRefreshAt) : null;

  const run = async (kind: 'add' | 'refresh' | 'remove', work: () => Promise<unknown>, done: string) => {
    setBusy(kind);
    try {
      await work();
      toast.success(done);
      await onChanged();
    } catch (err) {
      toast.error('That did not work', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const add = () => run('add', () => apiRequest('/api/trends/watches', { method: 'POST', body: { provider: source.provider } }), 'Chart turned on. The first fetch runs in the background.');
  const refresh = () => (watch ? run('refresh', () => apiRequest(`/api/trends/watches/${encodeURIComponent(watch.id)}/refresh`, { method: 'POST' }), 'Refresh started.') : undefined);
  const remove = () =>
    watch
      ? run(
          'remove',
          async () => {
            await apiRequest(`/api/trends/watches/${encodeURIComponent(watch.id)}`, { method: 'DELETE' });
            setConfirmOff(false);
          },
          'Chart turned off and its items deleted.',
        )
      : undefined;

  const fetchedItems = items.length ? items : [];
  const heading = fetchedItems[0]?.label ?? null;
  const shown = showAll ? fetchedItems : fetchedItems.slice(0, FIRST_ROWS);
  const anyStale = fetchedItems.some((i) => i.stale);

  return (
    <section aria-labelledby={`source-${source.provider}`} className="rounded-xl border border-charcoal-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`source-${source.provider}`} className="text-sm font-semibold text-charcoal-900">
            {source.status.name}
          </h3>
          <p className="mt-0.5 text-xs text-charcoal-500">Official YouTube Data API · music, movies and gaming only · no Shorts filter</p>
        </div>
        <StatusPill status={pill.status} label={pill.label} />
      </div>

      {!watch ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-charcoal-600">{source.status.message}</p>
          {source.status.missingEnv.length ? (
            <p className="text-xs text-charcoal-500">
              Server setting needed: <code className="rounded bg-charcoal-100 px-1.5 py-0.5">{source.status.missingEnv.join(', ')}</code>
            </p>
          ) : isOwner ? (
            <Button size="sm" onClick={add} loading={busy === 'add'}>
              Show the chart
            </Button>
          ) : (
            <p className="text-xs text-charcoal-500">The owner can turn this on.</p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {watch.status === 'pending' ? <Alert tone="info">Fetching the chart. This usually takes a few seconds; this page updates by itself.</Alert> : null}
          {watch.status === 'quota' ? <Alert tone="warning">{watch.statusMessage || 'YouTube’s daily limit was reached. It will try again tomorrow.'}</Alert> : null}
          {watch.status === 'error' || watch.status === 'unavailable' || watch.status === 'needs_reauth' ? (
            <Alert tone="warning" title="The last fetch did not work">
              {watch.statusMessage || 'Something went wrong while reading the chart.'}
              {watch.lastSuccessAt ? <span className="block text-xs">Last successful fetch: {formatTrendDateTime(watch.lastSuccessAt)}.</span> : null}
            </Alert>
          ) : null}

          {heading ? (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-medium text-charcoal-800">{heading}</h4>
                {anyStale ? <Badge tone="warning">Out of date</Badge> : null}
              </div>
              <ol className="mt-2 divide-y divide-charcoal-100 rounded-lg border border-charcoal-100">
                {shown.map((item) => (
                  <li key={item.id} className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
                    <div className="min-w-0 sm:flex-1">
                      <p className="text-sm text-charcoal-900 [overflow-wrap:anywhere]">
                        <span className="mr-1.5 text-xs text-charcoal-400">{item.position ?? ''}</span>
                        {item.title}
                      </p>
                      <p className="mt-0.5 text-xs text-charcoal-500 [overflow-wrap:anywhere]">
                        {item.channelTitle ? `${item.channelTitle} · ` : ''}
                        {item.categoryName ?? 'Other'}
                      </p>
                    </div>
                    <div className="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-charcoal-700 hover:bg-charcoal-100"
                      >
                        Watch on YouTube <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                      <Button variant="ghost" size="sm" onClick={() => onUseAsIdea(item)} aria-label={`Use “${item.title}” as an idea`}>
                        <Lightbulb className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
              {fetchedItems.length > FIRST_ROWS ? (
                <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${fetchedItems.length}`}
                </Button>
              ) : null}
              <p className="mt-2 text-xs text-charcoal-500">{YOUTUBE_CHART_FOOTER}</p>
            </div>
          ) : watch.status === 'ok' ? (
            <p className="text-sm text-charcoal-600">YouTube returned no videos for Australia on the last fetch.</p>
          ) : null}

          {isOwner ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={refresh} loading={busy === 'refresh'} disabled={Boolean(nextRefresh) || watch.status === 'pending'}>
                <RefreshCw className="size-4" aria-hidden="true" /> {watch.status === 'error' ? 'Try again' : 'Refresh now'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmOff(true)}>
                Turn off
              </Button>
              {nextRefresh ? <span className="text-xs text-charcoal-500">Next manual refresh from {formatTrendDateTime(nextRefresh)}. It also refreshes once a day.</span> : null}
            </div>
          ) : (
            <p className="text-xs text-charcoal-500">Refreshed once a day. Only the owner can change this source.</p>
          )}
        </div>
      )}

      <Dialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Turn off the YouTube chart?"
        description="Its fetched items are deleted now. You can turn it on again at any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={busy === 'remove'}>
              Turn off
            </Button>
          </>
        }
      />
    </section>
  );
}
