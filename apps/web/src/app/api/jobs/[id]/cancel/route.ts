import { handleApi } from '@/lib/api';
import { cancelJob, toJobDto } from '@/lib/jobs';
import { getAccessibleJob } from '@/lib/studio-access';

/** POST /api/jobs/[id]/cancel — cooperative cancel (flag + queue cancel) of a job the user may act on. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  const job = await getAccessibleJob(params.id, user);
  return { job: toJobDto(await cancelJob(job.id)) };
});
