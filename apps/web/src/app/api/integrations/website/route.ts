import { handleApi, requireOwner } from '@/lib/api';
import { disconnectWordPress } from '@/lib/website';

/** DELETE /api/integrations/website (owner): removes the WordPress credential; approved changes go back to review. */
export const DELETE = handleApi(async ({ user }) => {
  requireOwner(user);
  await disconnectWordPress(user);
  return undefined;
});
