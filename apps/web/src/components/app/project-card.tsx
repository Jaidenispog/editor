import { Clapperboard, Film } from 'lucide-react';
import Link from 'next/link';
import { StatusPill } from '@/components/ui/status-pill';
import { formatRelative } from '@/lib/format';
import type { ProjectSummaryDto } from '@/lib/shared/dto';

/** Plain-language summary of where a project is up to. */
export function projectProgressText(p: ProjectSummaryDto): string {
  if (p.assetCount === 0) return 'No clips yet';
  const clips = `${p.assetCount} clip${p.assetCount === 1 ? '' : 's'}`;
  const ready = p.readyAssetCount < p.assetCount ? ` · ${p.readyAssetCount} analysed` : '';
  const edits = p.editCount ? ` · ${p.editCount} edit${p.editCount === 1 ? '' : 's'}` : '';
  return `${clips}${ready}${edits}`;
}

/** Card linking to a project in the Video Studio. */
export function ProjectCard({ project }: { project: ProjectSummaryDto }) {
  const status = project.latestGeneration?.status ?? project.status;
  return (
    <Link
      href={`/studio/${project.id}`}
      className="group flex flex-col rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white p-5 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-charcoal-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-charcoal-900 text-accent" aria-hidden="true">
          {project.assetCount ? <Film className="size-5" /> : <Clapperboard className="size-5" />}
        </span>
        <StatusPill status={status} />
      </div>
      <h3 className="mt-4 truncate text-base font-semibold text-charcoal-950 group-hover:underline group-hover:decoration-[var(--accent)] group-hover:decoration-2 group-hover:underline-offset-4">
        {project.title}
      </h3>
      {project.clientName ? <p className="truncate text-sm text-charcoal-500">{project.clientName}</p> : null}
      <p className="mt-3 text-sm text-charcoal-600">{projectProgressText(project)}</p>
      <p className="mt-1 text-xs text-charcoal-400">Updated {formatRelative(project.updatedAt)}</p>
    </Link>
  );
}
