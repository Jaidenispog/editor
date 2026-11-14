import { handleApi, parseJson } from '@/lib/api';
import { CurrentVersionSchema } from '@/lib/shared/studio-schemas';
import { setCurrentVersion } from '@/lib/studio-edits';

/** POST /api/edits/[id]/current-version — { versionId } shows that version on the card; nothing is deleted. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const { versionId } = await parseJson(req, CurrentVersionSchema);
  return setCurrentVersion(params.id, user, versionId);
});
