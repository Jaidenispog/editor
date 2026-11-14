import { ReviewLinkSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { saveReviewLink } from '@/lib/reviews';

/** PUT /api/reviews/link (owner): saves the official review link the owner pasted (validated; never built by the app). */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const { url } = await parseJson(req, ReviewLinkSchema);
  return saveReviewLink(user, url);
});
