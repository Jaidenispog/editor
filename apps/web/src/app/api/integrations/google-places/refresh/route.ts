import { handleApi, requireOwner } from '@/lib/api';
import { refreshPlaces } from '@/lib/reviews';

/** POST /api/integrations/google-places/refresh (owner): at most every 10 minutes (429 otherwise). */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return refreshPlaces(user);
});
