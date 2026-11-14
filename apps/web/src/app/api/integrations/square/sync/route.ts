import { handleApi, requireOwner } from '@/lib/api';
import { queueSquareSync, requireSquareConnected } from '@/lib/square/status';

/** POST /api/integrations/square/sync (owner): queues a read-only `square.sync` ("Sync now" / Refresh). */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  await requireSquareConnected();
  return { jobId: await queueSquareSync('manual') };
});
