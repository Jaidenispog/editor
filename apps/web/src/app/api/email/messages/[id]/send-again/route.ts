import { SendAgainSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { sendAgain } from '@/lib/email';

/** POST /api/email/messages/[id]/send-again (owner): after an unknown outcome the owner checked, clears the claim and re-approves. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  await parseJson(req, SendAgainSchema);
  return sendAgain(user, params.id);
});
