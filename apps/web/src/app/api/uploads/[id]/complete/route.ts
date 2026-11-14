import { handleApi, parseJson } from '@/lib/api';
import { CompleteUploadSchema } from '@/lib/shared/studio-schemas';
import { completeUpload } from '@/lib/uploads';

/** POST /api/uploads/[id]/complete — assembles the file → { assetId } and queues analysis. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, CompleteUploadSchema);
  return completeUpload(params.id, user, body);
});
