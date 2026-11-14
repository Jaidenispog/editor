import { PlaceIdSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { disconnectPlaces, getPlacesState, setPlaceId } from '@/lib/reviews';

/** GET /api/integrations/google-places (owner): the rating card's state and the latest snapshot. */
export const GET = handleApi(async ({ user }) => {
  requireOwner(user);
  return getPlacesState();
});

/** PUT /api/integrations/google-places (owner): saves a Place ID and queues the first read-only lookup. */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const { placeId } = await parseJson(req, PlaceIdSchema);
  return setPlaceId(user, placeId);
});

/** DELETE /api/integrations/google-places (owner): removes the Place ID and the snapshot. */
export const DELETE = handleApi(async ({ user }) => {
  requireOwner(user);
  await disconnectPlaces(user);
});
