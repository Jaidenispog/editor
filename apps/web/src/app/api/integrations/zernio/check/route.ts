import { handleApi } from '@/lib/api';
import { checkZernioConnection } from '@/lib/publishing';

/** POST /api/integrations/zernio/check (owner): queues the read-only Zernio check. Never posts. */
export const POST = handleApi(async ({ user }) => checkZernioConnection(user));
