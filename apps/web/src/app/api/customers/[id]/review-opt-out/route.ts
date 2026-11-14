import { ReviewOptOutSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { setReviewOptOut } from '@/lib/email';

/** POST /api/customers/[id]/review-opt-out: staff may stop review requests; only the owner may turn them back on. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const { value } = await parseJson(req, ReviewOptOutSchema);
  return setReviewOptOut(user, params.id, value);
});
