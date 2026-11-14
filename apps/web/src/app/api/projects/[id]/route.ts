import { handleApi, parseJson } from '@/lib/api';
import { UpdateProjectSchema, deleteProjectPermanently, getProjectOrThrow, updateProject } from '@/lib/projects';

/** GET /api/projects/[id] — one project. */
export const GET = handleApi<{ id: string }>(async ({ params }) => ({ project: await getProjectOrThrow(params.id) }));

/** PATCH /api/projects/[id] — rename or edit client name / notes. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params }) => {
  const body = await parseJson(req, UpdateProjectSchema);
  return { project: await updateProject(params.id, body) };
});

/** DELETE /api/projects/[id] — permanently removes the project, its rows and every stored file. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  const result = await deleteProjectPermanently(params.id, user.id);
  return { ok: true, ...result };
});
