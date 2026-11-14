import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { AddWatchSchema, addWatch } from '@/lib/trend-watches';

/** POST /api/trends/watches — turns a live source on (owner) and queues its first read. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, AddWatchSchema);
  return addWatch(user, body);
});
