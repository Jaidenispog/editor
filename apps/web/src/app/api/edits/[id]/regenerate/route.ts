import { handleApi, parseJson } from '@/lib/api';
import { RegenerateSchema } from '@/lib/shared/studio-schemas';
import { createEditVersion } from '@/lib/studio-edits';

/** POST /api/edits/[id]/regenerate — a fresh take as a new version (the old one is kept). */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const { instruction } = await parseJson(req, RegenerateSchema);
  const { version, jobId } = await createEditVersion(params.id, user, { mode: 'regenerate', instruction });
  return Response.json({ versionId: version.id, versionNo: version.versionNo, jobId }, { status: 201 });
});
