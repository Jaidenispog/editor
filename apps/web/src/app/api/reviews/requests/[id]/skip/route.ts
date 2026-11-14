import { SkipReviewRequestSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { skipReviewRequest } from '@/lib/reviews';

/** POST /api/reviews/requests/[id]/skip (owner): a reason from the fixed list (a note for "Other"). */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  return skipReviewRequest(user, params.id, await parseJson(req, SkipReviewRequestSchema));
});
