import { handleApi, requireOwner } from '@/lib/api';
import { listReferences } from '@/lib/references';

/** GET /api/references — every reference video with its project, measurements and suggestions (owner only). */
export const GET = handleApi(async ({ user }) => {
  requireOwner(user);
  return { references: await listReferences() };
});
