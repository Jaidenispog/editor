import { handleApi } from '@/lib/api';
import { deleteNotedTrend } from '@/lib/trends';

/** DELETE /api/trends/notes/[id] — the owner, or the person who noted it. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  await deleteNotedTrend(user, params.id);
  return { ok: true };
});
