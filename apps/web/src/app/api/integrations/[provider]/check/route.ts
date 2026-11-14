import { handleApi } from '@/lib/api';
import { checkPublishingConnection } from '@/lib/publishing';

/** POST /api/integrations/[provider]/check (owner): queues the read-only connection check. Never posts. */
export const POST = handleApi<{ provider: string }>(async ({ params, user }) => checkPublishingConnection(params.provider, user));
