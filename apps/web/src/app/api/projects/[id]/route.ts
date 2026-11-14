import { handleApi, parseJson } from '@/lib/api';
import { UpdateProjectSchema, deleteProjectPermanently, updateProject } from '@/lib/projects';
import { getAccessibleProject } from '@/lib/studio-access';

/** GET /api/projects/[id] — one project (404 for staff opening someone else's project). */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => ({ project: await getAccessibleProject(params.id, user) }));

/** PATCH /api/projects/[id] — rename or edit client name / notes. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, UpdateProjectSchema);
  return { project: await updateProject(params.id, user, body) };
});

/** DELETE /api/projects/[id] — permanently removes the project, its rows and every stored file. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  const result = await deleteProjectPermanently(params.id, user);
  return { ok: true, ...result };
});
