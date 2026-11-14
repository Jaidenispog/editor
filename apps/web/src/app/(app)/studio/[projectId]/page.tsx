import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { isAppError } from '@studio/core';
import { StudioWorkspace } from '@/components/studio/studio-workspace';
import { getCurrentUser } from '@/lib/session';
import { getAccessibleProject } from '@/lib/studio-access';
import { buildStudioStatus } from '@/lib/studio-status';

export const metadata: Metadata = { title: 'Video Studio' };
export const dynamic = 'force-dynamic';

/** Video Studio for one project: uploads, clips, style choices, previews, revisions and exports. */
export default async function ProjectStudioPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/studio/${projectId}`)}`);
  let project;
  try {
    project = await getAccessibleProject(projectId, user);
  } catch (err) {
    if (isAppError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const status = await buildStudioStatus(project);
  return <StudioWorkspace initialStatus={status} />;
}
