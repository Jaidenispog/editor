import { AppError } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { getTrendsOverview } from '@/lib/trend-watches';
import { CreateTrendSchema, UpdateTrendSchema, createTrend, deleteTrend, updateTrend } from '@/lib/trends';

/**
 * GET /api/trends — the three groups Settings → Trends shows, never mixed: live signals (per turned-on source),
 * noted by staff and curated references, plus the live source cards. Every item carries its `label`.
 */
export const GET = handleApi(async ({ user }) => getTrendsOverview(user));

/** POST /api/trends — adds a curated reference (owner). The kind cannot be chosen by the client. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, CreateTrendSchema);
  return Response.json({ trend: await createTrend(body) }, { status: 201 });
});

/** PUT /api/trends — updates a curated reference { id, …fields, enabled?, markVerified? } (owner). */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, UpdateTrendSchema);
  return { trend: await updateTrend(body) };
});

/** DELETE /api/trends?id= — deletes a curated reference (owner). */
export const DELETE = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const id = req.nextUrl.searchParams.get('id');
  if (!id) throw new AppError('VALIDATION', 'Say which reference to delete.');
  await deleteTrend(id);
  return { ok: true };
});
