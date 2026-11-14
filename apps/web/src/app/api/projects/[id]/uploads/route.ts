import { handleApi, parseJson } from '@/lib/api';
import { CreateUploadSchema } from '@/lib/shared/studio-schemas';
import { createUpload } from '@/lib/uploads';

/** POST /api/projects/[id]/uploads — starts a chunked upload → { uploadId, partSize, partCount, receivedParts }. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, CreateUploadSchema);
  return Response.json(await createUpload(params.id, user, body), { status: 201 });
});
