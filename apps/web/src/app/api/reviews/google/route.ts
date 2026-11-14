import { handleApi, requireOwner } from '@/lib/api';
import { getGoogleReviews } from '@/lib/business-profile';
import { getPlacesState } from '@/lib/reviews';

/**
 * GET /api/reviews/google (owner): what Google provides, each with its own state: the Places rating (Tier 1) and the
 * Business Profile reviews (Tier 2). Never a placeholder number; reviews are never typed in by hand.
 */
export const GET = handleApi(async ({ user }) => {
  requireOwner(user);
  const [places, profile] = await Promise.all([getPlacesState(), getGoogleReviews()]);
  return { places, profile };
});
