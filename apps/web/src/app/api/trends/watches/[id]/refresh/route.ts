import { handleApi, requireOwner } from '@/lib/api';
import { requestWatchRefresh } from '@/lib/trend-watches';

/** POST /api/trends/watches/[id]/refresh — reads the source again now (owner; at most once every 6 hours). */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return requestWatchRefresh(params.id);
});
