import { handleApi, requireOwner } from '@/lib/api';
import { previewToMe } from '@/lib/email';

/** POST /api/email/messages/[id]/preview-to-me (owner): sends this exact draft to the owner's own address only, marked [Preview]. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return previewToMe(user, params.id);
});
