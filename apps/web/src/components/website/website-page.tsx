'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IntegrationStatusList } from '@/components/app/integration-status-list';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { apiRequest } from '@/lib/client/api-client';
import { SearchPerformanceCard } from './search-performance-card';
import { SetupChecklist } from './setup-checklist';
import { SuggestedChanges } from './suggested-changes';
import type { SearchPerformanceDto, WebsiteEditDto, WebsiteOverviewDto } from './types';
import { WebsiteCheckCard } from './website-check-card';

/**
 * The Website page body (design §10.1): setup checklist, website check, suggested changes, search performance and the
 * connections. Polls every 3 seconds while a check runs; otherwise it reloads after each action.
 */
export function WebsitePage({ initial, initialEdits, initialSearch }: { initial: WebsiteOverviewDto; initialEdits: WebsiteEditDto[]; initialSearch: SearchPerformanceDto }) {
  const [overview, setOverview] = useState(initial);
  const [changesKey, setChangesKey] = useState('0');
  const changesRef = useRef<HTMLDivElement>(null);
  const reload = useCallback(async () => {
    try {
      const next = await apiRequest<WebsiteOverviewDto>('/api/website');
      setOverview((prev) => {
        if (prev.latestAudit?.status !== next.latestAudit?.status || prev.openChanges !== next.openChanges) setChangesKey(String(Date.now()));
        return next;
      });
    } catch {
      // The next poll or action tries again.
    }
  }, []);
  const running = overview.latestAudit?.status === 'queued' || overview.latestAudit?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [running, reload]);
  const changeKeys = useMemo(() => new Set(initialEdits.map((e) => e.findingKey).filter((k): k is string => Boolean(k))), [initialEdits]);
  const connections = [overview.connections.searchConsole, overview.connections.wordpress].filter((c): c is NonNullable<typeof c> => c !== null);
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="min-w-0 space-y-6 lg:col-span-3">
        <SetupChecklist overview={overview} onChanged={() => void reload()} />
        <WebsiteCheckCard
          overview={overview}
          changeKeys={changeKeys}
          onChanged={() => void reload()}
          onShowChanges={() => {
            void reload();
            changesRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
        />
        <SuggestedChanges ref={changesRef} initialOpen={initialEdits} aiAvailable={overview.ai.copyAvailable} refreshKey={changesKey} onChanged={() => void reload()} />
      </div>
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <SearchPerformanceCard initial={initialSearch} queryGroups={overview.queryGroups} onChanged={() => void reload()} />
        <Card>
          <CardHeader title="Connections" description="Search Console is read-only. WordPress is optional; without it every change comes with copy-paste steps." />
          <CardBody className="min-w-0">
            {/* One card per row: this column is narrow, and two side by side cut the names short. */}
            <IntegrationStatusList integrations={connections} className="md:grid-cols-1" />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
