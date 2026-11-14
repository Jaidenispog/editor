import { handleApi, parseJson } from '@/lib/api';
import { reorderAssets } from '@/lib/assets';
import { ReorderAssetsSchema } from '@/lib/shared/studio-schemas';

/**
 * POST /api/projects/[id]/assets/order — `{ assetIds }` in the new order. Renumbers every clip's position in
 * one transaction (clips not listed keep their relative order after the listed ones) → `{ assets }`.
 */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, ReorderAssetsSchema);
  return { assets: await reorderAssets(params.id, user, body.assetIds) };
});
