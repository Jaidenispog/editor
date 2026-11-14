'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatTrendDateTime } from '@studio/core';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { apiRequest } from '@/lib/client/api-client';
import type { TrendsOverview } from '@/lib/trend-watches';
import type { IntegrationCardsProps } from './types';

/**
 * Settings → Integrations card for the trends module: the live state of each official trend source (the list above
 * shows only what the server settings allow). Read-only sources; turning them on happens in Settings → Trends.
 * WP5 adds the Instagram hashtag watch.
 */
export function TrendsIntegrationCards({ integrations }: IntegrationCardsProps) {
  const youtube = integrations.find((i) => i.id === 'youtube_chart');
  const [sources, setSources] = useState<TrendsOverview['sources'] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!youtube?.configured) return;
    let live = true;
    apiRequest<TrendsOverview>('/api/trends')
      .then((o) => live && setSources(o.sources))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [youtube?.configured]);

  if (!youtube?.configured) return null;
  const source = sources?.find((s) => s.provider === 'youtube_chart') ?? null;
  return (
    <Card>
      <CardHeader title="Trend sources" description="Official, read-only sources shown in Settings → Trends → Live signals. Nothing is posted or changed." />
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-charcoal-900">YouTube AU popular chart</p>
            <p className="mt-1 text-sm text-charcoal-600">
              {failed ? 'Its current state could not be loaded.' : !sources ? 'Loading…' : source?.status.message}
              {source?.watch?.lastSuccessAt ? ` Last fetched ${formatTrendDateTime(source.watch.lastSuccessAt)}.` : ''}
            </p>
          </div>
          {source ? <StatusPill status={source.status.state ?? 'not_connected'} /> : null}
        </div>
        <Link href="/settings?tab=trends" className="mt-3 inline-block text-sm font-medium text-charcoal-900 underline decoration-[var(--accent)] decoration-2 underline-offset-4">
          Open Settings → Trends
        </Link>
      </CardBody>
    </Card>
  );
}
