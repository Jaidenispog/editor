import { handleApi, requireOwner } from '@/lib/api';
import { removeWatch } from '@/lib/trend-watches';

/** DELETE /api/trends/watches/[id] — turns a live source off and deletes its items (owner). */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  await removeWatch(user, params.id);
  return { ok: true };
});
