'use client';

import { Film, RotateCcw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { OLDER_MEASUREMENT_NOTE, OLDER_VERSION_NOTE, formatTrendDate, formatTrendDateTime, olderVersionNotice, type EditingStyleRowField, type ReferenceSummaryField, type SummarySuggestion } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { ReferenceSummaryDto } from '@/lib/references';
import { anyStyleFromVideos, stopRowRequest, summaryRowActions } from '@/lib/shared/your-style';

/** Honesty line under the header (design §4.3.1.8). */
const HONESTY =
  "These are estimates from your videos, not exact measurements. Check the next few edits and change anything that doesn't feel like you. Nothing from the videos is used in your edits, and the files were deleted after measuring.";

function AgreementChip({ row }: { row: SummarySuggestion }) {
  const e = row.evidence;
  if (e.total === 0 || (e.measured === 0 && row.state === 'not_measured')) return null;
  return (
    <Badge tone="neutral">
      Seen in {e.agreeing} of {e.total} video{e.total === 1 ? '' : 's'}
    </Badge>
  );
}

/** What accepting a row also changes, in plain words. */
function alsoChangesText(row: SummarySuggestion): string | null {
  const parts = row.alsoChanges
    .map((a) => (a.field === 'transitions' ? 'Also turns on bolder transitions' : a.field === 'beatsPerCut' ? `Also cuts about every ${String(a.value)} beat${a.value === 1 ? '' : 's'}` : null))
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function Row({
  row,
  canEdit,
  busy,
  onDecide,
  onStop,
}: {
  row: SummarySuggestion;
  canEdit: boolean;
  busy: string | null;
  onDecide: (accept: ReferenceSummaryField[], dismiss: ReferenceSummaryField[], key: string) => void;
  onStop: (field: EditingStyleRowField) => void;
}) {
  const also = alsoChangesText(row);
  const actions = summaryRowActions(row, canEdit);
  return (
    <li className="flex flex-col gap-2 py-3" data-summary-row={row.field}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-charcoal-900">{row.label}</span>
        <AgreementChip row={row} />
        {row.inUse ? <Badge tone="info">In use: from your videos</Badge> : null}
      </div>
      <p className="text-sm text-charcoal-700">{row.seen}</p>
      {actions.decide ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {canEdit ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                className="min-h-11 whitespace-normal text-left sm:min-h-8"
                loading={busy === `a:${row.field}`}
                onClick={() => onDecide([row.field], [], `a:${row.field}`)}
              >
                {row.action ?? 'Use this'}
              </Button>
              {row.state === 'open' ? (
                <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" loading={busy === `d:${row.field}`} onClick={() => onDecide([], [row.field], `d:${row.field}`)}>
                  No thanks
                </Button>
              ) : (
                <span className="text-xs text-charcoal-500">You said no thanks to this.</span>
              )}
            </>
          ) : (
            <span className="text-xs text-charcoal-500">Only the owner can change preferences.</span>
          )}
          {also ? <span className="text-xs text-charcoal-600">{also}</span> : null}
        </div>
      ) : null}
      {row.state === 'matches' ? <span className="text-xs text-charcoal-500">Matches your settings</span> : null}
      {actions.stop ? (
        <div>
          <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" loading={busy === `s:${row.field}`} onClick={() => onStop(row.field as EditingStyleRowField)}>
            Change: use each style&apos;s own
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Settings → Editing preferences → "Your style from your videos" (design §4.3.1.9): what was estimated from the owner's
 * own posted videos, combined across every measured reference, with "Use this" / "No thanks" per row, "Use all
 * suggestions" and "Go back to each style's own". Staff see it read-only.
 */
export function YourStyleSummary({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<ReferenceSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'all' | 'reset' | null>(null);

  const load = useCallback(() => {
    setError(null);
    apiRequest<ReferenceSummaryDto>('/api/references/summary')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load your style.'));
  }, []);
  useEffect(load, [load]);

  const decide = async (accept: ReferenceSummaryField[], dismiss: ReferenceSummaryField[], key: string) => {
    if (!data) return;
    setBusy(key);
    try {
      const valueKeys: Partial<Record<ReferenceSummaryField, string>> = {};
      for (const f of [...accept, ...dismiss]) {
        const row = data.suggestions.find((r) => r.field === f);
        if (row?.valueKey) valueKeys[f] = row.valueKey;
      }
      await apiRequest('/api/references/summary/decide', {
        method: 'POST',
        body: { accept, dismiss, valueKeys },
      });
      if (accept.length) toast.success('Preferences updated', 'Set from your videos. Check the next few edits and change anything that does not feel like you.');
      load();
    } catch (err) {
      toast.error('Could not update your preferences', err instanceof Error ? err.message : undefined);
      load();
    } finally {
      setBusy(null);
    }
  };

  const stop = async (field: EditingStyleRowField) => {
    setBusy(`s:${field}`);
    try {
      // Every value accepting the row set goes back ("Cutting to the beat" also the beats per cut), not only its own.
      const request = stopRowRequest(field);
      await apiRequest(request.path, { method: request.method, body: request.body });
      load();
    } catch (err) {
      toast.error('Could not change that setting', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy('reset');
    try {
      await apiRequest('/api/references/summary/reset', { method: 'POST' });
      toast.success("Back to each style's own", 'Length, pace, colour, text and the Transitions setting stay as they are.');
      setConfirm(null);
      load();
    } catch (err) {
      toast.error('Could not change your preferences', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const open = data?.suggestions.filter((r) => r.state === 'open') ?? [];
  const anyFromVideos = data ? anyStyleFromVideos(data.suggestions) : false;
  const v = data?.videos;
  const header =
    data && data.summary.total > 0
      ? `Estimated from ${data.summary.total} of your videos${data.summary.updatedAt ? ` · updated ${formatTrendDateTime(data.summary.updatedAt)}` : ''}`
      : 'Estimated from your own posted videos';
  const nothingReportable = data && data.summary.total > 0 && data.suggestions.every((r) => r.state === 'not_measured' || r.state === 'differs');
  // Videos measured with an older version of the measuring are listed but not combined into the rows.
  const olderVersion = data?.summary.olderVersion ?? 0;

  return (
    <Card>
      <CardHeader title="Your style from your videos" description={header} />
      <CardBody>
        <div className="space-y-3">
          <p className="text-sm text-charcoal-600">{HONESTY}</p>
          {error ? (
            <Alert tone="warning" title="Could not load your style">
              <p>{error}</p>
              <Button size="sm" variant="secondary" className="mt-2 min-h-11 sm:min-h-8" onClick={load}>
                <RotateCcw className="size-4" aria-hidden="true" /> Try again
              </Button>
            </Alert>
          ) : null}
          {!data && !error ? (
            <div className="space-y-2" aria-label="Loading your style">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
          {data && v && v.measuring > 0 ? (
            <Alert tone="info">
              {v.measuring} video{v.measuring === 1 ? ' is' : 's are'} still being measured.
            </Alert>
          ) : null}
          {data && data.summary.total === 0 && olderVersion === 0 ? (
            <p className="text-sm text-charcoal-600">
              Upload a few of your own posted videos with <strong>Add a reference video</strong> in any project and the editor will estimate your style.
              {/* After the videos were removed, what was accepted from them is still listed below. */}
              {anyFromVideos ? null : ' Nothing has been measured yet.'}
            </p>
          ) : null}
          {olderVersion > 0 ? <Alert tone="info">{olderVersionNotice(olderVersion)}</Alert> : null}
          {data && data.summary.total > 0 && data.summary.measured === 0 ? (
            <Alert tone="info">Your videos were measured before transitions and beat were added. Upload them again to include them in these rows.</Alert>
          ) : null}
          {nothingReportable ? <Alert tone="info">Not enough to go on yet — another video or two will help.</Alert> : null}
          {/* The rows also show when no current video backs them but a value from the videos is still in use. */}
          {data && (data.summary.total > 0 || anyFromVideos) ? (
            <>
              {canEdit ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {open.length > 1 ? (
                    <Button size="sm" className="min-h-11 sm:min-h-8" onClick={() => setConfirm('all')}>
                      <Sparkles className="size-4" aria-hidden="true" /> Use all suggestions
                    </Button>
                  ) : null}
                  {anyFromVideos ? (
                    <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setConfirm('reset')}>
                      Go back to each style&apos;s own
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <ul className="divide-y divide-charcoal-100">
                {data.suggestions.map((row) => (
                  <Row key={row.field} row={row} canEdit={canEdit} busy={busy} onDecide={decide} onStop={stop} />
                ))}
              </ul>
            </>
          ) : null}
          {data && data.list.length ? (
            <div>
              <h3 className="text-sm font-semibold text-charcoal-900">Videos</h3>
              <ul className="mt-2 divide-y divide-charcoal-100">
                {data.list.map((video) => (
                  <li key={video.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 gap-3">
                      <div className="h-16 w-10 shrink-0 overflow-hidden rounded-md bg-charcoal-100">
                        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed link */}
                        {video.thumbnailUrl ? (
                          <img src={video.thumbnailUrl} alt="" className="size-full object-cover" />
                        ) : (
                          <Film className="m-auto mt-5 size-5 text-charcoal-400" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-charcoal-900">
                          {video.filename} <span className="font-normal text-charcoal-500">· {video.projectTitle}</span>
                        </p>
                        <p className="text-xs text-charcoal-500">Measured {formatTrendDate(video.measuredAt)}</p>
                        {video.line ? <p className="text-xs text-charcoal-700 [overflow-wrap:anywhere]">{video.line}</p> : null}
                        {video.olderMeasurement ? (
                          <Badge tone="neutral" className="mt-1">
                            Older measurement
                          </Badge>
                        ) : null}
                        {video.olderMeasurement ? <p className="mt-1 text-xs text-charcoal-500">{OLDER_MEASUREMENT_NOTE}</p> : null}
                        {video.olderVersion ? (
                          <Badge tone="neutral" className="mt-1">
                            Older version of the measuring
                          </Badge>
                        ) : null}
                        {video.olderVersion ? <p className="mt-1 text-xs text-charcoal-500">{OLDER_VERSION_NOTE}</p> : null}
                      </div>
                    </div>
                    <Link href={`/studio/${video.projectId}`} className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-charcoal-800 underline underline-offset-4">
                      Open project
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </CardBody>
      <Dialog
        open={confirm === 'all'}
        onClose={() => setConfirm(null)}
        title="Use all suggestions?"
        description="These are estimates from your videos. You can change any of them later in Settings."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              loading={busy === 'all'}
              onClick={async () => {
                await decide(
                  open.map((r) => r.field),
                  [],
                  'all',
                );
                setConfirm(null);
              }}
            >
              Use all
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-charcoal-800">
          {open.map((r) => (
            <li key={r.field}>
              {r.action}
              {alsoChangesText(r) ? <span className="block text-xs text-charcoal-600">{alsoChangesText(r)}</span> : null}
            </li>
          ))}
        </ul>
      </Dialog>
      <Dialog
        open={confirm === 'reset'}
        onClose={() => setConfirm(null)}
        title="Go back to each style's own?"
        description="Transitions, beat, reveal, zoom and music matching go back to each style's own. Length, pace, colour and text stay as they are. If accepting your style turned on varied (bolder) transitions, that stays on too; change it under Transitions in your editing preferences."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button loading={busy === 'reset'} onClick={reset}>
              Go back
            </Button>
          </>
        }
      />
    </Card>
  );
}
