'use client';

import { FolderOpen, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import type { ProjectSummaryDto } from '@/lib/shared/dto';
import { NewProjectButton } from './new-project-dialog';
import { ProjectCard } from './project-card';

/** Searchable grid of project cards (search filters by project or client name in the browser). */
export function ProjectList({ projects }: { projects: ProjectSummaryDto[] }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.title.toLowerCase().includes(q) || p.clientName.toLowerCase().includes(q));
  }, [projects, query]);

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen />}
        title="No projects yet"
        description="Create a project for a haircut, drop in the clips from your phone, and generate five different edits."
        action={<NewProjectButton />}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="relative max-w-md">
        <label htmlFor="project-search" className="sr-only">
          Search projects
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-charcoal-400" aria-hidden="true" />
        <input
          id="project-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by project or client"
          className="h-10 w-full rounded-[var(--radius-control)] border border-charcoal-200 bg-white pr-3 pl-9 text-sm placeholder:text-charcoal-400 focus:border-transparent focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
        />
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon={<Search />} title="No matching projects" description={`Nothing matches “${query.trim()}”. Try a different name.`} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <li key={p.id}>
              <ProjectCard project={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
