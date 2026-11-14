'use client';

import { forwardRef, useCallback, useEffect, useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs } from '@/components/ui/tabs';
import { apiRequest } from '@/lib/client/api-client';
import { ChangeCard } from './change-card';
import type { WebsiteEditDto } from './types';

type Tab = 'open' | 'done' | 'dismissed';

/**
 * "Suggested changes" (design §4.3): To review / Done / Dismissed. Nothing is applied without the owner choosing it
 * and confirming. Polls while a change is being applied or wording is being written.
 */
export const SuggestedChanges = forwardRef<
  HTMLDivElement,
  {
    initialOpen: WebsiteEditDto[];
    aiAvailable: boolean;
    refreshKey: string;
    onChanged: () => void;
  }
>(function SuggestedChanges({ initialOpen, aiAvailable, refreshKey, onChanged }, ref) {
  const [tab, setTab] = useState<Tab>('open');
  const [lists, setLists] = useState<Record<Tab, WebsiteEditDto[] | null>>({
    open: initialOpen,
    done: null,
    dismissed: null,
  });
  const load = useCallback(async (which: Tab) => {
    try {
      const res = await apiRequest<{ edits: WebsiteEditDto[] }>(`/api/website/edits?status=${which}`);
      setLists((l) => ({ ...l, [which]: res.edits }));
    } catch {
      setLists((l) => ({ ...l, [which]: l[which] ?? [] }));
    }
  }, []);
  useEffect(() => {
    void load(tab);
  }, [tab, load, refreshKey]);
  const busy = (lists.open ?? []).some((e) => e.status === 'approved' || e.status === 'applying');
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    if (!busy && !drafting) return;
    const t = setInterval(() => void load('open'), 3000);
    const stop = drafting ? setTimeout(() => setDrafting(false), 60_000) : null;
    return () => {
      clearInterval(t);
      if (stop) clearTimeout(stop);
    };
  }, [busy, drafting, load]);
  const changed = () => {
    setDrafting(true);
    void load(tab);
    if (tab !== 'open') void load('open');
    onChanged();
  };
  const render = (which: Tab) => {
    const list = lists[which];
    if (!list) return <Skeleton className="h-24" />;
    if (list.length === 0) {
      return (
        <p className="text-sm text-charcoal-600">
          {which === 'open'
            ? 'Nothing to change right now. Changes appear here after a check finds something we can prepare.'
            : which === 'done'
              ? 'No changes made yet.'
              : 'Nothing dismissed.'}
        </p>
      );
    }
    return (
      <div className="space-y-3">
        {list.map((e) => (
          <ChangeCard key={`${e.id}:${e.updatedAt}`} edit={e} aiAvailable={aiAvailable} onChanged={changed} />
        ))}
      </div>
    );
  };
  return (
    <div ref={ref} className="scroll-mt-4">
      <Card>
        <CardHeader
          title="Suggested changes"
          description="Prepared from your latest check and your business details. Review each one; nothing changes on your website unless you apply it or make it yourself."
        />
        <CardBody>
          <Tabs
            label="Suggested changes"
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
            items={[
              {
                id: 'open',
                label: `To review${lists.open ? ` (${lists.open.length})` : ''}`,
                content: render('open'),
              },
              { id: 'done', label: 'Done', content: render('done') },
              {
                id: 'dismissed',
                label: 'Dismissed',
                content: render('dismissed'),
              },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
});
