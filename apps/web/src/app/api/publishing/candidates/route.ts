import { handleApi } from '@/lib/api';
import { listCandidateVersions } from '@/lib/publishing';

/** GET /api/publishing/candidates (session): recent finished edits the composer's picker can add. Nothing is ticked. */
export const GET = handleApi(async ({ user }) => ({ versions: await listCandidateVersions(user) }));
