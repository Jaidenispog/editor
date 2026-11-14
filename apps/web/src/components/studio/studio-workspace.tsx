'use client';

import { Clapperboard, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { JobList } from '@/components/app/job-list';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { ChunkedUploader, type UploadItem } from '@/lib/client/uploader';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/shared/cn';
import type { GenerationDto, StudioStatusDto, StyleOptionDto } from '@/lib/shared/studio-dto';
import { ClipList } from './clip-list';
import { EditGrid } from './edit-grid';
import type { MusicUploadRequest } from './music-upload-dialog';
import { ProjectHeader } from './project-header';
import { StyleControls } from './style-controls';
import { UploadZone } from './upload-zone';
import { useStudioStatus } from './use-studio-status';

const EMPTY_UPLOADS: UploadItem[] = [];

function generationSummary(g: GenerationDto): string {
  const ready = g.edits.filter((e) => e.versions.some((v) => v.status === 'preview_ready')).length;
  const names = g.edits.map((e) => e.styleName).join(', ');
  return `${g.settings.durationSec} s · ${ready} of ${g.edits.length} ready${names ? ` · ${names}` : ''}`;
}

/**
 * The Video Studio for one project: header, drop zone with resumable uploads, clip cards, style controls with
 * "Generate N edits", live progress, the preview grid and the generation history. Keeps itself up to date by
 * polling the status endpoint.
 */
export function StudioWorkspace({ initialStatus }: { initialStatus: StudioStatusDto }) {
  const projectId = initialStatus.project.id;
  const toast = useToast();
  const { status, setStatus, error, refresh } = useStudioStatus(projectId, initialStatus);
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);

  const onFinished = useCallback(
    (item: UploadItem) => {
      if (item.kind === 'audio') toast.success('Track uploaded', `${item.name} is being analysed for its beat. It appears in the music list once ready.`);
      void refresh({ expectBusy: true });
    },
    [refresh, toast],
  );
  const [uploader] = useState(() => new ChunkedUploader({ onFinished }));
  useEffect(() => () => uploader.dispose(), [uploader]);
  const uploads = useSyncExternalStore(uploader.subscribe, uploader.getSnapshot, () => EMPTY_UPLOADS);

  useEffect(() => {
    const busy = uploads.some((u) => u.state === 'uploading' || u.state === 'finishing' || u.state === 'queued');
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploads]);

  const addVideos = (files: File[]) => uploader.add(files, { projectId, kind: 'video', maxBytes: status.limits.maxUploadBytes });
  const addMusic = (request: MusicUploadRequest) =>
    uploader.add([request.file], { projectId, kind: 'audio', maxBytes: status.limits.maxUploadBytes, completeBody: request.completeBody });

  const onStyles = useCallback((styles: StyleOptionDto[]) => setStatus((prev) => ({ ...prev, styles })), [setStatus]);
  const changed = useCallback((options?: { expectBusy?: boolean }) => void refresh(options), [refresh]);

  const generations = status.generations;
  const shown = useMemo(() => generations.find((g) => g.id === selectedGenerationId) ?? generations[0] ?? null, [generations, selectedGenerationId]);
  const ttl = status.limits.mediaLinkTtlSeconds;

  return (
    <div className="space-y-8">
      <ProjectHeader project={status.project} onChanged={() => changed()} />

      {error ? (
        <Alert tone="warning" title="Progress may be out of date">
          {error} We will keep trying.
        </Alert>
      ) : null}

      <UploadZone
        items={uploads}
        hasClips={status.assets.length > 0}
        onFiles={addVideos}
        onPause={(k) => uploader.pause(k)}
        onResume={(k) => uploader.resume(k)}
        onCancel={(k) => void uploader.cancel(k)}
        onDismiss={(k) => uploader.dismiss(k)}
      />

      <ClipList assets={status.assets} ttlSeconds={ttl} onChanged={changed} onStyles={onStyles} />

      {status.assets.length > 0 ? <StyleControls key={status.project.id} status={status} onGenerated={() => changed({ expectBusy: true })} onUploadMusic={addMusic} /> : null}

      {status.jobs.length ? (
        <Card>
          <CardHeader title="Working on it" description="Clips are analysed and edits are rendered in the background. You can leave this page; progress is saved." />
          <CardBody>
            <JobList jobs={status.jobs} onChanged={() => changed()} />
          </CardBody>
        </Card>
      ) : null}

      <section aria-labelledby="previews-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="previews-heading" className="text-lg font-semibold text-charcoal-950">
              Previews
            </h2>
            {shown ? (
              <p className="text-sm text-charcoal-500">
                Made {formatDateTime(shown.createdAt)} · {shown.settings.durationSec} s target
              </p>
            ) : null}
          </div>
          {shown ? <StatusPill status={shown.status} /> : null}
        </div>
        {shown ? (
          <>
            {shown.statusMessage && (shown.status === 'failed' || shown.status === 'partial' || shown.status === 'cancelled') ? (
              <Alert tone={shown.status === 'failed' ? 'danger' : 'warning'}>{shown.statusMessage}</Alert>
            ) : null}
            <EditGrid generation={shown} ttlSeconds={ttl} onChanged={changed} />
          </>
        ) : (
          <EmptyState
            icon={<Clapperboard className="size-6" />}
            title="No edits yet"
            description={status.assets.length ? 'Choose your styles above and press Generate. Five different vertical edits appear here.' : 'Drop your haircut clips above to start. Your vertical edits appear here.'}
          />
        )}
      </section>

      {generations.length > 1 ? (
        <section aria-labelledby="history-heading" className="space-y-3">
          <h2 id="history-heading" className="flex items-center gap-2 text-lg font-semibold text-charcoal-950">
            <History className="size-5" aria-hidden="true" /> Earlier generations
          </h2>
          <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white">
            {generations.map((g) => {
              const selected = g.id === shown?.id;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedGenerationId(g.id)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn('flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-charcoal-50 sm:flex-row sm:items-center sm:justify-between', selected && 'bg-accent-soft/60')}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-charcoal-900">{formatDateTime(g.createdAt)}</span>
                      <span className="block truncate text-xs text-charcoal-500">{generationSummary(g)}</span>
                    </span>
                    <StatusPill status={g.status} className="shrink-0" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
