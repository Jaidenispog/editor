import { handleApi, requireOwner } from '@/lib/api';
import { disconnectBusinessProfile } from '@/lib/business-profile';

/**
 * DELETE /api/integrations/google-business-profile?deleteData=true|false (owner): status `disconnected` at once;
 * Google revokes the sign-in in the shared `google.disconnect` job. With `deleteData=true` the stored Google reviews
 * and Business Profile numbers are deleted too.
 */
export const DELETE = handleApi(async ({ req, user }) => {
  requireOwner(user);
  await disconnectBusinessProfile(user, req.nextUrl.searchParams.get('deleteData') === 'true');
  return new Response(null, { status: 202 });
});
