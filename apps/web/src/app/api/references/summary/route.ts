import { handleApi } from '@/lib/api';
import { getReferenceSummary } from '@/lib/references';

/**
 * GET /api/references/summary — "Your style from your videos": the latest measured reference videos combined into
 * suggestion rows (estimates, with how many videos agree). Signed in; staff see the rows read-only, without the list
 * of videos (file names, thumbnails and project titles stay with the owner, as for GET /api/references).
 */
export const GET = handleApi(async ({ user }) => {
  const dto = await getReferenceSummary();
  if (user.role === 'owner') return dto;
  return { ...dto, list: [], summary: { ...dto.summary, referenceAssetIds: [] } };
});
