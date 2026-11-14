import { ApproveEmailSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { approveReviewRequest } from '@/lib/reviews';

/** POST /api/reviews/requests/[id]/approve (owner). */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, ApproveEmailSchema);
  return approveReviewRequest(user, params.id, body.scheduledFor);
});
