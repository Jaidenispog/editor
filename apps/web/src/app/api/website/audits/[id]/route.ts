import { handleApi, requireOwner } from '@/lib/api';
import { getAudit } from '@/lib/website';

/** GET /api/website/audits/[id] (owner): one check's stored result (read-only) and what was fixed since the one before. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return getAudit(params.id);
});
