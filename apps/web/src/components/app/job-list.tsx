'use client';

import { RotateCcw, Square } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatProgress, formatRelative } from '@/lib/format';
import { JOB_TYPE_LABELS, type JobDto } from '@/lib/shared/dto';

/**
 * Background jobs with progress bars and Cancel / Retry actions (POST /api/jobs/[id]/cancel|retry).
 * Calls router.refresh() after an action so server-rendered lists update.
 */
export function JobList({ jobs, showProject = false, onChanged }: { jobs: JobDto[]; showProject?: boolean; onChanged?: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (job: JobDto, action: 'cancel' | 'retry') => {
    setBusy(job.id);
    try {
      await apiRequest(`/api/jobs/${job.id}/${action}`, { method: 'POST' });
      toast.success(action === 'cancel' ? 'Cancelling' : 'Queued again');
      if (onChanged) onChanged();
      else router.refresh();
    } catch (err) {
      toast.error(action === 'cancel' ? 'Could not cancel' : 'Could not retry', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="divide-y divide-charcoal-100">
      {jobs.map((job) => {
        const active = job.status === 'queued' || job.status === 'running';
        return (
          <li key={job.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-charcoal-900">{JOB_TYPE_LABELS[job.type] ?? job.type}</span>
                <StatusPill status={job.cancelRequested && active ? 'cancelled' : job.status} {...(job.cancelRequested && active ? { label: 'Cancelling' } : {})} />
              </div>
              <p className="mt-0.5 truncate text-xs text-charcoal-500">
                {showProject && job.projectId ? (
                  <>
                    <Link href={`/studio/${job.projectId}`} className="underline-offset-2 hover:underline">
                      {job.projectTitle ?? 'Project'}
                    </Link>
                    {' · '}
                  </>
                ) : null}
                {job.status === 'failed' && job.error ? job.error : job.message || `Started ${formatRelative(job.createdAt)}`}
                {job.attempts > 1 ? ` · attempt ${job.attempts} of ${job.maxAttempts}` : ''}
              </p>
              {active ? (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-charcoal-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)} aria-label={`${JOB_TYPE_LABELS[job.type] ?? job.type} progress`}>
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: formatProgress(job.progress) }} />
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              {active && !job.cancelRequested ? (
                <Button size="sm" variant="secondary" onClick={() => act(job, 'cancel')} loading={busy === job.id}>
                  <Square className="size-3.5" aria-hidden="true" /> Cancel
                </Button>
              ) : null}
              {job.status === 'failed' || job.status === 'cancelled' ? (
                <Button size="sm" variant="secondary" onClick={() => act(job, 'retry')} loading={busy === job.id}>
                  <RotateCcw className="size-3.5" aria-hidden="true" /> Retry
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
