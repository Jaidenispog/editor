import { ApproveBatchSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { approveReviewBatch } from '@/lib/reviews';

/** POST /api/reviews/requests/approve-batch (owner): "Approve all ready". */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const { ids } = await parseJson(req, ApproveBatchSchema);
  return approveReviewBatch(user, ids);
});
