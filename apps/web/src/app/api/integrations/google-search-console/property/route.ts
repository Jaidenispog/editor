import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { selectSearchConsoleProperty } from '@/lib/website';

/** PUT /api/integrations/google-search-console/property (owner) `{ siteUrl }`: chooses the property and queues the first sync. */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ siteUrl: z.string().min(1).max(300) }));
  return selectSearchConsoleProperty(user, body.siteUrl);
});
