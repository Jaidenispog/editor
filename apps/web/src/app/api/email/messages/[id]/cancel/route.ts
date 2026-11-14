import { handleApi, requireOwner } from '@/lib/api';
import { cancelMessage } from '@/lib/email';

/** POST /api/email/messages/[id]/cancel (owner): cancels a message that has not gone out; 409 once it is sending or sent. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return cancelMessage(user, params.id);
});
