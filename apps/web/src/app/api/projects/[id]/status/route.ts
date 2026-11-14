import { handleApi } from '@/lib/api';
import { getAccessibleProject } from '@/lib/studio-access';
import { buildStudioStatus } from '@/lib/studio-status';

/** GET /api/projects/[id]/status — polling payload for the Video Studio page (clips, styles, edits, jobs). */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => {
  const project = await getAccessibleProject(params.id, user);
  return buildStudioStatus(project);
});
