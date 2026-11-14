import { handleApi, parseJson } from '@/lib/api';
import { ReviseSchema } from '@/lib/shared/studio-schemas';
import { createEditVersion } from '@/lib/studio-edits';

/**
 * POST /api/edits/[id]/revise — { instruction?, audio? } → new version (the old one is kept) → edits.revise. A Sound
 * panel change alone that needs no re-cut keeps the cuts (`audio` mode); anything else is re-planned.
 */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const { instruction, audio } = await parseJson(req, ReviseSchema);
  const { version, jobId } = await createEditVersion(params.id, user, { mode: 'revise', instruction: instruction ?? '', audio });
  return Response.json({ versionId: version.id, versionNo: version.versionNo, jobId }, { status: 201 });
});
