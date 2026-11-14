import { handleApi, requireOwner } from '@/lib/api';
import { markDone } from '@/lib/website';

/** POST /api/website/edits/[id]/mark-done (owner): "I've made this change" (the next check confirms it). */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return { edit: await markDone(user, params.id) };
});
