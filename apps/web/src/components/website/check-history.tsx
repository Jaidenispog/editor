'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@studio/core';
import { Dialog } from '@/components/ui/dialog';
import { StatusPill } from '@/components/ui/status-pill';
import { apiRequest } from '@/lib/client/api-client';
import { FindingsByCategory } from './findings-by-category';
import type { AuditSummaryDto } from './types';
import type { WebsiteAuditResult } from '@studio/core';

/** Plain counts for one check ("2 urgent, 5 important, …"). */
export function countsLine(s: AuditSummaryDto['summary']): string {
  const parts = [
    [s.counts.critical, 'urgent'],
    [s.counts.high, 'important'],
    [s.counts.medium, 'worth doing'],
    [s.counts.low, 'minor'],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
  return text.length ? text.join(', ') : 'Nothing to fix';
}

/** "Earlier checks": date, pages and counts; opening one shows its stored result read-only. */
export function CheckHistory({ refreshKey }: { refreshKey: string }) {
  const [audits, setAudits] = useState<AuditSummaryDto[] | null>(null);
  const [open, setOpen] = useState<{
    audit: AuditSummaryDto;
    result: WebsiteAuditResult | null;
    fixedSinceLast: string[];
  } | null>(null);
  const load = useCallback(async () => {
    try {
      setAudits((await apiRequest<{ audits: AuditSummaryDto[] }>('/api/website/audits?limit=20')).audits);
    } catch {
      setAudits([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  if (!audits || audits.length <= 1) return null;
  return (
    <section className="space-y-2" aria-labelledby="earlier-checks">
      <h3 id="earlier-checks" className="text-sm font-semibold text-charcoal-900">
        Earlier checks
      </h3>
      <ul className="divide-y divide-charcoal-100 rounded-lg border border-charcoal-200">
        {audits.slice(1).map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-charcoal-50"
              onClick={async () => {
                try {
                  setOpen(await apiRequest(`/api/website/audits/${a.id}`));
                } catch {
                  setOpen({ audit: a, result: null, fixedSinceLast: [] });
                }
              }}
            >
              <span className="text-charcoal-800">{formatDateTime(a.createdAt)}</span>
              <span className="flex items-center gap-2 text-charcoal-500">
                {a.summary.pagesChecked ? `${a.summary.pagesChecked} pages · ` : ''}
                {a.status === 'complete' || a.status === 'partial' ? countsLine(a.summary) : null}
                <StatusPill status={a.status} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open ? `Check of ${formatDateTime(open.audit.createdAt)}` : 'Check'} className="max-w-2xl">
        {open?.result ? (
          <div className="space-y-3">
            {open.fixedSinceLast.length ? <p className="text-sm text-emerald-800">Fixed since the check before: {open.fixedSinceLast.join('; ')}</p> : null}
            <FindingsByCategory findings={open.result.findings} changeKeys={new Set()} onShowChange={() => setOpen(null)} />
          </div>
        ) : (
          <p className="text-sm text-charcoal-600">{open?.audit.error ?? 'Only the summary of this older check is kept.'}</p>
        )}
      </Dialog>
    </section>
  );
}
