import { handleApi, requireOwner } from '@/lib/api';
import { useGoogleReviewLink } from '@/lib/reviews';

/** POST /api/reviews/link/use-google (owner): copies Google's own review link from the latest Places snapshot. */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return useGoogleReviewLink(user);
});
