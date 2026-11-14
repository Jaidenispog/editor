import { handleApi } from '@/lib/api';
import { retryJob, toJobDto } from '@/lib/jobs';
import { getAccessibleJob } from '@/lib/studio-access';

/** POST /api/jobs/[id]/retry — re-queues a failed or cancelled job the user may act on. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  const job = await getAccessibleJob(params.id, user);
  return { job: toJobDto(await retryJob(job.id)) };
});
