import { handleApi } from '@/lib/api';
import { listProjectJobs, toJobDto } from '@/lib/jobs';
import { getAccessibleProject } from '@/lib/studio-access';

/** GET /api/projects/[id]/jobs — recent background jobs for the project, newest first. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => {
  const project = await getAccessibleProject(params.id, user);
  return { jobs: (await listProjectJobs(project.id)).map((j) => toJobDto(j)) };
});
