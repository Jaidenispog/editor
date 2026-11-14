import { handleApi, requireOwner } from '@/lib/api';
import { requestRecompute } from '@/lib/preferences';

/** POST /api/preferences/recompute — "Try again" after a failed update of what was learned (owner only). */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  await requestRecompute();
  return { queued: true };
});
