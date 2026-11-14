import { AppError } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { CreateTrendSchema, UpdateTrendSchema, createTrend, deleteTrend, listTrends, updateTrend } from '@/lib/trends';

/** GET /api/trends — curated (and, later, live) trend references. */
export const GET = handleApi(async () => ({ trends: await listTrends() }));

/** POST /api/trends — adds a curated reference. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, CreateTrendSchema);
  return Response.json({ trend: await createTrend(body) }, { status: 201 });
});

/** PUT /api/trends — updates a reference { id, …fields, enabled?, markVerified? }. */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, UpdateTrendSchema);
  return { trend: await updateTrend(body) };
});

/** DELETE /api/trends?id= — deletes a reference. */
export const DELETE = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const id = req.nextUrl.searchParams.get('id');
  if (!id) throw new AppError('VALIDATION', 'Say which reference to delete.');
  await deleteTrend(id);
  return { ok: true };
});
