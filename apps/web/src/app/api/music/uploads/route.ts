import { handleApi, parseJson } from '@/lib/api';
import { CreateLibraryUploadSchema } from '@/lib/shared/studio-schemas';
import { createLibraryMusicUpload } from '@/lib/uploads';

/**
 * POST /api/music/uploads — starts a chunked upload of a licensed track from Settings → Music library
 * `{ filename, size, mimeType }` → 201 `{ uploadId, partSize, partCount, receivedParts, status }`. Parts and
 * completion then use the same `/api/uploads/[id]/…` routes as the Video Studio (completion needs the licence
 * and `confirmLicence: true`).
 */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, CreateLibraryUploadSchema);
  return Response.json(await createLibraryMusicUpload(user, body), { status: 201 });
});
