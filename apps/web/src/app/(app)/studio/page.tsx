import type { Metadata } from 'next';
import { NewProjectButton } from '@/components/app/new-project-dialog';
import { ProjectList } from '@/components/app/project-list';
import { PageHeader } from '@/components/ui/page-header';
import { listProjects } from '@/lib/projects';

export const metadata: Metadata = { title: 'Video Studio' };

/** Video Studio home: every project, searchable, with a "New project" action. */
export default async function StudioPage() {
  const projects = await listProjects();
  return (
    <>
      <PageHeader
        eyebrow="Video Studio"
        title="Projects"
        description="One project per haircut. Add the clips you filmed, choose a length and style, and generate five different vertical edits."
        actions={<NewProjectButton />}
      />
      <ProjectList projects={projects} />
    </>
  );
}
