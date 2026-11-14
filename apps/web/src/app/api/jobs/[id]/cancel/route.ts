import { handleApi } from '@/lib/api';
import { cancelJob, toJobDto } from '@/lib/jobs';

/** POST /api/jobs/[id]/cancel — cooperative cancel (flag + queue cancel). */
export const POST = handleApi<{ id: string }>(async ({ params }) => ({ job: toJobDto(await cancelJob(params.id)) }));
