import { handleApi } from '@/lib/api';
import { retryTarget } from '@/lib/publishing';

/** POST /api/publish-targets/[id]/retry (owner): a failed destination tries again with the same idempotency key. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => retryTarget(params.id, user));
