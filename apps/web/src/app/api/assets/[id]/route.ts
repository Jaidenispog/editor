import { handleApi, parseJson } from '@/lib/api';
import { deleteAsset, updateAsset } from '@/lib/assets';
import { UpdateAssetSchema } from '@/lib/shared/studio-schemas';
import { shapeStyleOptions } from '@/lib/studio-status-shape';

/** PATCH /api/assets/[id] — clip tag, per-shot tags or position; tags recompute style support. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, UpdateAssetSchema);
  const { asset, styleSupport } = await updateAsset(params.id, user, body);
  return {
    asset: { id: asset.id, clipLabel: asset.clipLabel, manualLabels: asset.manualLabels, sortOrder: asset.sortOrder },
    ...(styleSupport !== null || body.clipLabel !== undefined || body.manualLabels !== undefined ? { styles: shapeStyleOptions(styleSupport) } : {}),
  };
});

/** DELETE /api/assets/[id] — removes the clip and all of its stored files. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  const result = await deleteAsset(params.id, user);
  return { ok: true, ...result };
});
