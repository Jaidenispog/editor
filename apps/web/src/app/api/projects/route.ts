import { handleApi, parseJson } from '@/lib/api';
import { CreateProjectSchema, createProject, listProjects } from '@/lib/projects';

/** GET /api/projects?search= — projects the user may see (owner: all, staff: their own) with counts. */
export const GET = handleApi(async ({ req, user }) => {
  const search = req.nextUrl.searchParams.get('search') ?? undefined;
  return { projects: await listProjects(user, search ? { search } : {}) };
});

/** POST /api/projects — creates a project { title, clientName?, notes? } owned by the signed-in user. */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, CreateProjectSchema);
  const project = await createProject(user.id, body);
  return Response.json({ project }, { status: 201 });
});
