import { handleApi, requireOwner } from '@/lib/api';
import { getWebsiteOverview } from '@/lib/website';

/** GET /api/website (owner): setup checklist, latest check, active job, open changes, connections and AI availability. */
export const GET = handleApi(async ({ user }) => {
  requireOwner(user);
  return getWebsiteOverview();
});
