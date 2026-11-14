import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { applyEdit } from '@/lib/website';

/**
 * POST /api/website/edits/[id]/apply (owner) `{ confirm: true, expectedAfter }`: the explicit "Apply now". 409 when the
 * wording changed since the dialog opened; 422 without a connected adapter that supports the change.
 */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ confirm: z.literal(true), expectedAfter: z.string().max(5000) }));
  return NextResponse.json(await applyEdit(user, params.id, body.expectedAfter), { status: 202 });
});
