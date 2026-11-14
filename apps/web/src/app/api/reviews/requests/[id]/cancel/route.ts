import { handleApi, requireOwner } from '@/lib/api';
import { cancelReviewRequest } from '@/lib/reviews';

/** POST /api/reviews/requests/[id]/cancel (owner). */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return cancelReviewRequest(user, params.id);
});
