import { handleApi, parseJson } from '@/lib/api';
import { NoteTrendSchema, noteTrend } from '@/lib/trends';

/** POST /api/trends/notes — "Note a trend": anyone signed in records something they saw themselves. */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, NoteTrendSchema);
  return Response.json({ trend: await noteTrend(user, body) }, { status: 201 });
});
