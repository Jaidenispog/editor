import { handleApi, parseJson } from '@/lib/api';
import { ReviseSchema } from '@/lib/shared/studio-schemas';
import { createEditVersion } from '@/lib/studio-edits';

/** POST /api/edits/[id]/revise — { instruction } → new version (the old one is kept) → edits.revise. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const { instruction } = await parseJson(req, ReviseSchema);
  const { version, jobId } = await createEditVersion(params.id, user, { mode: 'revise', instruction });
  return Response.json({ versionId: version.id, versionNo: version.versionNo, jobId }, { status: 201 });
});
