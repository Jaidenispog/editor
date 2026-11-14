'use client';

import { useMemo, useState } from 'react';
import { formatDateTime } from '@studio/core';
import { JobList } from '@/components/app/job-list';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { CheckHistory, countsLine } from './check-history';
import { FindingsByCategory } from './findings-by-category';
import { PriorityList } from './priority-list';
import type { WebsiteOverviewDto } from './types';

function took(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const s = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return s >= 60 ? ` (took ${Math.floor(s / 60)} min ${s % 60} s)` : ` (took ${s} s)`;
}

/**
 * "Check my website" (design §4.2): the button (disabled with the reason), job progress with Cancel, the outcome line,
 * partial notes, "Do these first", all findings by category and earlier checks. A check never changes the site.
 */
export function WebsiteCheckCard({
  overview,
  changeKeys,
  onChanged,
  onShowChanges,
}: {
  overview: WebsiteOverviewDto;
  changeKeys: Set<string>;
  onChanged: () => void;
  onShowChanges: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const a = overview.latestAudit;
  const result = overview.latestResult;
  const findings = useMemo(() => result?.findings ?? [], [result]);
  const altImages = useMemo(() => {
    const seen = new Set<string>();
    return (result?.pages ?? []).flatMap((p) =>
      p.skipped === null ? p.images.filter((i) => i.alt === null && !seen.has(i.src) && (seen.add(i.src), true)).map((i) => ({ src: i.src, pageUrl: p.finalUrl })) : [],
    );
  }, [result]);
  const start = async () => {
    setBusy(true);
    try {
      await apiRequest('/api/website/audits', { method: 'POST', body: {} });
      toast.success('Website check started', 'It reads up to 25 pages and takes a minute or two.');
      onChanged();
    } catch (e) {
      toast.error('The check did not start', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const blocked = overview.checkBlockedReason;
  const running = a && (a.status === 'queued' || a.status === 'running');
  return (
    <Card>
      <CardHeader
        title="Website check"
        description="Reads up to 25 pages of your website, the way a visitor's browser and Google would, and lists what to fix first. It never changes anything."
        actions={
          <Button className="min-h-11" loading={busy} disabled={Boolean(blocked) || busy} onClick={() => void start()}>
            Check my website
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {blocked && !running ? <p className="text-sm text-charcoal-600">{blocked}</p> : null}
        {overview.activeJob ? <JobList jobs={[overview.activeJob]} onChanged={onChanged} /> : null}
        {!a ? <p className="text-sm text-charcoal-600">No checks yet. A check reads up to 25 pages of your website and takes a minute or two. It never changes anything.</p> : null}
        {a && a.status === 'failed' ? <Alert tone="danger">{a.error ?? "The check didn't finish. Try again."}</Alert> : null}
        {a && a.status === 'cancelled' ? <Alert tone="info">Check cancelled. Nothing was changed.</Alert> : null}
        {a && (a.status === 'complete' || a.status === 'partial') ? (
          <div className="space-y-2">
            <p className="text-sm text-charcoal-800">
              Checked {a.summary.pagesChecked} page
              {a.summary.pagesChecked === 1 ? '' : 's'} on {formatDateTime(a.finishedAt ?? a.createdAt)}
              {took(a.startedAt, a.finishedAt)}. {countsLine(a.summary)}.
            </p>
            {a.summary.partialReasons.map((r) => (
              <Alert key={r} tone="warning">
                {r}
              </Alert>
            ))}
            {overview.fixedSinceLast.length ? <p className="text-sm text-emerald-800">Fixed since last check: {overview.fixedSinceLast.join('; ')}</p> : null}
            {result?.platformHint && result.platformHint !== 'unknown' ? (
              <p className="text-xs text-charcoal-500">
                Your site looks like it&apos;s built with{' '}
                {result.platformHint === 'wordpress' ? 'WordPress' : result.platformHint.charAt(0).toUpperCase() + result.platformHint.slice(1)}.
              </p>
            ) : null}
            <p className="text-xs text-charcoal-500">
              Speed figures are measured from our server, not from a phone in Ivanhoe. Nobody can promise rankings; these are things that can help people find and choose you.
            </p>
          </div>
        ) : null}
        {result ? <PriorityList findings={findings} changeKeys={changeKeys} onShowChange={onShowChanges} altImages={altImages} /> : null}
        {result ? (
          <section className="space-y-2" aria-labelledby="all-findings">
            <h3 id="all-findings" className="text-sm font-semibold text-charcoal-900">
              Everything we found
            </h3>
            <FindingsByCategory findings={findings} changeKeys={changeKeys} onShowChange={onShowChanges} altImages={altImages} />
          </section>
        ) : null}
        <CheckHistory refreshKey={a?.id ?? 'none'} />
      </CardBody>
    </Card>
  );
}
