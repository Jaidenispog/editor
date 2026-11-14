import { handleApi } from '@/lib/api';
import { cancelJob } from '@/lib/jobs';

/** POST /api/jobs/[id]/cancel — cooperative cancel (flag + queue cancel). */
export const POST = handleApi<{ id: string }>(async ({ params }) => ({ job: await cancelJob(params.id) }));
