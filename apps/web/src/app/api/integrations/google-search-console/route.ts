import { handleApi, requireOwner } from '@/lib/api';
import { disconnectSearchConsole } from '@/lib/website';

/** DELETE /api/integrations/google-search-console?deleteData=true|false (owner): disconnects; Google revokes in a job. */
export const DELETE = handleApi(async ({ req, user }) => {
  requireOwner(user);
  await disconnectSearchConsole(user, req.nextUrl.searchParams.get('deleteData') === 'true');
  return new Response(null, { status: 202 });
});
