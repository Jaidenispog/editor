import { handleApi, parseJson } from '@/lib/api';
import { CreateProjectSchema, createProject, listProjects } from '@/lib/projects';

/** GET /api/projects?search= — projects with clip counts and latest generation status. */
export const GET = handleApi(async ({ req }) => {
  const search = req.nextUrl.searchParams.get('search') ?? undefined;
  return { projects: await listProjects(search ? { search } : {}) };
});

/** POST /api/projects — creates a project { title, clientName?, notes? }. */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, CreateProjectSchema);
  const project = await createProject(user.id, body);
  return Response.json({ project }, { status: 201 });
});
