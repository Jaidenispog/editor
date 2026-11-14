import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { chooseProfileLocation } from '@/lib/business-profile';

/**
 * PUT /api/integrations/google-business-profile/location (owner) `{ locationName }`: one of the locations Google
 * listed for the account. Queues the first reviews read and the Performance probe (both read-only).
 */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ locationName: z.string().regex(/^locations\/[A-Za-z0-9_-]{1,100}$/, 'Choose one of the listed locations.') }));
  return chooseProfileLocation(user, body.locationName);
});
