import { handleApi } from '@/lib/api';
import { listProjectJobs } from '@/lib/jobs';
import { getProjectOrThrow } from '@/lib/projects';

/** GET /api/projects/[id]/jobs — recent background jobs for the project, newest first. */
export const GET = handleApi<{ id: string }>(async ({ params }) => {
  await getProjectOrThrow(params.id);
  return { jobs: await listProjectJobs(params.id) };
});
