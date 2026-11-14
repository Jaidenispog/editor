import { ConfirmPlaceSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { confirmPlace } from '@/lib/reviews';

/** POST /api/integrations/google-places/confirm (owner): "Yes, that's us" or "No". */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const { confirm } = await parseJson(req, ConfirmPlaceSchema);
  return confirmPlace(user, confirm);
});
