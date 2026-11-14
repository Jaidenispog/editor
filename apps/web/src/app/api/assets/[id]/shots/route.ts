import { handleApi } from '@/lib/api';
import { getAssetShots } from '@/lib/assets';

/** GET /api/assets/[id]/shots — the clip's shots with labels, label source and a signed frame link each. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => getAssetShots(params.id, user));
