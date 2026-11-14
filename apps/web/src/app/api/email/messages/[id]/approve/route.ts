import { ApproveEmailSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { approveMessage } from '@/lib/email';

/** POST /api/email/messages/[id]/approve (owner): approves a draft; 422 with the blockers when the send gate would block it. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, ApproveEmailSchema);
  return approveMessage(user, params.id, body.scheduledFor);
});
