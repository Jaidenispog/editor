import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { NewProjectButton } from '@/components/app/new-project-dialog';
import { ProjectList } from '@/components/app/project-list';
import { PageHeader } from '@/components/ui/page-header';
import { listProjects } from '@/lib/projects';
import { getCurrentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Video Studio' };

/** Video Studio home: every project the user may open (staff: their own), searchable, with "New project". */
export default async function StudioPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const projects = await listProjects(user);
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
