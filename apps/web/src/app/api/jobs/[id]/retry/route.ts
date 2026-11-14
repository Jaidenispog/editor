import { handleApi } from '@/lib/api';
import { retryJob } from '@/lib/jobs';

/** POST /api/jobs/[id]/retry — re-queues a failed or cancelled job. */
export const POST = handleApi<{ id: string }>(async ({ params }) => ({ job: await retryJob(params.id) }));
